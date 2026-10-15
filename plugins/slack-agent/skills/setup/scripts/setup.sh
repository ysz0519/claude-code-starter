#!/bin/bash
# claude-slack-agent-setup — Slack × Claude Code 連携のセットアップ（macOS）
#
# 3つのコンポーネントを導入する:
#   cli     … slack-cli（Claude Code から Slack へ Block Kit 投稿する CLI）
#   bot     … claude-slack-bot（Slack のメンション/DM で Claude Code を起動する常駐 Bot）
#   catchup … slack-thread-catchup（依頼スレッドの返信を検知して作業を自動再開する launchd ポーラー）
#
# 使い方:
#   bash scripts/setup.sh                       # 対話（未指定項目を聞く）
#   bash scripts/setup.sh --bot-handle claude_ab --my-user-id U0123 --workdir ~/work --workspace-url https://xxx.slack.com
#   bash scripts/setup.sh --components cli,catchup
#
# トークンは対話入力（画面に出ない）か、環境変数 SLACK_BOT_TOKEN / SLACK_USER_TOKEN / SLACK_APP_TOKEN で渡す。
set -euo pipefail

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPONENTS_DIR="$SKILL_DIR/components"
CLAUDE_HOME="$HOME/.claude"
AGENT_ENV="$CLAUDE_HOME/.env.claude-slack-agent"
BOT_ENV="$CLAUDE_HOME/.env.slack-cli.bot"
USER_ENV="$CLAUDE_HOME/.env.slack-cli.user"
LAUNCH_AGENTS="$HOME/Library/LaunchAgents"

BOT_HANDLE=""; MY_USER_ID=""; WORKDIR=""; WORKSPACE_URL=""; OPS_LOG_CHANNEL=""; OWNER_NAME=""
COMPONENTS="cli,bot,catchup"
DM_CHANNEL=""

die()  { echo "ERROR: $*" >&2; exit 1; }
info() { echo "  $*"; }
step() { echo; echo "▶ $*"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --bot-handle)    BOT_HANDLE="$2"; shift 2 ;;
    --my-user-id)    MY_USER_ID="$2"; shift 2 ;;
    --workdir)       WORKDIR="$2"; shift 2 ;;
    --workspace-url) WORKSPACE_URL="$2"; shift 2 ;;
    --ops-log)       OPS_LOG_CHANNEL="$2"; shift 2 ;;
    --owner-name)    OWNER_NAME="$2"; shift 2 ;;
    --components)    COMPONENTS="$2"; shift 2 ;;
    -h|--help)       sed -n '2,20p' "$0"; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
done

want() { case ",$COMPONENTS," in *",$1,"*) return 0 ;; *) return 1 ;; esac }

ask() { # ask VAR "プロンプト" ["既定値"]
  local __var="$1" __prompt="$2" __default="${3:-}" __cur __in
  eval "__cur=\${$__var}"
  [ -n "$__cur" ] && return 0
  if [ ! -t 0 ]; then die "$__var が未指定です（非対話実行ではフラグで渡してください）"; fi
  if [ -n "$__default" ]; then
    read -r -p "$__prompt [$__default]: " __in || true
    __in="${__in:-$__default}"
  else
    read -r -p "$__prompt: " __in || true
  fi
  [ -n "$__in" ] || die "$__var は必須です"
  eval "$__var=\$__in"
}

ask_secret() { # ask_secret VAR "プロンプト"
  local __var="$1" __prompt="$2" __cur __in
  eval "__cur=\${$__var:-}"
  [ -n "$__cur" ] && return 0
  [ -t 0 ] || die "$__var が未設定です（非対話実行では環境変数で渡してください）"
  read -r -s -p "$__prompt: " __in || true; echo
  [ -n "$__in" ] || die "$__var は必須です"
  eval "$__var=\$__in"
}

# 値をシングルクォートで包み、埋め込みシングルクォートを '\'' へ退避する。
# 生成した env ファイルは bash から source されるため、空白・#・$()・` を含む値でも
# 壊れず、かつコマンド実行にならないようにする（Codex 指摘 HIGH・2026-08-12）。
shq() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }

