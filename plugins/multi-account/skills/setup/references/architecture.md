# 設計の詳細（claude-multi-account）

## 全体図

```
┌──────────────────────────────────────────────────────────────────────┐
│  Mac 1台に Claude Code は1つ。設定ディレクトリと認証を切り替えて、      │
│  独立した複数の Claude アカウントを使い分ける                          │
└──────────────────────────────────────────────────────────────────────┘

        claude（メイン）                    claude2（2つ目・3つ目以降も同型）
   ═══════════════════════            ═══════════════════════════════════
            │                                        │
   ┌────────▼─────────┐                    ┌─────────▼──────────┐
   │  アカウント A     │                    │  アカウント B       │ ← 別の Claude ログイン
   └────────┬─────────┘                    └─────────┬──────────┘
            │                                        │
   ┌────────▼──────────────┐          ┌──────────────▼─────────────────────┐
   │ 設定: ~/.claude        │          │ 設定: ~/.claude-accounts/account2   │
   │ （デフォルト）          │          │  CLAUDE_CONFIG_DIR で切替           │
   └────────┬──────────────┘          └──────────────┬─────────────────────┘
            │                                        │
   ┌────────▼───────────────────┐    ┌───────────────▼─────────────────────┐
   │ 認証: macOS Keychain        │    │ 認証: macOS Keychain                 │
   │  "Claude Code-credentials"  │    │  "Claude Code-credentials-<8桁>"     │
   │                             │    │   8桁 = 設定ディレクトリの sha256 先頭 │
   │                             │    │  （無ければ .oauth-token にフォール   │
   │                             │    │    バック＝Remote Control 不可）      │
   └─────────────────────────────┘    └─────────────────────────────────────┘
            │                                        │
   ┌────────▼──────────┐              ┌──────────────▼─────────────────────┐
   │ 起動: `claude`     │              │ 起動: `claude2`（zsh 関数）          │
   │                    │              │ → サブシェルで env を隔離して起動    │
   │                    │              │   （メインの環境を汚染しない）        │
   └────────────────────┘              └─────────────────────────────────────┘
```

## 共有するもの / 独立するもの

| 項目 | メイン | 2つ目 | 関係 |
|---|---|---|---|
| Claude アカウント | A | B | **完全に別** |
| 認証（Keychain エントリ） | `Claude Code-credentials` | `Claude Code-credentials-<8桁>` | **別** |
| 設定ディレクトリ | `~/.claude` | `~/.claude-accounts/account2` | **別** |
| セッション履歴 / `projects` / `sessions` | 各自の実体 | 各自の実体 | **別** |
| `.claude.json` / `history.jsonl` | 各自の実体 | 各自の実体 | **別** |
| スキル / `CLAUDE.md` / `settings.json` / plugins / `.env.*` | 実体 | → symlink で共有 | **共通** |

**ツールとルールは共有、アカウントとセッションだけ分離**。これが設計の中心。
「どちらで起動しても同じスキルが使える」ことと「上限・履歴が独立している」ことを両立させる。

### 共有してはいけないもの（スクリプトが拒否する）

`.claude.json` / `sessions` / `projects` / `history.jsonl` / `todos` / `shell-snapshots` /
認証ファイル。これらを symlink にすると **2つのアカウントが同じセッション状態を奪い合い**、
分離そのものが壊れる。`setup-account.sh` は `--share` にこれらが渡されるとエラーで停止する。

## Keychain のサービス名について

Claude Code は、デフォルト以外の `CLAUDE_CONFIG_DIR` を使うとき
`Claude Code-credentials-<設定ディレクトリの絶対パスの sha256 先頭8桁>` というサービス名で
認証情報を保存する。したがって **サービス名をハードコードしてはいけない**（設定ディレクトリの
場所を変えると変わる）。本スキルは常に実行時に算出する。

```bash
printf '%s' "$HOME/.claude-accounts/account2" | shasum -a 256 | cut -c1-8
```

## 認証の2方式

| 方式 | 作り方 | Remote Control | 用途 |
|---|---|---|---|
| **full-scope ログイン**（推奨） | セッション内で `/login` | ✅ 使える | 対話利用の既定 |
| 長期トークン | `claude setup-token` → `<設定ディレクトリ>/.oauth-token`（chmod 600） | ❌ 使えない（inference 専用） | 無人実行・CI 用のフォールバック |

