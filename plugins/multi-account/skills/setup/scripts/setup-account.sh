#!/bin/bash
# 2つ目以降の Claude アカウント用プロファイルを作る（macOS 専用・冪等）。
#
#   bash setup-account.sh --index 2 [--with-chrome] [--workdir ~/work] [--dry-run]
#
# やること:
#   1. 専用の設定ディレクトリ ~/.claude-accounts/accountN を作る（chmod 700）
#   2. スキル・CLAUDE.md・settings 等をメイン ~/.claude から symlink で共有する
#      （セッション履歴・.claude.json・認証は共有しない＝ここが分離の本体）
#   3. ~/.zshrc に起動関数 claudeN() を追記する（マーカーで囲むので再実行しても重複しない）
#   4. （任意）--with-chrome で専用 Chrome 一式もセットアップする
#
# メインの ~/.claude には一切書き込まない。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
. "$SCRIPT_DIR/lib/common.sh"
TEMPLATE_DIR="$(cd "$SCRIPT_DIR/../templates" && pwd)"

INDEX=""
FN_NAME=""
WORKDIR=""
MAIN_CFG="${CLAUDE_MAIN_CONFIG_DIR:-$HOME/.claude}"
ACCOUNTS_ROOT="${CLAUDE_ACCOUNTS_ROOT:-$HOME/.claude-accounts}"
SHELL_RC="${CLAUDE_SHELL_RC:-$HOME/.zshrc}"
SHARE_LIST="$CMA_SHARE_DEFAULT"
SHARE_ENV=1
EDIT_SHELL=1
WITH_CHROME=0

usage() {
  sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  cat <<'EOS'

オプション:
  --index N          2以上の番号（必須）。設定ディレクトリは accountN になる
  --name NAME        起動コマンド名（既定: claudeN）
  --workdir DIR      起動時に cd するディレクトリ（既定: cd しない）
  --with-chrome      専用 Chrome（Claude in Chrome の2つ目）もセットアップする
  --share "a b c"    共有する項目を上書き（既定: CLAUDE.md settings.json skills … ）
  --no-share-env     .env.* を共有しない
  --no-shell         ~/.zshrc を編集しない（関数は自分で貼る）
  --shell-rc PATH    編集するシェル設定ファイル（既定: ~/.zshrc）
  --dry-run          何も書き込まず、実行予定だけ表示する
  -h, --help         このヘルプ

環境変数:
  CLAUDE_ACCOUNTS_ROOT    プロファイルの置き場（既定: ~/.claude-accounts）
  CLAUDE_MAIN_CONFIG_DIR  共有元のメイン設定ディレクトリ（既定: ~/.claude）
EOS
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --index) INDEX="${2:-}"; shift 2 ;;
    --name) FN_NAME="${2:-}"; shift 2 ;;
    --workdir) WORKDIR="${2:-}"; shift 2 ;;
    --with-chrome) WITH_CHROME=1; shift ;;
    --share) SHARE_LIST="${2:-}"; shift 2 ;;
    --no-share-env) SHARE_ENV=0; shift ;;
    --no-shell) EDIT_SHELL=0; shift ;;
    --shell-rc) SHELL_RC="${2:-}"; shift 2 ;;
    --dry-run) CMA_DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) cma_die "不明なオプション: $1（--help で使い方）" ;;
  esac
done

# ---- 事前チェック ---------------------------------------------------------
[ "$(uname -s)" = "Darwin" ] || cma_die "このスキルは macOS 専用です（Keychain / open -na を使います）"
case "$INDEX" in
  ''|*[!0-9]*) cma_die "--index には2以上の数字を指定してください" ;;
esac
[ "$INDEX" -ge 2 ] || cma_die "--index は2以上にしてください（1はメインの ~/.claude）"

command -v claude >/dev/null 2>&1 || cma_warn "claude コマンドが PATH にありません（後で入れる場合は続行して構いません）"
[ -d "$MAIN_CFG" ] || cma_die "メインの設定ディレクトリが見つかりません: $MAIN_CFG"

