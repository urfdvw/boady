"""Mirror <-> board synchronisation (backend side).

The backend only maintains the mirror ``src/``. Reading, hashing, writing and
deleting files on the board is done by the frontend through hw requests:

* ``fs.read_all`` -> ``{"files": {path: base64}}`` (all board files)
* ``fs.plan`` ``{"manifest": {path: sha256}}`` -> ``{"need": [path...], "delete": [path...]}``
* ``fs.apply`` ``{"files": {path: base64}, "delete": [path...]}`` -> ``{"written": [...], "deleted": [...]}``
"""

from __future__ import annotations

import base64
import fnmatch
import hashlib
import os
from pathlib import Path
from typing import Any

# Never synced in either direction (OS junk on USB drives + MicroPython ID file)
EXCLUDE_NAMES = {".DS_Store", ".Trashes", ".fseventsd", ".Spotlight-V100", "System Volume Information", "Thumbs.db"}
EXCLUDE_PATTERNS = ["._*"]
EXCLUDE_ROOT_FILES = {".boady_id"}


def excluded(rel: str) -> bool:
    rel = rel.strip("/")
    parts = rel.split("/")
    if rel in EXCLUDE_ROOT_FILES:
        return True
    for part in parts:
        if part in EXCLUDE_NAMES or any(fnmatch.fnmatchcase(part, pat) for pat in EXCLUDE_PATTERNS):
            return True
    return False


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


class MirrorPathError(ValueError):
    pass


def mirror_src(root: Path) -> Path:
    """The project's ``src/``, refusing a symlink or anything resolving outside the project.

    A cloned repository may contain a ``src`` symlink to an arbitrary place;
    syncing or installing libraries through it would write or delete there.
    """
    src = root / "src"
    if src.is_symlink():
        raise MirrorPathError("src/ is a symbolic link; boady refuses to use it")
    r_root, r_src = root.resolve(), src.resolve()
    if r_root not in r_src.parents:
        raise MirrorPathError("src/ resolves outside the project")
    return src


def mirror_files(src: Path) -> dict[str, Path]:
    """Regular files under ``src`` (symlinks are neither followed nor listed)."""
    out: dict[str, Path] = {}
    if not src.is_dir() or src.is_symlink():
        return out
    base = src.resolve()
    for dirpath, dirnames, filenames in os.walk(src, followlinks=False):
        d = Path(dirpath)
        dirnames[:] = sorted(n for n in dirnames if not (d / n).is_symlink())
        for n in sorted(filenames):
            p = d / n
            if p.is_symlink() or not p.is_file():
                continue
            if base not in p.resolve().parents:
                continue
            rel = p.relative_to(src).as_posix()
            if not excluded(rel):
                out[rel] = p
    return dict(sorted(out.items()))


def snapshot(src: Path) -> dict[str, bytes]:
    """Contents of all mirror files at one moment (for an upload)."""
    return {rel: p.read_bytes() for rel, p in mirror_files(src).items()}


def manifest(src: Path) -> dict[str, str]:
    return {rel: sha256(p.read_bytes()) for rel, p in mirror_files(src).items()}


def _safe_target(src: Path, rel: str) -> Path:
    target = (src / rel.lstrip("/")).resolve()
    if src.resolve() not in target.parents:
        raise ValueError(f"unsafe path from device: {rel}")
    return target


def case_insensitive(d: Path) -> bool:
    """Whether the file system holding ``d`` ignores case (macOS and Windows defaults)."""
    name = d.name
    flipped = name.swapcase()
    if flipped == name:
        return False
    try:
        return os.path.samefile(d, d.parent / flipped)
    except OSError:
        return False


def case_collisions(paths: list[str]) -> list[tuple[str, str]]:
    """Pairs of paths (or path prefixes) that differ only in case."""
    seen: dict[str, str] = {}
    out: list[tuple[str, str]] = []
    for rel in sorted(paths):
        parts = rel.split("/")
        for i in range(1, len(parts) + 1):
            spelled = "/".join(parts[:i])
            key = spelled.casefold()
            other = seen.setdefault(key, spelled)
            if other != spelled and (other, spelled) not in out:
                out.append((other, spelled))
    return out


def apply_from_device(src: Path, board_files: dict[str, str]) -> dict[str, list[str]]:
    """Make the mirror ``src/`` equal to the board. ``board_files``: path -> base64.

    Refuses, before changing anything, board files that cannot coexist in the
    mirror (``A.txt`` and ``a.txt`` on a case-insensitive file system). Deletes
    before writing, so a local ``Code.py`` replaced by the board's ``code.py``
    is not written and then removed again.
    """
    src.mkdir(parents=True, exist_ok=True)
    board: dict[str, str] = {}
    for rel, b64 in board_files.items():
        rel = rel.strip("/")
        if rel and not excluded(rel):
            board[rel] = b64
    if case_insensitive(src):
        clashes = case_collisions(list(board))
        if clashes:
            a, b = clashes[0]
            raise ValueError(f"case_collision: the board has both {a!r} and {b!r}; this computer's file system cannot keep both")
    for rel in board:
        _safe_target(src, rel)  # refuse unsafe board paths before touching anything
        if _through_link(src, rel):
            # b.py -> a.py would merge two board files into one (review 9); like a partial pull
            raise ValueError(f"refusing a path through a symlink: {rel} (src/ has a symbolic link there; remove it first)")
    current = mirror_files(src)
    added, modified, deleted = [], [], []
    for rel, p in current.items():
        if rel not in board:
            p.unlink()
            deleted.append(rel)
    _prune_empty_dirs(src)
    for rel in sorted(board):
        alias = case_alias(src, rel)
        if alias:
            raise ValueError(f"case_collision: {rel!r} would be written into the existing {alias!r}")
    for rel in sorted(board):
        data = base64.b64decode(board[rel])
        target = _safe_target(src, rel)
        if rel in current:
            if current[rel].read_bytes() == data:
                continue
            modified.append(rel)
        else:
            added.append(rel)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
    return {"added": added, "modified": modified, "deleted": deleted}


