"""Library management on the mirror ``src/`` (never on the board).

CircuitPython: circup with ``--path <project>/src``; circup reads the CircuitPython
version and board id from ``src/boot_out.txt`` (pulled from the board on
connect). MicroPython: mpremote's mip writing into ``src/lib`` through a mirror
transport (``mip_mirror``); there is no manifest, so "installed" means the
top-level entries of ``src/lib``.
"""

from __future__ import annotations

import re
import shutil
import sys
from pathlib import Path
from typing import Any

from .proc import run

NAME_RE = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9_.\-]*$")


class LibraryError(Exception):
    pass


def _circup() -> list[str]:
    exe = shutil.which("circup")
    return [exe] if exe else [sys.executable, "-m", "circup"]


def _check_ready(src: Path) -> None:
    if not (src / "boot_out.txt").is_file():
        raise LibraryError("no_boot_out: connect the board once so boot_out.txt is pulled into src/")


async def circup(src: Path, *args: str, timeout: float = 600) -> str:
    _check_ready(src)
    res = await run([*_circup(), "--path", str(src), *args], cwd=src.parent, timeout=timeout)
    out = (res.stdout + "\n" + res.stderr).strip()
    if not res.ok or "There was a problem downloading" in out:
        raise LibraryError(out.splitlines()[-1] if out else f"circup exit {res.code}")
    return out


def parse_freeze(out: str) -> dict[str, str]:
    mods: dict[str, str] = {}
    for line in out.splitlines():
        m = re.match(r"^([A-Za-z0-9_.\-]+)==(\S+)$", line.strip())
        if m:
            mods[m.group(1)] = m.group(2)
    return mods


def parse_outdated(out: str) -> dict[str, dict[str, str]]:
    rows: dict[str, dict[str, str]] = {}
    lines = out.splitlines()
    try:
        start = next(i for i, l in enumerate(lines) if l.strip().startswith("---")) + 1
    except StopIteration:
        return rows
    for line in lines[start:]:
        cols = re.split(r"\s{2,}", line.strip())
        if len(cols) >= 3:
            rows[cols[0]] = {"latest": cols[2], "reason": cols[3] if len(cols) > 3 else ""}
    return rows


def parse_show(out: str) -> list[str]:
    names = []
    for line in out.splitlines():
        line = line.strip()
        if NAME_RE.match(line) and not line.startswith("Found"):
            names.append(line)
    return names


def _mp_entries(src: Path) -> list[dict[str, Any]]:
    lib = src / "lib"
    if not lib.is_dir():
        return []
    out = []
    for e in sorted(lib.iterdir(), key=lambda x: x.name.lower()):
        if e.name.startswith("."):
            continue
        name = e.stem if e.is_file() else e.name
        out.append({"name": name, "entry": e.name, "version": "", "latest": None, "outdated": False, "reason": ""})
    return out


async def list_installed(project_type: str, src: Path) -> list[dict[str, Any]]:
    if project_type == "micropython":
        return _mp_entries(src)
    installed = parse_freeze(await circup(src, "freeze"))
    outdated = parse_outdated(await circup(src, "list"))
    return [
        {"name": n, "version": v, "latest": outdated.get(n, {}).get("latest"), "outdated": n in outdated,
         "reason": outdated.get(n, {}).get("reason", "")}
        for n, v in sorted(installed.items())
    ]


async def search(project_type: str, src: Path, query: str) -> list[str]:
    q = query.strip()
    if project_type == "micropython":
        from . import mip_mirror

        try:
            pkgs = await mip_mirror.index()
        except Exception as e:
            raise LibraryError(f"index_unavailable: {e}") from e
        ql = q.lower()
        return sorted(p["name"] for p in pkgs if ql in p.get("name", "").lower() or ql in p.get("description", "").lower())[:200]
    if q and not NAME_RE.match(q):
        raise LibraryError("invalid_name")
    return parse_show(await circup(src, "show", *([q] if q else [])))[:200]


def _names(names: list[str]) -> list[str]:
    if not names or not all(isinstance(n, str) and NAME_RE.match(n) for n in names):
        raise LibraryError("invalid_name")
    return names


MIP_PKG_RE = re.compile(r"^(?:[A-Za-z0-9_][A-Za-z0-9_.\-]*|(?:github|gitlab|codeberg):[A-Za-z0-9_.\-/]+|https://[^\s]+)(?:@[A-Za-z0-9_.\-]+)?$")


async def install(project_type: str, src: Path, names: list[str], mpy_version: int | None = None) -> str:
    if project_type == "micropython":
        from . import mip_mirror

        if not names or not all(isinstance(n, str) and MIP_PKG_RE.match(n) for n in names):
            raise LibraryError("invalid_name")
        logs = []
        for n in names:
            pkg, _, ver = n.partition("@")
            try:
                res = await mip_mirror.install(src, pkg, ver or None, mpy_version)
            except Exception as e:
                raise LibraryError(str(e)) from e
            logs.append(res["log"].strip())
        return "\n".join(logs)
    return await circup(src, "install", *_names(names))


async def update(project_type: str, src: Path) -> str:
    if project_type == "micropython":
        raise LibraryError("not_available: mip has no update; install the package again")
    return await circup(src, "update", "--all")


async def uninstall(project_type: str, src: Path, names: list[str]) -> str:
    if project_type == "micropython":
        lib = (src / "lib").resolve()
        removed = []
        for e in _mp_entries(src):
            if e["name"] in _names(names) or e["entry"] in names:
                target = (lib / e["entry"]).resolve()
                if lib not in target.parents:
                    continue
                if target.is_dir():
                    import shutil

                    shutil.rmtree(target)
                else:
                    target.unlink()
                removed.append(e["entry"])
        if not removed:
            raise LibraryError("not_installed")
        return "removed " + ", ".join(removed)
    return await circup(src, "uninstall", *_names(names))
