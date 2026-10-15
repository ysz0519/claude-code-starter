#!/usr/bin/env python3
"""slack-thread-catchup: 監視スレッド台帳（watchlist）の state 操作 CLI / ライブラリ。

自分の Bot が他メンバー宛に送った依頼スレッド（cc: <@自分のユーザーID> 付きルート投稿）を監視対象として保持し、
poller.py が新着返信の検知に使う。登録の入口は2つ:
  1. slack-cli send の自動登録（register-events.jsonl への append → `ingest` で取り込み）
  2. 依頼を送った Claude セッションによる `add --brief`（継続ブリーフ付き手動登録）

State File:
  - primary: ~/.claude/state/slack-thread-catchup/watchlist.json（atomic write）
  - 入力: ~/.claude/state/slack-thread-catchup/register-events.jsonl（slack-cli send が append）
  - 更新タイミング: poller 実行時（ingest/gc/scan）・手動 add/close 時

サブコマンド:
  ingest                 register-events.jsonl の新規イベントを watchlist へ dedup 取り込み
  add --channel C --thread-ts TS [--brief TEXT] [--session-id SID] [--text-head T]
  close --id ID [--reason TEXT]
  list [--status open|processing|closed|all]
  seen --id ID --ts TS   last_seen_ts を前進（status も open へ戻す）
  gc                     14日新着なし→close / processing 120分超→open / closed 30日超→purge

セルフテスト: /usr/bin/python3 watchlist.py --selftest
"""
from __future__ import annotations

import argparse
import contextlib
import datetime
import fcntl
import json
import os
import sys

# 配布版: atomic write ヘルパは同梱の lib/ から読む（Vault 依存を持たない）
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "lib"))
from atomic_write import atomic_write_json  # noqa: E402

STATE_DIR = os.environ.get(
    "SLACK_THREAD_CATCHUP_STATE_DIR",
    os.path.expanduser("~/.claude/state/slack-thread-catchup"),
)
WATCHLIST_PATH = os.path.join(STATE_DIR, "watchlist.json")
EVENTS_PATH = os.path.join(STATE_DIR, "register-events.jsonl")

TTL_DAYS = 14  # 新着なしで自動 close（監視の単調増加防止）
CLOSED_PURGE_DAYS = 30  # closed エントリの保持期間
PROCESSING_STALE_MIN = 120  # processing のまま放置された場合の回収（claude-invoke の既定 timeout と同値）
MAX_RUNS_PER_DAY = 6  # 1スレッドあたりの1日のキャッチアップ起動上限（bot ピンポン防止）


