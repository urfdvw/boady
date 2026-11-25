"""Project lifecycle: create (skeleton), clone (with type check), delete."""

from __future__ import annotations

import json
import logging
import re
import shutil
from pathlib import Path
from typing import Any, Awaitable, Callable

from . import gitops, prompts
from .config import PROJECT_TYPES, SKELETON_DIR
from .proc import ProcError, run

log = logging.getLogger("boady.projects")

NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
TYPE_LABEL = {"circuitpython": "CircuitPython", "micropython": "MicroPython"}
ENTRY_FILE = {"circuitpython": "code.py", "micropython": "main.py"}


class ProjectError(Exception):
    pass


def validate_name(name: str) -> str:
    name = (name or "").strip()
    if not NAME_RE.match(name):
        raise ProjectError("invalid_name")
    return name


# Files boady reads or writes on its own (no tool call, so no approval): only the
# project's own regular files, never through a symbolic link (review 9).
METADATA_FILES = ("boady.json", "CLAUDE.md")


def own_file(root: Path, name: str) -> Path | None:
    """``root/name`` if it is a regular file of the project itself, else None."""
    f = root / name
    if f.is_symlink() or not f.is_file() or f.resolve().parent != root.resolve():
        return None
    return f


def _writable(root: Path, name: str) -> Path:
    f = root / name
    if f.is_symlink() or (f.exists() and own_file(root, name) is None):
        raise ProjectError(f"unsafe_project_file: {name} is a symbolic link or not a regular file")
    return f


