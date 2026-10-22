#!/bin/bash
# 複数アカウント構成の健康診断（read-only・何も書き換えない）。
#
#   bash status.sh [--accounts-root DIR] [--shell-rc PATH]
#
# 各プロファイルについて、設定ディレクトリ・認証・共有 symlink・専用 Chrome の状態を一覧する。
# 認証は「有無」だけを見る（トークンの中身は読まないし表示もしない）。

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
. "$SCRIPT_DIR/lib/common.sh"

ACCOUNTS_ROOT="${CLAUDE_ACCOUNTS_ROOT:-$HOME/.claude-accounts}"
MAIN_CFG="${CLAUDE_MAIN_CONFIG_DIR:-$HOME/.claude}"
SHELL_RC="${CLAUDE_SHELL_RC:-$HOME/.zshrc}"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --accounts-root) ACCOUNTS_ROOT="${2:-}"; shift 2 ;;
    --main-config) MAIN_CFG="${2:-}"; shift 2 ;;
    --shell-rc) SHELL_RC="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,10p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) cma_die "不明なオプション: $1" ;;
  esac
done

mark() { if [ "$1" = "1" ]; then printf '✅'; else printf '—'; fi; }

# ログイン済みか（$1=service 名・$2=account 名〔省略可〕）。
# 項目の有無だけでは判定しない。`claude mcp list` などは未ログインでも MCP 用の情報（mcpOAuth）だけを
# 同じ service 名で作るため、有無で見ると未ログインを ✅ と表示する（2026-10-22・claude4 で実測）。
# 中身は画面に出さず、ログイン情報の鍵名（claudeAiOauth）があるかだけを見る。
# 同じ service 名に account 名違いの項目が並ぶことがある（ログイン用は macOS のユーザー名／MCP 用は unknown）。
# `-s` だけだと先頭の1件しか見ないので、自分のユーザー名の項目と先頭の項目の両方を見る。
has_login() {
  local a
  for a in "$(id -un)" ""; do
    /usr/bin/grep -q '"claudeAiOauth"' <<< "$(security find-generic-password -s "$1" ${a:+-a "$a"} -w 2>/dev/null)" \
      && return 0
  done
  return 1
}

printf '\n=== Claude マルチアカウント状態 ===\n'
printf 'いま動いているプロファイル: %s\n' "${CLAUDE_CONFIG_DIR:-$MAIN_CFG (default)}"

# ---- メイン ---------------------------------------------------------------
printf '\n[main] %s\n' "$MAIN_CFG"
if [ -d "$MAIN_CFG" ]; then
  main_login=0
  if has_login "Claude Code-credentials"; then main_login=1; fi
  printf '  Keychain ログイン : %s (Claude Code-credentials)\n' "$(mark "$main_login")"
  main_token=0
  if [ -s "$MAIN_CFG/.oauth-token" ]; then main_token=1; fi
  printf '  長期トークン      : %s\n' "$(mark "$main_token")"
else
  printf '  ⚠️  見つかりません\n'
fi

# ---- 追加プロファイル -----------------------------------------------------
if [ ! -d "$ACCOUNTS_ROOT" ]; then
  printf '\n追加プロファイルはまだありません（%s が無い）\n' "$ACCOUNTS_ROOT"
  printf 'つくる: bash %s/setup-account.sh --index 2\n\n' "$SCRIPT_DIR"
  exit 0
fi

