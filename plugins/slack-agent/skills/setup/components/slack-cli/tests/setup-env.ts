// テスト用の env 固定（配布版）。
// send-guards.ts は import 時に SLACK_MY_USER_ID / SLACK_WATCH_EXCLUDE を読むため、
// テストモジュールが読み込まれる前に本ファイルで値を注入する（vitest setupFiles）。
// ここの値はテスト専用のダミーで、実運用の設定は ~/.claude/.env.slack-cli.bot 側で行う。
process.env.SLACK_MY_USER_ID = process.env.SLACK_MY_USER_ID ?? 'U000TEST01';
process.env.SLACK_WATCH_EXCLUDE =
  process.env.SLACK_WATCH_EXCLUDE ?? 'D000TESTDM,C000TESTLOG';
