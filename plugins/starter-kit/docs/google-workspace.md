# Google Workspace（gog）

`gog`（＝Gmail・カレンダー・Drive・Docs・スプレッドシートをターミナルから扱うコマンド。https://gogcli.sh）を入れると、Claude がメールの下書き・予定の確認・シートの読み書きをできるようになる。
所要 15 分。Google Cloud（Google の開発者向け管理画面）での操作があり、初期セットアップの中で一番手間がかかる。急がなければ後回しでよい。

## 1. 入れる

```bash
brew install openclaw/tap/gogcli
gog --version
```

（macOS 15 より前の Mac では配布済みのバイナリが使えず、時間がかかることがある）

## 2. Google Cloud で「鍵の入れ物」を作る（ブラウザ）

1. https://console.cloud.google.com/ を開き、右上のプロジェクト選択から「新しいプロジェクト」を作る（名前は何でもよい。例: `gog`）
2. 左メニュー「API とサービス → ライブラリ」で、使う API を有効にする: **Gmail API・Google Calendar API・Google Drive API・Google Docs API・Google Sheets API**（検索して「有効にする」を5回）
3. 「API とサービス → OAuth 同意画面」で、ユーザーの種類を **外部** にし、アプリ名とメールアドレスを入れて保存する
4. 同じ画面の「対象（Audience）」で **アプリを公開（Publish app）→ 確認** を押す（審査には出ない。「テスト」のままだと7日ごとにログインし直しになる）
5. 「API とサービス → 認証情報 → 認証情報を作成 → OAuth クライアント ID」で、種類を **デスクトップ アプリ** にして作成し、**JSON をダウンロード**する（`~/Downloads/client_secret_….json`）

## 3. gog に登録してログインする（ターミナル）

```bash
gog auth credentials ~/Downloads/client_secret_*.json
gog auth add あなたのメールアドレス --services gmail,calendar,drive,docs,sheets
gog auth list --check
```

`gog auth add` でブラウザが開くので、Google アカウントでログインして許可する。
「このアプリは Google で確認されていません」と出たら「詳細 → （アプリ名）に移動」で進む（自分で作ったアプリなので問題ない）。

## 4. 使い方の例

```
今日の予定を教えて（gog を使って）
〇〇さんからの最新メールを要約して
この表をスプレッドシート「集計」に書き込んで
```

- 鍵（ダウンロードした JSON とトークン）は `~/Library/Application Support/gogcli/` に入る。他人に渡さない
- 動かないとき: `gog auth doctor --check`。ログインし直すときは `gog auth add` を同じ `--services` で再実行する
