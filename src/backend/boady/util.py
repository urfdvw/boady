from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path
from typing import Any


def atomic_write_text(path: Path, text: str, mode: int | None = None) -> None:
    """Write a file atomically (tmp + rename), optionally with permissions."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(text)
            f.flush()
            os.fsync(f.fileno())
        if mode is not None:
            os.chmod(tmp, mode)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except FileNotFoundError:
            pass
        raise


def read_json(path: Path, default: Any) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return default


def write_json(path: Path, data: Any, mode: int | None = None) -> None:
    atomic_write_text(path, json.dumps(data, indent=2, ensure_ascii=False) + "\n", mode)


def in_git_dir(root: Path, path: Path) -> bool:
    """True if ``path`` is the project's ``.git`` or inside it, by file-system identity:
    on a case-insensitive file system ``.GIT/config`` is ``.git/config`` (review 8),
    and a link to ``.git`` is ``.git`` too."""
    git = root / ".git"
    p = path if path.is_absolute() else root / path
    if is_within(p, git):
        return True
    if not git.exists():
        return False
    for cand in {Path(os.path.abspath(p)), p.resolve()}:
        for a in (cand, *cand.parents):
            try:
                if os.path.samefile(a, git):
                    return True
            except OSError:
                continue  # does not exist (yet)
    return False


def is_within(path: Path, root: Path) -> bool:
    """True if ``path`` (resolved) is ``root`` or inside it."""
    try:
        path.resolve().relative_to(root.resolve())
        return True
    except ValueError:
        return False
