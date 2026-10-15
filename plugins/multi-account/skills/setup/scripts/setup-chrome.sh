#!/bin/bash
# 2つ目のアカウント専用の Chrome（Claude in Chrome 用）を用意する（macOS 専用・冪等）。
#
#   bash setup-chrome.sh --index 2 [--dry-run]
#
# なぜ専用 Chrome が要るか:
#   Chrome 拡張 ↔ Claude Code は native messaging host で繋がる。host は起動時の
#   CLAUDE_CONFIG_DIR で接続先セッションが決まるが、Claude Code が自動生成する
#   ラッパーはそれを設定しないため、常にメインの ~/.claude に繋がってしまう。
#   そこで「専用 user-data-dir の Chrome」＋「CLAUDE_CONFIG_DIR を渡すラッパー」を
#   自前で用意し、2つ目のアカウントでもブラウザ操作を使えるようにする。
#
# メインの Chrome / ~/.claude には一切触れない。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
. "$SCRIPT_DIR/lib/common.sh"
TEMPLATE_DIR="$(cd "$SCRIPT_DIR/../templates" && pwd)"

INDEX=""
FN_NAME=""
ACCOUNTS_ROOT="${CLAUDE_ACCOUNTS_ROOT:-$HOME/.claude-accounts}"
CHROME_APP="${CLAUDE_CHROME_APP:-/Applications/Google Chrome.app}"
EXT_ID="$CMA_EXT_ID_DEFAULT"
LAUNCH_NOW=0

usage() {
  cat <<'EOS'
使い方: bash setup-chrome.sh --index N [オプション]

  --index N            対象アカウントの番号（必須）
  --name NAME          表示用の名前（既定: claudeN）
  --accounts-root DIR  プロファイルの置き場（既定: ~/.claude-accounts）
  --chrome-app PATH    Chrome.app のパス（既定: /Applications/Google Chrome.app）
  --extension-id ID    Claude in Chrome 拡張の ID（既定値あり・通常は変更不要）
  --launch             セットアップ後に専用 Chrome を起動する
  --dry-run            何も書き込まず、実行予定だけ表示する
  -h, --help           このヘルプ
EOS
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --index) INDEX="${2:-}"; shift 2 ;;
    --name) FN_NAME="${2:-}"; shift 2 ;;
    --accounts-root) ACCOUNTS_ROOT="${2:-}"; shift 2 ;;
    --chrome-app) CHROME_APP="${2:-}"; shift 2 ;;
    --extension-id) EXT_ID="${2:-}"; shift 2 ;;
    --launch) LAUNCH_NOW=1; shift ;;
    --dry-run) CMA_DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) cma_die "不明なオプション: $1（--help で使い方）" ;;
  esac
done

[ "$(uname -s)" = "Darwin" ] || cma_die "このスキルは macOS 専用です"
case "$INDEX" in
  ''|*[!0-9]*) cma_die "--index には2以上の数字を指定してください" ;;
esac
[ "$INDEX" -ge 2 ] || cma_die "--index は2以上にしてください"
[ -n "$FN_NAME" ] || FN_NAME="claude$INDEX"

CFG_DIR="$ACCOUNTS_ROOT/account$INDEX"
if [ ! -d "$CFG_DIR" ]; then
  if [ "$CMA_DRY_RUN" = "1" ]; then
    cma_warn "プロファイルがまだありません: ${CFG_DIR}（dry-run なので続行します）"
  else
    cma_die "プロファイルがまだありません: ${CFG_DIR}（先に setup-account.sh を実行してください）"
  fi
fi

if [ ! -d "$CHROME_APP" ]; then
  cma_warn "Google Chrome が見つかりません: ${CHROME_APP}（設定ファイルは作りますが、起動には Chrome が必要です）"
fi

USER_DATA_DIR="$CFG_DIR/chrome-user-data"
HOST_PATH="$CFG_DIR/chrome/chrome-native-host-$FN_NAME"
MANIFEST_DIR="$USER_DATA_DIR/NativeMessagingHosts"
MANIFEST_PATH="$MANIFEST_DIR/com.anthropic.claude_code_browser_extension.json"

printf '\n=== 専用 Chrome のセットアップ（%s）===\n' "$FN_NAME"
cma_info "user-data-dir : $USER_DATA_DIR"
cma_info "native host   : $HOST_PATH"
cma_info "manifest      : $MANIFEST_PATH"
if [ "$CMA_DRY_RUN" = "1" ]; then cma_info "モード        : dry-run（書き込みなし）"; fi

cma_step "ディレクトリを用意"
cma_act "作成: $CFG_DIR/chrome" mkdir -p "$CFG_DIR/chrome"
cma_act "作成: $MANIFEST_DIR" mkdir -p "$MANIFEST_DIR"
cma_act "権限: $USER_DATA_DIR を 700" chmod 700 "$USER_DATA_DIR"

cma_step "native host ラッパーと manifest を書き出し"
# セットアップ時点で解決できた claude の実パスを第一候補として焼き込む
# （Chrome は最小 PATH で host を起動するため、nvm/volta 等では PATH 探索が失敗しやすい）
CLAUDE_BIN="$(command -v claude 2>/dev/null || true)"
if [ -n "$CLAUDE_BIN" ]; then
  cma_info "claude の実パス: ${CLAUDE_BIN}（ラッパーの第一候補にします）"
else
  cma_warn "claude が PATH に見つかりません。ラッパーは既定の候補パスから探します"
fi
cma_write_file "$HOST_PATH" 755 \
  "$(cma_render "$TEMPLATE_DIR/chrome-native-host.tmpl" \
      __FN_NAME__ "$FN_NAME" __CFG_DIR__ "$CFG_DIR" __INDEX__ "$INDEX" __CLAUDE_BIN__ "$CLAUDE_BIN")"

cma_write_file "$MANIFEST_PATH" 644 \
  "$(cma_render "$TEMPLATE_DIR/native-host-manifest.json.tmpl" \
      __FN_NAME__ "$FN_NAME" __HOST_PATH__ "$HOST_PATH" __EXTENSION_ID__ "$EXT_ID")"

cma_step "起動スクリプトを書き出し"
cma_write_file "$CFG_DIR/chrome/launch-chrome.sh" 755 \
  "$(cma_render "$TEMPLATE_DIR/launch-chrome.sh.tmpl" \
      __FN_NAME__ "$FN_NAME" __CFG_DIR__ "$CFG_DIR" __CHROME_APP__ "$CHROME_APP" __INDEX__ "$INDEX")"

if [ "$LAUNCH_NOW" = "1" ] && [ "$CMA_DRY_RUN" != "1" ]; then
  cma_step "専用 Chrome を起動"
  bash "$CFG_DIR/chrome/launch-chrome.sh"
fi

cat <<EOS

=== 次にやること ===

1. 専用 Chrome を起動:  bash $CFG_DIR/chrome/launch-chrome.sh
   （$FN_NAME を起動すると自動でも立ち上がります）
2. その Chrome で Claude in Chrome 拡張をインストールし、2つ目のアカウントでログインする
3. $FN_NAME のセッションで /chrome を実行し、「Browser 1 · current」と出れば接続成功
4. 確認: chrome://version の「プロフィール パス」が
   $USER_DATA_DIR 配下であること

うまく繋がらないときは、まず「専用 Chrome が起動しているか」を疑ってください:
  /usr/bin/pgrep -fl "chrome-user[-]data"
EOS
