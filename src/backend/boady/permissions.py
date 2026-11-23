"""Tool permission rules (pure functions, unit-tested).

Three layers (spec「权限审批」):
1. static options: which tools exist at all (``BUILTIN_TOOLS`` + boady MCP tools);
2. ``classify`` -> "allow" (silently) or "ask" (pushed to the frontend);
3. ``hard_block`` -> a reason string when a PreToolUse hook must deny outright.

Bash is kept but restricted to a whitelist (git, circup with ``--path``);
see Specs/additional_specs.md, decision D3.
"""

from __future__ import annotations

import shlex
from pathlib import Path
from typing import Any, Literal

from .util import is_within

BUILTIN_TOOLS = ["Read", "Edit", "Write", "Glob", "Grep", "Bash", "TodoWrite"]
MCP_PREFIX = "mcp__boady__"

# boady MCP tools that run without asking
MCP_AUTO_ALLOW = {
    "read_repl",
    "write_repl",
    "read_data",
    "write_data",
    "sync_from_device",
    "install_library",
    "list_libraries",
}
MCP_ASK = {"sync_to_device"}

GIT_READONLY = {"status", "diff", "log", "show", "blame", "ls-files", "rev-parse", "shortlog"}
GIT_ALLOWED = GIT_READONLY | {
    "add", "commit", "reset", "restore", "checkout", "switch", "branch", "push",
    "pull", "fetch", "rm", "mv", "tag", "stash", "remote", "revert", "merge",
}
CIRCUP_AUTO = {"install", "update", "uninstall", "list", "freeze", "show"}
SHELL_META = (";", "&", "|", "`", "$(", ">", "<", "\n", "\r")

Decision = Literal["allow", "ask"]


def _path_arg(tool: str, inp: dict[str, Any]) -> str | None:
    if tool in ("Read", "Edit", "Write"):
        return inp.get("file_path")
    if tool in ("Glob", "Grep"):
        return inp.get("path")
    return None


def _inside(root: Path, p: str | None, default_inside: bool = True) -> bool:
    if not p:
        return default_inside
    path = Path(p)
    if not path.is_absolute():
        path = root / path
    return is_within(path, root)


def _in_git_dir(root: Path, p: str | None) -> bool:
    if not p:
        return False
    path = Path(p)
    if not path.is_absolute():
        path = root / path
    return is_within(path, root / ".git")


def parse_bash(command: str) -> list[str] | None:
    """Split a whitelisted command; None if it uses shell features."""
    if any(m in command for m in SHELL_META):
        return None
    try:
        argv = shlex.split(command)
    except ValueError:
        return None
    return argv or None


def _circup_path_ok(argv: list[str], root: Path) -> bool:
    src = root / "src"
    for i, a in enumerate(argv):
        val = None
        if a == "--path" and i + 1 < len(argv):
            val = argv[i + 1]
        elif a.startswith("--path="):
            val = a.split("=", 1)[1]
        if val is not None:
            p = Path(val)
            if not p.is_absolute():
                p = root / p
            return p.resolve() == src.resolve()
    return False


def _args_leave_root(argv: list[str], root: Path) -> bool:
    for a in argv[1:]:
        if a.startswith("-"):
            continue
        if a.startswith("/") or a.startswith("~") or ".." in Path(a).parts:
            if not _inside(root, a.replace("~", str(Path.home()), 1)):
                return True
    return False


def hard_block(tool: str, inp: dict[str, Any], root: Path) -> str | None:
    """Reason to deny outright (PreToolUse), or None."""
    if tool in ("Edit", "Write") and _in_git_dir(root, inp.get("file_path")):
        return "Writing inside .git is not allowed."
    if tool != "Bash":
        return None
    argv = parse_bash(str(inp.get("command", "")))
    if argv is None:
        return "Bash only runs single whitelisted commands (no pipes, redirects, chaining or substitution)."
    prog = argv[0]
    if prog == "git":
        if len(argv) < 2 or argv[1].startswith("-"):
            return "git global options (-C, -c, ...) are not allowed; run git subcommands in the project root."
        if argv[1] == "config":
            if any(a in ("--get", "--list", "-l", "--get-all") for a in argv[2:]):
                return None
            return "Changing git config is not allowed."
        if argv[1] not in GIT_ALLOWED:
            return f"git {argv[1]} is not in the boady whitelist."
        return None
    if prog == "circup":
        if not _circup_path_ok(argv, root):
            return "circup must be called with --path src (the project mirror)."
        return None
    if prog == "mpremote":
        return "mpremote cannot reach the board from the backend; use the boady library tool for MicroPython packages."
    return f"Bash command '{prog}' is not in the boady whitelist (git, circup)."


def classify(tool: str, inp: dict[str, Any], root: Path) -> Decision:
    """Allow silently, or ask the user (frontend approval card)."""
    if tool.startswith(MCP_PREFIX):
        name = tool[len(MCP_PREFIX):]
        return "allow" if name in MCP_AUTO_ALLOW else "ask"
    if tool == "TodoWrite":
        return "allow"
    if tool in ("Read", "Glob", "Grep", "Edit", "Write"):
        return "allow" if _inside(root, _path_arg(tool, inp)) else "ask"
    if tool == "Bash":
        argv = parse_bash(str(inp.get("command", "")))
        if not argv:
            return "ask"
        if _args_leave_root(argv, root):
            return "ask"
        if argv[0] == "git" and len(argv) > 1:
            if argv[1] in GIT_READONLY:
                return "allow"
            if argv[1] == "branch" and len(argv) == 2:
                return "allow"
            if argv[1] == "config":
                return "allow"
            return "ask"
        if argv[0] == "circup" and _circup_path_ok(argv, root):
            sub = next((a for a in argv[1:] if not a.startswith("-") and not _is_opt_value(argv, a)), None)
            return "allow" if sub in CIRCUP_AUTO else "ask"
        return "ask"
    return "ask"


def _is_opt_value(argv: list[str], a: str) -> bool:
    i = argv.index(a)
    return i > 0 and argv[i - 1] in ("--path", "--board-id", "--cpy-version")
