#!/bin/bash
# 上限で止まった会話を、別アカウントへ記録ごと移して再開する。
#
#   bash move-session.sh --to <auto|main|2|3...> [--no-launch|--prepare] [--notify] <session-id> [<session-id>...]
#
#   --prepare  タブにコマンドを打ち込むだけで Enter は押さない（再開は人が Enter で決める）
#   --notify   終わったら macOS の通知で結果を出す（上限到達のフックから呼ぶとき用）
#
# 会話の記録はアカウントごとに別フォルダにあるので、全アカウントから同じ ID の記録を探し、
# 中身が最も進んでいるもの（最後の発言の時刻が新しいもの）を移動先へコピーする。
# 更新時刻では選ばない（止まった側の窓を閉じただけでも更新時刻は進む）。
# --to auto は、記録が今あるアカウントを除き、5時間枠と週の枠の残りが最も多いアカウントを選ぶ。
# コピーは複製で、元の記録は残る。移動先に古い写しがあれば .bak-<時刻> に退避してから置き換える。
# 既定では iTerm の前面の窓に新しいタブを開き、`cd <会話の作業フォルダ> && claudeN --resume <ID>` を実行する。

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
. "$SCRIPT_DIR/lib/common.sh"

ACCOUNTS_ROOT="${CLAUDE_ACCOUNTS_ROOT:-$HOME/.claude-accounts}"
MAIN_CFG="${CLAUDE_MAIN_CONFIG_DIR:-$HOME/.claude}"
# 各アカウントの枠の記録（画面下の使用量表示と同じもの）
USAGE_DIR="${CLAUDE_USAGE_DIR:-$HOME/.claude/state/statusline-usage}"
USAGE_REFRESH="$SCRIPT_DIR/../../../scripts/statusline-usage-refresh.py"
TO=""
LAUNCH=1
NOTIFY=0
IDS=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --to) TO="${2:-}"; shift 2 ;;
    --no-launch) LAUNCH=0; shift ;;
    --prepare) LAUNCH=2; shift ;;
    --notify) NOTIFY=1; shift ;;
    -h|--help) sed -n '2,14p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) cma_die "不明なオプション: $1" ;;
    *) IDS="$IDS $1"; shift ;;
  esac
done

[ -n "$TO" ] || cma_die "--to で移動先を指定してください（auto / main / 2 / 3 ...）"
[ -n "$IDS" ] || cma_die "会話の ID を1つ以上渡してください（/status の Session ID）"

# プロファイルの設定フォルダ → 起動コマンド名（claude / claudeN）
cmd_of() {
  case "$1" in
    "$MAIN_CFG") printf 'claude' ;;
    *) printf 'claude%s' "${1##*/account}" ;;
  esac
}

# 探す対象のプロファイル（メイン＋accountN）
CFGS="$MAIN_CFG"
for d in "$ACCOUNTS_ROOT"/account*; do
  [ -d "$d/projects" ] && CFGS="$CFGS $d"
done

FIXED_CFG=""
case "$TO" in
  auto) ;;
  main|1) FIXED_CFG="$MAIN_CFG" ;;
  *[!0-9]*) cma_die "--to は auto / main / 数字です: $TO" ;;
  *) FIXED_CFG="$ACCOUNTS_ROOT/account$TO" ;;
esac
if [ -n "$FIXED_CFG" ]; then
  [ -d "$FIXED_CFG/projects" ] || cma_die "移動先のプロファイルがありません: ${FIXED_CFG}（setup-account.sh --index ${TO} で作る）"
elif [ -r "$USAGE_REFRESH" ]; then
  # 5分以内に取った記録があれば何もしない。失敗しても手元の記録で選ぶ
  /usr/bin/python3 "$USAGE_REFRESH" >/dev/null 2>&1 || true
fi

