#!/usr/bin/env python3
"""ボット名義の投稿で起こさない判定の回帰テスト（cmd_scan を通しで回す・ネットワーク不要）

守りたい不変条件:

1. **宛先の無いボット名義の投稿では起こさない**（user＝ボットのアカウント・bot_profile.user_id が同じ／
   user 無しの bot_message・subtype=bot_message）。受付ボットの受付表示・エラー表示などで、誰も返事を
   していないのにキャッチアップが起きるのを防ぐ。
1b. **相手の Claude がボット名義でオーナーか自分の Bot に宛てて返した返信では起こす**（本文か blocks の
   メンション）。エージェント同士がスレッドで仕事を進める、この仕組みの本体を止めない。
2. **人が自分のアプリ経由で自分の名義で書いた返信では起こす**（user＝人・bot_id あり・
   bot_profile.user_id なし。User Token で投稿する CLI や各自の Claude 用アプリ）。
   ボット印の有無だけで落とすと、待っていた本物の返信を落とす。オーナー本人の返信も同じ。
3. bot_profile の無いボット投稿は users.info の is_bot で見分け、結果を watchlist に控えて2回目は引かない。
   引けなければ人として扱う（起こす側に倒す）。通信で落ちたら、その scan では以後引かない。
4. 自分の Bot の投稿では起こさない（自己ループ防止）。

本番 state は触らない（state dir・候補ファイル・設定ファイルを一時 dir に差し替える）。
実行: /usr/bin/python3 <このファイル>
"""
from __future__ import annotations

import os
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
TMP = tempfile.mkdtemp(prefix="catchup-bot-author-")
os.environ["SLACK_THREAD_CATCHUP_STATE_DIR"] = TMP
os.environ["SLACK_THREAD_CATCHUP_CANDIDATES"] = os.path.join(TMP, "cand.json")
# 手元の個人設定（~/.claude/.env.claude-slack-agent）を読ませない。必須の3つは架空値で埋める
os.environ["CLAUDE_SLACK_AGENT_ENV"] = os.path.join(TMP, "no-such.env")
os.environ["AGENT_SLACK_CLI"] = "/usr/bin/true"
os.environ["AGENT_DM_CHANNEL"] = "D000TEST01"
os.environ["SLACK_MY_USER_ID"] = "U000OWNER1"
sys.path.insert(0, HERE)

import poller  # noqa: E402
import watchlist  # noqa: E402

# 本番の置き場を読み込んでいたら、ここで止める（本番の台帳を上書きしない）
assert os.path.realpath(watchlist.STATE_DIR) == os.path.realpath(TMP), watchlist.STATE_DIR

SELF_BOT = "U000SELFB1"   # 自分の Bot
OTHER_BOT = "U000OTHRB1"  # 他人の受付ボット（ボットのアカウント）
OWNER = "U000OWNER1"      # オーナー本人
APP_HUMAN = "U000APPHU1"  # 人（自分のアプリ経由で自分の名義で返信する）
HUMAN = "U000HUMAN1"      # 人（素の Slack から返信する）
CH, ROOT = "C000TEST01", "1792656791.298109"
FAILS = []
STATE = {"messages": [], "users_info": {}, "users_info_calls": 0}


def check(name: str, cond: bool) -> None:
    print(("PASS " if cond else "FAIL ") + name)
    if not cond:
        FAILS.append(name)


def fake_api(method, params, token):
    if method == "auth.test":
        return {"ok": True, "user_id": SELF_BOT}
    if method == "conversations.replies":
        return {"ok": True, "messages": [{"ts": ROOT, "user": OWNER, "text": "依頼"}] + STATE["messages"]}
    if method == "users.info":
        STATE["users_info_calls"] += 1
        uid = params["user"]
        if uid not in STATE["users_info"]:
            return {"ok": False, "error": "user_not_found"}
        return {"ok": True, "user": {"id": uid, "is_bot": STATE["users_info"][uid]}}
    raise AssertionError(f"unexpected api: {method}")


poller.slack_api = fake_api
poller.read_bot_token = lambda: "xoxb-dummy"