found=0
for cfg in "$ACCOUNTS_ROOT"/*; do
  [ -d "$cfg" ] || continue
  found=1
  name="$(basename "$cfg")"
  idx="${name#account}"
  fn="claude$idx"

  printf '\n[%s] %s\n' "$name" "$cfg"

  svc="$(cma_keychain_service "$cfg")"
  login=0
  if has_login "$svc"; then login=1; fi
  printf '  Keychain ログイン : %s (%s)\n' "$(mark "$login")" "$svc"

  token=0
  if [ -s "$cfg/.oauth-token" ]; then token=1; fi
  printf '  長期トークン      : %s%s\n' "$(mark "$token")" \
    "$( [ "$login" = 0 ] && [ "$token" = 1 ] && printf ' … Remote Control は使えません（/login すると有効化）' )"

  if [ "$login" = 0 ] && [ "$token" = 0 ]; then
    printf '  ⚠️  未認証です。%s を起動して /login してください\n' "$fn"
  fi

  # 共有 symlink
  links=0; broken=0
  for entry in "$cfg"/* "$cfg"/.env.*; do
    [ -L "$entry" ] || continue
    links=$((links + 1))
    [ -e "$entry" ] || broken=$((broken + 1))
  done
  printf '  共有 symlink      : %s 本' "$links"
  if [ "$broken" -gt 0 ]; then printf '（⚠️ 切れている: %s 本）' "$broken"; fi
  printf '\n'

  # 分離できているか（ここが共有されていたらアカウント分離が壊れている）
  leak=""
  for must_be_own in .claude.json sessions projects history.jsonl; do
    if [ -L "$cfg/$must_be_own" ]; then leak="$leak $must_be_own"; fi
  done
  if [ -n "$leak" ]; then
    printf '  ❌ 分離違反       :%s が symlink になっています（実体に戻してください）\n' "$leak"
  else
    printf '  分離             : ✅ セッション・認証はこのプロファイル固有\n'
  fi

  # シェル関数
  rc_ok=0; rc_note=""
  if [ -f "$SHELL_RC" ]; then
    if /usr/bin/grep -qF "claude-multi-account ($fn)" "$SHELL_RC"; then
      rc_ok=1
    elif /usr/bin/grep -qE "^[[:space:]]*(function[[:space:]]+)?${fn}[[:space:]]*\(\)" "$SHELL_RC"; then
      # このスキルが作ったものではないが、同名の起動関数が手書きで存在する
      rc_ok=1; rc_note=" ※手書き定義（このスキルの管理外）"
    fi
  fi
  printf '  起動コマンド      : %s %s（%s）%s\n' "$(mark "$rc_ok")" "$fn" "$SHELL_RC" "$rc_note"

  # 専用 Chrome
  udd="$cfg/chrome-user-data"
  manifest="$udd/NativeMessagingHosts/com.anthropic.claude_code_browser_extension.json"
  if [ -d "$udd" ]; then
    host_path=""
    if [ -f "$manifest" ]; then
      host_path="$(/usr/bin/sed -n 's/.*"path"[[:space:]]*:[[:space:]]*"\(.*\)".*/\1/p' "$manifest" | head -1)"
    fi
    host_ok=0
    if [ -n "$host_path" ] && [ -x "$host_path" ]; then host_ok=1; fi
    running=0
    if /usr/bin/pgrep -f "user-data-dir=$udd" >/dev/null 2>&1; then running=1; fi
    printf '  専用 Chrome       : manifest %s / native host %s / 起動中 %s\n' \
      "$(mark "$( [ -f "$manifest" ] && echo 1 || echo 0 )")" "$(mark "$host_ok")" "$(mark "$running")"
    if [ "$host_ok" = 0 ] && [ -n "$host_path" ]; then
      printf '     ⚠️  native host が実行できません: %s\n' "$host_path"
    fi
    if [ "$running" = 0 ]; then
      printf '     起動: bash %s/chrome/launch-chrome.sh\n' "$cfg"
    fi
  else
    printf '  専用 Chrome       : — 未設定（bash %s/setup-chrome.sh --index %s）\n' "$SCRIPT_DIR" "$idx"
  fi
done

if [ "$found" = 0 ]; then
  printf '\n追加プロファイルはまだありません。つくる: bash %s/setup-account.sh --index 2\n' "$SCRIPT_DIR"
fi
printf '\n'
