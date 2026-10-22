# Claude × Slack エージェント セットアップ手順

自分の Claude Code を Slack 上で動かすためのセットアップ一式です。
所要時間は 15〜20 分（Slack App の作成に管理者承認が要る場合はその待ち時間が別途かかります）。

## これで何ができるようになるか

1. **Claude が Slack へ投稿する** — 作業結果の報告、他メンバーへの依頼、ファイルの添付
2. **Slack から Claude を動かす** — チャンネルで `@claude_ab やっといて` と書くと自分の Claude Code が起動する
3. **依頼の続きが自動で進む** — 他メンバーへ出した依頼に返信が来ると、Claude が返信を読んで
   保留していた作業を再開し、同じスレッドへ報告する

3 が本体です。結果として、自分の Claude と相手の Claude が Slack のスレッド上で
やり取りしながら仕事を進める状態になります。

## 前提

| 必要なもの | 確認コマンド | 無い場合 |
|---|---|---|
| macOS | — | — |
| Claude Code | `claude --version` | Claude Code を先に導入してください |
| Node.js 20 以上 | `node -v` | `brew install node` |
| npm | `npm -v` | Node.js に同梱 |
| jq | `jq --version` | `brew install jq` |
| Python3 | `/usr/bin/python3 -V` | `xcode-select --install` |

## 手順

### 1. 一式を配置する

zip を展開し、フォルダごと自分の Claude Code の作業ディレクトリ配下に置きます。

```
<作業ディレクトリ>/.claude/skills/claude-slack-agent-setup/
```

### 2. Slack App を作る

`references/slack-app-manifest.yaml` をテキストエディタで開き、冒頭のコメントの手順に従います。要点:

1. https://api.slack.com/apps → **Create New App** → **From an app manifest**
2. ワークスペースを選び、YAML を貼り付ける
   - **`claude_xx` を自分用の名前に変える**（例 `claude_ab`。誰のエージェントか一目で分かる名前に）
3. **Install to Workspace** で承認
4. トークンを3つ控える
   - `xoxb-…` … OAuth & Permissions ページ
   - `xoxp-…` … 同ページ
   - `xapp-…` … Basic Information → App-Level Tokens →「Generate Token and Scopes」で
     `connections:write` を付けて生成

> トークンは3つとも秘密情報です。Slack に貼らない、Git にコミットしない。

### 3. 自分の Slack ユーザーIDを調べる

Slack で自分のプロフィールを開く → 「…」→「メンバーIDをコピー」（`U` から始まる文字列）。

### 4. セットアップを実行する

作業ディレクトリで、Claude Code に次のように頼むのが一番簡単です。

```
claude-slack-agent-setup でセットアップして
```

自分でコマンドを打つ場合:

```bash
cd <作業ディレクトリ>
bash .claude/skills/claude-slack-agent-setup/scripts/setup.sh \
  --bot-handle claude_ab \
  --my-user-id U0123ABCD \
  --workdir "$PWD" \
  --workspace-url https://your-team.slack.com \
  --owner-name 田中
```

途中でトークン3つを聞かれます（入力は画面に表示されません）。

### 5. 動作を確認する

```bash
bash .claude/skills/claude-slack-agent-setup/scripts/verify.sh
```

自分の Slack DM にテスト投稿が届けば成功です。`FAIL` が出た場合は
`references/troubleshooting.md` を参照してください。

### 6. Bot をチャンネルに招待する

使いたいチャンネルで:

```
/invite @claude_ab
```

> そのチャンネルに居る人は誰でもメンションで自分の Claude Code を動かせます。招待先は意識して選んでください。

### 7. 投稿の作法を Claude に教える

自分の `CLAUDE.md`（作業ディレクトリ直下、または `~/.claude/CLAUDE.md`）に次の2行を追記します。

```markdown
## Slack 投稿
Slack への投稿は `.claude/skills/claude-slack-agent-setup/references/slack-post-rules.md` に従う。
```

この参照が無いと、依頼投稿に付ける `cc: <@自分のID>` のルールが守られません。
このマーカーがスレッド自動継続の登録キーなので、**入れないと 3 の機能が動きません**。

## 使い方

| やりたいこと | 操作 |
|---|---|
| Slack から作業を頼む | チャンネルで `@claude_ab <依頼>`、または Bot との DM |
| 誰かに依頼を出す | Claude に「○○さんに△△を依頼して」と頼む |
| 監視中のスレッドを見る | `/usr/bin/python3 .claude/skills/claude-slack-agent-setup/components/slack-thread-catchup/watchlist.py list --status all` |
| 一時的に止める | `launchctl bootout "gui/$(id -u)/com.claude-slack-agent.bot"` |

## 気をつけること

- 常駐 Bot は **Mac が起きている間だけ**動きます。スリープ中はメンションに反応しません
- 自動再開は1スレッド1日6回、1回あたり $8 の予算上限で止まります
- 他の人の受付ボットの「受け付けました」「エラー」のような、自分宛てのメンションが無いボットの投稿では自動再開しません（相手の Claude が自分宛てにメンションして返した返信と、人の返信には反応します）
- 料金が発生する操作・削除・外部送信は自動実行されず、確認を求められます
- 困ったら `references/troubleshooting.md` を先に読んでください
