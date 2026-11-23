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


def mirror_files(src: Path) -> dict[str, Path]:
    out: dict[str, Path] = {}
    if not src.is_dir():
        return out
    for p in sorted(src.rglob("*")):
        if p.is_file() and not p.is_symlink():
            rel = p.relative_to(src).as_posix()
            if not excluded(rel):
                out[rel] = p
    return out


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
    for d in sorted((p for p in root.rglob("*") if p.is_dir()), key=lambda p: -len(p.parts)):
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