write_env_file() { # write_env_file PATH CONTENT
  local path="$1" content="$2"
  mkdir -p "$(dirname "$path")"
  if [ -f "$path" ]; then
    cp "$path" "$path.bak-$(date +%Y%m%d-%H%M%S)"
    info "既存ファイルを退避: $path.bak-*"
  fi
  printf '%s' "$content" > "$path"
  chmod 600 "$path"
  info "書き込み: $path (600)"
}

# ---------------------------------------------------------------- preflight
step "前提コマンドの確認"
command -v node >/dev/null || die "node が見つかりません（Node.js 20 以上が必要）"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] || die "Node.js 20 以上が必要です（現在 v$(node -p 'process.versions.node')）"
command -v npm >/dev/null || die "npm が見つかりません"
command -v jq  >/dev/null || die "jq が見つかりません（brew install jq）"
[ -x /usr/bin/python3 ] || die "/usr/bin/python3 が見つかりません（xcode-select --install）"
command -v claude >/dev/null || die "claude（Claude Code CLI）が PATH 上にありません"
info "node $(node -v) / npm $(npm -v) / python3 $(/usr/bin/python3 -V 2>&1 | awk '{print $2}') / claude OK"

# ---------------------------------------------------------------- config
step "設定"
ask BOT_HANDLE    "Slack の Bot 表示名（@ を除く。例 claude_ab）"
ask MY_USER_ID    "自分の Slack ユーザーID（プロフィール → メンバーIDをコピー。例 U0123ABCD）"
ask WORKDIR       "Claude Code の作業ディレクトリ（絶対パス）" "$HOME"
ask WORKSPACE_URL "Slack ワークスペースの URL（例 https://your-team.slack.com）"
ask OWNER_NAME    "Bot の持ち主の呼び名（システムプロンプトで使う）" "$(id -F 2>/dev/null || whoami)"

WORKDIR="${WORKDIR/#\~/$HOME}"
[ -d "$WORKDIR" ] || die "作業ディレクトリが存在しません: $WORKDIR"
WORKDIR="$(cd "$WORKDIR" && pwd)"
WORKSPACE_URL="${WORKSPACE_URL%/}"
case "$MY_USER_ID" in U*) : ;; *) die "ユーザーIDは U で始まります: $MY_USER_ID" ;; esac

# 生成する env は bash（source）と dotenv の両方から読まれる。両者でクォート解釈が
# 一致しない引用符を最初から弾く（空白は許可。O'Brien のような値だけ手直しが要る）。
for v in BOT_HANDLE MY_USER_ID WORKDIR WORKSPACE_URL OWNER_NAME OPS_LOG_CHANNEL; do
  case "${!v}" in
    *\'*|*\"*) die "$v に引用符（' \"）は使えません: ${!v}" ;;
  esac
done
case "$BOT_HANDLE" in *[!a-zA-Z0-9_.-]*) die "Bot 表示名に使えるのは英数字と _ . - です: $BOT_HANDLE" ;; esac
case "$MY_USER_ID" in *[!A-Z0-9]*) die "ユーザーIDの形式が不正です: $MY_USER_ID" ;; esac
if [ -n "$OPS_LOG_CHANNEL" ]; then
  case "$OPS_LOG_CHANNEL" in C*) : ;; *) die "ログ用チャンネルIDは C で始まります: $OPS_LOG_CHANNEL" ;; esac
fi

step "Slack トークンの入力（画面には表示されません）"
echo "  Slack App の管理画面から取得します。取得箇所は references/slack-app-manifest.yaml の手順を参照。"
ask_secret SLACK_BOT_TOKEN  "Bot User OAuth Token (xoxb-...)"
ask_secret SLACK_USER_TOKEN "User OAuth Token (xoxp-...)"
if want bot; then
  ask_secret SLACK_APP_TOKEN "App-Level Token (xapp-... / Socket Mode 用)"
