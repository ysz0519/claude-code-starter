#!/bin/bash
# claude-slack-agent-setup — 疎通確認
#
#   bash scripts/verify.sh            # 全項目
#   bash scripts/verify.sh --no-post  # Slack へのテスト投稿はしない
#
# 「設定した」と「動いている」は別物なので、実際に API を叩いて確認する。
set -uo pipefail

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPONENTS_DIR="$SKILL_DIR/components"
AGENT_ENV="${CLAUDE_SLACK_AGENT_ENV:-$HOME/.claude/.env.claude-slack-agent}"
DO_POST=1
[ "${1:-}" = "--no-post" ] && DO_POST=0

PASS=0; FAIL=0
ok()   { echo "  ✅ $*"; PASS=$((PASS+1)); }
ng()   { echo "  ❌ $*"; FAIL=$((FAIL+1)); }
head_() { echo; echo "▶ $*"; }

head_ "設定ファイル"
if [ -r "$AGENT_ENV" ]; then
  # shellcheck disable=SC1090
  set -a; source "$AGENT_ENV"; set +a
  ok "$AGENT_ENV を読み込みました"
else
  ng "$AGENT_ENV がありません（setup.sh を実行してください）"; exit 1
fi
for k in SLACK_MY_USER_ID SLACK_BOT_HANDLE AGENT_DM_CHANNEL AGENT_WORKDIR AGENT_SLACK_CLI; do
  if [ -n "${!k:-}" ]; then ok "$k=${!k}"; else ng "$k が未設定"; fi
done
[ -d "${AGENT_WORKDIR:-/nonexistent}" ] && ok "作業ディレクトリが存在" || ng "作業ディレクトリが存在しない: ${AGENT_WORKDIR:-}"

head_ "トークン"
BOT_TOKEN="$(grep '^SLACK_BOT_TOKEN=' "$HOME/.claude/.env.slack-cli.bot" 2>/dev/null | cut -d= -f2-)"
if [ -n "$BOT_TOKEN" ]; then
  R="$(curl -s -H "Authorization: Bearer $BOT_TOKEN" https://slack.com/api/auth.test)"
  [ "$(echo "$R" | jq -r .ok)" = "true" ] \
    && ok "Bot Token: $(echo "$R" | jq -r .user) ($(echo "$R" | jq -r .user_id))" \
    || ng "Bot Token: $(echo "$R" | jq -r .error)"
else
  ng "~/.claude/.env.slack-cli.bot に SLACK_BOT_TOKEN がありません"
fi
USER_TOKEN="$(grep '^SLACK_USER_TOKEN=' "$HOME/.claude/.env.slack-cli.user" 2>/dev/null | cut -d= -f2-)"
if [ -n "$USER_TOKEN" ]; then
  R="$(curl -s -H "Authorization: Bearer $USER_TOKEN" https://slack.com/api/auth.test)"
  [ "$(echo "$R" | jq -r .ok)" = "true" ] \
    && ok "User Token: $(echo "$R" | jq -r .user)" \
    || ng "User Token: $(echo "$R" | jq -r .error)"
else
  ng "~/.claude/.env.slack-cli.user に SLACK_USER_TOKEN がありません"
fi

head_ "slack-cli"
if [ -x "$AGENT_SLACK_CLI" ] && "$AGENT_SLACK_CLI" --version >/dev/null 2>&1; then
  ok "slack-cli 起動 OK（$("$AGENT_SLACK_CLI" --version)）"
  if [ "$DO_POST" -eq 1 ]; then
    TMP="$(mktemp -t verify-post.XXXXXX.json)"
    cat > "$TMP" <<JSON
{"blocks":[{"type":"section","text":{"type":"mrkdwn","text":"[claude-slack-agent-setup]\n🟢 セットアップ疎通確認\n結論: slack-cli から自分の DM へ投稿できています\n理由: verify.sh がこのメッセージを送信しました"}}],"text":"[claude-slack-agent-setup] セットアップ疎通確認"}
JSON
    if "$AGENT_SLACK_CLI" send --channel "$AGENT_DM_CHANNEL" --json-file "$TMP" >/dev/null 2>&1; then
      ok "自分の DM へテスト投稿しました（Slack を確認してください）"
    else
      ng "テスト投稿に失敗（$AGENT_SLACK_CLI send のエラー出力を確認）"
    fi
    rm -f "$TMP"
  fi
else
  ng "slack-cli が実行できません: ${AGENT_SLACK_CLI}（setup.sh --components cli を実行）"
fi

head_ "常駐 Bot（claude-slack-bot）"
if launchctl print "gui/$(id -u)/com.claude-slack-agent.bot" >/dev/null 2>&1; then
  ok "launchd に登録済み"
  if pgrep -f "claude-slack-bot/dist/index.js" >/dev/null; then
    ok "プロセス稼働中"
  else
    ng "プロセスが起動していません（logs/stderr.log を確認）"
  fi
else
  echo "  － 未導入（--components に bot を含めていない場合は正常）"
fi

head_ "スレッド返信キャッチアップ"
if launchctl print "gui/$(id -u)/com.claude-slack-agent.thread-catchup" >/dev/null 2>&1; then
  ok "launchd に登録済み（5分毎）"
  if /usr/bin/python3 "$COMPONENTS_DIR/slack-thread-catchup/watchlist.py" list --status all >/dev/null 2>&1; then
    ok "監視台帳 CLI 動作 OK"
  else
    ng "監視台帳 CLI が動きません"
  fi
else
  echo "  － 未導入（--components に catchup を含めていない場合は正常）"
fi

echo
echo "================ 結果: PASS=$PASS FAIL=$FAIL ================"
[ "$FAIL" -eq 0 ] || exit 1