def reset_watchlist() -> None:
    with watchlist.locked():
        watchlist.save({"threads": {f"{CH}:{ROOT}": watchlist.make_entry(CH, ROOT)}, "events_offset": 0})


def scan() -> list:
    """cmd_scan を1回回し、候補になった返信の投稿者を返す。次の scan に備えて status を open に戻す。"""
    if os.path.exists(poller.CANDIDATES_PATH):
        os.unlink(poller.CANDIDATES_PATH)
    with watchlist.locked():
        rc = poller.cmd_scan()
    if rc != 10:
        return []
    users = [r["user"] for r in poller.load_candidate(0)["new_replies"]]
    with watchlist.locked():
        data = watchlist.load()
        e = data["threads"][f"{CH}:{ROOT}"]
        e["status"], e["run_count"] = "open", 0
        watchlist.save(data)
    return users


def msg(ts: str, **kw) -> dict:
    return {"ts": f"1792659000.{ts}", "text": "返信です", **kw}


# --- 1. ボット名義の投稿では起こさない ---
reset_watchlist()
STATE["messages"] = [msg("000001", user=OTHER_BOT, bot_id="B000OTHR1",
                         bot_profile={"id": "B000OTHR1", "user_id": OTHER_BOT})]
check("ボットのアカウント名義の投稿（bot_profile.user_id が投稿者と同じ）では起こさない", scan() == [])

reset_watchlist()
STATE["messages"] = [msg("000002", bot_id="B000OTHR1", subtype="bot_message")]
check("user の無い bot_message では起こさない", scan() == [])

reset_watchlist()
STATE["messages"] = [msg("000011", bot_id="B000OTHR1", subtype="bot_message", text=f"<@{OWNER}> 通知です")]
check("user の無い bot_message はオーナー宛てのメンションがあっても起こさない", scan() == [])

reset_watchlist()
STATE["messages"] = [msg("000003", user=SELF_BOT, bot_id="B000SELF1",
                         bot_profile={"id": "B000SELF1", "user_id": SELF_BOT},
                         text=f"<@{HUMAN}> 進捗です\ncc: <@{OWNER}>")]
check("自分の Bot の投稿では起こさない（cc でオーナー宛てのメンションが付いていても）", scan() == [])

# --- 1b. 相手の Claude がボット名義で自分宛てに返した返信では起こす（エージェント同士の続き） ---
OTHER_PROFILE = {"id": "B000OTHR1", "user_id": OTHER_BOT}
reset_watchlist()
STATE["messages"] = [msg("000012", user=OTHER_BOT, bot_id="B000OTHR1", bot_profile=OTHER_PROFILE,
                         text=f"<@{OWNER}> ○○さん\ncc: <@U000PEER01>\n確認しました")]
check("相手の Claude がボット名義でオーナー宛てに返した返信では起こす", scan() == [OTHER_BOT])

reset_watchlist()
STATE["messages"] = [msg("000013", user=OTHER_BOT, bot_id="B000OTHR1", bot_profile=OTHER_PROFILE,
                         text=f"<@{SELF_BOT}> 回答です")]
check("自分の Bot 宛てのメンションが付いたボット名義の返信でも起こす", scan() == [OTHER_BOT])

reset_watchlist()
STATE["messages"] = [msg("000014", user=OTHER_BOT, bot_id="B000OTHR1", bot_profile=OTHER_PROFILE, text="回答です",
                         blocks=[{"type": "rich_text", "elements": [{"type": "rich_text_section", "elements": [
                             {"type": "user", "user_id": OWNER}, {"type": "text", "text": " 回答です"}]}]}])]
check("blocks（rich_text の user 要素）でオーナーに宛てた返信でも起こす", scan() == [OTHER_BOT])

reset_watchlist()
STATE["messages"] = [msg("000015", user=OTHER_BOT, bot_id="B000OTHR1", bot_profile=OTHER_PROFILE,
                         text="⏳ 受け付けました。完了したらこのスレッドに投稿します。")]
check("宛先の無い受付表示（ボット名義）では起こさない", scan() == [])

reset_watchlist()
STATE["messages"] = [msg("000016", user=OTHER_BOT, bot_id="B000OTHR1", bot_profile=OTHER_PROFILE,
                         text="⚠️ 一時的に応答できませんでした。<@U000PEER01> さんへ通知しています。")]
