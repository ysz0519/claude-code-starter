#!/usr/bin/env python3
"""durable state file の atomic write 共通ヘルパ。

rename だけでは電源断・カーネルパニックのタイミングで「中身が空のまま置き換わった」
状態になり得る。ページキャッシュ上のデータがディスクに届く前に、メタデータ操作である
rename が先に永続化されることがあるため。よって
  同一ディレクトリの一時ファイル → write → flush → fsync → os.replace → 親dir fsync
の順を守る。

- 一時ファイルは必ず置き換え先と同じディレクトリに作る（別FS間の os.replace は失敗する）
- 親ディレクトリの fsync まで行う（replace 自体の永続化）
- Python 3.9（/usr/bin/python3）互換。第三者パッケージに依存しない

## 使い方

    import os, sys
    sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "lib"))
    from atomic_write import atomic_write_json, atomic_write_text, append_jsonl

    atomic_write_json(state_path, {"last_run": "2026-08-02"})

書き込み失敗は握りつぶさず OSError を送出する。呼び出し側は沈黙せず、
ログ ERROR + Slack DM 1行で報告すること。
"""

from __future__ import annotations

import json
import os
import tempfile
from typing import Any, Iterable, Optional, Union

__all__ = ["atomic_write_bytes", "atomic_write_text", "atomic_write_json",
           "append_jsonl", "fsync_dir"]

PathLike = Union[str, "os.PathLike[str]"]


def fsync_dir(dir_path: PathLike) -> None:
    """ディレクトリエントリの変更（rename・create）をディスクへ確定させる。

    ディレクトリの fsync に失敗する環境（一部のネットワークFS）では黙って諦める。
    ここで落とすとファイル本体は書けているのにジョブが失敗扱いになるため。
    """
    fd = None
    try:
        fd = os.open(str(dir_path), os.O_RDONLY)
        os.fsync(fd)
    except OSError:
        pass
    finally:
        if fd is not None:
            try:
                os.close(fd)
            except OSError:
                pass


def atomic_write_bytes(path: PathLike, data: bytes, mode: Optional[int] = None) -> None:
    """bytes を atomic に書き込む（全ヘルパの土台）。"""
    path = os.fspath(path)
    directory = os.path.dirname(os.path.abspath(path)) or "."
    os.makedirs(directory, exist_ok=True)

    fd, tmp = tempfile.mkstemp(dir=directory, prefix=".tmp-",
                               suffix=os.path.basename(path))
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())     # 本体をディスクへ確定（rename より先に必ず行う）
        # mkstemp は 0600 で作るため、既存ファイルの権限を引き継ぎたい場合は明示指定する
        if mode is not None:
            os.chmod(tmp, mode)
        else:
            try:
                os.chmod(tmp, os.stat(path).st_mode & 0o777)
            except OSError:
                pass                 # 新規作成時は既存が無いので 0600 のままでよい
        os.replace(tmp, path)        # POSIX 上で atomic
        tmp = None
    finally:
        if tmp is not None:
            try:
                os.unlink(tmp)       # 途中で失敗したら一時ファイルを残さない
            except OSError:
                pass
    fsync_dir(directory)


def atomic_write_text(path: PathLike, text: str, encoding: str = "utf-8",
                      mode: Optional[int] = None) -> None:
    """テキストを atomic に書き込む。"""
    atomic_write_bytes(path, text.encode(encoding), mode=mode)


def atomic_write_json(path: PathLike, obj: Any, *, indent: int = 2,
                      ensure_ascii: bool = False, sort_keys: bool = False,
                      mode: Optional[int] = None) -> None:
    """JSON を atomic に書き込む（末尾に改行を付ける）。"""
    text = json.dumps(obj, ensure_ascii=ensure_ascii, indent=indent,
                      sort_keys=sort_keys) + "\n"
    atomic_write_text(path, text, mode=mode)


def append_jsonl(path: PathLike, records: Union[Any, Iterable[Any]], *,
                 ensure_ascii: bool = False) -> None:
    """JSONL に追記して fsync する。

    追記は replace できない（既存行を読み直して全書き換えするとコストと事故が増える）ため、
    O_APPEND の atomic 性（PIPE_BUF 以下の1回の write は分割されない）に依存し、
    永続化だけ fsync で担保する。1レコードが極端に長い場合は行が混ざり得るので、
    巨大レコードを高頻度で追記する用途にはこのヘルパを使わない。
    """
    if isinstance(records, (dict, str, bytes)) or not hasattr(records, "__iter__"):
        records = [records]
    lines = "".join(json.dumps(r, ensure_ascii=ensure_ascii) + "\n" for r in records)
    if not lines:
        return
    path = os.fspath(path)
    directory = os.path.dirname(os.path.abspath(path)) or "."
    os.makedirs(directory, exist_ok=True)
    created = not os.path.exists(path)
    with open(path, "a", encoding="utf-8") as f:
        f.write(lines)
        f.flush()
        os.fsync(f.fileno())
    if created:
        fsync_dir(directory)         # 新規作成時のみディレクトリエントリの確定が要る


if __name__ == "__main__":
    # セルフテスト（回帰テストからも呼ぶ）
    import sys
    import shutil

    tmpdir = tempfile.mkdtemp(prefix="atomic-write-selftest-")
    try:
        p = os.path.join(tmpdir, "nested", "state.json")
        atomic_write_json(p, {"a": 1, "日本語": "ok"})
        assert json.loads(open(p, encoding="utf-8").read()) == {"a": 1, "日本語": "ok"}

        # 上書きで権限が維持されること
        os.chmod(p, 0o600)
        atomic_write_json(p, {"a": 2})
        assert os.stat(p).st_mode & 0o777 == 0o600, "権限が引き継がれていない"
        assert json.loads(open(p, encoding="utf-8").read()) == {"a": 2}

        # 一時ファイルが残らないこと
        leftovers = [n for n in os.listdir(os.path.dirname(p)) if n.startswith(".tmp-")]
        assert not leftovers, f"一時ファイルが残った: {leftovers}"

        q = os.path.join(tmpdir, "events.jsonl")
        append_jsonl(q, {"e": 1})
        append_jsonl(q, [{"e": 2}, {"e": 3}])
        assert [json.loads(l) for l in open(q, encoding="utf-8")] == [
            {"e": 1}, {"e": 2}, {"e": 3}]

        atomic_write_text(os.path.join(tmpdir, "a.txt"), "hello")
        assert open(os.path.join(tmpdir, "a.txt"), encoding="utf-8").read() == "hello"

        print("atomic_write selftest: OK")
    except AssertionError as e:
        print(f"atomic_write selftest: FAIL - {e}", file=sys.stderr)
        sys.exit(1)
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)
