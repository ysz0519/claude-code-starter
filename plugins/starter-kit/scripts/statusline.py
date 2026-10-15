#!/usr/bin/env python3
# starter-kit:statusline — このファイルは starter-kit のウィザードが置いたもの（更新は /starter-kit:setup）
"""statusline.py — Claude Code のステータスライン（画面下の常時表示）。標準ライブラリのみ・Python 3.9+。

Claude Code が stdin に渡す JSON（model / workspace / cost / context_window / rate_limits / effort …）を読み、
2〜3行を描く。settings.json の statusLine から `/usr/bin/python3 ~/.claude/statusline.py` として呼ばれる。

1行目: フォルダ │ モデル │ effort │ 料金（API 換算の累計）
2行目: 文脈の使用率バー（緑 <60% / 黄 <80% / 赤）と、プランの残り（5時間枠・7日枠・リセットまでの時間）
3行目: git のブランチと差分行数（git リポジトリの中だけ）

試す: echo '{"model":{"display_name":"Opus"},"workspace":{"current_dir":"/tmp"},"context_window":{"used_percentage":42}}' | /usr/bin/python3 statusline.py
"""
import json
import os
import subprocess
import sys
import time

RESET, BOLD, DIM = "\033[0m", "\033[1m", "\033[2m"
WHITE, CYAN, YELLOW, GREEN, RED, GRAY, MAGENTA = "\033[37m", "\033[36m", "\033[33m", "\033[32m", "\033[31m", "\033[90m", "\033[35m"
BAR_WIDTH = 20


def color_by_pct(pct, warn=60, bad=80):
    if pct < warn:
        return GREEN
    if pct < bad:
        return YELLOW
    return RED


def remain(reset_epoch, unit):
    try:
        diff = int(reset_epoch) - int(time.time())
    except (TypeError, ValueError):
        return ""
    if diff <= 0:
        return ""
    if unit == "h":
        return "%dh%02dm" % (diff // 3600, (diff % 3600) // 60)
    return "%dd%dh" % (diff // 86400, (diff % 86400) // 3600)


def usage_cell(label, block, unit):
    if not isinstance(block, dict) or block.get("used_percentage") is None:
        return ""
    try:
        pct = int(round(float(block["used_percentage"])))
    except (TypeError, ValueError):
        return ""
    s = "%s%s%s:%s%d%%%s" % (GRAY, label, RESET, color_by_pct(pct, 50, 80), pct, RESET)
    r = remain(block.get("resets_at"), unit)
    if r:
        s += "%s(↻%s)%s" % (DIM, r, RESET)
    return s


def git_line(cwd):
    if not cwd:
        return ""
    probe = cwd
    found = False
    for _ in range(12):
        if os.path.isdir(os.path.join(probe, ".git")) or os.path.isfile(os.path.join(probe, ".git")):
            found = True
            break
        parent = os.path.dirname(probe)
        if parent == probe:
            break
        probe = parent
    if not found:
        return ""
    try:
        br = subprocess.run(["git", "-C", cwd, "--no-optional-locks", "rev-parse", "--abbrev-ref", "HEAD"],
                            capture_output=True, text=True, timeout=1.5).stdout.strip()
        st = subprocess.run(["git", "-C", cwd, "--no-optional-locks", "diff", "--shortstat", "HEAD"],
                            capture_output=True, text=True, timeout=1.5).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return ""
    if not br:
        return ""
    added = deleted = 0
    for part in st.split(","):
        part = part.strip()
        if part.endswith(("insertion(+)", "insertions(+)")):
            added = int(part.split()[0])
        elif part.endswith(("deletion(-)", "deletions(-)")):
            deleted = int(part.split()[0])
    diff = "%s+%d%s %s-%d%s" % (GREEN, added, RESET, RED, deleted, RESET) if st else "%sno changes%s" % (GRAY, RESET)
    return "%sgit%s %s%s%s %s" % (GRAY, RESET, MAGENTA, br, RESET, diff)


def main():
    try:
        data = json.load(sys.stdin)
    except ValueError:
        data = {}
    if not isinstance(data, dict):
        data = {}
    model = (data.get("model") or {}).get("display_name") or "Claude"
    ws = data.get("workspace") or {}
    cwd = ws.get("current_dir") or data.get("cwd") or os.getcwd()
    folder = os.path.basename(cwd.rstrip("/")) or cwd
    ctx = (data.get("context_window") or {}).get("used_percentage")
    cost = (data.get("cost") or {}).get("total_cost_usd")
    effort = (data.get("effort") or {}).get("level") or ""
    fast = bool(data.get("fast_mode"))
    vim = (data.get("vim") or {}).get("mode")
    rl = data.get("rate_limits") or {}

    line1 = "%s%s%s%s %s|%s %s%s%s" % (BOLD, WHITE, folder, RESET, DIM, RESET, CYAN, model, RESET)
    if effort:
        line1 += " %s|%s %seffort:%s%s" % (DIM, RESET, GRAY, RESET, effort)
    if cost is not None:
        try:
            line1 += " %s|%s %s$%.2f%s%s(API換算)%s" % (DIM, RESET, YELLOW, float(cost), RESET, DIM, RESET)
        except (TypeError, ValueError):
            pass
    if fast:
        line1 += " %s⚡fast%s" % (YELLOW, RESET)
    if vim:
        line1 += " %s[%s]%s" % (YELLOW if vim == "NORMAL" else GREEN, vim, RESET)

    if ctx is not None:
        try:
            pct = int(round(float(ctx)))
        except (TypeError, ValueError):
            pct = None
    else:
        pct = None
    if pct is None:
        bar = GRAY + "░" * BAR_WIDTH + RESET
        pct_s = "--"
    else:
        filled = max(0, min(BAR_WIDTH, int(pct * BAR_WIDTH / 100)))
        bar = color_by_pct(pct) + "█" * filled + GRAY + "░" * (BAR_WIDTH - filled) + RESET
        pct_s = "%d%%" % pct
    line2 = "ctx %s %s%s%s" % (bar, GRAY, pct_s, RESET)
    cells = [c for c in (usage_cell("5h", rl.get("five_hour"), "h"), usage_cell("7d", rl.get("seven_day"), "d")) if c]
    if cells:
        line2 += "  " + "  ".join(cells)

    out = [line1, line2]
    g = git_line(cwd)
    if g:
        out.append(g)
    sys.stdout.write("\n".join(out) + "\n")


if __name__ == "__main__":
    main()