# 枠の残りが最も多いプロファイルを「設定フォルダ<TAB>説明」で返す（第1引数のプロファイルは除く）
pick_target() {
  local exclude=$1 cfg
  set --
  for cfg in $CFGS; do
    [ "$cfg" = "$exclude" ] && continue
    set -- "$@" "${cfg}"$'\t'"$(cmd_of "$cfg")"
  done
  [ "$#" -gt 0 ] || return 0
  /usr/bin/python3 -I -c "$PICK_PY" "$USAGE_DIR" "$@"
}
read -r -d '' PICK_PY <<'PY'
import json, os, sys, time
usage_dir, now, rows = sys.argv[1], time.time(), []
for arg in sys.argv[2:]:
    cfg, name = arg.split("\t")
    try:
        with open(os.path.join(usage_dir, name + ".json")) as f:
            u = json.load(f)
    except (OSError, ValueError):
        rows.append((-1, -1, cfg, "%s（枠の記録なし）" % name))
        continue
    def used(p, r):
        if not isinstance(p, (int, float)):
            return None
        return 0 if isinstance(r, (int, float)) and r <= now else p   # 窓が明けていれば 0
    p5, p7 = used(u.get("p5"), u.get("r5")), used(u.get("p7"), u.get("r7"))
    if p5 is None and p7 is None:
        rows.append((-1, -1, cfg, "%s（枠の記録なし）" % name))
        continue
    left5, left7 = 100 - (p5 or 0), 100 - (p7 or 0)
    rows.append((min(left5, left7), left7, cfg, "%s（5時間枠 残り%d%%・週 残り%d%%）" % (name, left5, left7)))
ok = [r for r in rows if r[0] > 0] or [r for r in rows if r[0] < 0]
if ok:
    best = max(ok)
    print("%s\t%s" % (best[2], best[3]))
PY

# 記録の「最後の発言時刻<TAB>行数<TAB>作業フォルダ」を返す
probe() {
  /usr/bin/python3 -I - "$1" <<'PY'
import json, sys
last, cwd, n = "", "", 0
with open(sys.argv[1], encoding="utf-8", errors="replace") as f:
    for line in f:
        n += 1
        try:
            d = json.loads(line)
        except ValueError:
            continue
        if not isinstance(d, dict):
            continue
        ts = d.get("timestamp")
        if isinstance(ts, str) and ts > last:
            last = ts
        if isinstance(d.get("cwd"), str):
            cwd = d["cwd"]
print("%s\t%d\t%s" % (last, n, cwd))
PY
}

# iTerm の前面の窓に新しいタブを開いてコマンドを打つ（窓が無ければ窓を作る）
# open_tab <コマンド> <Enter を押すか 1|0> [先に表示する案内文]
open_tab() {
  /usr/bin/osascript - "$1" "$2" "${3:-}" <<'OSA' >/dev/null
on run argv
  tell application "iTerm"
    if (count of windows) = 0 then
      set s to current session of (create window with default profile)
    else
      set w to current window
      if w is missing value then set w to window 1
      tell w to set t to (create tab with default profile)
      set s to current session of t
    end if
    tell s
      if (item 3 of argv) is not "" then write text "clear; printf '%s\\n' " & quoted form of (item 3 of argv)
      if (item 2 of argv) is "1" then
        write text (item 1 of argv)
      else
        write text (item 1 of argv) newline false
      end if
    end tell
  end tell
end run
OSA
}

notify() {
  [ "$NOTIFY" = "1" ] || return 0
  /usr/bin/osascript -e 'on run argv' -e 'display notification (item 1 of argv) with title "Claude の上限"' -e 'end run' "$1" >/dev/null 2>&1 || true
}

STAMP="$(date +%Y%m%d-%H%M%S)"
LAUNCHED=""

