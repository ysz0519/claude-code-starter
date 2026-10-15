---
name: setup
description: "Claude Code を入れたばかりの人向けの初期セットアップ・ウィザード。環境を自動で調べ、足りない所だけ質問して、ステータスライン・権限の安全弁・デスクトップ通知・個人用 CLAUDE.md・git と GitHub・ブラウザ操作（Playwright）・公式ドキュメント MCP・文書変換・Google Workspace・Slack を設定する。「セットアップして」「初期設定して」「starter-kit」「設定を続きから」で起動。現状の確認だけなら status、使い方の案内は guide。"
---

# starter-kit: setup（初期セットアップ・ウィザード）

相手は Claude Code を入れたばかりの初心者（非エンジニアを含む）。技術用語は使わず「何が起きるか」で話す。
機械で決められることは聞かない。本体は `scripts/setup.py`（何も聞かない・何もインストールしない純プログラム）。
Claude が担うのは、質問・説明・答えの書き込み・インストールコマンドの実行の4つだけ。

```bash
S="${CLAUDE_PLUGIN_ROOT}/scripts/setup.py"
/usr/bin/python3 "$S" preflight --json      # 環境と各項目の現状。何も書かない
/usr/bin/python3 "$S" plan --json           # 答えから「書くもの・入れるもの・人がやるもの」を出す。何も書かない
/usr/bin/python3 "$S" apply --json          # 設定を冪等に書く（2回目以降は「変更なし」）
/usr/bin/python3 "$S" status                # 現状表（人が読む1画面）
```

終了コード: `0` 成功 / `1` 前提の不合格・答えの不備（stderr に人が読む1行）/ `2` 引数エラー。
答えの置き場は preflight の `answers_path`（Claude が Write で書く）。

## 手順

### 1. 前提を調べる（聞かない）

`preflight --json` を実行する。

- `ok: false` なら `stop_reasons[].hint` を1行ずつ伝えて終える。「完了」とは言わない
- `items` で `state` が `done` の項目は質問しない。全部 done なら「すでに設定済みです」と伝え、`status` の表を見せて終える
- `previous_answers` があれば AskUserQuestion を1問: 「前回の答えのまま続きからやりますか」（続きから／聞き直す）
- `notes` があれば1行ずつ伝える（未ログイン・Homebrew なし・Terminal.app の3種）

結果は事業の言葉で2〜3行にまとめる（例:「この Mac で設定できます。ログイン済み（Max）。未設定は、ステータスライン・通知・ブラウザ操作の3つです」）。

### 2. 質問する（AskUserQuestion・最大2回・各4問まで）

質問は「何が起きるか」、選択肢の説明は「何を得て何を失うか」で書く。ファイル名・方式の名前は出さない。
`items` が `done` の項目の質問は飛ばす（1回目が0問になったら2回目だけ行う）。

1回目（必須の項目）:

| # | header | question | options（label: description） |
|---|---|---|---|
| 1 | 確認の頻度 | Claude がファイルの編集やコマンドの実行をする前に、どのくらい確認を求めますか | 自動（おすすめ）: 読む・書く・コマンドは自動で進み、危ない操作だけ Claude 側の判定役が止める。手が止まらない ／ 編集だけ自動: ファイルの編集は自動、コマンドは毎回確認。慎重に始めたい人向け ／ 毎回確認: すべて確認する。慣れるまでの1週間だけこれにする人も多い ／ 今のまま: 変えない |
| 2 | 通知 | 作業が終わったときや許可待ちのとき、Mac の通知を鳴らしますか | 鳴らす（おすすめ）: 別の作業中でも気づけて、放置で止まる時間が減る。初回だけ macOS が通知の許可を求める ／ 鳴らさない: 画面を見ているときだけ分かる |
| 3 | 話し方 | Claude の話し方と、必ず確認してほしいことを決めます（全プロジェクトに適用される） | 日本語・丁寧（おすすめ）: です・ます調で結論から。削除・インストール・課金・外部送信は必ず確認してから ／ 日本語・フランク: くだけた言い方。確認してほしいことは同じ ／ 英語: 英語で答える。確認してほしいことは同じ ／ 決めない: 今は何も書かない |
| 4 | GitHub | GitHub（コードや文書を共有するサイト）を Claude から使いますか | 使う: 操作コマンド（gh）を入れ、ログインの手順を案内する。Claude が PR や Issue を読み書きできる ／ 今はしない: 後から /starter-kit:setup で足せる |

2回目（任意の項目）:

