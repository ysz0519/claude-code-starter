---
name: status
description: "Claude Code の初期セットアップの現状表（設定済み・未設定・一部だけ）を1画面で出す。「設定の状態を見せて」「セットアップの確認」「starter-kit status」で起動。問い合わせのときはこの表を貼ってもらう。設定を進めるのは start。"
---

# starter-kit: status（現状表）

```bash
/usr/bin/python3 "${CLAUDE_PLUGIN_ROOT}/scripts/setup.py" status
```

出力をそのままコードブロックで見せる（要約しない。問い合わせ対応に使う表なので、全行が要る）。
記号の意味を1行添える: ✅ 設定済み ／ 🟡 一部だけ ／ ⬜ 未設定 ／ 🔷 別の設定がある ／ ℹ️ 案内のみ。

- ⬜ か 🟡 が残っていれば「`/starter-kit:setup` で続きから設定できます」と1行
- `❌ settings.json` の行があれば、設定ファイルが壊れている。直す前に `~/.claude/settings.json.bak-*` の控えがあるかを見る
- `注意:` の行はそのまま伝える（未ログイン・Homebrew なし・Terminal.app）
