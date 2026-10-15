# ブラウザ操作

Claude にブラウザを使わせる方法は2つある。初期セットアップは **Playwright を主**にし、Claude in Chrome 拡張を副にしている。

| | Playwright MCP（主） | Claude in Chrome 拡張（副） |
|---|---|---|
| 何が起きるか | 専用の Chrome の窓が開き、Claude がそこで操作する | 普段使っている Chrome のタブを Claude が開いて操作する |
| ログイン | 専用のプロファイル（`~/.claude/playwright-profile`）に残る。一度ログインしたサイトは次回も使える | 普段の Chrome のログインがそのまま使える |
| 個人の履歴・Cookie | 触らない（別プロファイル） | 共有する（Claude がログイン済みのサイトを何でも見られる） |
| 要るもの | Node.js・Google Chrome | Chrome 拡張（1.0.36 以降）・claude.ai のログイン（Pro/Max/Team/Enterprise） |
| 向くこと | 調べ物・一覧の収集・自分のアカウントを使わない作業・定型のフォーム入力 | ログイン済みの社内サービス・Google Docs・Gmail の画面操作 |

## Playwright（主）

セットアップが MCP『playwright』を登録している（`claude mcp get playwright` で確認）。使い方は、頼み方に「ブラウザで」と添えるだけ。

```
ブラウザで https://example.com を開いて、料金表を表にして
```

- 初回は Chrome の窓が開く。ログインが要るサイトは、その窓で自分でログインする（Claude にパスワードを渡さない）。ログインは専用プロファイルに残る
- 画面の無い（headless）動かし方は、初心者には勧めない。本人確認の画面・使い捨てのリンクを Claude が先に開いて消費してしまうことがある
- 許可を毎回聞かれて煩わしいときは、確認の頻度を「自動」にするか、聞かれたときに「このセッションでは今後聞かない」を選ぶ
- 動かないとき: `claude mcp list` で `playwright` が `Connected` か見る。`node -v` が出なければ Node.js が無い（`brew install node`）。Chrome が無ければ入れる
- 登録の中身: `npx -y @playwright/mcp@<版> --browser chrome --user-data-dir ~/.claude/playwright-profile --output-dir ~/.claude/playwright-output`。版は `/starter-kit:setup` を再実行すると新しいものに揃う

## Claude in Chrome 拡張（副）

1. Chrome ウェブストアで「Claude in Chrome」を入れ、Claude（Pro/Max）でログインする: https://chromewebstore.google.com/detail/claude/fcoeoabgfenejglbffodgkkbkcdhcgfn
2. Claude Code で `/chrome` と打ち、「Enabled by default」を選ぶ。`Status: Enabled` と `Extension: Installed` が出れば接続できている
3. 頼み方は Playwright と同じ。Claude がタブを開いて操作する（ログイン画面や CAPTCHA に当たると止まって、あなたに任せる）

注意: API キーや長期トークンでログインした Claude Code では使えない（`claude auth status` で `claude.ai` と出るログインが要る）。
つながらないときは `/chrome` → 「Reconnect extension」、それでもだめなら Chrome と Claude Code を両方再起動する。

## 付録: chrome-devtools-mcp（勧めない）

Chrome をデバッグポート（`--remote-debugging-port=9222`）付きで起動し、`chrome-devtools-mcp` から操作する方式もある。
ログイン済みの普段の Chrome を外部から操作できる状態にするため、初心者には勧めない。どうしても要るときだけ、公式 README（https://github.com/ChromeDevTools/chrome-devtools-mcp）に従う。
