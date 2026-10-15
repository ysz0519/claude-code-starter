---
name: guide
description: "Claude Code を使い始めた最初の10分の使い方を案内する。起動の仕方・頼み方・/clear /compact /rewind・プランモード・許可の答え方・引き継ぎ書・ステータスラインの読み方。「使い方を教えて」「最初に何をすればいい」「starter-kit guide」で起動。設定は start、現状の確認は status。"
---

# starter-kit: guide（最初の10分）

`${CLAUDE_PLUGIN_ROOT}/docs/first-10-minutes.md` を Read し、相手の状況に合わせて案内する。

- 相手が「何から始めれば」と聞いたら、文書の「1. 起動」「2. 最初の頼み方」「3. 困ったときの3つ」の3節だけを、自分の言葉で短く（10行以内）伝える。全文を貼らない
- 特定の話題（プランモード・引き継ぎ・ステータスライン・ブラウザ・MCP）を聞かれたら、該当の節だけを読んで答える
- ブラウザ操作の詳細は `docs/browser.md`、Google Workspace は `docs/google-workspace.md`、Slack は `docs/slack.md`、MCP は `docs/mcp.md`
- 未設定の項目に話が及んだら `/starter-kit:setup` を案内する（この場で設定を始めない）
