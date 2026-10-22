---
name: setup
description: 1台の Mac で Claude Code を複数の Claude アカウント（Max/Pro）で使い分けられるようにする。設定ディレクトリと認証だけを分離し、スキル・CLAUDE.md・settings は共有したまま claude2 / claude3 … のコマンドを追加する。Claude in Chrome を2つ目のアカウントでも使うための専用 Chrome もセットアップできる。「claude2 を作りたい」「アカウントを使い分けたい」「上限が来たので別アカウントに切り替えたい」「Claude Code をもう1つのアカウントで動かす」で起動。
---

# claude-multi-account — Claude Code を複数アカウントで使い分ける

1台の Mac の Claude Code を、**複数の Claude アカウントで切り替えて使う**ための環境を作る。

```
claude   →  アカウント A（メイン）    設定: ~/.claude
claude2  →  アカウント B（2つ目）    設定: ~/.claude-accounts/account2
claude3  →  アカウント C（3つ目）    設定: ~/.claude-accounts/account3   ← 同じ手順で増やせる
```

**分けるのは「設定ディレクトリ」と「認証」だけ**。スキル・`CLAUDE.md`・`settings.json`・plugins は
メインから symlink で共有するので、**どのコマンドで起動しても同じスキル・同じルールが適用される**。
セッション履歴・`.claude.json`・認証情報だけがアカウントごとに独立する。

## 前提

| 項目 | 内容 |
|---|---|
| OS | **macOS 専用**（Keychain・`open -na`・`pgrep` を使う） |
| シェル | zsh（macOS 標準） |
| 必要なもの | Claude Code がインストール済み ＋ **2つ目の Claude アカウント（Max/Pro）を自分で用意していること** |
| 触らないもの | メインの `~/.claude` には一切書き込まない。既存の `claude` コマンドの挙動は変わらない |

> ⚠️ 上限回避を目的とした**自動アカウント切替（proxy 等）は Anthropic の規約で禁止**されている。
> このスキルが作るのは**手動で切り替えるための環境**であり、自動切替の仕組みは提供しない。

## 処理手順

### Step 0: セットアップ内容をヒアリング（AskUserQuestion）

以下を確認してから実行する。既に決まっている項目は聞き直さない。

| 聞くこと | 既定 | 備考 |
|---|---|---|
| 何番目のアカウントか | `2` | 既存があれば空いている番号を提案する。`status.sh` で既存を確認できる |
| 起動コマンド名 | `claude<番号>` | `--name` で変更可。`claude` は使えない |
| Claude in Chrome を2つ目でも使うか | 使う | 使うなら `--with-chrome`。ブラウザ操作を使わないなら不要 |
| 起動時に移動するディレクトリ | 移動しない | よく使う作業フォルダがあれば `--workdir` で指定 |

### Step 1: 実行内容を見せる（dry-run）

**必ず先に dry-run を実行し、何が作られ・どのファイルが編集されるかをユーザーに見せる。**

```bash
bash scripts/setup-account.sh --index 2 --with-chrome --dry-run
```

### Step 2: セットアップを実行

```bash
bash scripts/setup-account.sh --index 2 --with-chrome
```

やること（すべて冪等・何度実行しても壊れない）:

1. `~/.claude-accounts/account2` を作る（`chmod 700`）
2. メイン `~/.claude` から共有 symlink を張る（`CLAUDE.md` / `settings.json` / `skills` / `agents` / `commands` / `hooks` / `plugins` / `scripts` / `.env.*` など、**存在するものだけ**）
3. `~/.zshrc` に起動関数 `claude2()` と `claude-which` を追記する
   - `# >>> claude-multi-account (claude2) >>>` … `# <<< …` のマーカーで囲む → **再実行時は差し替え**なので重複しない
   - 編集前に `~/.zshrc.bak.<日時>` を必ず作る
4. `--with-chrome` なら専用 Chrome 一式（`scripts/setup-chrome.sh`）も用意する

### Step 3: 初回ログイン（ここだけ人間の操作）

```bash
exec zsh        # シェルを読み直す（または新しいターミナルを開く）
claude2         # 2つ目のプロファイルで起動（この時点ではまだ未ログイン）
```

セッション内で **`/login`** を実行し、**2つ目の Claude アカウント**で認証する。
ログインすると、そのプロファイル専用の Keychain エントリ
（`Claude Code-credentials-<設定ディレクトリの sha256 先頭8桁>`）が作られる。
メインの Keychain エントリとは別枠なので、**メインのログインは影響を受けない**。

> `/login` による full-scope ログインをすると **Remote Control**（claude.ai / モバイルアプリから
> そのセッションに接続する機能）も使える。`claude setup-token` の長期トークンは inference 専用で
> Remote Control を張れないため、起動関数は full-scope ログインを優先し、トークンはフォールバック扱いにしている。

### Step 4: 検証（完了報告の前に必ず実行）

```bash
bash scripts/status.sh
```

以下がすべて期待どおりか確認してから完了とする。

- 対象プロファイルの「Keychain ログイン」が ✅
- 「分離」が ✅（`.claude.json` / `sessions` / `projects` / `history.jsonl` が symlink になっていない）
- 「起動コマンド」が ✅
- Chrome を使う場合、「専用 Chrome」の manifest / native host が ✅

あわせて `claude-which` を実行し、`claude2` セッションで設定ディレクトリが切り替わっていることを確認する。

### Step 5: 使い方を伝える

```bash
claude          # メイン（アカウント A）
claude2         # 2つ目（アカウント B）
claude-which    # 今どちらのプロファイルで動いているかを表示
```

3つ目が必要になったら `--index 3` で同じ手順を繰り返すだけ。

## 上限で止まった会話を別アカウントで続ける