def _through_link(src: Path, rel: str) -> bool:
    p = src
    for part in [x for x in rel.strip("/").split("/") if x]:
        p = p / part
        if p.is_symlink():
            return True
    return False


def apply_paths(src: Path, board_files: dict[str, str], paths: list[str]) -> dict[str, list[str]]:
    """Make only ``paths`` in the mirror equal to the board; nothing else changes."""
    bad = [p for p in paths if canonical_rel(p) is None]
    if bad:
        raise ValueError(f"not a canonical path: {bad[0]!r}")
    for p in paths:
        alias = case_alias(src, p)
        if alias:
            raise ValueError(f"{p!r} would reach {alias!r} (different spelling); use the exact name")
    board = {k.strip("/"): v for k, v in board_files.items()}
    added, modified, deleted = [], [], []
    for rel in paths:
        target = _safe_target(src, rel)
        if _through_link(src, rel):
            raise ValueError(f"refusing a path through a symlink: {rel}")
        if rel in board:
            data = base64.b64decode(board[rel])
            if target.is_file():
                if target.read_bytes() == data:
                    continue
                modified.append(rel)
            else:
                added.append(rel)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
        elif target.is_file():
            target.unlink()
            deleted.append(rel)
    return {"added": added, "modified": modified, "deleted": deleted}


def _prune_empty_dirs(root: Path) -> None:
    for dirpath, _dirs, _files in os.walk(root, topdown=False, followlinks=False):
        d = Path(dirpath)
        if d == root or d.is_symlink():
            continue
        try:
            d.rmdir()
        except OSError:
            pass


def canonical_rel(rel: object) -> str | None:
    """``rel`` if it is a canonical src-relative path (``lib/x.py``), else None.

    No guessing: ``./x``, ``a//b``, ``a/../b``, leading or trailing ``/``,
    backslashes and empty parts are refused, because one path must mean one
    file both when checking for local edits and when writing or deleting.
    """
    if not isinstance(rel, str) or not rel or "\\" in rel or "\0" in rel:
        return None
    parts = rel.split("/")
    if any(p in ("", ".", "..") for p in parts):
        return None
    return rel


def case_alias(src: Path, rel: str) -> str | None:
    """The on-disk spelling if ``rel`` reaches an existing entry under another
    spelling (case-insensitive file systems: ``CODE.PY`` -> ``code.py``), else None."""
    d = src
    parts = rel.split("/")
    for i, part in enumerate(parts):
        try:
            names = os.listdir(d)
        except OSError:
            return None
        if part in names:
            d = d / part
            continue
        same = [n for n in names if n.casefold() == part.casefold()]
        if same:
            return "/".join(parts[:i] + [same[0]])
        return None
    return None


def safe_mirror_file(src: Path, rel: str) -> Path | None:
    """``src/rel`` if it is a regular file reached without any symlink (file or
    directory) and inside ``src``; otherwise None. ``rel`` comes from the board."""
    parts = [x for x in rel.strip("/").split("/") if x]
    if not parts or any(x in (".", "..") for x in parts):
        return None
    p = src
    for x in parts:
        p = p / x
        if p.is_symlink():
            return None
    if not p.is_file() or src.resolve() not in p.resolve().parents:
        return None
    return p


def manifest_of(files_b64: dict[str, str]) -> dict[str, str]:
    """Hashes of board files given as base64 (same format as ``manifest``)."""
    out: dict[str, str] = {}
    for rel, b64 in files_b64.items():
        rel = rel.strip("/")
        if rel and not excluded(rel):
            out[rel] = sha256(base64.b64decode(b64))
    return dict(sorted(out.items()))


def text_diffs(mirror: dict[str, bytes], board_b64: dict[str, str], paths: list[str], max_chars: int = 6000) -> dict[str, str]:
    """Unified diffs mirror -> board for text files among ``paths`` (truncated):
    ``+`` lines are what the board has, ``-`` lines what the mirror has.
    ``mirror`` is a ``snapshot()``: the same moment the caller's hashes describe."""
    import difflib

    out: dict[str, str] = {}
    budget = max_chars
    for rel in paths:
        if budget <= 0:
            break
        try:
            board = base64.b64decode(board_b64[rel]).decode("utf-8") if rel in board_b64 else ""
            local = mirror[rel].decode("utf-8") if rel in mirror else ""
        except (UnicodeDecodeError, ValueError, OSError):
            out[rel] = "(binary)"
            continue
        d = "".join(difflib.unified_diff(local.splitlines(True), board.splitlines(True), f"mirror/{rel}", f"board/{rel}"))
        out[rel] = d[:budget]
        budget -= len(out[rel])
    return out
