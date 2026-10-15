#!/bin/bash
# mkdir ロックの共通ヘルパ（platform-rules.md「ファイルロック」の実装・source 専用）
#
# 解く問題: SIGKILL・強制終了・パニックで trap が走らないとロックディレクトリが残り、
# 以後そのジョブが毎回 skip し続けて「静かに止まる」。TTL とプロセス生存確認で回収する。
#
# macOS に flock(1) が無いため mkdir の atomic 性を使う（platform-rules.md 準拠）。
#
# ## 使い方
#
#   source "$VAULT/.claude/scripts/lock-lib.sh"
#   lock_acquire "/tmp/myskill.lock" 120 "$LOG_FILE"; rc=$?
#   [ "$rc" -eq 1 ] && exit 0    # 他が保持中 = 正常な skip
#   [ "$rc" -ne 0 ] && exit 1    # 取得エラー = 異常（launchd の exit code で拾わせる）
#   # …本処理…（解放は lock_acquire が仕掛ける EXIT trap が行う。既存 trap があれば前段に連結する）
#
# 戻り値: 0=取得 / 1=他が保持中（skip） / 2=取得エラー（skip と混同しない）
#
# TTL の決め方: そのジョブの watchdog（claude-invoke.sh の CLAUDE_TIMEOUT_SEC 等）より
# 十分に長くする。正常実行は watchdog で必ず終わるので、TTL 超えのロックは取り残しと断定できる。
#
# 正本: .claude/rules/platform-rules.md ／ 定数: shared-constants.md → path.lock_lib

# 二重 source の防止（複数 lib を source する wrapper がある）
[ -n "${_LOCK_LIB_LOADED:-}" ] && return 0
_LOCK_LIB_LOADED=1

_lock_log() {
  # $1=ログパス（空なら stderr）, $2=本文
  if [ -n "${1:-}" ]; then
    echo "$(date '+%F %T') $2" >> "$1"
  else
    echo "$(date '+%F %T') $2" >&2
  fi
}

# lock_acquire <lock_dir> [stale_min] [log_file]
#
# 戻り値:
#   0 = 取得した
#   1 = 他プロセスが保持中（正常な skip。呼び出し側は exit 0 でよい）
#   2 = 取得エラー（権限・パス不正・ディスク不足など）。**skip と混同してはいけない**。
#       呼び出し側は非0で終了し、launchd の exit code で異常として拾わせる
lock_acquire() {
  local lock_dir="$1"
  local stale_min="${2:-120}"
  local log_file="${3:-}"

  if [ -z "$lock_dir" ]; then
    _lock_log "$log_file" "[lock-lib] ERROR: lock_dir が空"
    return 2
  fi

  if ! mkdir -p "$(dirname "$lock_dir")" 2>/dev/null; then
    _lock_log "$log_file" "[lock-lib] ERROR: 親ディレクトリを作成できない: $(dirname "$lock_dir")"
    return 2
  fi

  if mkdir "$lock_dir" 2>/dev/null; then
    _lock_finalize "$lock_dir"
    return 0
  fi

  # mkdir の失敗理由を切り分ける。「既に存在する」以外（権限・ENOSPC・パス不正）を
  # skip として黙って返すと、ジョブが動かないまま正常終了に見えてしまう
  if [ ! -d "$lock_dir" ]; then
    _lock_log "$log_file" "[lock-lib] ERROR: ロックを作成できない（権限・容量・パスを確認）: $lock_dir"
    return 2
  fi

  # ── 既存ロックあり: 取り残しか判定する ──
  local owner
  owner=$(cat "$lock_dir/pid" 2>/dev/null || echo "")

  local reason=""
  if [ -n "$(/usr/bin/find "$lock_dir" -maxdepth 0 -mmin "+$stale_min" 2>/dev/null)" ]; then
    # TTL 超過。PID 生存は見ない（PID は再利用されるため、生きている別プロセスを
    # 保持者と誤認して永久 skip する事故のほうが実害が大きい）
    reason="TTL ${stale_min}分超"
  elif [ -n "$owner" ] && [ "$owner" -eq "$owner" ] 2>/dev/null && ! kill -0 "$owner" 2>/dev/null; then
    # TTL 内でも、記録された PID が既に居ないなら取り残し
    reason="保持プロセス不在 (pid=$owner)"
  fi

  if [ -z "$reason" ]; then
    _lock_log "$log_file" "[lock-lib] already locked (owner=${owner:-unknown}), skip"
    return 1
  fi

  _lock_log "$log_file" "[lock-lib] stale lock を回収（${reason}・owner=${owner:-unknown}）"
  rm -rf "$lock_dir"
  if mkdir "$lock_dir" 2>/dev/null; then
    _lock_finalize "$lock_dir"
    return 0
  fi

  # 回収直後に他プロセスが先取りした（競合）。奪い合いを避けて今回は諦める
  _lock_log "$log_file" "[lock-lib] lock 再取得失敗（競合）, skip"
  return 1
}