fi
case "$SLACK_BOT_TOKEN"  in xoxb-*) : ;; *) die "Bot Token は xoxb- で始まります" ;; esac
case "$SLACK_USER_TOKEN" in xoxp-*) : ;; *) die "User Token は xoxp- で始まります" ;; esac
if want bot; then
  case "$SLACK_APP_TOKEN" in xapp-*) : ;; *) die "App Token は xapp- で始まります" ;; esac
fi

step "トークンの疎通確認"
AUTH="$(curl -s -H "Authorization: Bearer $SLACK_BOT_TOKEN" https://slack.com/api/auth.test)"
[ "$(echo "$AUTH" | jq -r .ok)" = "true" ] || die "Bot Token の auth.test に失敗: $(echo "$AUTH" | jq -r .error)"
BOT_USER_ID="$(echo "$AUTH" | jq -r .user_id)"
info "Bot として認証成功: $(echo "$AUTH" | jq -r .user) ($BOT_USER_ID)"
UAUTH="$(curl -s -H "Authorization: Bearer $SLACK_USER_TOKEN" https://slack.com/api/auth.test)"
[ "$(echo "$UAUTH" | jq -r .ok)" = "true" ] || die "User Token の auth.test に失敗: $(echo "$UAUTH" | jq -r .error)"
UAUTH_UID="$(echo "$UAUTH" | jq -r .user_id)"
[ "$UAUTH_UID" = "$MY_USER_ID" ] || die "User Token の持ち主（${UAUTH_UID}）が --my-user-id（${MY_USER_ID}）と一致しません"
info "User として認証成功: $(echo "$UAUTH" | jq -r .user) ($UAUTH_UID)"

step "自分宛 DM チャンネルの解決"
DM="$(curl -s -H "Authorization: Bearer $SLACK_BOT_TOKEN" -d "users=$MY_USER_ID" https://slack.com/api/conversations.open)"
if [ "$(echo "$DM" | jq -r .ok)" = "true" ]; then
  DM_CHANNEL="$(echo "$DM" | jq -r .channel.id)"
  info "Bot ↔ 自分の DM: $DM_CHANNEL"
else
  die "DM チャンネルを開けませんでした: $(echo "$DM" | jq -r .error)（スコープ im:write を確認してください）"
fi

# ---------------------------------------------------------------- env files
step "設定ファイルの生成"
WATCH_EXCLUDE="$DM_CHANNEL"
[ -n "$OPS_LOG_CHANNEL" ] && WATCH_EXCLUDE="$DM_CHANNEL,$OPS_LOG_CHANNEL"

write_env_file "$BOT_ENV"  "SLACK_BOT_TOKEN=$(shq "$SLACK_BOT_TOKEN")"$'\n'
write_env_file "$USER_ENV" "SLACK_USER_TOKEN=$(shq "$SLACK_USER_TOKEN")"$'\n'

write_env_file "$AGENT_ENV" "# claude-slack-agent 共通設定（setup.sh が生成）
# slack-cli / slack-thread-catchup の両方がここを読む。
# 値はシングルクォート済み。手で編集する場合もクォートを外さないこと。
SLACK_MY_USER_ID=$(shq "$MY_USER_ID")
SLACK_BOT_HANDLE=$(shq "$BOT_HANDLE")
SLACK_WORKSPACE_URL=$(shq "$WORKSPACE_URL")
# 監視対象外チャンネル（自分の DM / ops_log は自分が読む通知のため除外）
SLACK_WATCH_EXCLUDE=$(shq "$WATCH_EXCLUDE")
SLACK_OPS_LOG_CHANNEL=$(shq "$OPS_LOG_CHANNEL")

AGENT_DM_CHANNEL=$(shq "$DM_CHANNEL")
AGENT_WORKDIR=$(shq "$WORKDIR")
AGENT_SLACK_CLI=$(shq "$COMPONENTS_DIR/slack-cli/bin/slack-cli")
AGENT_CATCHUP_MODEL='sonnet'
AGENT_CATCHUP_BUDGET_USD='8.00'
"