| # | header | question | options |
|---|---|---|---|
| 5 | ブラウザ操作 | Claude にブラウザを操作させますか（調べ物・フォーム入力・画面の確認） | Playwright（おすすめ）: 専用の Chrome 窓が開き、Claude が操作する。普段の Chrome とは別のプロファイルなので個人の履歴やログインは触らない。一度ログインしたサイトは次回も使える ／ Claude in Chrome 拡張: 普段使っている Chrome をそのまま Claude が操作する（ログイン済みのサイトをすぐ使える）。公式の拡張を入れて /chrome と打つだけ。Pro/Max のログインが要る ／ 両方 ／ 今は入れない |
| 6 | 追加の道具（複数可） | ほかに入れておくものを選んでください（multiSelect） | 公式ドキュメント MCP（おすすめ）: Claude Code の使い方を Claude 自身に聞けるようになる。認証不要・1分 ／ 文書変換: Word・PowerPoint・Excel・PDF を Claude が読めるようにする。約5分 ／ Google Workspace: Gmail・カレンダー・Drive・スプレッドシートを Claude が読み書きできる。Google Cloud の画面操作が要り約15分 ／ Slack: 3つの選び方の案内だけ（通知のみ／公式の Claude in Slack／自前の Bot） |
| 7 | 名前 | 変更の記録（git）に残す名前とメールアドレスを登録します（`git_identity` が `done` なら飛ばす） | 登録する: 「その他」に `名前 <メール>` の形で書く ／ 後で: 今は登録しない |

### 3. 答えを書き、計画を見せて確認する

答えを `answers_path` に Write で書く（JSON）。

| 質問 | 値 |
|---|---|
| 1 | `permission_mode`: 自動→`auto` ／ 編集だけ自動→`acceptEdits` ／ 毎回確認→`default` ／ 今のまま→`keep` |
| 2 | `notifications`: `true` / `false` |
| 3 | `persona`: 丁寧→`polite_ja` ／ フランク→`casual_ja` ／ 英語→`en` ／ 決めない→`skip` |
| 4 | `github`: 使う→`login` ／ 今はしない→`skip`（7で名前だけ登録するなら `identity_only`） |
| 5 | `browser`: `playwright` / `chrome` / `both` / `none` |
| 6 | `extras`: 選んだ分を `["docs_mcp","doc_tools","google","slack"]` から配列で |
| 7 | `git_name` / `git_email`（登録しないなら空文字） |
| 常に | `statusline`: `true`。`items.statusline.state` が `other`（別のステータスラインがある）のときだけ「置き換えますか」を聞き、置き換えるなら `"replace"` |

`plan --json` を実行し、`summary` を箇条書きで見せてから AskUserQuestion「この内容で進めてよいですか」（進める／直す／やめる）。
「直す」なら該当の質問だけ聞き直し、answers を書き直して plan からやり直す。

### 4. 入れる（`install_commands`）

`install_commands` を上から1つずつ Bash で実行する（`command` をそのまま・timeout 600000）。
実行前に「◯◯を入れます（約 N 分）」と1行伝える。失敗したら止めて、エラーの最後の数行を伝える。
`skipped` に「Homebrew が無い」があれば、README の「Homebrew」の節を案内して、そこまでで終える。

### 5. 書く（`apply`）

`apply --json` を実行する。`results` を1行ずつ伝える（`ok` 設定した／`unchanged` 変更なし／`skipped` 飛ばした理由／`failed` 失敗）。
`failed` があれば「完了」と言わず、内容を伝える。`backup` があれば「元の設定の控え: <パス>」を1行添える。

### 6. 人がやること（`manual_steps`）

`manual_steps` を番号付きで見せる。GitHub のログインは別のターミナルで行う（Claude の中からは対話のログインができない）。
Claude in Chrome 拡張は Chrome ウェブストアから入れる。Google は `docs/google-workspace.md` の手順書どおりに進める。

### 7. 最後に伝えること

```
Claude Code をいったん終了して、もう一度 claude で起動してください（ステータスライン・通知・MCP はそこから有効になります）。
いつでも /starter-kit:status で現状の表が出ます（うまくいかないときはこの表を貼って相談してください）。
最初の10分の使い方は /starter-kit:guide です。
```

## 守ること

- 聞くのは上の7問だけ。仕様・ファイル名・方式は聞かない。迷ったら「おすすめ」を既定にして進める
- 答えを得るまで `apply` に進まない。計画の確認（3）を飛ばさない
- インストールは `install_commands` にあるコマンドだけを、1つずつ、そのまま実行する。それ以外を勝手に入れない
- 鍵・トークン・パスワードは聞かない・表示しない。ログインはすべて人がブラウザで行う
- 既存の設定は上書きしない（`unchanged` / `skipped` の理由をそのまま伝える）。元に戻す必要があれば `backup` の控えを案内する