_lock_finalize() {
  local lock_dir="$1"
  echo "$$" > "$lock_dir/pid" 2>/dev/null
  _LOCK_HELD_DIRS="${_LOCK_HELD_DIRS:-} $lock_dir"
  _lock_install_exit_trap
}

_lock_install_exit_trap() {
  # EXIT のみに仕掛ける。INT/TERM は既定ハンドラで exit するため EXIT trap が走る
  # （INT/TERM を個別に trap すると、呼び出し元の trap を上書きしてしまう）
  #
  # 呼び出し元が既に EXIT trap を持っている場合、無条件に上書きすると
  # その後片付け（一時ファイル削除など）が消える。既存コマンドを先に走らせてから解放する。
  local existing
  existing=$(trap -p EXIT 2>/dev/null)

  if [ -z "$existing" ]; then
    trap '_lock_release_all' EXIT
    return 0
  fi
  case "$existing" in
    *_lock_release_all*) return 0 ;;   # 既に仕掛け済み（2本目のロック取得など）
  esac

  # `trap -p EXIT` は `trap -- 'CMD' EXIT` を返す。CMD の取り出しに sed は使わない
  # （CMD 内の単一引用符は `'\''` にエスケープされており、外側クォートを剥がすだけでは
  #  復元できず、再インストール時に構文エラーになる＝2026-08-02 Codex 指摘）。
  # クォート解除は bash 自身（eval + set --）にさせる。
  local body prev
  body=${existing#trap -- }
  body=${body% EXIT}
  if ! eval "set -- $body" 2>/dev/null; then
    _lock_log "" "[lock-lib] WARN: 既存 EXIT trap を解釈できないため自動解放を見送る（TTL で回収）"
    return 0
  fi
  prev="$1"

  # 既存コマンドを関数に閉じ込め、trap 文字列は単一引用符の固定文にする
  # （trap にコマンド本文を埋め込むと、本文中のクォートで再び壊れるため）
  if ! eval "_lock_prev_exit_trap() {
$prev
}" 2>/dev/null; then
    _lock_log "" "[lock-lib] WARN: 既存 EXIT trap を再構成できないため自動解放を見送る（TTL で回収）"
    return 0
  fi
  # "$@" を渡すのは、元の trap が $1/$2/$# を参照していた場合に値を保つため
  # （関数に包むと関数側の位置パラメータになり、素のままでは空になる＝2026-08-02 Codex 指摘）
  trap '_lock_prev_exit_trap "$@"; _lock_release_all' EXIT
}

_lock_release_all() {
  local d
  for d in ${_LOCK_HELD_DIRS:-}; do
    # 自分が保持しているものだけ消す（TTL 回収で他プロセスへ渡った後に消さない）
    if [ "$(cat "$d/pid" 2>/dev/null || echo "")" = "$$" ]; then
      rm -rf "$d" 2>/dev/null
    fi
  done
  _LOCK_HELD_DIRS=""
}

# lock_release <lock_dir> — 本処理より早く明示解放したい場合のみ使う（通常は不要）
lock_release() {
  local lock_dir="$1"
  if [ "$(cat "$lock_dir/pid" 2>/dev/null || echo "")" = "$$" ]; then
    rm -rf "$lock_dir" 2>/dev/null
  fi
  _LOCK_HELD_DIRS="$(echo "${_LOCK_HELD_DIRS:-}" | sed "s|$lock_dir||")"
}