# ---------------------------------------------------------------- cli
if want cli; then
  step "slack-cli のビルド"
  ( cd "$COMPONENTS_DIR/slack-cli" && npm install --silent && npm run --silent build )
  info "ビルド完了: $COMPONENTS_DIR/slack-cli/bin/slack-cli"
fi

# ---------------------------------------------------------------- bot
if want bot; then
  step "claude-slack-bot のビルド"
  ( cd "$COMPONENTS_DIR/claude-slack-bot" && npm install --silent && npm run --silent build )
  mkdir -p "$COMPONENTS_DIR/claude-slack-bot/logs"
  # dotenv が読む。dotenv は引用符を解釈するので同じくクォートして書く。
  write_env_file "$COMPONENTS_DIR/claude-slack-bot/.env" "SLACK_BOT_TOKEN=$(shq "$SLACK_BOT_TOKEN")
SLACK_USER_TOKEN=$(shq "$SLACK_USER_TOKEN")
SLACK_APP_TOKEN=$(shq "$SLACK_APP_TOKEN")
BOT_NAME=$(shq "$BOT_HANDLE")
OWNER_NAME=$(shq "$OWNER_NAME")
DEFAULT_CWD=$(shq "$WORKDIR")
MY_USER_ID=$(shq "$MY_USER_ID")
DM_CHANNEL_ID=$(shq "$DM_CHANNEL")
MODEL=sonnet
MAX_TURNS=10
BUDGET_GENERAL=1.0
BUDGET_SKILL=3.0
BUDGET_TEAM=5.0
MAX_CONCURRENT=2
"
  step "常駐 Bot を launchd へ登録"
  NODE_BIN="$(command -v node)"
  PLIST="$LAUNCH_AGENTS/com.claude-slack-agent.bot.plist"
  mkdir -p "$LAUNCH_AGENTS"
  sed -e "s|@@NODE@@|$NODE_BIN|g" \
      -e "s|@@BOT_DIR@@|$COMPONENTS_DIR/claude-slack-bot|g" \
      -e "s|@@HOME@@|$HOME|g" \
      "$SKILL_DIR/scripts/templates/bot.plist.tmpl" > "$PLIST"
  launchctl bootout "gui/$(id -u)/com.claude-slack-agent.bot" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$PLIST"
  info "登録: com.claude-slack-agent.bot（ログ: $COMPONENTS_DIR/claude-slack-bot/logs/）"
fi

# ---------------------------------------------------------------- catchup
if want catchup; then
  step "スレッド返信キャッチアップを launchd へ登録"
  chmod +x "$COMPONENTS_DIR/slack-thread-catchup/run.sh"
  PLIST="$LAUNCH_AGENTS/com.claude-slack-agent.thread-catchup.plist"
  mkdir -p "$LAUNCH_AGENTS"
  sed -e "s|@@RUN_SH@@|$COMPONENTS_DIR/slack-thread-catchup/run.sh|g" \
      -e "s|@@WORKDIR@@|$WORKDIR|g" \
      -e "s|@@HOME@@|$HOME|g" \
      "$SKILL_DIR/scripts/templates/thread-catchup.plist.tmpl" > "$PLIST"
  launchctl bootout "gui/$(id -u)/com.claude-slack-agent.thread-catchup" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$PLIST"
  info "登録: com.claude-slack-agent.thread-catchup（5分毎・ログ: /tmp/claude-slack-agent-thread-catchup.log）"
fi

step "完了"
cat <<EOS
次にやること:
  1. bash $SKILL_DIR/scripts/verify.sh   … 疎通確認（自分の DM にテスト投稿が届きます）
  2. Bot を使いたいチャンネルで /invite @$BOT_HANDLE
  3. 投稿の作法は references/slack-post-rules.md を自分の CLAUDE.md から参照する
EOS