[ -n "$FN_NAME" ] || FN_NAME="claude$INDEX"
case "$FN_NAME" in
  claude) cma_die "--name に claude は使えません（メインを壊します）" ;;
  *[!A-Za-z0-9_-]*) cma_die "--name に使えない文字が含まれています: $FN_NAME" ;;
esac

CFG_DIR="$ACCOUNTS_ROOT/account$INDEX"
[ "$CFG_DIR" != "$MAIN_CFG" ] || cma_die "プロファイルの置き場がメインと同じです: $CFG_DIR"

# --workdir は生成する zsh 関数へそのまま埋め込むため、関数を壊す文字を弾く
if [ -n "$WORKDIR" ]; then
  case "$WORKDIR" in
    *'"'*|*'$'*|*'`'*|*'\'*|*'
'*) cma_die "--workdir に使えない文字が含まれています（\" \$ \` \\ 改行は不可）: $WORKDIR" ;;
  esac
  [ -d "$WORKDIR" ] || cma_die "--workdir が存在しません: $WORKDIR"
fi

printf '\n=== claude-multi-account セットアップ ===\n'
cma_info "番号        : $INDEX"
cma_info "起動コマンド: $FN_NAME"
cma_info "設定ディレクトリ: $CFG_DIR"
cma_info "共有元      : $MAIN_CFG"
cma_info "シェル設定  : $([ "$EDIT_SHELL" = 1 ] && echo "$SHELL_RC" || echo '編集しない')"
cma_info "Keychain    : $(cma_keychain_service "$CFG_DIR")"
if [ "$CMA_DRY_RUN" = "1" ]; then cma_info "モード      : dry-run（書き込みなし）"; fi

# ---- 1. 設定ディレクトリ --------------------------------------------------
cma_step "設定ディレクトリを用意"
if [ -d "$CFG_DIR" ]; then
  cma_info "既存のプロファイルを検出。不足分だけ補います: $CFG_DIR"
fi
cma_act "作成: $ACCOUNTS_ROOT (chmod 700)" mkdir -p "$ACCOUNTS_ROOT"
cma_act "権限: $ACCOUNTS_ROOT を 700" chmod 700 "$ACCOUNTS_ROOT"
cma_act "作成: $CFG_DIR (chmod 700)" mkdir -p "$CFG_DIR"
cma_act "権限: $CFG_DIR を 700" chmod 700 "$CFG_DIR"

# ---- 2. 共有 symlink ------------------------------------------------------
cma_step "メイン設定からの共有（symlink）"
for item in $SHARE_LIST; do
  if cma_is_forbidden_share "$item"; then
    cma_die "共有してはいけない項目が指定されています: ${item}（アカウント分離が壊れます）"
  fi
  cma_link "$MAIN_CFG/$item" "$CFG_DIR/$item"
done

if [ "$SHARE_ENV" = "1" ]; then
  for envfile in "$MAIN_CFG"/.env.*; do
    [ -e "$envfile" ] || continue
    base="$(basename "$envfile")"
    case "$base" in
      *.bak*|*.invalid*) continue ;;
    esac
    cma_link "$envfile" "$CFG_DIR/$base"
  done
fi

cma_info "共有しないもの（意図的）: .claude.json / sessions / projects / history.jsonl / 認証"

# ---- 3. 起動関数 ----------------------------------------------------------
cma_step "起動コマンド $FN_NAME を用意"

if [ "$WITH_CHROME" = "1" ]; then
  CHROME_BLOCK="  # 専用 Chrome（Claude in Chrome 用）が未起動なら自動起動する。
  # パターンの [-] は、この pgrep 自身のコマンドラインに誤マッチしないための書き方。
  if (( ! is_print )) && ! /usr/bin/pgrep -f \"user-data-dir=\$cfg/chrome-user[-]data\" >/dev/null 2>&1; then
    bash \"\$cfg/chrome/launch-chrome.sh\" >&2 || \\
      echo \"⚠️  $FN_NAME: 専用 Chrome の自動起動に失敗しました。手動: bash \$cfg/chrome/launch-chrome.sh\" >&2
  fi"
