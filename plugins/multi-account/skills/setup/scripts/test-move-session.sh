#!/bin/bash
# move-session.sh の回帰テスト（移動先の自動選択・最新の記録の選び方・既知のプロファイル以外へ書かない）
#   /bin/bash .claude/skills/claude-multi-account/scripts/test-move-session.sh
# iTerm は開かない（--no-launch）。実アカウントには触れない（すべて一時フォルダ）。
set -uo pipefail

S="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/move-session.sh"
ROOT="$(mktemp -d "${TMPDIR:-/tmp}/move-session-test.XXXXXX")"
trap 'rm -rf "$ROOT"' EXIT
FAIL=0
ID=11111111-2222-3333-4444-555555555555
NOW=$(date +%s); H=$((NOW + 3600)); D=$((NOW + 86400)); PAST=$((NOW - 10))
WORK="$ROOT/work dir"   # 空白入りの作業フォルダでも cd できること
mkdir -p "$WORK"

u() { printf '{"p5":%s,"r5":%s,"p7":%s,"r7":%s}' "$1" "$2" "$3" "$4"; }

# scenario <名前> <期待する移動先 claude|claude2|claude3|none> <記録の置き場 main|2|3> <claude> <claude2> <claude3>
scenario() {
  local name=$1 want=$2 src=$3 T out got sd
  T="$(mktemp -d "$ROOT/s.XXXXXX")"
  mkdir -p "$T/main/projects" "$T/acc/account2/projects" "$T/acc/account3/projects" "$T/u"
  case "$src" in main) sd="$T/main" ;; *) sd="$T/acc/account$src" ;; esac
  mkdir -p "$sd/projects/-x/$ID/subagents"
  printf '{"timestamp":"2026-10-18T05:00:00Z","cwd":"%s"}\n' "$WORK" > "$sd/projects/-x/$ID.jsonl"
  printf '{}\n' > "$sd/projects/-x/$ID/subagents/agent-a.jsonl"
  printf '%s' "$4" > "$T/u/claude.json"; printf '%s' "$5" > "$T/u/claude2.json"; printf '%s' "$6" > "$T/u/claude3.json"
  out=$(cd "$T" && CLAUDE_MAIN_CONFIG_DIR="$T/main" CLAUDE_ACCOUNTS_ROOT="$T/acc" CLAUDE_USAGE_DIR="$T/u" \
        /bin/bash "$S" --to auto --no-launch "$ID" 2>&1)
  got=$(sed -n 's/.*&& \(claude[0-9]*\) --resume.*/\1/p' <<< "$out")
  [ -n "$got" ] || got=none
  if [ "$got" = "$want" ]; then echo "ok   $name"; else echo "FAIL ${name}（期待 ${want}・実際 ${got}）"; echo "$out" | sed 's/^/     /'; FAIL=1; fi
  # 書いてよいのは一時フォルダの中の既知のプロファイルだけ（2026-10-18 に IFS の漏れで「~/.claude 」を作った）
  local stray
  stray=$(find "$T" -name "$ID.jsonl" | grep -v -e "^$T/main/projects/" -e "^$T/acc/account[23]/projects/")
  if [ -n "$stray" ]; then
    echo "FAIL ${name}（既知のプロファイルの外に記録を書いた）"; FAIL=1
  fi
  if [ "$want" != none ]; then
    local dst; case "$want" in claude) dst="$T/main" ;; *) dst="$T/acc/account${want#claude}" ;; esac
    [ -f "$dst/projects/-x/$ID/subagents/agent-a.jsonl" ] || { echo "FAIL ${name}（補助エージェントの記録が移っていない）"; FAIL=1; }
  fi
}

scenario "週が尽きたアカウントを避けて残りの多い方へ" claude3 main "$(u 100 $H 50 $D)" "$(u 10 $H 100 $D)" "$(u 30 $H 20 $D)"
scenario "窓が明けたアカウントは使用率0として扱う" claude2 main "$(u 100 $H 50 $D)" "$(u 10 $H 100 $PAST)" "$(u 30 $H 20 $D)"
scenario "どれも尽きていれば移さない" none main "$(u 100 $H 50 $D)" "$(u 100 $H 1 $D)" "$(u 100 $H 1 $D)"
scenario "記録が今あるアカウントは空いていても移動先にしない" none main "$(u 0 $H 0 $D)" "$(u 100 $H 1 $D)" "$(u 100 $H 1 $D)"
scenario "claude3 から戻すときも他の2つから選ぶ" claude 3 "$(u 100 $PAST 50 $D)" "$(u 100 $H 100 $D)" "$(u 0 $H 0 $D)"
scenario "枠の記録が無いアカウントは最後の手段" claude3 main "$(u 100 $H 50 $D)" "not json" "$(u 90 $H 20 $D)"

# 進み具合で選ぶ（更新時刻ではなく最後の発言時刻）
T="$(mktemp -d "$ROOT/p.XXXXXX")"
mkdir -p "$T/main/projects/-x" "$T/acc/account2/projects/-x" "$T/acc/account3/projects"
printf '{"timestamp":"2026-10-18T06:00:00Z","cwd":"%s"}\n{"timestamp":"2026-10-18T06:01:00Z"}\n' "$WORK" > "$T/acc/account2/projects/-x/$ID.jsonl"
printf '{"timestamp":"2026-10-18T05:00:00Z","cwd":"%s"}\n' "$WORK" > "$T/main/projects/-x/$ID.jsonl"
touch "$T/main/projects/-x/$ID.jsonl"   # 古い方の更新時刻だけ新しくする
CLAUDE_MAIN_CONFIG_DIR="$T/main" CLAUDE_ACCOUNTS_ROOT="$T/acc" /bin/bash "$S" --to 3 --no-launch "$ID" >/dev/null 2>&1
if [ "$(wc -l < "$T/acc/account3/projects/-x/$ID.jsonl" | tr -d ' ')" = 2 ]; then echo "ok   更新時刻ではなく最後の発言が新しい記録を移す"; else echo "FAIL 古い記録を移した"; FAIL=1; fi

[ "$FAIL" = 0 ] && echo "PASS" || { echo "FAILED"; exit 1; }