@contextlib.contextmanager
def locked():
    """watchlist の read-modify-write を直列化する排他ロック（fcntl.flock・blocking）。

    5分毎の poller（scan/finalize/reopen）と手動 add/close が並行すると last-write-wins で
    更新を失うため、mutate する呼び出しは必ず本コンテキスト内で load()→save() する（Codex P1 対応）。
    """
    os.makedirs(STATE_DIR, exist_ok=True)
    lock_path = os.path.join(STATE_DIR, ".watchlist.flock")
    with open(lock_path, "w") as f:
        fcntl.flock(f, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(f, fcntl.LOCK_UN)


def now() -> datetime.datetime:
    return datetime.datetime.now(datetime.timezone.utc)


def now_iso() -> str:
    return now().strftime("%Y-%m-%dT%H:%M:%S+00:00")


def parse_iso(s: str) -> datetime.datetime:
    # 3.9 互換: fromisoformat は +00:00 形式を読める
    return datetime.datetime.fromisoformat(s)


def load() -> dict:
    if not os.path.exists(WATCHLIST_PATH):
        return {"threads": {}, "events_offset": 0}
    with open(WATCHLIST_PATH, "r", encoding="utf-8") as f:
        data = json.load(f)
    data.setdefault("threads", {})
    data.setdefault("events_offset", 0)
    return data


def save(data: dict) -> None:
    atomic_write_json(WATCHLIST_PATH, data, indent=2)


def make_entry(channel: str, thread_ts: str, text_head: str = "",
               session_id=None, brief=None, source: str = "auto") -> dict:
    return {
        "id": f"{channel}:{thread_ts}",
        "channel": channel,
        "thread_ts": thread_ts,
        "text_head": text_head,
        "session_id": session_id,
        "brief": brief,
        "status": "open",
        "last_seen_ts": thread_ts,
        "registered_at": now_iso(),
        "last_activity_at": now_iso(),
        "source": source,
        "run_date": None,
        "run_count": 0,
    }


def ingest(data: dict) -> int:
    """register-events.jsonl の未読分を watchlist へ取り込む（byte offset 管理・dedup by id）。"""
    if not os.path.exists(EVENTS_PATH):
        return 0
    added = 0
    offset = int(data.get("events_offset", 0))
    size = os.path.getsize(EVENTS_PATH)
    if size < offset:
        offset = 0  # ファイルがローテート/縮小された場合は先頭から（dedup があるので安全）
    with open(EVENTS_PATH, "r", encoding="utf-8") as f:
        f.seek(offset)
        while True:
            line = f.readline()
            if not line:
                break
            data["events_offset"] = f.tell()
            line = line.strip()
            if not line:
                continue
            try:
                ev = json.loads(line)
            except json.JSONDecodeError:
                continue
            ch = ev.get("channel")
            ts = ev.get("thread_ts")
            if not ch or not ts:
                continue
            tid = f"{ch}:{ts}"
            if tid in data["threads"]:
                continue
            data["threads"][tid] = make_entry(
                ch, ts,
                text_head=str(ev.get("text_head") or "")[:200],
                session_id=ev.get("session_id"),
                source="auto",
            )
            added += 1
    return added


def gc(data: dict) -> dict:
    """TTL close / stale processing 回収 / closed purge。戻り値は件数サマリ。"""
    closed = reopened = purged = 0
    for tid in list(data["threads"].keys()):
        e = data["threads"][tid]
        try:
            last_act = parse_iso(e.get("last_activity_at") or e["registered_at"])
        except (ValueError, KeyError):
            last_act = now()
            e["last_activity_at"] = now_iso()
        age = now() - last_act
        if e["status"] == "processing" and age > datetime.timedelta(minutes=PROCESSING_STALE_MIN):
            e["status"] = "open"
            reopened += 1
        if e["status"] in ("open", "processing") and age > datetime.timedelta(days=TTL_DAYS):
            e["status"] = "closed"
            e["closed_at"] = now_iso()
            e["close_reason"] = f"auto: {TTL_DAYS}日間新着なし"
            closed += 1
        if e["status"] == "closed":
            try:
                closed_at = parse_iso(e.get("closed_at") or e["last_activity_at"])
            except ValueError:
                closed_at = now()
            if now() - closed_at > datetime.timedelta(days=CLOSED_PURGE_DAYS):
                del data["threads"][tid]
                purged += 1
    return {"closed": closed, "reopened": reopened, "purged": purged}


def can_run_today(e: dict) -> bool:
    today = now().astimezone().strftime("%Y-%m-%d")
    if e.get("run_date") != today:
        return True
    return int(e.get("run_count") or 0) < MAX_RUNS_PER_DAY


def bump_run(e: dict) -> None:
    today = now().astimezone().strftime("%Y-%m-%d")
    if e.get("run_date") != today:
        e["run_date"] = today
        e["run_count"] = 0
    e["run_count"] = int(e.get("run_count") or 0) + 1


def cmd_add(args) -> int:
    data = load()
    tid = f"{args.channel}:{args.thread_ts}"
    if tid in data["threads"]:
        e = data["threads"][tid]
        # 既存（自動登録済み等）にはブリーフ・session_id を上書き付与
        if args.brief:
            e["brief"] = args.brief
        if args.session_id:
            e["session_id"] = args.session_id
        if args.text_head:
            e["text_head"] = args.text_head[:200]
        if e["status"] == "closed":
            e["status"] = "open"
            e["last_activity_at"] = now_iso()
        print(f"updated: {tid}")
    else:
        data["threads"][tid] = make_entry(
            args.channel, args.thread_ts,
            text_head=(args.text_head or "")[:200],
            session_id=args.session_id or os.environ.get("CLAUDE_SESSION_ID"),
            brief=args.brief,
            source="manual",
        )
        print(f"added: {tid}")
    save(data)
    return 0


def cmd_close(args) -> int:
    data = load()
    e = data["threads"].get(args.id)
    if not e:
        print(f"not found: {args.id}", file=sys.stderr)
        return 1
    e["status"] = "closed"
    e["closed_at"] = now_iso()
    e["close_reason"] = args.reason or "manual"
    save(data)
    print(f"closed: {args.id}")
    return 0


def cmd_list(args) -> int:
    data = load()
    rows = list(data["threads"].values())
    if args.status != "all":
        rows = [e for e in rows if e["status"] == args.status]
    print(json.dumps(rows, ensure_ascii=False, indent=2))
    return 0


def cmd_seen(args) -> int:
    data = load()
    e = data["threads"].get(args.id)
    if not e:
        print(f"not found: {args.id}", file=sys.stderr)
        return 1
    if float(args.ts) > float(e["last_seen_ts"]):
        e["last_seen_ts"] = args.ts
    e["status"] = "open"
    e["last_activity_at"] = now_iso()
    save(data)
    return 0


def cmd_ingest(_args) -> int:
    data = load()
    added = ingest(data)
    save(data)
    print(f"ingested: {added}")
    return 0


def cmd_gc(_args) -> int:
    data = load()
    stats = gc(data)
    save(data)
    print(json.dumps(stats))
    return 0


def selftest() -> int:
    import tempfile
    global STATE_DIR, WATCHLIST_PATH, EVENTS_PATH
    with tempfile.TemporaryDirectory() as td:
        STATE_DIR = td
        WATCHLIST_PATH = os.path.join(td, "watchlist.json")
        EVENTS_PATH = os.path.join(td, "register-events.jsonl")
        # ingest
        with open(EVENTS_PATH, "w", encoding="utf-8") as f:
            f.write(json.dumps({"channel": "C1", "thread_ts": "100.1", "text_head": "req",
                                "session_id": "sid-1", "registered_at": now_iso()}) + "\n")
            f.write("broken\n")
            f.write(json.dumps({"channel": "C1", "thread_ts": "100.1"}) + "\n")  # dup
        data = load()
        assert ingest(data) == 1, "dedup ingest"
        save(data)
        # incremental: 新イベントのみ
        with open(EVENTS_PATH, "a", encoding="utf-8") as f:
            f.write(json.dumps({"channel": "C2", "thread_ts": "200.2"}) + "\n")
        data = load()
        assert ingest(data) == 1, "incremental ingest"
        # runs/day cap
        e = data["threads"]["C1:100.1"]
        for _ in range(MAX_RUNS_PER_DAY):
            assert can_run_today(e)
            bump_run(e)
        assert not can_run_today(e), "runs cap"
        # gc: stale processing 回収
        e["status"] = "processing"
        e["last_activity_at"] = (now() - datetime.timedelta(minutes=PROCESSING_STALE_MIN + 1)).strftime(
            "%Y-%m-%dT%H:%M:%S+00:00")
        stats = gc(data)
        assert e["status"] == "open" and stats["reopened"] == 1, "stale processing"
        # gc: TTL close
        e["last_activity_at"] = (now() - datetime.timedelta(days=TTL_DAYS + 1)).strftime(
            "%Y-%m-%dT%H:%M:%S+00:00")
        stats = gc(data)
        assert e["status"] == "closed", "ttl close"
        save(data)
    print("selftest OK")
    return 0


def main() -> int:
    p = argparse.ArgumentParser(description="slack-thread-catchup watchlist")
    p.add_argument("--selftest", action="store_true")
    sub = p.add_subparsers(dest="cmd")

    sp = sub.add_parser("add")
    sp.add_argument("--channel", required=True)
    sp.add_argument("--thread-ts", required=True)
    sp.add_argument("--brief")
    sp.add_argument("--session-id")
    sp.add_argument("--text-head")
    sp.set_defaults(fn=cmd_add)

    sp = sub.add_parser("close")
    sp.add_argument("--id", required=True)
    sp.add_argument("--reason")
    sp.set_defaults(fn=cmd_close)

    sp = sub.add_parser("list")
    sp.add_argument("--status", default="open",
                    choices=["open", "processing", "closed", "all"])
    sp.set_defaults(fn=cmd_list)

    sp = sub.add_parser("seen")
    sp.add_argument("--id", required=True)
    sp.add_argument("--ts", required=True)
    sp.set_defaults(fn=cmd_seen)

    sp = sub.add_parser("ingest")
    sp.set_defaults(fn=cmd_ingest)

    sp = sub.add_parser("gc")
    sp.set_defaults(fn=cmd_gc)

    args = p.parse_args()
    if args.selftest:
        return selftest()
    if not getattr(args, "fn", None):
        p.print_help()
        return 1
    if args.fn is cmd_list:
        return args.fn(args)  # read-only はロック不要
    with locked():
        return args.fn(args)


if __name__ == "__main__":
    sys.exit(main())
