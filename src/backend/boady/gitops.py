"""Git operations on a project mirror. All are triggered manually (user action
or an agent tool call the user approved); nothing here runs automatically."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from . import files
from .proc import ProcError, run

FALLBACK_IDENTITY = ["-c", "user.name=boady", "-c", "user.email=boady@localhost"]


async def _identity_args(repo: Path) -> list[str]:
    """Use the user's git identity; fall back to a local one if none is set."""
    name = await run(["git", "config", "user.name"], cwd=repo)
    email = await run(["git", "config", "user.email"], cwd=repo)
    if name.ok and name.stdout.strip() and email.ok and email.stdout.strip():
        return []
    return FALLBACK_IDENTITY


async def git(repo: Path, *args: str, check: bool = True) -> str:
    res = await run(["git", *args], cwd=repo, check=check)
    return res.stdout


async def init(repo: Path) -> None:
    await run(["git", "init", "-q", "-b", "main"], cwd=repo, check=True)


async def has_commits(repo: Path) -> bool:
    res = await run(["git", "rev-parse", "--verify", "-q", "HEAD"], cwd=repo)
    return res.ok


async def status(repo: Path) -> list[dict[str, str]]:
    """Changed files: [{path, status}] with status in added/modified/deleted/renamed."""
    out = await git(repo, "status", "--porcelain=v1", "-z", "--untracked-files=all")
    entries: list[dict[str, str]] = []
    parts = out.split("\0")
    i = 0
    while i < len(parts):
        item = parts[i]
        i += 1
        if len(item) < 4:
            continue
        xy, path = item[:2], item[3:]
        orig = None
        if "R" in xy:
            orig = parts[i] if i < len(parts) else None  # -z: rename source follows
            i += 1
            st = "renamed"
        elif xy == "??" or "A" in xy:
            st = "added"
        elif "D" in xy:
            st = "deleted"
        else:
            st = "modified"
        if orig:
            entries.append({"path": path, "status": st, "from": orig})
            continue
        entries.append({"path": path, "status": st})
    entries.sort(key=lambda e: e["path"])
    return entries


async def diff(repo: Path, path: str | None = None) -> str:
    """Unified diff of the working tree against HEAD, including untracked files."""
    files = await status(repo)
    if path is not None:
        files = [f for f in files if f["path"] == path]
    chunks: list[str] = []
    head = await has_commits(repo)
    for f in files:
        if f["status"] == "added":
            tracked = (await run(["git", "ls-files", "--error-unmatch", "--", f["path"]], cwd=repo)).ok
            if not tracked or not head:
                res = await run(["git", "diff", "--no-index", "--", "/dev/null", f["path"]], cwd=repo)
                chunks.append(res.stdout)
                continue
        if head:
            chunks.append(await git(repo, "diff", "HEAD", "--", f["path"]))
    return "".join(chunks)


async def log(repo: Path, limit: int = 50) -> list[dict[str, Any]]:
    if not await has_commits(repo):
        return []
    out = await git(repo, "log", f"-n{limit}", "--format=%H%x1f%an%x1f%at%x1f%s%x1e")
    commits = []
    for rec in out.split("\x1e"):
        rec = rec.strip()
        if not rec:
            continue
        h, author, ts, subject = rec.split("\x1f", 3)
        commits.append({"hash": h, "author": author, "time": int(ts), "subject": subject})
    return commits


async def commit(repo: Path, message: str) -> str:
    if not message.strip():
        raise ValueError("commit message is empty")
    await git(repo, "add", "-A")
    ident = await _identity_args(repo)
    await run(["git", *ident, "commit", "-q", "-m", message], cwd=repo, check=True)
    return (await git(repo, "rev-parse", "HEAD")).strip()


async def _reset_one(repo: Path, path: str) -> None:
    tracked_in_head = (await has_commits(repo)) and (
        await run(["git", "cat-file", "-e", f"HEAD:{path}"], cwd=repo)
    ).ok
    if tracked_in_head:
        await git(repo, "restore", "--staged", "--worktree", "--source=HEAD", "--", path)
    else:
        await run(["git", "rm", "-q", "--cached", "--ignore-unmatch", "--", path], cwd=repo)
        target = files.resolve(repo, path)
        if target.is_file():
            target.unlink()


async def reset_file(repo: Path, path: str) -> None:
    """Discard changes to one path; a rename is undone on both ends."""
    files.resolve(repo, path)  # refuses paths outside the project and inside .git
    entry = next((e for e in await status(repo) if e["path"] == path), None)
    await _reset_one(repo, path)
    if entry and entry.get("from"):
        files.resolve(repo, entry["from"])
        await _reset_one(repo, entry["from"])


async def reset_all(repo: Path) -> None:
    if await has_commits(repo):
        await git(repo, "reset", "-q", "--hard", "HEAD")
    else:
        await run(["git", "rm", "-rq", "--cached", "--ignore-unmatch", "."], cwd=repo)
    await git(repo, "clean", "-fdq")


async def remotes(repo: Path) -> list[str]:
    return [r for r in (await git(repo, "remote")).split() if r]


async def push(repo: Path) -> str:
    if not await remotes(repo):
        raise ProcError(["git"], _fake("no remote configured; create one with GitHub first"))
    branch = (await git(repo, "rev-parse", "--abbrev-ref", "HEAD")).strip()
    res = await run(["git", "push", "-u", "origin", branch], cwd=repo, check=True, timeout=600)
    return (res.stderr + res.stdout).strip()


def _fake(msg: str):
    from .proc import ProcResult

    return ProcResult(1, "", msg)