for ID in $IDS; do
  grep -Eq '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' <<< "$ID" \
    || { cma_warn "ID の形式ではないので飛ばします: $ID"; continue; }
  cma_step "$ID"

  best=""; best_cfg=""; best_ts=""; best_n=0; best_cwd=""
  for cfg in $CFGS; do
    for f in "$cfg"/projects/*/"$ID".jsonl; do
      [ -f "$f" ] || continue
      # 結果を変数に受けてから read する（`IFS=… read <<EOF $(…)` だと関数の中まで IFS が効き、$CFGS が分割されない）
      out="$(probe "$f")"
      IFS=$'\t' read -r ts n cwd <<< "$out"
      cma_info "候補: ${f}（最後の発言 ${ts:-不明}・${n}行）"
      # 同じ進み具合なら移動先の写しを優先する（同じ中身を退避して入れ直さない）
      if [ -z "$best" ] || [[ "$ts" > "$best_ts" ]] || { [ "$ts" = "$best_ts" ] && [ "$n" -gt "$best_n" ]; } \
         || { [ "$ts" = "$best_ts" ] && [ "$n" = "$best_n" ] && [ "$cfg" = "$FIXED_CFG" ]; }; then
        best="$f"; best_cfg="$cfg"; best_ts="$ts"; best_n="$n"; best_cwd="$cwd"
      fi
    done
  done
  [ -n "$best" ] || { cma_warn "どのアカウントにも記録がありません"; continue; }
  [ -d "$best_cwd" ] || { cma_warn "作業フォルダが見つかりません: ${best_cwd:-不明}"; continue; }

  if [ -n "$FIXED_CFG" ]; then
    DST_CFG="$FIXED_CFG"
  else
    out="$(pick_target "$best_cfg")"
    DST_CFG=""; why=""
    IFS=$'\t' read -r DST_CFG why <<< "$out"
    if [ -z "$DST_CFG" ]; then
      cma_warn "移せるアカウントがありません（どれも枠が尽きています）"
      notify "移せるアカウントがありません（どれも枠が尽きています）。枠が戻るまで待つ必要があります。"
      continue
    fi
    cma_info "移動先: ${why}"
  fi
  # 移動先は既知のプロファイルのどれかに限る（それ以外の場所へは書かない）
  case " $CFGS " in
    *" $DST_CFG "*) ;;
    *) cma_warn "移動先が既知のプロファイルではないので止めます: ${DST_CFG}"; continue ;;
  esac
  DST_CMD="$(cmd_of "$DST_CFG")"

  proj="$(basename "$(dirname "$best")")"
  src_dir="$(dirname "$best")"
  dst_dir="$DST_CFG/projects/$proj"
  dst="$dst_dir/$ID.jsonl"

  if [ "$best" = "$dst" ]; then
    cma_ok "移動先の記録が最新なのでコピー不要"
  else
    mkdir -p "$dst_dir" || cma_die "作成できません: $dst_dir"
    if [ -f "$dst" ]; then
      mv "$dst" "$dst.bak-$STAMP" || cma_die "退避できません: $dst"
      cma_info "移動先の古い写しを退避: $dst.bak-$STAMP"
    fi
    cp -p "$best" "$dst" || cma_die "コピーできません: $best"
    if [ -d "$src_dir/$ID" ]; then
      mkdir -p "$dst_dir/$ID" && cp -Rp "$src_dir/$ID/." "$dst_dir/$ID/" || cma_die "補助エージェントの記録をコピーできません"
    fi
    cma_ok "コピー: ${best} → ${dst}（${best_n}行）"
  fi

  cmd="cd '$(printf '%s' "$best_cwd" | sed "s/'/'\\\\''/g")' && $DST_CMD --resume $ID"
  if [ "$LAUNCH" = "1" ]; then
    open_tab "$cmd" 1 || { cma_warn "iTerm のタブを開けませんでした。手で実行: $cmd"; continue; }
    cma_ok "iTerm のタブで起動: $cmd"
    LAUNCHED="$LAUNCHED $ID"
    sleep 1
  elif [ "$LAUNCH" = "2" ]; then
    banner="上限で止まった会話を ${why:-$DST_CMD} で続ける準備ができました。Enter で再開します。元のタブは閉じてください（残すと枠が戻った時刻に元のアカウントで自動再開し、同じ作業が二重に動きます）"
    if open_tab "$cmd" 0 "$banner"; then
      cma_ok "iTerm のタブに用意（Enter 待ち）: $cmd"
      notify "${DST_CMD} で続きを用意しました。新しいタブで Enter を押すと再開します。元のタブは閉じてください。"
    else
      cma_warn "iTerm のタブを開けませんでした。手で実行: $cmd"
      notify "タブを開けませんでした。手で実行: $cmd"
    fi
    sleep 1
  else
    cma_info "手で実行: $cmd"
  fi
done

[ -z "$LAUNCHED" ] || printf '\n開いたタブで「続けて」と打つと、止まる直前から再開します。\n'
