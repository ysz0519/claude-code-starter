#!/bin/bash
# slack-thread-catchup launchd エントリ（5分毎ポーリング・配布版）
#
# 自分の Bot が他メンバー宛に送った依頼スレッドの新着返信を検知し、キャッチアップ用の claude を
# 起動して保留作業を自動で進める。検知（poller.py scan）は LLM を起動しない。
# 新着があるときだけ claude -p を起動する（空振りでトークンを払わない）。
#
# ロックは本 wrapper が取得・解放する（LLM には触らせない。LLM は中断され得るため）。
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

export PATH="/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$HOME/.local/bin:$HOME/.npm-global/bin"

# ---- 設定（setup.sh が生成）----
AGENT_ENV="${CLAUDE_SLACK_AGENT_ENV:-$HOME/.claude/.env.claude-slack-agent}"
if [ ! -r "$AGENT_ENV" ]; then
  echo "ERROR: 設定ファイルがありません: ${AGENT_ENV}（setup.sh を実行してください）" >&2
  exit 78
fi
# shellcheck disable=SC1090
set -a; source "$AGENT_ENV"; set +a

: "${AGENT_WORKDIR:?AGENT_WORKDIR が未設定です}"
PY="${AGENT_PYTHON:-/usr/bin/python3}"
MODEL="${AGENT_CATCHUP_MODEL:-sonnet}"
BUDGET="${AGENT_CATCHUP_BUDGET_USD:-8.00}"
POLLER="$SCRIPT_DIR/poller.py"
CANDIDATES_FILE="${SLACK_THREAD_CATCHUP_CANDIDATES:-/tmp/slack-thread-catchup-candidates.json}"

LOG_DIR="$HOME/.claude/logs"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/slack-thread-catchup-$(date +%Y-%m-%d).log"
exec >> "$LOG_FILE" 2>&1

# ---- ロック（stale 回収つき・TTL 150分）----
# shellcheck disable=SC1090
source "$SCRIPT_DIR/lib/lock-lib.sh"
lock_acquire "/tmp/slack-thread-catchup.lock" 150 "$LOG_FILE"; LOCK_RC=$?
[ "$LOCK_RC" -eq 1 ] && exit 0   # 他が実行中 = 正常な skip
if [ "$LOCK_RC" -ne 0 ]; then
  echo "ERROR: lock 取得エラー (rc=$LOCK_RC)"
  "$PY" "$POLLER" record-error "lock 取得エラー (rc=$LOCK_RC)" || true
  exit 1
fi

echo "--- scan: $(date '+%Y-%m-%d %H:%M:%S') ---"
"$PY" "$POLLER" scan
SCAN_RC=$?

if [ "$SCAN_RC" -eq 0 ]; then
  exit 0   # 新着なし（沈黙・LLM 非起動）
fi
if [ "$SCAN_RC" -ne 10 ]; then
  echo "ERROR: scan 失敗 (rc=$SCAN_RC)"
  "$PY" "$POLLER" record-error "scan 失敗 (rc=$SCAN_RC)" || true
  exit 1
fi

# ---- 新着あり → 候補ごとに claude を起動 ----
CLAUDE_BIN="${AGENT_CLAUDE_BIN:-$(command -v claude || true)}"
if [ -z "$CLAUDE_BIN" ]; then
  echo "ERROR: Claude CLI が PATH 上に見つかりません"
  "$PY" "$POLLER" record-error "Claude CLI 不在（PATH を確認してください）"
  exit 1
fi

N=$(jq length "$CANDIDATES_FILE")
echo "candidates: $N 件"
FAILED=0

# --resume に使う transcript の置き場（Claude Code は cwd をエンコードしたディレクトリ名で保存する）
PROJECT_SLUG="$(printf '%s' "$AGENT_WORKDIR" | tr '/.' '--')"

for ((i = 0; i < N; i++)); do
  CID=$(jq -r ".[$i].id" "$CANDIDATES_FILE")
  SID=$(jq -r ".[$i].session_id // empty" "$CANDIDATES_FILE")
  PROMPT=$("$PY" "$POLLER" prompt --index "$i")

  # 元セッションの transcript が実在する場合のみ resume（文脈維持）。無ければ新規セッション。
  if [ -n "$SID" ] && [ -f "$HOME/.claude/projects/$PROJECT_SLUG/$SID.jsonl" ]; then
    export CLAUDE_SESSION_ID="$SID"
    SESSION_ARGS=(--resume "$SID")
    echo "[$CID] resume session $SID"
  else
    CLAUDE_SESSION_ID=$(uuidgen)
    export CLAUDE_SESSION_ID
    SESSION_ARGS=(--session-id "$CLAUDE_SESSION_ID")
    echo "[$CID] new session $CLAUDE_SESSION_ID"
  fi
  PROMPT="$PROMPT
【セッションID: ${CLAUDE_SESSION_ID}】"

  cd "$AGENT_WORKDIR" || exit 1
  # キャッチアップは保留作業（検証・実装・回答）を継続する自律実行のため、ツールは明示列挙で広めに許可する。
  # 承認必須の操作はプロンプト手順4と各自の CLAUDE.md が止める。
  # NOTE: --allowedTools は可変長引数のためプロンプトは stdin で渡す
  printf '%s' "$PROMPT" | "$CLAUDE_BIN" \
    --print \
    "${SESSION_ARGS[@]}" \
    --model "$MODEL" \
    --max-budget-usd "$BUDGET" \
    --allowedTools "Read" "Edit" "Write" "Glob" "Grep" "Skill" "Task" "WebSearch" "WebFetch" "Bash"
  CLAUDE_RC=$?

  if [ "$CLAUDE_RC" -eq 0 ]; then
    "$PY" "$POLLER" finalize --index "$i"
    echo "[$CID] 完了 (claude exit 0)"
  else
    # last_seen は前進させず open へ戻す（次 tick で再試行・runs/day 上限 6 が暴走を抑える）
    "$PY" "$POLLER" reopen --index "$i"
    echo "ERROR: [$CID] claude 実行失敗 (rc=$CLAUDE_RC)"
    "$PY" "$POLLER" record-error "キャッチアップ失敗 (thread=$CID rc=$CLAUDE_RC)" || true
    FAILED=1
  fi
done

rm -f "$CANDIDATES_FILE"
exit "$FAILED"