会話の記録はアカウントごとに別フォルダにあるので、切り替えただけでは続きから再開できない。

**手動**: 止まった画面の `/status` で Session ID を控え、次の1行で移す（複数 ID を並べてよい）。

```bash
bash scripts/move-session.sh --to auto <ID> [<ID>...]   # auto / main / 2 / 3 ...
```

- 全アカウントから同じ ID の記録を探し、**最後の発言の時刻が最も新しいもの**をコピーする（更新時刻では選ばない）
- `--to auto` は、記録が今あるアカウントを除き、5時間枠と週の枠の残りの少ない方が最も大きいアカウントを選ぶ。枠の値は `~/.claude/state/statusline-usage/<起動コマンド名>.json` から読む
- この記録がどのアカウントにも無いと、移動先を推測せずに止まる。記録を書く仕組みが無い環境では `--to 2` のように番号で指定する
- 既定は前面の窓に新しいタブを開いて即実行。`--prepare` は打ち込むだけ、`--no-launch` はコマンドの表示だけ
- 元のタブは閉じる。残すと枠が戻った時刻に元のアカウントで自動再開し、同じ作業が二重に動く
- 途中で失敗したチームメイトは自動では戻らないので、再開後に「失敗した writer をやり直して」のように頼む
- 回帰テスト: `scripts/test-move-session.sh`
- Claude の会話の中から別アカウントの設定を触るときは、会話の環境変数（`CLAUDE_CODE_SESSION_ID`・`CLAUDECODE`・`CLAUDE_CODE_CHILD_SESSION` 等）を `env -u` で外す。付いたままだと `CLAUDE_CONFIG_DIR` の指定より会話のアカウントが優先される

## Claude in Chrome を2つ目のアカウントで使う

`--with-chrome` を付けなかった場合、あとから追加できる。

```bash
bash scripts/setup-chrome.sh --index 2
```

**なぜ専用 Chrome が要るのか**: Chrome 拡張と Claude Code は native messaging host で繋がるが、
接続先セッションを決めるのは「host 起動時の `CLAUDE_CONFIG_DIR`」であり、Claude Code が自動生成する
ラッパーはそれを設定しない（＝常にメインに繋がる）。そこで **専用 user-data-dir の Chrome** と
**`CLAUDE_CONFIG_DIR` を渡すラッパー**を自前で用意する。

セットアップ後の流れ:

1. `bash ~/.claude-accounts/account2/chrome/launch-chrome.sh` で専用 Chrome を起動
   （`claude2` を起動すると未起動時に自動で立ち上がる）
2. その Chrome に Claude in Chrome 拡張を入れ、2つ目のアカウントでログインする
3. `claude2` のセッションで `/chrome` を実行 → 「Browser 1 · current」と出れば接続成功

> ブラウザが繋がらないときは、設定の破損ではなく**専用 Chrome が起動していないだけ**のことが多い。
> `/usr/bin/pgrep -fl "chrome-user[-]data"` で確認する（`ps aux | grep` は長いコマンドラインを
> 取りこぼすことがある）。詳細は `references/architecture.md` のトラブルシュート。

## 元に戻す（アンインストール）

**削除は必ずユーザーの承認を得てから行う。** 手順:

1. `~/.zshrc` から `# >>> claude-multi-account (claude2) >>>` 〜 `# <<< … <<<` のブロックを削除
2. Keychain のエントリを削除（`security delete-generic-password -s "Claude Code-credentials-<8桁>"`）
   - 8桁の値は `bash scripts/status.sh` に表示される
3. 設定ディレクトリ `~/.claude-accounts/account2` を削除（セッション履歴も消える）

メイン（`~/.claude`）には何も足していないので、上記だけで元の状態に戻る。

## スクリプト一覧

| ファイル | 役割 |
|---|---|
| `scripts/setup-account.sh` | プロファイル作成・共有 symlink・起動関数の追記（`--dry-run` / `--with-chrome` / `--workdir` / `--no-shell`） |
| `scripts/setup-chrome.sh` | そのプロファイル専用 Chrome 一式（user-data-dir / native host ラッパー / manifest / 起動スクリプト） |
| `scripts/status.sh` | 健康診断（read-only）。認証・共有 symlink・分離・Chrome の状態を一覧 |
| `scripts/move-session.sh` | 上限で止まった会話を別アカウントへコピーして iTerm のタブで再開（`--to auto` / `--prepare` / `--no-launch`） |
| `scripts/lib/common.sh` | 共通ライブラリ（dry-run・テンプレート描画・マーカーブロック更新・symlink） |
| `templates/` | 起動関数 / native host / Chrome 起動スクリプト / manifest の雛形 |

すべて `--help` を持つ。挙動は環境変数 `CLAUDE_ACCOUNTS_ROOT` / `CLAUDE_MAIN_CONFIG_DIR` /
`CLAUDE_SHELL_RC` で差し替えられる（テスト・非標準構成向け）。

## 安全設計（配布物として守っていること）

- メインの `~/.claude` には**書き込まない**
- `~/.zshrc` は**マーカーで囲んだブロックだけ**を差し替え、編集前にバックアップを作る
- 既に実体（ファイル・ディレクトリ）がある場所には symlink を作らず、警告して飛ばす
- `.claude.json` / `sessions` / `projects` / `history.jsonl` を共有しようとすると**エラーで止める**（アカウント分離が壊れるため）
- 認証トークンは読まない・表示しない・コマンドライン引数に載せない（存在確認のみ）
- `~/.claude-accounts/` は `chmod 700`

## 関連

- 設計の詳細・全体図・トラブルシュート: `references/architecture.md`
- Raycast のホットキー起動を足したい場合: `references/raycast.md`
