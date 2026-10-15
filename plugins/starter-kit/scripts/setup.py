#!/usr/bin/env python3
"""setup.py — Claude Code 初期セットアップの機械部分（純プログラム・標準ライブラリのみ・Python 3.9+）。

Claude（スキル start）が質問して集めた答え（answers.json）を受け取り、設定ファイルを冪等に書く。
質問・説明・インストールの実行は SKILL.md 側（Claude）が担い、ここは何も聞かず、何もインストールしない。

使い方:
  setup.py preflight [--json]                 環境と各項目の現状を調べる。何も書かない
  setup.py plan   [--answers <json>] [--json] 答えから「書くもの・入れるもの・人がやるもの」を出す。何も書かない
  setup.py apply  [--answers <json>] [--json] 設定を冪等に書く（2回目以降は「変更なし」）
  setup.py status [--json|--text]             各項目の現状表（問い合わせ時はこの出力を貼ってもらう）

answers.json（Claude が Write で書く・既定の置き場は <config>/state/starter-kit/answers.json）:
  {"permission_mode": "auto|acceptEdits|default|keep",
   "notifications": true,
   "persona": "polite_ja|casual_ja|en|skip",
   "github": "login|identity_only|skip", "git_name": "", "git_email": "",
   "browser": "playwright|chrome|both|none",
   "extras": ["docs_mcp", "doc_tools", "google", "slack"],
   "statusline": true|false|"replace"}

終了コード: 0=成功 / 1=前提の不合格・答えの不備（stderr に人が読む1行）/ 2=引数・環境エラー
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import platform
import shlex
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

HERE = Path(__file__).resolve().parent
MARK = "starter-kit"
STATUSLINE_MARKER = "# starter-kit:statusline"
BLOCK_START = "<!-- >>> starter-kit >>> -->"
BLOCK_END = "<!-- <<< starter-kit <<< -->"
PLAYWRIGHT_MCP_VERSION = "0.0.83"
DOCS_MCP_URL = "https://code.claude.com/docs/mcp"
DOCS_MCP_NAME = "claude-docs"
PLAYWRIGHT_MCP_NAME = "playwright"
CHROME_HOST_MANIFEST = Path.home() / "Library/Application Support/Google/Chrome/NativeMessagingHosts/com.anthropic.claude_code_browser_extension.json"
CHROME_APP_PATHS = [Path("/Applications/Google Chrome.app"), Path.home() / "Applications/Google Chrome.app"]
DENY_RULES = [
    "Bash(sudo *)",
    "Bash(rm -rf /)",
    "Bash(rm -rf /*)",
    "Bash(rm -rf ~)",
    "Bash(rm -rf ~/*)",
    "Bash(git push --force *)",
    "Bash(git push -f *)",
    "Bash(git reset --hard *)",
    "Read(**/.env)",
    "Read(**/.env.*)",
    "Read(**/*.pem)",
    "Read(**/*.key)",
    "Read(**/*id_rsa*)",
    "Read(**/*id_ed25519*)",
    "Read(~/.ssh/**)",
    "Read(~/.aws/**)",
]
PERMISSION_MODES = ("auto", "acceptEdits", "default", "keep")
PERSONAS = ("polite_ja", "casual_ja", "en", "skip")
GITHUB_CHOICES = ("login", "identity_only", "skip")
BROWSER_CHOICES = ("playwright", "chrome", "both", "none")
EXTRA_CHOICES = ("docs_mcp", "doc_tools", "google", "slack")
STATUSLINE_CHOICES = (True, False, "replace")

ITEM_LABELS = {
    "statusline": "ステータスライン（画面下の常時表示）",
    "permissions": "権限の既定と安全弁",
    "notifications": "デスクトップ通知",
    "claude_md": "個人用 CLAUDE.md（話し方・やらないこと）",
    "git_identity": "git の名前とメールアドレス",
    "github": "GitHub（gh コマンド）",
    "browser_playwright": "ブラウザ操作（Playwright）",
    "browser_chrome_ext": "ブラウザ操作（Claude in Chrome 拡張）",
    "docs_mcp": "公式ドキュメント MCP",
    "doc_tools": "文書変換（pandoc・markitdown）",
    "google": "Google Workspace（gog）",
    "slack": "Slack",
    "terminal": "ターミナル",
}
ITEM_ORDER = ["statusline", "permissions", "notifications", "claude_md", "git_identity", "github", "terminal",
              "browser_playwright", "browser_chrome_ext", "docs_mcp", "doc_tools", "google", "slack"]

PERSONA_BLOCKS = {
    "polite_ja": """## 基本姿勢
- 日本語（です・ます調）で、結論から簡潔に答える
- 専門用語には1行の注釈を付ける
- 分からないことは推測せず、質問する

## やらないこと（必ず人に確認してから）
- ファイル・フォルダの削除
- 新しいソフト・パッケージのインストール
- 料金が発生する操作（有料 API・広告・購入）
- 戻せない外部送信（メール送信・SNS 投稿・公開）

## 進め方
- 3ステップ以上の作業は、先に手順を示してから着手する
- 終わったら「何をしたか・何が変わったか・次に何をするか」を短く報告する""",
    "casual_ja": """## 基本姿勢
- 日本語でフランクに、結論から短く答える
- 専門用語には1行の注釈を付ける
- 分からないことは推測せず、聞く

## やらないこと（必ず人に確認してから）
- ファイル・フォルダの削除
- 新しいソフト・パッケージのインストール
- 料金が発生する操作（有料 API・広告・購入）
- 戻せない外部送信（メール送信・SNS 投稿・公開）

## 進め方
- 3ステップ以上の作業は、先に手順を見せてから始める
- 終わったら「やったこと・変わったこと・次にやること」を短く報告する""",
    "en": """## Working style
- Answer in English, conclusion first, briefly
- Add a one-line note for technical terms
- Ask instead of guessing when something is unclear

## Never do without asking a human first
- Delete files or folders
- Install new software or packages
- Anything that costs money (paid APIs, ads, purchases)
- Irreversible external actions (sending email, posting, publishing)

