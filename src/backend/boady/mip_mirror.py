"""MicroPython packages into the mirror with mpremote's own mip code.

Spec「库管理」: call ``mpremote.mip._install_package(transport, package, index,
target, version, mpy)`` with a local transport. mip (mpremote 1.29.0) only uses
``fs_exists``, ``fs_mkdir``, ``fs_hashfile``, ``fs_writefile``, ``exec`` and
``eval`` on it: the four fs methods map to ``src/``, ``exec`` is ignored and
``eval`` only answers the ``.mpy`` version query with the project table value.
``_install_package`` is internal, so mpremote is pinned (requirements.txt).
"""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import io
import json
import threading
import urllib.request
from pathlib import Path
from typing import Any

from mpremote import mip
from mpremote.commands import CommandError

INDEX = "https://micropython.org/pi/v2"
TARGET = "lib"
_lock = threading.Lock()  # redirect_stdout is process-wide


class MirrorTransport:
    """The subset of mpremote's Transport that mip uses, backed by ``src/``."""

    def __init__(self, src: Path, mpy_version: int | None):
        self.src = src.resolve()
        self.mpy_version = mpy_version
        self.written: list[str] = []

    def _path(self, p: str) -> Path:
        target = (self.src / p.lstrip("/")).resolve()
        if target != self.src and self.src not in target.parents:
            raise CommandError(f"path outside the mirror: {p}")
        return target

    def fs_exists(self, p: str) -> bool:
        return self._path(p).exists()

    def fs_mkdir(self, p: str) -> None:
        self._path(p).mkdir(parents=True, exist_ok=True)

    def fs_hashfile(self, p: str, algo: str) -> bytes:
        f = self._path(p)
        if not f.is_file():
            raise FileNotFoundError(p)
        return hashlib.new(algo, f.read_bytes()).digest()

    def fs_writefile(self, p: str, data: bytes, progress_callback: Any = None) -> None:
        f = self._path(p)
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_bytes(data)
        self.written.append(f.relative_to(self.src).as_posix())

    def exec(self, cmd: str, data_consumer: Any = None) -> bytes:
        return b""

    def eval(self, expr: str, parse: bool = True) -> Any:
        # only "getattr(sys.implementation, '_mpy', 0) & 0xFF"
        return (self.mpy_version or 0) & 0xFF


def _install_sync(src: Path, package: str, version: str | None, mpy_version: int | None) -> dict[str, Any]:
    t = MirrorTransport(src, mpy_version)
    out = io.StringIO()
    with _lock, contextlib.redirect_stdout(out):
        # never connected (no .mpy version known): install .py sources
        mip._install_package(t, package, INDEX, TARGET, version, bool(mpy_version))
    return {"written": t.written, "log": out.getvalue()}


async def install(src: Path, package: str, version: str | None, mpy_version: int | None) -> dict[str, Any]:
    try:
        return await asyncio.to_thread(_install_sync, src, package, version, mpy_version)
    except CommandError as e:
        raise RuntimeError(str(e)) from e


_index_cache: list[dict[str, Any]] | None = None


def _fetch_index() -> list[dict[str, Any]]:
    with urllib.request.urlopen(f"{INDEX}/index.json", timeout=30) as r:
        return list(json.load(r).get("packages", []))


async def index() -> list[dict[str, Any]]:
    global _index_cache
    if _index_cache is None:
        _index_cache = await asyncio.to_thread(_fetch_index)
    return _index_cache