起動関数は full-scope ログインを優先し、無ければトークンを `CLAUDE_CODE_OAUTH_TOKEN` として渡す。
どちらも無ければ「未ログイン」と案内したうえで起動する（そのまま `/login` できる）。

> ⚠️ トークンは平文でチャット・ログに残さない。`claude setup-token` の出力を pipe でファイルに
> 落とすと TUI のエスケープ文字が混ざって壊れることがあるため、**目視でコピーして貼る**のが確実。

## Claude in Chrome を2つ目のアカウントで使う仕組み

Chrome 拡張 ↔ Claude Code は **native messaging host** で繋がる。ここでの本質は:

> 接続先セッションを決めるのは「manifest がどのファイルを指すか」ではなく、
> **「host プロセス起動時にどの `CLAUDE_CONFIG_DIR` が渡るか」**。

Claude Code が自動生成する native host ラッパーは `CLAUDE_CONFIG_DIR` を設定しないため、
どの Chrome から起動しても常にメインの `~/.claude` に繋がってしまう。そこで:

```
メイン Chrome（通常起動）              2つ目用 Chrome（別 user-data-dir）
  └ 拡張 → グローバル manifest           └ 拡張 → user-data-dir/NativeMessagingHosts/ の manifest
      └ host（env なし → ~/.claude）         └ chrome-native-host-claude2
                                                （CLAUDE_CONFIG_DIR=account2 を export）
      └ メインのセッションに接続              └ claude2 のセッションに接続
```

macOS でも `--user-data-dir` 配下の `NativeMessagingHosts/` が探索されることを利用している。
ペアリング状態は各設定ディレクトリの `.claude.json` → `chromeExtension.pairedDeviceId` に入るので、
双方とも自分の1台目が「Browser 1」と表示される（正常）。

拡張の利用資格・使用量は、**拡張にログインしている Claude アカウント側**で消費される。

### トラブルシュート

| 症状 | まず疑うこと | 対処 |
|---|---|---|
| `list_connected_browsers` が空 | **専用 Chrome が起動していないだけ** | `/usr/bin/pgrep -fl "chrome-user[-]data"` で確認 → `launch-chrome.sh` で起動 |
| 専用 Chrome は起動しているのに空 | native host ラッパーの claude バイナリパス失効 | ラッパーは `~/.local/bin/claude` を第一候補にしている。`bash status.sh` で native host の実行可否を確認し、直したら **Chrome を再起動**して host を再生成させる |
| メインのブラウザ操作まで壊れた | 触っていないので通常起こらない | グローバル manifest（`~/Library/Application Support/Google/Chrome/NativeMessagingHosts/`）は本スキルの管理外 |

> `ps aux \| grep` は長いコマンドラインを取りこぼして「起動していない」と誤判定することがある。
> プロセス確認は `pgrep -f` を使う。

## セキュリティ方針

- **トークンを env に載せるのは起動関数のフォールバック時だけ**。full-scope ログイン（`/login`）が
  あれば `CLAUDE_CODE_OAUTH_TOKEN` は一切 export されない。長期トークンしか無い場合のみ、起動する
  claude プロセスの環境に渡す（env 経由のトークンは同一ユーザーのプロセス情報から見える露出面に
  なるため、**対話利用では `/login` を推奨**する）
- native host ラッパーは、フォールバックの場合でも `CLAUDE_CODE_OAUTH_TOKEN` を **export しない**
  （常時起動する常駐プロセスであり露出時間が長い。トークン無しでもペアリング・操作は成立する）
- `~/.claude-accounts/` 配下は `chmod 700`（Chrome プロファイルには拡張の状態やセッション由来の
  データが入るため、他ユーザーからの走査を遮断する）
- `launch-chrome.sh` は追加引数の `--user-data-dir` 上書きを無視する（分離前提を壊させない）
- 起動関数は**サブシェルで env を隔離**する。呼び出し元のシェルとメインの `claude` を汚染しない

## 運用のコツ

- 上限対策の優先順位: ① `/model` で軽いモデルを使う（最も効果が大きい） ② 使用量を監視して早めに気づく
  ③ 手動でアカウントを切り替える ④ 用途で使い分ける（例: 調査は B、実装は A）
- プランの大小と「メイン/予備」の役割が逆になっていないか、切替時に確認する
- **自動切替（proxy 等）は Anthropic の規約で禁止**。切替は手動で行う