else
  CHROME_BLOCK="  # （専用 Chrome は未設定。使う場合は scripts/setup-chrome.sh --index ${INDEX}）"
fi

if [ -n "$WORKDIR" ]; then
  # 作業フォルダを5秒で開けるかを先に確かめる（2026-10-05）。macOS の「書類フォルダへのアクセス」確認が応答待ちだと
  # Mac 全体の書類フォルダが固まり、claude は「An unknown error occurred (Unexpected)」としか言わずに落ちる
  WORKDIR_BLOCK=$(cat <<EOF_WD
    # 作業フォルダを5秒で開けるか確かめる。macOS の確認ダイアログが応答待ちだと書類フォルダ全体が固まり、
    # claude は「An unknown error occurred (Unexpected)」としか言わずに落ちる（2026-10-04・10-05 の停止）
    if ! /usr/bin/perl -e 'alarm 5; opendir(my \$d, \$ARGV[0]) or exit 1; exit 0' "${WORKDIR}" 2>/dev/null; then
      echo "🔴 ${FN_NAME}: 作業フォルダ（${WORKDIR}）を5秒以内に開けません。" >&2
      echo "   macOS の「書類フォルダへのアクセス」確認ダイアログが応答待ちで、書類フォルダ全体が固まっている可能性が高いです。" >&2
      echo "   画面（ほかのウィンドウの裏も）に出ている確認ダイアログを探して「許可」を押し、もう一度実行してください。" >&2
      echo "   ダイアログが見当たらないとき: killall -9 tccd （直らなければ sudo killall -9 tccd）" >&2
      exit 1
    fi
    cd "${WORKDIR}" || true
EOF_WD
)
else
  WORKDIR_BLOCK="    # （起動時の cd はしない。呼び出し元のディレクトリのまま起動する）"
fi

FN_BLOCK="$(cma_render "$TEMPLATE_DIR/shell-function.zsh.tmpl" \
  __FN_NAME__ "$FN_NAME" \
  __CFG_DIR__ "$CFG_DIR" \
  __INDEX__ "$INDEX" \
  __CHROME_BLOCK__ "$CHROME_BLOCK" \
  __WORKDIR_BLOCK__ "$WORKDIR_BLOCK")"

# 生成物は必ず手元にも残す（--no-shell の人が自分で貼れるように）
cma_write_file "$CFG_DIR/shell-function.zsh" 600 "$FN_BLOCK"

if [ "$EDIT_SHELL" = "1" ]; then
  cma_upsert_block "$SHELL_RC" "$FN_NAME" "$FN_BLOCK"
  cma_upsert_block "$SHELL_RC" "common" "$(cat "$TEMPLATE_DIR/common-block.zsh.tmpl")"
else
  cma_info "シェル設定は編集しませんでした。$CFG_DIR/shell-function.zsh の内容を ~/.zshrc に貼ってください"
fi

# ---- 4. Chrome（任意） ----------------------------------------------------
if [ "$WITH_CHROME" = "1" ]; then
  chrome_args=(--index "$INDEX" --name "$FN_NAME" --accounts-root "$ACCOUNTS_ROOT")
  if [ "$CMA_DRY_RUN" = "1" ]; then chrome_args+=(--dry-run); fi
  bash "$SCRIPT_DIR/setup-chrome.sh" "${chrome_args[@]}"
fi

# ---- 5. 次にやること ------------------------------------------------------
cat <<EOS

=== 次にやること ===

1. シェルを読み直す:      exec zsh    （または新しいターミナルを開く）
2. 起動する:              $FN_NAME
3. 初回だけログインする:  セッション内で /login → 2つ目の Claude アカウントで認証
   （ログインすると専用の Keychain エントリができ、次回から Remote Control も使えます）
4. 確認:                  claude-which  → CLAUDE_CONFIG_DIR=$CFG_DIR と出れば成功
5. 状態の一覧:            bash $SCRIPT_DIR/status.sh

メインは今までどおり claude で起動します。両者はアカウントもセッションも別物です。
EOS
