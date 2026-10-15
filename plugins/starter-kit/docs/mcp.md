# MCP（外部サービスとの接続口）

MCP（Model Context Protocol）は、Claude に「道具」を足す仕組み。接続口を1つ登録すると、Claude がそのサービスを読み書きできるようになる（例: ブラウザ・公式ドキュメント・Notion・社内の DB）。

## 登録の形

```bash
# HTTP で提供されるもの（URL を渡す）
claude mcp add --transport http -s user <名前> <URL>

# 手元でプログラムを動かすもの（コマンドを渡す。-- の後ろがそのコマンド）
claude mcp add -s user <名前> -- npx -y <パッケージ名>

claude mcp list            # 登録と接続状態の一覧
claude mcp get <名前>       # 1つの詳細
claude mcp remove -s user <名前>
```

- `-s user` を付けると、どのフォルダで起動しても使える（付けないと、そのフォルダだけ）
- 認証が要るものは、Claude Code の中で `/mcp` と打って、そのサービスの行から「Authenticate」を選ぶ
- 登録を変えたら Claude Code を起動し直す

## 初期セットアップが登録するもの

| 名前 | 何ができるか |
|---|---|
| `playwright` | ブラウザ操作（`docs/browser.md`） |
| `claude-docs` | Claude Code の公式ドキュメントを Claude 自身が引く。「hooks の書き方を公式ドキュメントで調べて」のように頼める。認証不要 |

## 足すときの注意

- MCP は「あなたの権限で動くプログラム」。公式か、作者がはっきりしているものだけを入れる。名前が似た偽物に注意し、`npx` に渡すパッケージ名は公式ページからコピーする
- 鍵（API キー）が要るものは、`-e KEY=値` で渡すより、`~/.claude/.env.<サービス名>` のようなファイルに書いて `chmod 600` にし、そのファイルを読む設定にするほうが安全。`.env*` は初期セットアップの安全弁で Claude が読めないようにしてある
- 使わなくなったら `claude mcp remove` で外す（接続口が多いほど Claude の文脈を消費する）
