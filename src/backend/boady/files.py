"""Mirror file access for the Files tab (path-safe, project root only)."""

from __future__ import annotations

from pathlib import Path
from typing import Any

MAX_TEXT_BYTES = 2 * 1024 * 1024
SKIP_DIRS = {".git"}


class PathError(ValueError):
    pass


def resolve(root: Path, rel: str) -> Path:
    rel = rel.replace("\\", "/").lstrip("/")
    target = (root / rel).resolve()
    root_r = root.resolve()
    if target != root_r and root_r not in target.parents:
        raise PathError(f"path outside project: {rel}")
    if any(part in SKIP_DIRS for part in target.relative_to(root_r).parts):
        raise PathError(f"path not allowed: {rel}")
    return target


def tree(root: Path) -> list[dict[str, Any]]:
    """Flat, sorted list of entries: {path, dir, size}. Directories first per level."""
    out: list[dict[str, Any]] = []

    def walk(d: Path, prefix: str) -> None:
        try:
            items = sorted(d.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower()))
        except OSError:
            return
        for p in items:
            if p.name in SKIP_DIRS or p.is_symlink():
                continue
            rel = f"{prefix}{p.name}"
            if p.is_dir():
                out.append({"path": rel, "dir": True})
                walk(p, rel + "/")
            else:
                out.append({"path": rel, "dir": False, "size": p.stat().st_size})

    walk(root, "")
    return out


def read(root: Path, rel: str) -> dict[str, Any]:
    p = resolve(root, rel)
    if not p.is_file():
        raise PathError(f"not a file: {rel}")
    data = p.read_bytes()
    if len(data) > MAX_TEXT_BYTES:
        return {"path": rel, "binary": True, "size": len(data)}
    try:
        return {"path": rel, "text": data.decode("utf-8"), "binary": False}
    except UnicodeDecodeError:
        return {"path": rel, "binary": True, "size": len(data)}


def write(root: Path, rel: str, text: str) -> None:
    p = resolve(root, rel)
    if p == root.resolve() or p.is_dir():
        raise PathError(f"not a file path: {rel}")
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text, encoding="utf-8")
