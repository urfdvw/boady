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


def manifest(src: Path) -> dict[str, str]:
    return {rel: sha256(p.read_bytes()) for rel, p in mirror_files(src).items()}


def _safe_target(src: Path, rel: str) -> Path:
    target = (src / rel.lstrip("/")).resolve()
    if src.resolve() not in target.parents:
        raise ValueError(f"unsafe path from device: {rel}")
    return target


def apply_from_device(src: Path, board_files: dict[str, str]) -> dict[str, list[str]]:
    """Make the mirror ``src/`` equal to the board. ``board_files``: path -> base64."""
    src.mkdir(parents=True, exist_ok=True)
    current = mirror_files(src)
    added, modified, deleted = [], [], []
    seen = set()
    for rel, b64 in sorted(board_files.items()):
        rel = rel.strip("/")
        if not rel or excluded(rel):
            continue
        seen.add(rel)
        data = base64.b64decode(b64)
        target = _safe_target(src, rel)
        if rel in current:
            if current[rel].read_bytes() == data:
                continue
            modified.append(rel)
        else:
            added.append(rel)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
    for rel, p in current.items():
        if rel not in seen:
            p.unlink()
            deleted.append(rel)
    _prune_empty_dirs(src)
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


def encode_files(src: Path, paths: list[str]) -> dict[str, str]:
    files = mirror_files(src)
    out: dict[str, Any] = {}
    for rel in paths:
        if rel in files:
            out[rel] = base64.b64encode(files[rel].read_bytes()).decode()
    return out


def manifest_of(files_b64: dict[str, str]) -> dict[str, str]:
    """Hashes of board files given as base64 (same format as ``manifest``)."""
    out: dict[str, str] = {}
    for rel, b64 in files_b64.items():
        rel = rel.strip("/")
        if rel and not excluded(rel):
            out[rel] = sha256(base64.b64decode(b64))
    return dict(sorted(out.items()))


def text_diffs(src: Path, board_b64: dict[str, str], paths: list[str], max_chars: int = 6000) -> dict[str, str]:
    """Unified diffs board -> mirror for text files among ``paths`` (truncated)."""
    import difflib

    out: dict[str, str] = {}
    budget = max_chars
    for rel in paths:
        if budget <= 0:
            break
        try:
            board = base64.b64decode(board_b64[rel]).decode("utf-8") if rel in board_b64 else ""
            mp = src / rel
            mirror = mp.read_text(encoding="utf-8") if mp.is_file() and not mp.is_symlink() else ""
        except (UnicodeDecodeError, ValueError, OSError):
            out[rel] = "(binary)"
            continue
        d = "".join(difflib.unified_diff(board.splitlines(True), mirror.splitlines(True), f"board/{rel}", f"mirror/{rel}"))
        out[rel] = d[:budget]
        budget -= len(out[rel])
    return out
