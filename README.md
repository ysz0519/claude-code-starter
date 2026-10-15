# Claude Code はじめの一歩（claude-code-starter）

Claude Code（＝ターミナルで動く Claude。あなたの Mac のファイルを読み書きし、コマンドを実行できる）を入れたばかりの人向けの、初期セットアップ一式です。
人が手でやるのは、この手順書の 1〜4 だけ。5 からは Claude が質問してくるので、答えるだけで設定が終わります。
所要時間は 30 分ほど（Google 連携まで入れると 45 分）。

対象は **macOS**（13 以降）です。Windows は対象外です。

## できるようになること

| 項目 | 何が起きるか |
|---|---|
| ステータスライン | 画面の一番下に、モデル・会話の文脈の使用率・料金の目安・プランの残り（5時間枠・7日枠）が常に出る |
| 権限の既定と安全弁 | 「自動／編集だけ自動／毎回確認」を選べる。`sudo`・ホームの削除・`git push --force`・鍵ファイルの読み取りは、どのモードでも止まる |
| デスクトップ通知 | 作業完了・許可待ち・入力待ちで Mac の通知が鳴る |
| 個人用 CLAUDE.md | 話し方（日本語・結論から）と「必ず確認してから」（削除・インストール・課金・外部送信）が全プロジェクトに適用される |
| git と GitHub | 変更の記録に残す名前と、GitHub を操作するコマンド（gh） |
| ブラウザ操作 | Playwright（専用の Chrome 窓を Claude が操作）を主、Claude in Chrome 拡張を副として設定 |
| 公式ドキュメント MCP | Claude Code の使い方を Claude 自身に聞ける |
| 任意 | 文書変換（Word・PowerPoint・Excel・PDF）、Google Workspace（Gmail・カレンダー・Drive・シート）、Slack の案内 |

## 用意する物

- Mac（macOS 13 以降）と、ソフトを入れられる権限
- Claude の有料プラン（Pro か Max）のアカウント。ログインはブラウザで行う
- Google Chrome（ブラウザ操作で使う）
- 30 分

## 手順（人がやるのはここだけ）

### 1. ターミナルを開く

「アプリケーション → ユーティリティ → ターミナル」。iTerm2（https://iterm2.com/）を入れて使うと、通知・リンク・改行の体験が良くなりますが、必須ではありません。

### 2. Homebrew を入れる（道具を入れる道具。5〜10 分）

ターミナルに次を貼って Enter。途中でパスワードを聞かれます（画面に出ませんが入力されています）。

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

終わったら、画面の最後に出る `Next steps` の2行（`echo >> ~/.zprofile …` と `eval …`）も貼って実行します。
そのあと `brew --version` で版が出れば完了です（Command Line Tools も一緒に入ります）。

### 3. Claude Code を入れて、動作を確かめる

```bash
curl -fsSL https://claude.ai/install.sh | bash
```

ターミナルをいったん閉じて開き直し、次を実行します。

```bash
claude doctor
```

`✔` が並べば OK です（この入れ方だと自動で更新されます）。

### 4. ログインする

```bash
claude
```

初回はブラウザが開くので、**Pro/Max のアカウント**でログインします。
注意: 会社の都合などで `ANTHROPIC_API_KEY` という環境変数が設定されている Mac では、そちらの API（従量課金）が優先されます。定額プランで使いたい人は `echo $ANTHROPIC_API_KEY` が空であることを確かめてください。
ログインできたら `/exit` で一度抜けます。

### 5. ウィザードを入れて、起動する

ターミナルで次の2行を実行します（GitHub のアカウントは要りません）。

```bash
claude plugin marketplace add ysz0519/claude-code-starter
claude plugin install starter-kit@claude-code-starter
```

そのあと `claude` で起動し、次のように打ちます。

```
/starter-kit:setup
```

ここから先は Claude が環境を調べ、足りない所だけを質問します（最大 7 問）。答え終わると設定が書かれ、人がやることが残っていれば番号付きで案内されます。
終わったら Claude Code を起動し直してください。ステータスライン・通知・接続口はそこから有効になります。

## 終わったあと

| やりたいこと | 打つもの |
|---|---|
| 設定の現状を見る（問い合わせのときはこの表を貼る） | `/starter-kit:status` |
| 最初の 10 分の使い方 | `/starter-kit:guide` |
| 途中でやめた設定を続きから | `/starter-kit:setup` |
| このウィザードを新しい版にする | ターミナルで `claude plugin marketplace update claude-code-starter` のあと `claude plugin update starter-kit@claude-code-starter` |

## 一緒に配っているプラグイン

| プラグイン | 何ができるか | 入れ方 |
|---|---|---|
| `multi-account` | 1 台の Mac で Claude Code を複数の Claude アカウントで使い分ける（上限が来たときの切り替え用・`claude2` コマンドを足す） | `claude plugin install multi-account@claude-code-starter` |
| `slack-agent` | 自分の Claude Code を Slack の「AI 社員」として動かす（投稿・メンションで起動・依頼スレッドの自動再開） | `claude plugin install slack-agent@claude-code-starter` |

## 困ったとき

| 症状 | 見るところ |
|---|---|
| `claude: command not found` | ターミナルを開き直す。それでも出なければ手順 3 をやり直す |
| `brew: command not found` | 手順 2 の `Next steps` の2行を実行していない |
| ウィザードの導入で `git` のエラー | 手順 2 をやり直す（Command Line Tools が要る）。`CLAUDE_CODE_PLUGIN_PREFER_HTTPS=1` を頭に付けて再実行すると直ることがある |
| ステータスラインが出ない | Claude Code を起動し直す。`/starter-kit:status` の1行目を見る |
| 通知が鳴らない | macOS の「システム設定 → 通知」で「Script Editor」の通知を許可する |
| ブラウザ操作が動かない | `claude mcp list` で `playwright` が `Connected` か。`node -v` が出なければ `brew install node` |

## 中身

```
.claude-plugin/marketplace.json      マーケットプレイス（プラグインの一覧）
plugins/starter-kit/                 ウィザード本体
  skills/setup|status|guide/          Claude が読む手順（質問の仕方・順番）
  scripts/setup.py                    設定を書く純プログラム（何も聞かない・何も入れない）
  scripts/statusline.py               ステータスライン本体（~/.claude/statusline.py にコピーされる）
  docs/                               最初の10分・ブラウザ・Google・Slack・MCP の案内
plugins/multi-account/         複数アカウント
plugins/slack-agent/     Slack の AI 社員
```

設定の書き込みはすべて「既存を壊さない追記」で、書く前に `~/.claude/settings.json.bak-<日時>` の控えを取ります。鍵やトークンは一切扱いません。

## ライセンス・連絡先

MIT License。不具合・改善の提案は GitHub の Issue（https://github.com/ysz0519/claude-code-starter/issues）へ。
