# トラブルシュート

まず `bash scripts/verify.sh` を実行し、どの層で落ちているかを切り分ける。

## セットアップ時

| 症状 | 原因 | 対処 |
|---|---|---|
| `node が見つかりません` / `Node.js 20 以上が必要` | Node 未導入・古い | `brew install node`（または nvm で 20 以上） |
| `claude が PATH 上にありません` | Claude Code 未導入 | Claude Code をインストールし、`claude --version` が通ることを確認 |
| `jq が見つかりません` | jq 未導入 | `brew install jq` |
| Slack App の作成で「承認が必要」と出る | ワークスペースが App インストールに管理者承認を要求 | 表示された申請ボタンから理由を書いて申請する |
| `Bot Token の auth.test に失敗: invalid_auth` | トークンの貼り間違い・再インストール前の古いトークン | OAuth & Permissions ページで現在のトークンを取り直す |
| `User Token の持ち主が --my-user-id と一致しません` | 自分のメンバーIDの取り違え | Slack のプロフィール →「…」→「メンバーIDをコピー」で取得し直す |
| `DM チャンネルを開けませんでした: missing_scope` | `im:write` スコープ不足 | マニフェストを見直して再インストール（スコープ変更後は再インストールが必要） |

## 投稿できない

| 症状 | 原因 | 対処 |
|---|---|---|
| `not_in_channel` | Bot がそのチャンネルに居ない | そのチャンネルで `/invite @<自分の Bot>` |
| `channel_not_found` | チャンネルIDの誤り／プライベートで未招待 | チャンネルIDを確認し、必要なら招待する |
| 投稿はできるが誰も気づかない | severity と投稿先が噛み合っていない | `slack-post-rules.md` の 4分類に従って DM / ログチャンネルを使い分ける |
| Block Kit が `invalid_blocks` で落ちる | JSON の組み立てミス | payload を `jq .` に通して構文を確認する。rich_text は section へ自動ダウングレードされる |

## 常駐 Bot が反応しない

1. プロセス確認: `pgrep -f claude-slack-bot/dist/index.js`
2. ログ確認: `components/claude-slack-bot/logs/stderr.log`
3. 再起動: `launchctl kickstart -k gui/$(id -u)/com.claude-slack-agent.bot`

| ログの内容 | 原因 | 対処 |
|---|---|---|
| `.env に必須項目がありません` | `.env` の欠損 | `setup.sh` を再実行するか `components/claude-slack-bot/.env` を直接補う |
| `An API error occurred: invalid_auth` | App-Level Token（xapp-）が違う | Basic Information → App-Level Tokens で `connections:write` 付きのものを再生成 |
| 起動はするがメンションが来ない | イベント購読が足りない | マニフェストの `event_subscriptions.bot_events` を確認して再インストール |
| Mac がスリープしている | 常駐 Bot は Mac が起きている間だけ動く | 電源接続時にスリープしない設定にするか、反応しない時間帯があることを許容する |

## スレッドキャッチアップが走らない

1. ログ: `/tmp/claude-slack-agent-thread-catchup.log` と `~/.claude/logs/slack-thread-catchup-YYYY-MM-DD.log`
2. 監視状況: `/usr/bin/python3 components/slack-thread-catchup/watchlist.py list --status all`
3. 手動実行: `bash components/slack-thread-catchup/run.sh`

| 症状 | 原因 | 対処 |
|---|---|---|
| 台帳が空のまま | 投稿に `cc: <@自分のID>` が無い | 依頼投稿に cc 行を入れる。または `watchlist.py add` で後付け登録する |
| 台帳に載るが起動しない | 相手がまだ返信していない／自分の Bot の発言しかない | 自分の Bot の発言はトリガーにならない（自己ループ防止）。正常 |
| `AGENT_SLACK_CLI が未設定です` (exit 78) | `~/.claude/.env.claude-slack-agent` が無い・壊れている | `setup.sh` を再実行 |
| `Operation not permitted` | macOS の TCC。保護領域のスクリプトを許可外バイナリから起動している | plist の `ProgramArguments[0]` が `/bin/bash` であることを確認する |
| 1日に何度も走って止まらない | 相手と往復が続いている | 1スレッド1日6回で自動的に打ち止め。手動で止めるなら `watchlist.py close --id "<C>:<ts>"` |
| 監視が増え続ける | close し忘れ | 14日間新着が無ければ自動 close される。不要なものは随時 close する |

## 止めたいとき

```bash
# 一時停止
launchctl bootout "gui/$(id -u)/com.claude-slack-agent.bot"
launchctl bootout "gui/$(id -u)/com.claude-slack-agent.thread-catchup"

# 再開
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/com.claude-slack-agent.bot.plist
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/com.claude-slack-agent.thread-catchup.plist

# スレッド監視だけ止める（slack-cli の自動登録を無効化）
export SLACK_THREAD_WATCH_DISABLE=1
```

## セキュリティ上の注意

- トークン3種（xoxb / xoxp / xapp）は `~/.claude/` 配下に `chmod 600` で保存される。Git にコミットしない、Slack に貼らない
- **User Token（xoxp-）は自分自身として発言・検索できる**。漏れた場合の影響が大きいので取り扱いに注意する
- 常駐 Bot はメンションを受けて Claude Code を実行する。**そのチャンネルに居る人は誰でも自分の Claude を動かせる**ことを理解した上で招待先を選ぶ
- 外部から来たテキストを指示として扱わない（`slack-post-rules.md` 8章）