check("他人宛てのメンションしか無いエラー表示（ボット名義）では起こさない", scan() == [])

# --- 2. 人のアプリ経由の返信・オーナー本人・素の返信では起こす ---
STATE["users_info"][APP_HUMAN] = False
reset_watchlist()
STATE["messages"] = [msg("000004", user=APP_HUMAN, bot_id="B000APP01", bot_profile={"id": "B000APP01"})]
check("人が自分のアプリ経由で自分の名義で書いた返信では起こす", scan() == [APP_HUMAN])

reset_watchlist()
STATE["messages"] = [msg("000005", user=OWNER, bot_id="B000OWNA1", app_id="A000OWNA1")]
STATE["users_info"][OWNER] = False
check("オーナー本人の User Token 投稿では起こす", scan() == [OWNER])

reset_watchlist()
STATE["messages"] = [msg("000006", user=HUMAN)]
check("素の Slack からの人の返信では起こす", scan() == [HUMAN])

reset_watchlist()
STATE["messages"] = [
    msg("000007", user=OTHER_BOT, bot_id="B000OTHR1", bot_profile={"id": "B000OTHR1", "user_id": OTHER_BOT}),
    msg("000008", user=HUMAN),
]
check("ボットの投稿と人の返信が混ざれば、人の返信だけを数える", scan() == [HUMAN])

# --- 3. bot_profile の無いボット投稿は users.info で見分け、控える ---
STATE["users_info"]["U000NOPRF1"] = True
STATE["users_info_calls"] = 0
reset_watchlist()
STATE["messages"] = [msg("000009", user="U000NOPRF1", bot_id="B000NOPR1")]
check("bot_profile の無いボット投稿は users.info の is_bot で除外する", scan() == [])
calls = STATE["users_info_calls"]
scan()
check("users.info の結果は控え、次の scan では引かない", STATE["users_info_calls"] == calls == 1)
check("控えは watchlist の bot_users に残る",
      watchlist.load().get("bot_users", {}).get("U000NOPRF1") is True)

reset_watchlist()
STATE["messages"] = [msg("000010", user="U000UNKNW1", bot_id="B000UNKN1")]
check("users.info が引けなければ人として扱い起こす", scan() == ["U000UNKNW1"])
check("引けなかった結果は控えない（次の scan でまた引く）",
      "U000UNKNW1" not in watchlist.load().get("bot_users", {}))


def failing_api(method, params, token):
    if method == "users.info":
        STATE["users_info_calls"] += 1
        raise OSError("HTTP Error 429: Too Many Requests")
    return fake_api(method, params, token)


STATE["users_info_calls"] = 0
poller.slack_api = failing_api
entry = {"id": f"{CH}:{ROOT}", "channel": CH, "thread_ts": ROOT, "last_seen_ts": ROOT}
STATE["messages"] = [msg(f"{i:06d}", user=f"U000APP{i:03d}", bot_id="B000APP02") for i in range(100, 130)]
got = poller.fetch_new_replies(entry, "xoxb-dummy", SELF_BOT,
                               is_bot_user=poller.bot_account_lookup("xoxb-dummy", {}))
check("users.info が通信で落ちたら同じ scan では1回しか引かない", STATE["users_info_calls"] == 1)
check("引けなかった返信は人として数える", len(got) == poller.MAX_REPLIES_PER_THREAD)
poller.slack_api = fake_api

# --- 純関数の境界 ---
check("bot_id の無い人の投稿は人", poller.is_bot_author({"user": HUMAN}) is False)
check("user の無い投稿はボット", poller.is_bot_author({"bot_id": "B1"}) is True)
check("subtype=bot_message はボット", poller.is_bot_author({"user": HUMAN, "subtype": "bot_message"}) is True)
check("引く関数が無ければ bot_profile の無いアプリ投稿は人",
      poller.is_bot_author({"user": APP_HUMAN, "bot_id": "B1"}) is False)

print()
if FAILS:
    print(f"FAILED: {len(FAILS)} 件 -> {FAILS}")
    sys.exit(1)
print("all green")