def _read_json(root: Path) -> Any:
    f = own_file(root, "boady.json")
    if f is None:
        return None
    try:
        return json.loads(f.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def read_type(root: Path) -> str | None:
    data = _read_json(root)
    t = data.get("type") if isinstance(data, dict) else None
    return t if t in PROJECT_TYPES else None


def write_type(root: Path, project_type: str) -> None:
    _writable(root, "boady.json").write_text(json.dumps({"type": project_type}, indent=2) + "\n", encoding="utf-8")


# Board kind, fixed by the first connection (D40):
#   "usb"      — a real board over USB
#   "rp2040js" — the emulator: Wokwi's rp2040js emulating a Raspberry Pi Pico (a test project)
BOARD_KINDS = ("usb", "rp2040js")


def read_board(root: Path) -> str | None:
    data = _read_json(root)
    b = data.get("board") if isinstance(data, dict) else None
    return b if b in BOARD_KINDS else None


def write_board(root: Path, kind: str) -> None:
    """Add ``board`` to boady.json, keeping its other keys (left uncommitted: git is manual)."""
    if kind not in BOARD_KINDS:
        raise ValueError(f"unknown board kind: {kind}")
    f = _writable(root, "boady.json")
    data = json.loads(f.read_text(encoding="utf-8"))
    data["board"] = kind
    f.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")


def _render(text: str, name: str, project_type: str) -> str:
    return text.replace("{{name}}", name).replace("{{type}}", project_type).replace("{{type_label}}", TYPE_LABEL[project_type])


def _doc_texts(name: str, project_type: str) -> dict[str, str]:
    """The project documents of a new project (not code), by path."""
    out = {"CLAUDE.md": _render(prompts.project_claude_md(project_type), name, project_type)}
    for fname, dest in (("DESIGN.md", "DESIGN.md"), ("README.md", "README.md"), ("CIRCUIT.md", "src/CIRCUIT.md")):
        out[dest] = _render((SKELETON_DIR / fname).read_text(encoding="utf-8"), name, project_type)
    return out


def write_skeleton(root: Path, name: str, project_type: str) -> None:
    (root / "src").mkdir(parents=True, exist_ok=True)
    write_type(root, project_type)
    for dest, text in _doc_texts(name, project_type).items():
        (root / dest).write_text(text, encoding="utf-8")
    entry = ENTRY_FILE[project_type]
    shutil.copyfile(SKELETON_DIR / entry, root / "src" / entry)


def _taken(d: Path, name: str) -> bool:
    """An entry ``name`` exists in ``d`` under any spelling (``readme.md`` counts for
    ``README.md``), or as a link, even a dangling one."""
    try:
        return any(e.name.casefold() == name.casefold() for e in d.iterdir())
    except OSError:
        return True  # unreadable (or a file where a directory should be): leave it alone


def fill_missing_docs(root: Path, name: str, project_type: str) -> list[str]:
    """After a clone: add the project documents a new project has (CLAUDE.md,
    DESIGN.md, README.md, src/CIRCUIT.md) that the repository lacks. Existing files
    under any spelling and links are left alone; no code files. Left uncommitted
    (git is manual). Returns the added paths (D44)."""
    added = []
    for dest, text in _doc_texts(name, project_type).items():
        f = root / dest
        d = f.parent
        if d.is_symlink() or not d.is_dir() or _taken(d, f.name):
            continue
        f.write_text(text, encoding="utf-8")
        added.append(dest)
    return added


async def create(projects_dir: Path, name: str, project_type: str) -> Path:
    name = validate_name(name)
    if project_type not in PROJECT_TYPES:
        raise ProjectError("invalid_type")
    root = projects_dir / name
    if root.exists():
        raise ProjectError("name_taken")
    root.mkdir(parents=True)
    try:
        write_skeleton(root, name, project_type)
        await gitops.init(root)
        await gitops.commit(root, "Create boady project")
    except Exception:
        shutil.rmtree(root, ignore_errors=True)
        raise
    return root


async def create_github_remote(root: Path, name: str, private: bool = True) -> str:
    """``gh repo create`` (private by default) and push."""
    vis = "--private" if private else "--public"
    res = await run(["gh", "repo", "create", name, vis, "--source", str(root), "--remote", "origin", "--push"], cwd=root, timeout=600)
    if not res.ok:
        raise ProjectError((res.stderr or res.stdout).strip() or "gh repo create failed")
    return (res.stdout + res.stderr).strip()


def name_from_url(url: str) -> str:
    base = url.rstrip("/").rsplit("/", 1)[-1].rsplit(":", 1)[-1]
    if base.endswith(".git"):
        base = base[:-4]
    base = re.sub(r"[^A-Za-z0-9._-]", "-", base).strip("-.") or "project"
    return base[:64]


def unique_name(projects_dir: Path, base: str, taken: set[str]) -> str:
    name, i = base, 2
    while name in taken or (projects_dir / name).exists():
        name = f"{base}-{i}"
        i += 1
    return name


Classifier = Callable[[Path], Awaitable[dict[str, Any]]]


async def clone(projects_dir: Path, url: str, taken: set[str], classify: Classifier) -> tuple[Path, str, str]:
    """Clone a repo. Returns (root, name, type). Raises ProjectError if unfit."""
    url = (url or "").strip()
    if not url or url.startswith("-") or any(c in url for c in "\n\r\0 "):
        raise ProjectError("invalid_url")
    name = unique_name(projects_dir, name_from_url(url), taken)
    root = projects_dir / name
    try:
        await run(["git", "clone", "-q", "--", url, str(root)], check=True, timeout=900)
    except ProcError as e:
        shutil.rmtree(root, ignore_errors=True)
        raise ProjectError(f"clone_failed: {e}") from e
    from .sync import MirrorPathError, mirror_src

    try:
        mirror_src(root)
    except MirrorPathError as e:
        shutil.rmtree(root, ignore_errors=True)
        raise ProjectError(f"repo_unfit: {e}") from e
    links = [n for n in METADATA_FILES if (root / n).is_symlink()]
    if links:
        shutil.rmtree(root, ignore_errors=True)
        raise ProjectError(f"repo_unfit: {links[0]} is a symbolic link; boady reads and writes it without asking, so it must be a regular file")
    project_type = read_type(root)
    if project_type is None:
        try:
            verdict = await classify(root)
        except Exception as e:
            shutil.rmtree(root, ignore_errors=True)
            raise ProjectError(f"classify_failed: {e}") from e
        if verdict.get("type") not in PROJECT_TYPES:
            shutil.rmtree(root, ignore_errors=True)
            raise ProjectError("repo_unfit: " + str(verdict.get("reason") or "type could not be determined"))
        project_type = verdict["type"]
        write_type(root, project_type)  # left uncommitted: git is manual
    fill_missing_docs(root, name, project_type)
    return root, name, project_type


def delete_dir(projects_dir: Path, root: Path) -> None:
    root_r, base = root.resolve(), projects_dir.resolve()
    if base not in root_r.parents:
        raise ProjectError("refusing to delete a directory outside the projects folder")
    shutil.rmtree(root_r, ignore_errors=True)


def parse_verdict(text: str) -> dict[str, Any]:
    """Extract the last JSON object from the classifier's final answer."""
    for m in reversed(list(re.finditer(r"\{[^{}]*\}", text or ""))):
        try:
            data = json.loads(m.group(0))
        except json.JSONDecodeError:
            continue
        if isinstance(data, dict) and "type" in data:
            return data
    return {"type": "reject", "reason": "no verdict"}