## How to work
- For tasks with 3+ steps, show the plan before starting
- When done, report briefly: what you did, what changed, what comes next""",
}


# ---------------------------------------------------------------------------- 小さな道具
def _run(cmd: List[str], timeout: int = 20, env: Optional[Dict[str, str]] = None) -> Tuple[int, str, str]:
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, env=env)
        return r.returncode, r.stdout or "", r.stderr or ""
    except (OSError, subprocess.SubprocessError) as e:
        return 127, "", str(e)


def _which(name: str) -> Optional[str]:
    p = shutil.which(name)
    if p:
        return p
    for cand in (Path.home() / ".local/bin" / name, Path("/opt/homebrew/bin") / name, Path("/usr/local/bin") / name):
        if cand.exists() and os.access(str(cand), os.X_OK):
            return str(cand)
    return None


def _now() -> str:
    return dt.datetime.now().strftime("%Y%m%d-%H%M%S")


def _atomic_write_text(p: Path, text: str, mode: Optional[int] = None) -> None:
    p.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".tmp.", dir=str(p.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(text)
            f.flush()
            os.fsync(f.fileno())
        if mode is not None:
            os.chmod(tmp, mode)
        elif p.exists():
            os.chmod(tmp, p.stat().st_mode & 0o777)
        os.replace(tmp, p)
    except Exception:
        try:
            os.remove(tmp)
        except OSError:
            pass
        raise


def _load_json(p: Path) -> Tuple[Dict[str, Any], Optional[str]]:
    """(dict, error). ファイルが無ければ ({}, None)。壊れていれば ({}, 'reason') で、呼び手は書かない。"""
    if not p.exists():
        return {}, None
    try:
        d = json.loads(p.read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        return {}, f"{p} を JSON として読めません: {e}"
    if not isinstance(d, dict):
        return {}, f"{p} の最上位がオブジェクトではありません"
    return d, None


def _dump_json(d: Dict[str, Any]) -> str:
    return json.dumps(d, ensure_ascii=False, indent=2) + "\n"


# ---------------------------------------------------------------------------- 置き場
class Paths:
    def __init__(self) -> None:
        cfg = os.environ.get("CLAUDE_CONFIG_DIR", "").strip()
        self.config_dir = Path(cfg).expanduser() if cfg else Path.home() / ".claude"
        self.claude_json = (self.config_dir / ".claude.json") if cfg else (Path.home() / ".claude.json")
        self.settings = self.config_dir / "settings.json"
        self.claude_md = self.config_dir / "CLAUDE.md"
        self.statusline_dst = self.config_dir / "statusline.py"
        self.state_dir = self.config_dir / "state" / "starter-kit"
        self.answers = self.state_dir / "answers.json"
        self.playwright_profile = self.config_dir / "playwright-profile"
        self.playwright_output = self.config_dir / "playwright-output"

    def display(self, p: Path) -> str:
        s = str(p)
        home = str(Path.home())
        return "~" + s[len(home):] if s.startswith(home) else s


# ---------------------------------------------------------------------------- 環境の検出
def detect_env(paths: Paths) -> Dict[str, Any]:
    env: Dict[str, Any] = {}
    env["os"] = platform.system()
    env["macos_version"] = platform.mac_ver()[0] if platform.system() == "Darwin" else ""
    env["python"] = platform.python_version()
    env["shell"] = os.path.basename(os.environ.get("SHELL", ""))
    env["terminal"] = os.environ.get("TERM_PROGRAM", "")
    env["config_dir"] = str(paths.config_dir)

    claude = _which("claude")
    env["claude_path"] = claude
    env["claude_version"] = None
    env["login"] = {"ok": False, "method": None, "email": None, "plan": None}
    if claude:
        rc, out, _ = _run([claude, "--version"], timeout=20)
        if rc == 0:
            env["claude_version"] = out.strip().split()[0] if out.strip() else None
        rc, out, _ = _run([claude, "auth", "status", "--json"], timeout=25)
        if rc == 0 and out.strip():
            try:
                a = json.loads(out)
                env["login"] = {"ok": bool(a.get("loggedIn")), "method": a.get("authMethod"),
                                "email": a.get("email"), "plan": a.get("subscriptionType")}
            except ValueError:
                pass

    rc, _, _ = _run(["xcode-select", "-p"], timeout=10)
    env["clt"] = rc == 0
    env["git"] = bool(_which("git")) and env["clt"]
    env["homebrew"] = _which("brew")
    node = _which("node")
    env["node"] = None
    if node:
        rc, out, _ = _run([node, "-v"], timeout=10)
        env["node"] = out.strip() if rc == 0 else None
    env["npx"] = bool(_which("npx"))
    gh = _which("gh")
    env["gh"] = {"installed": bool(gh), "logged_in": False}
    if gh:
        rc, _, _ = _run([gh, "auth", "status"], timeout=20)
        env["gh"]["logged_in"] = rc == 0
    env["git_name"] = ""
    env["git_email"] = ""
    if env["git"]:
        rc, out, _ = _run(["git", "config", "--global", "user.name"], timeout=10)
        env["git_name"] = out.strip() if rc == 0 else ""
        rc, out, _ = _run(["git", "config", "--global", "user.email"], timeout=10)
        env["git_email"] = out.strip() if rc == 0 else ""
    env["chrome_app"] = any(p.exists() for p in CHROME_APP_PATHS)
    env["chrome_ext_host"] = CHROME_HOST_MANIFEST.exists()
    env["pandoc"] = bool(_which("pandoc"))
    env["markitdown"] = bool(_which("markitdown"))
    gog = _which("gog")
    env["gog"] = {"installed": bool(gog), "accounts": 0}
    if gog:
        rc, out, _ = _run([gog, "auth", "list", "--plain"], timeout=20)
        if rc == 0:
            env["gog"]["accounts"] = len([ln for ln in out.splitlines() if "@" in ln])
    cj, _ = _load_json(paths.claude_json)
    env["mcp_servers"] = {k: v for k, v in (cj.get("mcpServers") or {}).items() if isinstance(v, dict)}
    return env


def _mcp_entry_text(v: Dict[str, Any]) -> str:
    if v.get("url"):
        return str(v.get("url"))
    return " ".join([str(v.get("command", ""))] + [str(a) for a in (v.get("args") or [])])


def detect_items(paths: Paths, env: Dict[str, Any], settings: Dict[str, Any], settings_err: Optional[str]) -> Dict[str, Dict[str, Any]]:
    items: Dict[str, Dict[str, Any]] = {}

    sl = settings.get("statusLine") if isinstance(settings.get("statusLine"), dict) else None
    ours_file = _statusline_is_ours(paths.statusline_dst)
    if sl and str(paths.statusline_dst) in str(sl.get("command", "")) and ours_file:
        items["statusline"] = {"state": "done", "detail": f"導入済み（{paths.display(paths.statusline_dst)}）"}
    elif sl and sl.get("command"):
        items["statusline"] = {"state": "other", "detail": "別のステータスラインが設定済み（置き換えるときは statusline を replace にする）"}
    elif paths.statusline_dst.exists() and not ours_file:
        items["statusline"] = {"state": "other", "detail": f"{paths.display(paths.statusline_dst)} に別のファイルがある（置き換えるときは statusline を replace にする）"}
    else:
        items["statusline"] = {"state": "todo", "detail": "未設定"}

    perms = settings.get("permissions") if isinstance(settings.get("permissions"), dict) else {}
    mode = perms.get("defaultMode")
    deny = perms.get("deny") if isinstance(perms.get("deny"), list) else []
    missing = [r for r in DENY_RULES if r not in deny]
    if mode and not missing:
        items["permissions"] = {"state": "done", "detail": f"運転モード {mode}・安全弁 {len(DENY_RULES)} 本", "mode": mode, "deny_missing": 0}
    elif mode or len(missing) < len(DENY_RULES):
        items["permissions"] = {"state": "partial", "detail": f"運転モード {mode or '未設定（既定の auto）'}・安全弁 不足 {len(missing)} 本", "mode": mode, "deny_missing": len(missing)}
    else:
        items["permissions"] = {"state": "todo", "detail": "運転モード未設定（既定の auto）・安全弁なし", "mode": None, "deny_missing": len(missing)}

    tagged = _find_tagged_hooks(settings)
    if {"notify-permission", "notify-idle", "notify-stop"} <= set(tagged):
        items["notifications"] = {"state": "done", "detail": "許可待ち・入力待ち・作業完了の3種"}
    elif tagged:
        items["notifications"] = {"state": "partial", "detail": f"一部だけ（{', '.join(sorted(tagged))}）"}
    else:
        items["notifications"] = {"state": "todo", "detail": "未設定"}

    if paths.claude_md.exists():
        text = paths.claude_md.read_text(encoding="utf-8", errors="ignore")
        if BLOCK_START in text and BLOCK_END in text:
            items["claude_md"] = {"state": "done", "detail": f"設定済み（{paths.display(paths.claude_md)}）"}
        else:
            items["claude_md"] = {"state": "partial", "detail": "ファイルはあるが、このウィザードの区間は無い（末尾に足す）"}
    else:
        items["claude_md"] = {"state": "todo", "detail": "未作成"}

    if env["git_name"] and env["git_email"]:
        items["git_identity"] = {"state": "done", "detail": f"{env['git_name']} <{env['git_email']}>"}
    elif env["git_name"] or env["git_email"]:
        items["git_identity"] = {"state": "partial", "detail": "名前かメールの片方だけ"}
    else:
        items["git_identity"] = {"state": "todo", "detail": "未設定"}

    gh = env["gh"]
    if gh["installed"] and gh["logged_in"]:
        items["github"] = {"state": "done", "detail": "gh ログイン済み"}
    elif gh["installed"]:
        items["github"] = {"state": "partial", "detail": "gh は入っているが未ログイン（gh auth login -w）"}
    else:
        items["github"] = {"state": "todo", "detail": "gh 未導入"}

    term = env.get("terminal") or "不明"
    items["terminal"] = {"state": "info", "detail": f"{term}（iTerm2 推奨・Claude Code 内で /terminal-setup）"}

    mcps = env["mcp_servers"]
    pw = mcps.get(PLAYWRIGHT_MCP_NAME)
    if pw and "@playwright/mcp" in _mcp_entry_text(pw):
        ours = f"@playwright/mcp@{PLAYWRIGHT_MCP_VERSION}" in _mcp_entry_text(pw)
        items["browser_playwright"] = {"state": "done", "detail": "登録済み" + ("" if ours else "（別の版・設定）"), "ours": ours}
    elif pw:
        items["browser_playwright"] = {"state": "other", "detail": "playwright という名前の別の MCP が登録済み"}
    else:
        items["browser_playwright"] = {"state": "todo", "detail": "未登録" + ("" if env["node"] else "・Node.js も未導入")}

    if env["chrome_ext_host"]:
        items["browser_chrome_ext"] = {"state": "done", "detail": "接続設定あり（/chrome で状態を確認）"}
    else:
        items["browser_chrome_ext"] = {"state": "todo", "detail": "未接続（拡張を入れて /chrome）" if env["chrome_app"] else "Google Chrome 未導入"}

    if any("code.claude.com/docs/mcp" in _mcp_entry_text(v) for v in mcps.values()):
        items["docs_mcp"] = {"state": "done", "detail": "登録済み"}
    elif DOCS_MCP_NAME in mcps:
        items["docs_mcp"] = {"state": "other", "detail": f"{DOCS_MCP_NAME} という名前の別の MCP が登録済み"}
    else:
        items["docs_mcp"] = {"state": "todo", "detail": "未登録"}

    if env["pandoc"] and env["markitdown"]:
        items["doc_tools"] = {"state": "done", "detail": "pandoc・markitdown"}
    elif env["pandoc"] or env["markitdown"]:
        items["doc_tools"] = {"state": "partial", "detail": "pandoc" if env["pandoc"] else "markitdown" + " だけ"}
    else:
        items["doc_tools"] = {"state": "todo", "detail": "未導入"}

    g = env["gog"]
    if g["installed"] and g["accounts"]:
        items["google"] = {"state": "done", "detail": f"gog 認証済み（{g['accounts']} アカウント）"}
    elif g["installed"]:
        items["google"] = {"state": "partial", "detail": "gog は入っているが未認証"}
    else:
        items["google"] = {"state": "todo", "detail": "未導入"}

    items["slack"] = {"state": "info", "detail": "案内のみ（通知だけ／公式の Claude in Slack／自前の Bot）"}
    if settings_err:
        items["_settings_error"] = {"state": "error", "detail": settings_err}
    return items


def _statusline_is_ours(p: Path) -> bool:
    """置いたファイルの先頭に所有マーカーがあるか（利用者が自作した同名ファイルを上書きしないため）。"""
    try:
        with open(p, "r", encoding="utf-8", errors="ignore") as f:
            return STATUSLINE_MARKER in f.read(2048)
    except OSError:
        return False


def _find_tagged_hooks(settings: Dict[str, Any]) -> Dict[str, Dict[str, Any]]:
    found: Dict[str, Dict[str, Any]] = {}
    hooks = settings.get("hooks") if isinstance(settings.get("hooks"), dict) else {}
    for event, groups in hooks.items():
        if not isinstance(groups, list):
            continue
        for g in groups:
            for h in (g.get("hooks") or []) if isinstance(g, dict) else []:
                cmd = str(h.get("command", "")) if isinstance(h, dict) else ""
                tag = _tag_of(cmd)
                if tag:
                    found[tag] = h
    return found


def _tag_of(command: str) -> Optional[str]:
    key = f"# {MARK}:"
    if key in command:
        return command.split(key, 1)[1].strip().split()[0]
    return None


# ---------------------------------------------------------------------------- preflight
def preflight(paths: Paths) -> Tuple[Dict[str, Any], int]:
    env = detect_env(paths)
    settings, serr = _load_json(paths.settings)
    items = detect_items(paths, env, settings, serr)
    stop: List[Dict[str, str]] = []
    if env["os"] != "Darwin":
        stop.append({"code": "not_macos", "hint": "このウィザードは macOS 専用です（Windows・Linux は対象外）"})
    if not env["claude_path"]:
        stop.append({"code": "claude_missing", "hint": "claude コマンドが見つかりません。手順書の「インストール」をやり直してください"})
    if not env["clt"]:
        stop.append({"code": "clt_missing", "hint": "Command Line Tools が未導入です。ターミナルで xcode-select --install を実行してください"})
    if serr:
        stop.append({"code": "settings_broken", "hint": serr})
    prev, _ = _load_json(paths.answers)
    out = {
        "ok": not stop,
        "stop_reasons": stop,
        "env": env,
        "items": items,
        "answers_path": str(paths.answers),
        "previous_answers": prev or None,
        "notes": _notes(env),
    }
    return out, (0 if not stop else 1)


def _notes(env: Dict[str, Any]) -> List[str]:
    notes = []
    if not env["login"]["ok"]:
        notes.append("Claude にログインしていません。ステータスラインの残量表示とブラウザ拡張はログイン後に動きます（claude を起動して /login）")
    elif env["login"].get("method") not in (None, "claude.ai"):
        notes.append("API キー（または長期トークン）でのログインです。Claude in Chrome 拡張は使えず、料金は従量課金になります")
    if not env["homebrew"]:
        notes.append("Homebrew が未導入です。追加の道具（gh・Node.js・pandoc 等）を入れるには先に Homebrew が要ります")
    if env.get("terminal") == "Apple_Terminal":
        notes.append("Terminal.app を使っています。iTerm2 にすると通知・リンク・改行キーの体験が良くなります（任意）")
    return notes


# ---------------------------------------------------------------------------- answers
def load_answers(path: Path) -> Dict[str, Any]:
    d, err = _load_json(path)
    if err:
        raise SystemExit(f"answers: {err}")
    if not d:
        raise SystemExit(f"answers: {path} がありません（Claude が質問の答えを書いてから実行します）")
    problems = []
    a: Dict[str, Any] = {}
    a["permission_mode"] = d.get("permission_mode", "keep")
    if a["permission_mode"] not in PERMISSION_MODES:
        problems.append(f"permission_mode は {PERMISSION_MODES} のどれか")
    a["notifications"] = bool(d.get("notifications", False))
    a["persona"] = d.get("persona", "skip")
    if a["persona"] not in PERSONAS:
        problems.append(f"persona は {PERSONAS} のどれか")
    a["github"] = d.get("github", "skip")
    if a["github"] not in GITHUB_CHOICES:
        problems.append(f"github は {GITHUB_CHOICES} のどれか")
    a["git_name"] = str(d.get("git_name", "") or "").strip()
    a["git_email"] = str(d.get("git_email", "") or "").strip()
    if a["git_email"] and "@" not in a["git_email"]:
        problems.append("git_email がメールアドレスの形ではありません")
    a["browser"] = d.get("browser", "none")
    if a["browser"] not in BROWSER_CHOICES:
        problems.append(f"browser は {BROWSER_CHOICES} のどれか")
    extras = d.get("extras", [])
    if not isinstance(extras, list) or any(e not in EXTRA_CHOICES for e in extras):
        problems.append(f"extras は {EXTRA_CHOICES} の配列")
        extras = []
    a["extras"] = list(dict.fromkeys(extras))
    a["statusline"] = d.get("statusline", True)
    if a["statusline"] not in STATUSLINE_CHOICES:
        problems.append("statusline は true / false / \"replace\" のどれか")
    if problems:
        raise SystemExit("answers の不備: " + "／".join(problems))
    return a


# ---------------------------------------------------------------------------- plan
def make_plan(paths: Paths, a: Dict[str, Any]) -> Dict[str, Any]:
    env = detect_env(paths)
    settings, serr = _load_json(paths.settings)
    if serr:
        raise SystemExit(serr)
    items = detect_items(paths, env, settings, None)
    actions: List[Dict[str, Any]] = []
    installs: List[Dict[str, Any]] = []
    manual: List[Dict[str, Any]] = []
    skipped: List[Dict[str, str]] = []

    # ステータスライン
    st = items["statusline"]["state"]
    if a["statusline"] is False:
        skipped.append({"id": "statusline", "reason": "入れない（答え）"})
    elif st == "done":
        actions.append({"id": "statusline", "label": ITEM_LABELS["statusline"], "detail": "最新のスクリプトに更新（設定はそのまま）"})
    elif st == "other" and a["statusline"] != "replace":
        skipped.append({"id": "statusline", "reason": "別のステータスラインがあるので残す（置き換えるなら statusline を \"replace\"）"})
    else:
        actions.append({"id": "statusline", "label": ITEM_LABELS["statusline"],
                        "detail": f"{paths.display(paths.statusline_dst)} を置き、settings.json の statusLine に登録"})

    # 権限
    pm = a["permission_mode"]
    missing = items["permissions"]["deny_missing"]
    if pm == "keep" and missing == 0:
        skipped.append({"id": "permissions", "reason": "変更なし（運転モードはそのまま・安全弁は揃っている）"})
    else:
        d = []
        if pm != "keep":
            d.append(f"運転モードを {pm} にする")
        if missing:
            d.append(f"安全弁（deny）を {missing} 本足す")
        actions.append({"id": "permissions", "label": ITEM_LABELS["permissions"], "detail": "・".join(d)})

    # 通知
    if a["notifications"]:
        if items["notifications"]["state"] == "done":
            skipped.append({"id": "notifications", "reason": "設定済み"})
        else:
            actions.append({"id": "notifications", "label": ITEM_LABELS["notifications"],
                            "detail": "許可待ち・入力待ち・作業完了で macOS の通知を出す（hooks に3本）"})
            manual.append({"id": "notifications", "label": "通知の許可",
                           "steps": ["初回の通知のあと、macOS の「システム設定 → 通知」で Script Editor（osascript）の通知を許可する"]})
    else:
        skipped.append({"id": "notifications", "reason": "鳴らさない（答え）"})

    # CLAUDE.md
    if a["persona"] == "skip":
        skipped.append({"id": "claude_md", "reason": "作らない（答え）"})
    else:
        verb = "更新" if items["claude_md"]["state"] == "done" else ("末尾に区間を追加" if items["claude_md"]["state"] == "partial" else "新規作成")
        actions.append({"id": "claude_md", "label": ITEM_LABELS["claude_md"], "detail": f"{paths.display(paths.claude_md)} を{verb}（{a['persona']}）"})

    # git の名前・GitHub
    if a["github"] == "skip":
        skipped.append({"id": "github", "reason": "今はしない（答え）"})
    else:
        if (a["git_name"] and not env["git_name"]) or (a["git_email"] and not env["git_email"]):
            actions.append({"id": "git_identity", "label": ITEM_LABELS["git_identity"],
                            "detail": f"git config --global に {a['git_name'] or '（名前は既存）'} / {a['git_email'] or '（メールは既存）'} を登録（既存の値は上書きしない）"})
        elif env["git_name"] and env["git_email"]:
            skipped.append({"id": "git_identity", "reason": f"設定済み（{env['git_name']}）"})
        if a["github"] == "login":
            if not env["gh"]["installed"]:
                if env["homebrew"]:
                    installs.append({"id": "gh", "label": "GitHub の操作コマンド（gh）", "command": "brew install gh", "minutes": 2})
                else:
                    skipped.append({"id": "github", "reason": "Homebrew が無いので gh を入れられない（先に Homebrew）"})
            if not env["gh"]["logged_in"]:
                manual.append({"id": "github", "label": "GitHub にログイン",
                               "steps": ["別のターミナルで gh auth login -w を実行し、ブラウザで承認する",
                                         "続けて gh auth setup-git を実行する（git の認証を gh に任せる）",
                                         "終わったら /starter-kit:status で確認する"]})

    # ブラウザ
    b = a["browser"]
    if b in ("playwright", "both"):
        if items["browser_playwright"]["state"] == "done" and items["browser_playwright"].get("ours"):
            skipped.append({"id": "browser_playwright", "reason": "登録済み"})
        elif items["browser_playwright"]["state"] == "other":
            skipped.append({"id": "browser_playwright", "reason": "playwright という名前の別の MCP があるので触らない"})
        else:
            if not env["node"]:
                if env["homebrew"]:
                    installs.append({"id": "node", "label": "Node.js（Playwright MCP を動かすのに必要）", "command": "brew install node", "minutes": 3})
                else:
                    skipped.append({"id": "browser_playwright", "reason": "Node.js が無く Homebrew も無い（先に Homebrew）"})
            if not env["chrome_app"]:
                manual.append({"id": "chrome_app", "label": "Google Chrome を入れる",
                               "steps": ["https://www.google.com/chrome/ から Chrome を入れる（Playwright は手元の Chrome を使う）"]})
            actions.append({"id": "browser_playwright", "label": ITEM_LABELS["browser_playwright"],
                            "detail": f"MCP『{PLAYWRIGHT_MCP_NAME}』を登録（@playwright/mcp@{PLAYWRIGHT_MCP_VERSION}・手元の Chrome・専用プロファイル {paths.display(paths.playwright_profile)}）",
                            "needs": ["node"] if not env["node"] else []})
    if b in ("chrome", "both"):
        if items["browser_chrome_ext"]["state"] == "done":
            skipped.append({"id": "browser_chrome_ext", "reason": "接続設定あり"})
        else:
            steps = []
            if not env["chrome_app"]:
                steps.append("https://www.google.com/chrome/ から Chrome を入れる")
            steps += ["Chrome ウェブストアで「Claude in Chrome」拡張を入れ、Claude（Pro/Max）でログインする: https://chromewebstore.google.com/detail/claude/fcoeoabgfenejglbffodgkkbkcdhcgfn",
                      "Claude Code で /chrome を実行し「Enabled by default」を選ぶ（Status: Enabled / Extension: Installed になれば完了）"]
            if not env["login"]["ok"] or env["login"].get("method") not in (None, "claude.ai"):
                steps.append("注意: 拡張は claude.ai のログイン（Pro/Max/Team/Enterprise）でだけ動く。API キーのログインでは使えない")
            manual.append({"id": "browser_chrome_ext", "label": "Claude in Chrome 拡張", "steps": steps})
    if b == "none":
        skipped.append({"id": "browser", "reason": "入れない（答え）"})

    # 追加の道具
    ex = a["extras"]
    if "docs_mcp" in ex:
        if items["docs_mcp"]["state"] == "done":
            skipped.append({"id": "docs_mcp", "reason": "登録済み"})
        elif items["docs_mcp"]["state"] == "other":
            skipped.append({"id": "docs_mcp", "reason": f"{DOCS_MCP_NAME} という名前の別の MCP があるので触らない"})
        else:
            actions.append({"id": "docs_mcp", "label": ITEM_LABELS["docs_mcp"], "detail": f"MCP『{DOCS_MCP_NAME}』を登録（{DOCS_MCP_URL}・認証不要）"})
    if "doc_tools" in ex:
        if items["doc_tools"]["state"] == "done":
            skipped.append({"id": "doc_tools", "reason": "導入済み"})
        elif not env["homebrew"]:
            skipped.append({"id": "doc_tools", "reason": "Homebrew が無い（先に Homebrew）"})
        else:
            if not env["pandoc"]:
                installs.append({"id": "pandoc", "label": "pandoc（Word などの変換）", "command": "brew install pandoc", "minutes": 2})
            if not env["markitdown"]:
                installs.append({"id": "markitdown", "label": "markitdown（PowerPoint・Excel・PDF を文章にする）",
                                 "command": "brew install pipx && pipx ensurepath && pipx install \"markitdown[pptx,xlsx,docx,pdf]\"", "minutes": 5})
    if "google" in ex:
        if items["google"]["state"] == "done":
            skipped.append({"id": "google", "reason": "認証済み"})
        else:
            if not env["gog"]["installed"]:
                if env["homebrew"]:
                    installs.append({"id": "gog", "label": "gog（Gmail・カレンダー・Drive・スプレッドシートの操作コマンド）",
                                     "command": "brew install openclaw/tap/gogcli", "minutes": 3})
                else:
                    skipped.append({"id": "google", "reason": "Homebrew が無い（先に Homebrew）"})
            manual.append({"id": "google", "label": "Google Workspace の認証（所要 15 分・Google Cloud の画面操作あり）",
                           "steps": ["docs/google-workspace.md の手順で OAuth クライアント（デスクトップ）の JSON を作る",
                                     "gog auth credentials ~/Downloads/client_secret_*.json",
                                     "gog auth add あなたのメール --services gmail,calendar,drive,docs,sheets",
                                     "gog auth list --check で確認する"]})
    if "slack" in ex:
        manual.append({"id": "slack", "label": "Slack（3つの選び方）",
                       "steps": ["docs/slack.md を読んで「通知だけ」「公式の Claude in Slack / Claude Tag」「自前の Bot」から選ぶ"]})

    return {
        "ok": True,
        "answers": a,
        "config_actions": actions,
        "install_commands": installs,
        "manual_steps": manual,
        "skipped": skipped,
        "settings_path": str(paths.settings),
        "restart_required": bool(actions),
        "summary": _plan_summary(actions, installs, manual, skipped),
    }


def _plan_summary(actions, installs, manual, skipped) -> List[str]:
    lines = []
    for x in actions:
        lines.append(f"設定: {x['label']} … {x['detail']}")
    for x in installs:
        lines.append(f"導入: {x['label']} … `{x['command']}`（約 {x['minutes']} 分）")
    for x in manual:
        lines.append(f"人がやる: {x['label']}")
    for x in skipped:
        lines.append(f"飛ばす: {x['id']} … {x['reason']}")
    return lines


# ---------------------------------------------------------------------------- apply
class Applier:
    def __init__(self, paths: Paths, a: Dict[str, Any]) -> None:
        self.paths = paths
        self.a = a
        self.env = detect_env(paths)
        self.settings, err = _load_json(paths.settings)
        if err:
            raise SystemExit(err)
        self.settings_before = json.dumps(self.settings, sort_keys=True)
        self.had_settings = paths.settings.exists()  # この実行の前から settings.json があったか（控えはそのときだけ）
        self.results: List[Dict[str, Any]] = []
        self.backup: Optional[Path] = None

    def _ok(self, id_: str, msg: str, changed: bool = True) -> None:
        self.results.append({"id": id_, "status": "ok" if changed else "unchanged", "message": msg})

    def _skip(self, id_: str, msg: str) -> None:
        self.results.append({"id": id_, "status": "skipped", "message": msg})

    def _fail(self, id_: str, msg: str) -> None:
        self.results.append({"id": id_, "status": "failed", "message": msg})

    # -- settings.json
    def _save_settings(self) -> bool:
        after = json.dumps(self.settings, sort_keys=True)
        if after == self.settings_before:
            return False
        if self.had_settings and self.backup is None:  # 最初の書き込みの直前に、実行前の内容を控える
            self.backup = self.paths.settings.with_name(f"settings.json.bak-{_now()}")
            shutil.copy2(self.paths.settings, self.backup)
        _atomic_write_text(self.paths.settings, _dump_json(self.settings))
        self.settings_before = after
        return True

    def statusline(self) -> None:
        src = HERE / "statusline.py"
        if not src.exists():
            self._fail("statusline", f"同梱の statusline.py が見つかりません（{src}）")
            return
        dst = self.paths.statusline_dst
        sl = self.settings.get("statusLine") if isinstance(self.settings.get("statusLine"), dict) else None
        ours_file = _statusline_is_ours(dst)
        foreign_setting = bool(sl and sl.get("command") and str(dst) not in str(sl.get("command")))
        foreign_file = dst.exists() and not ours_file
        if (foreign_setting or foreign_file) and self.a["statusline"] != "replace":
            self._skip("statusline", "別のステータスライン（設定かファイル）があるので残しました")
            return
        changed = False
        new_text = src.read_text(encoding="utf-8")
        if foreign_file:  # 利用者のファイルは控えてから置き換える
            keep = dst.with_name(f"statusline.py.bak-{_now()}")
            shutil.copy2(dst, keep)
            self.results.append({"id": "statusline", "status": "ok", "message": f"元のファイルを {self.paths.display(keep)} に控えました"})
        if not dst.exists() or dst.read_text(encoding="utf-8", errors="ignore") != new_text:
            _atomic_write_text(dst, new_text, mode=0o755)
            changed = True
        want = {"type": "command", "command": f"/usr/bin/python3 {shlex.quote(str(dst))}", "padding": 0}
        if sl != want:
            self.settings["statusLine"] = want
            changed = self._save_settings() or changed
        self._ok("statusline", f"{self.paths.display(dst)} を置き、statusLine に登録しました" if changed else "変更なし", changed)

    def permissions(self) -> None:
        perms = self.settings.setdefault("permissions", {})
        if not isinstance(perms, dict):
            self._fail("permissions", "settings.json の permissions がオブジェクトではありません")
            return
        changed = False
        pm = self.a["permission_mode"]
        if pm != "keep" and perms.get("defaultMode") != pm:
            perms["defaultMode"] = pm
            changed = True
        deny = perms.setdefault("deny", [])
        if not isinstance(deny, list):
            self._fail("permissions", "settings.json の permissions.deny が配列ではありません")
            return
        added = 0
        for r in DENY_RULES:
            if r not in deny:
                deny.append(r)
                added += 1
        changed = changed or added > 0
        if changed:
            self._save_settings()
        self._ok("permissions", f"運転モード {perms.get('defaultMode') or '（変更なし）'}・安全弁を {added} 本足しました" if changed else "変更なし", changed)

    def notifications(self) -> None:
        hooks = self.settings.setdefault("hooks", {})
        if not isinstance(hooks, dict):
            self._fail("notifications", "settings.json の hooks がオブジェクトではありません")
            return
        wanted = [
            ("Notification", "permission_prompt", "notify-permission", "許可を待っています（ターミナルを見てください）", "Glass"),
            ("Notification", "idle_prompt", "notify-idle", "入力を待っています", "Glass"),
            ("Stop", None, "notify-stop", "作業が終わりました", "Ping"),
        ]
        changed = False
        for event, matcher, tag, text, sound in wanted:
            cmd = (f"osascript -e 'display notification \"{text}\" with title \"Claude Code\" sound name \"{sound}\"' "
                   f">/dev/null 2>&1 # {MARK}:{tag}")
            handler = {"type": "command", "command": cmd, "timeout": 5}
            groups = hooks.setdefault(event, [])
            if not isinstance(groups, list):
                self._fail("notifications", f"settings.json の hooks.{event} が配列ではありません")
                return
            placed = False
            for g in groups:
                if not isinstance(g, dict):
                    continue
                for i, h in enumerate(g.get("hooks") or []):
                    if isinstance(h, dict) and _tag_of(str(h.get("command", ""))) == tag:
                        if h != handler:
                            g["hooks"][i] = handler
                            changed = True
                        placed = True
            if not placed:
                g = {"hooks": [handler]}
                if matcher:
                    g["matcher"] = matcher
                groups.append(g)
                changed = True
        if changed:
            self._save_settings()
        self._ok("notifications", "許可待ち・入力待ち・作業完了の通知を登録しました" if changed else "変更なし", changed)

    def claude_md(self) -> None:
        block = PERSONA_BLOCKS[self.a["persona"]]
        body = f"{BLOCK_START}\n{block}\n{BLOCK_END}\n"
        p = self.paths.claude_md
        if p.exists():
            text = p.read_text(encoding="utf-8", errors="ignore")
            if BLOCK_START in text and BLOCK_END in text:
                head, rest = text.split(BLOCK_START, 1)
                _, tail = rest.split(BLOCK_END, 1)
                new = head + body.rstrip("\n") + tail
            else:
                new = text.rstrip("\n") + "\n\n" + body
        else:
            new = "# CLAUDE.md（全プロジェクト共通の指示）\n\n" + body
        if p.exists() and p.read_text(encoding="utf-8", errors="ignore") == new:
            self._ok("claude_md", "変更なし", False)
            return
        _atomic_write_text(p, new)
        self._ok("claude_md", f"{self.paths.display(p)} に話し方とやらないことを書きました")

    def git_identity(self) -> None:
        if not self.env["git"]:
            self._skip("git_identity", "git が使えない（Command Line Tools 未導入）")
            return
        done = []
        for key, val, cur in (("user.name", self.a["git_name"], self.env["git_name"]), ("user.email", self.a["git_email"], self.env["git_email"])):
            if val and not cur:
                rc, _, err = _run(["git", "config", "--global", key, val], timeout=10)
                if rc != 0:
                    self._fail("git_identity", f"git config {key} に失敗: {err.strip()}")
                    return
                done.append(key)
        self._ok("git_identity", f"{', '.join(done)} を登録しました" if done else "変更なし（既存の値を残しました）", bool(done))

    def _mcp_add(self, id_: str, name: str, args: List[str], expect: str, ours: str) -> None:
        """MCP を登録する。同名の登録が既にあるときは、こちらが置いたもの（ours を含む）だけを控えを取ってから置き換え、
        利用者が自分で登録したものには触らない。"""
        claude = self.env["claude_path"]
        if not claude:
            self._fail(id_, "claude コマンドが見つかりません")
            return
        existing = self.env["mcp_servers"].get(name)
        if existing and expect in _mcp_entry_text(existing):
            self._ok(id_, "登録済み（変更なし）", False)
            return
        if existing and ours not in _mcp_entry_text(existing):
            self._skip(id_, f"『{name}』という名前の別の登録があるので触りませんでした")
            return
        backup: Optional[Path] = None
        if existing:
            self.paths.state_dir.mkdir(parents=True, exist_ok=True)
            backup = self.paths.state_dir / f"mcp-{name}.bak-{_now()}.json"
            _atomic_write_text(backup, _dump_json(existing))
            rc, _, err = _run([claude, "mcp", "remove", "-s", "user", name], timeout=60)
            if rc != 0:
                self._fail(id_, f"古い登録の削除に失敗: {err.strip()[:200]}")
                return
        rc, out, err = _run([claude, "mcp", "add", "-s", "user"] + args, timeout=120)
        if rc != 0:
            msg = f"claude mcp add に失敗: {(err or out).strip()[:300]}"
            if backup:
                rc2, _, _ = _run([claude, "mcp", "add-json", "-s", "user", name, json.dumps(existing)], timeout=60)
                msg += "。元の登録を戻しました" if rc2 == 0 else f"。元の登録は {self.paths.display(backup)} に控えてあります（claude mcp add-json で戻せます）"
            self._fail(id_, msg)
            return
        self._ok(id_, f"MCP『{name}』を登録しました（反映は Claude Code の再起動後）" + (f"。前の登録は {self.paths.display(backup)} に控えました" if backup else ""))

    def browser_playwright(self) -> None:
        if not self.env["node"] or not self.env["npx"]:
            self._skip("browser_playwright", "Node.js（npx）が無いので後回し。導入後に apply を再実行してください")
            return
        self.paths.playwright_profile.mkdir(parents=True, exist_ok=True)
        self.paths.playwright_output.mkdir(parents=True, exist_ok=True)
        args = [PLAYWRIGHT_MCP_NAME, "--", "npx", "-y", f"@playwright/mcp@{PLAYWRIGHT_MCP_VERSION}",
                "--browser", "chrome",
                "--user-data-dir", str(self.paths.playwright_profile),
                "--output-dir", str(self.paths.playwright_output)]
        self._mcp_add("browser_playwright", PLAYWRIGHT_MCP_NAME, args, f"@playwright/mcp@{PLAYWRIGHT_MCP_VERSION}", "@playwright/mcp")

    def docs_mcp(self) -> None:
        self._mcp_add("docs_mcp", DOCS_MCP_NAME, ["--transport", "http", DOCS_MCP_NAME, DOCS_MCP_URL], "code.claude.com/docs/mcp", "code.claude.com/docs/mcp")

    def run(self, plan: Dict[str, Any]) -> Dict[str, Any]:
        order = ["statusline", "permissions", "notifications", "claude_md", "git_identity", "browser_playwright", "docs_mcp"]
        wanted = {x["id"] for x in plan["config_actions"]}
        for id_ in order:
            if id_ not in wanted:
                continue
            try:
                getattr(self, id_)()
            except SystemExit:
                raise
            except Exception as e:  # 1項目の失敗で全体を止めない
                self._fail(id_, f"{type(e).__name__}: {e}")
        self.paths.state_dir.mkdir(parents=True, exist_ok=True)
        _atomic_write_text(self.paths.state_dir / "last-apply.json", _dump_json({
            "at": dt.datetime.now().isoformat(timespec="seconds"), "results": self.results,
            "backup": str(self.backup) if self.backup else None}))
        failed = [r for r in self.results if r["status"] == "failed"]
        return {"ok": not failed, "results": self.results, "backup": str(self.backup) if self.backup else None,
                "install_commands": plan["install_commands"], "manual_steps": plan["manual_steps"],
                "restart_required": any(r["status"] == "ok" for r in self.results)}


# ---------------------------------------------------------------------------- status
STATE_ICON = {"done": "✅", "partial": "🟡", "todo": "⬜", "other": "🔷", "info": "ℹ️", "error": "❌"}


def status(paths: Paths) -> Dict[str, Any]:
    env = detect_env(paths)
    settings, serr = _load_json(paths.settings)
    items = detect_items(paths, env, settings, serr)
    return {"env": {k: env[k] for k in ("os", "macos_version", "claude_version", "login", "terminal", "node", "homebrew", "config_dir")},
            "items": items, "notes": _notes(env)}


def status_text(s: Dict[str, Any]) -> str:
    e = s["env"]
    login = e["login"]
    lines = [f"Claude Code {e.get('claude_version') or '不明'} / macOS {e.get('macos_version') or '?'} / 設定 {e.get('config_dir')}",
             f"ログイン: {'済み（' + str(login.get('plan') or login.get('method')) + '）' if login.get('ok') else '未ログイン'}"]
    for id_ in ITEM_ORDER:
        it = s["items"].get(id_)
        if not it:
            continue
        lines.append(f"{STATE_ICON.get(it['state'], '•')} {ITEM_LABELS[id_]}: {it['detail']}")
    if s["items"].get("_settings_error"):
        lines.append(f"❌ settings.json: {s['items']['_settings_error']['detail']}")
    for n in s["notes"]:
        lines.append(f"注意: {n}")
    return "\n".join(lines)


# ---------------------------------------------------------------------------- main
def main(argv: Optional[List[str]] = None) -> int:
    ap = argparse.ArgumentParser(description="Claude Code 初期セットアップ（機械部分）")
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("preflight"); p.add_argument("--json", action="store_true")
    p = sub.add_parser("plan"); p.add_argument("--answers"); p.add_argument("--json", action="store_true")
    p = sub.add_parser("apply"); p.add_argument("--answers"); p.add_argument("--json", action="store_true")
    p = sub.add_parser("status"); p.add_argument("--json", action="store_true"); p.add_argument("--text", action="store_true")
    args = ap.parse_args(argv)
    paths = Paths()

    if args.cmd == "preflight":
        out, rc = preflight(paths)
        print(json.dumps(out, ensure_ascii=False, indent=2) if args.json else status_text(status(paths)) + "\n" + "\n".join(
            f"止まる理由: {r['hint']}" for r in out["stop_reasons"]))
        return rc
    if args.cmd == "status":
        s = status(paths)
        print(json.dumps(s, ensure_ascii=False, indent=2) if args.json and not args.text else status_text(s))
        return 0
    answers_path = Path(args.answers).expanduser() if args.answers else paths.answers
    try:
        a = load_answers(answers_path)
        if args.cmd == "plan":
            out = make_plan(paths, a)
            paths.state_dir.mkdir(parents=True, exist_ok=True)
            _atomic_write_text(paths.state_dir / "last-plan.json", _dump_json(out))
            print(json.dumps(out, ensure_ascii=False, indent=2) if args.json else "\n".join(out["summary"]))
            return 0
        plan = make_plan(paths, a)
        out = Applier(paths, a).run(plan)
        if args.json:
            print(json.dumps(out, ensure_ascii=False, indent=2))
        else:
            for r in out["results"]:
                print(f"[{r['status']}] {r['id']}: {r['message']}")
            if out["backup"]:
                print(f"settings.json の控え: {out['backup']}")
        return 0 if out["ok"] else 1
    except SystemExit as e:
        if isinstance(e.code, str):
            print(e.code, file=sys.stderr)
            return 1
        raise
    return 2


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(2)
