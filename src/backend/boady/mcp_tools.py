"""The ``boady`` in-process MCP server: abstract file and serial tools.

Project type and transport differences are handled entirely by the frontend;
these tools do not distinguish them. JSON shapes: Specs/additional_specs.md (D7).
"""

from __future__ import annotations

import base64
import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Awaitable, Callable

from claude_agent_sdk import create_sdk_mcp_server, tool

from . import gitops, libraries, sync
from .hardware import HardwareBridge, HardwareError

USER_DECLINED = "User declined."

_CTRL = re.compile(r"\\x0([1-4])")


_TRAILING_ENTER = re.compile(r"(?:\\r|\\n)+$")


def decode_ctrl(data: str) -> str:
    r"""Turn literal ``\x01``..``\x04`` escapes into Ctrl-A..Ctrl-D, and a literal
    ``\r`` / ``\n`` at the very end into Enter.

    Models sometimes write Enter the same way as the Ctrl escapes (a backslash
    followed by ``r``). Only the end of ``data`` is decoded: there it can never be
    meaningful Python, while ``\n`` inside the code (e.g. ``exec("a\nb")``) must
    stay a Python escape.
    """
    data = _TRAILING_ENTER.sub(lambda m: "\r" * max(1, m.group(0).count("\\r")), data)
    return _CTRL.sub(lambda m: chr(int(m.group(1))), data)


_WAIT_ESC = re.compile(r"\\(x0[1-4]|r|n)")
_WAIT_CHARS = {"r": "\r", "n": "\n"}


def decode_wait_for(text: str) -> str:
    r"""``wait_for`` written the way the prompt teaches writing: ``\x01``..``\x04``,
    ``\r`` and ``\n`` as escape text become the real characters (board output
    practically never contains a literal backslash before them)."""
    return _WAIT_ESC.sub(lambda m: _WAIT_CHARS.get(m.group(1)) or chr(int(m.group(1)[1:], 16)), text)


def _wait_arg(w: Any) -> str | list[str] | None:
    if isinstance(w, list):
        return [decode_wait_for(str(x)) for x in w if x] or None
    return decode_wait_for(str(w)) if w else None


@dataclass
class ToolContext:
    bridge: HardwareBridge
    project_dir: Callable[[], Path | None]
    # ask the user a yes/no question in the chat; returns True if allowed
    confirm: Callable[[str, dict[str, Any]], Awaitable[bool]]
    on_mirror_changed: Callable[[], Awaitable[None]]
    on_synced: Callable[[str, dict[str, Any]], Awaitable[None]] | None = None
    # (project type, .mpy version) of the open project, or None
    project_info: Callable[[], tuple[str, int | None] | None] = lambda: None
    # why the connected board must not be used with the open project, or None
    board_error: Callable[[], str | None] = lambda: None
    # the board's file hashes right after the last pull / upload (baseline), or None
    get_baseline: Callable[[], dict[str, str] | None] = lambda: None
    set_baseline: Callable[[dict[str, str]], None] = lambda m: None


def _ok(data: Any) -> dict[str, Any]:
    return {"content": [{"type": "text", "text": json.dumps(data, ensure_ascii=False)}]}


def _err(msg: str) -> dict[str, Any]:
    return {"content": [{"type": "text", "text": json.dumps({"error": msg})}], "is_error": True}


READ_SCHEMA = {
    "type": "object",
    "properties": {
        "since": {"type": "integer", "description": "Cursor (byte position) to read from; use the cursor returned by a write."},
        "tail": {"type": "integer", "description": "Only return the last N lines."},
        "wait_for": {
            "anyOf": [{"type": "string"}, {"type": "array", "items": {"type": "string"}}],
            "description": "Wait until this text (or any of these texts) appears after `since`; `match` tells which came first. "
            "\\x01-\\x04, \\r and \\n may be written as escapes.",
        },
        "timeout_ms": {"type": "integer", "description": "Max wait for `wait_for` (default 0)."},
    },
}
WRITE_SCHEMA = {
    "type": "object",
    "properties": {"data": {"type": "string", "description": "Text to write. \\x01-\\x04 mean Ctrl-A..Ctrl-D. End a line with a real carriage return (Enter); a trailing backslash-r is also accepted as Enter."}},
    "required": ["data"],
}


async def _dirty_src(root: Path) -> list[str]:
    return [f["path"] for f in await gitops.status(root) if f["path"].startswith("src/")]


async def pull_from_device(ctx: ToolContext, ask: bool = True, paths: list[str] | None = None) -> dict[str, Any]:
    """Shared by the tool and the user's pull button. Raises HardwareError.

    ``paths`` (src-relative): only make these mirror files equal to the board's
    (written, or deleted if the board has no such file); all others stay as they
    are. Used to keep selected board changes without overwriting local edits.

    Uncommitted changes in src/ are only overwritten with the user's consent.
    The transfer can take minutes, so the mirror is fingerprinted before it and
    compared again right before writing; anything changed meanwhile is asked
    about again. The final compare and the write run without awaiting in
    between, so nothing in this process can interleave.
    """
    root = ctx.project_dir()
    if root is None:
        raise HardwareError("No project is open.")
    if not ctx.bridge.connected:
        raise HardwareError("Device not connected.")
    _check_board(ctx)
    src = _src(root)
    # fingerprint first: everything changed after this moment is asked about again,
    # including edits made while the first approval card is waiting
    scope = None
    if paths is not None:
        bad = [p for p in paths if sync.canonical_rel(p) is None]
        if bad or not paths:
            raise HardwareError(f"paths must be plain src-relative paths like 'lib/x.py' (got {bad[0]!r})" if bad else "paths is empty")
        # one path, one file: on case-insensitive file systems CODE.PY reaches code.py,
        # which the local-edit check (exact names) would not see
        aliases = [(p, sync.case_alias(src, p)) for p in paths]
        aliases = [(p, a) for p, a in aliases if a]
        if aliases:
            raise HardwareError(f"{aliases[0][0]!r} names the existing file {aliases[0][1]!r} with a different spelling; use the exact name")
        scope = set(paths)
    if scope is not None and any(sync.excluded(p) for p in scope):
        raise HardwareError("These files are never synced: " + ", ".join(sorted(p for p in scope if sync.excluded(p))))

    def in_scope(m: dict[str, str]) -> dict[str, str]:
        return m if scope is None else {k: v for k, v in m.items() if k in scope}

    before = in_scope(sync.manifest(src))
    dirty = [f for f in await _dirty_src(root) if scope is None or f[len("src/"):] in scope]
    if dirty and ask and not await ctx.confirm("pull_overwrites", {"files": dirty}):
        return {"declined": True}
    res = await ctx.bridge.request("fs.read_all", {}, timeout=300)
    while True:
        now = in_scope(sync.manifest(src))
        changed = sorted("src/" + p for p in set(before) | set(now) if before.get(p) != now.get(p))
        if not changed:
            break
        if not await ctx.confirm("pull_overwrites", {"files": changed}):
            return {"declined": True}
        before = now  # re-check: more edits may have arrived while asking
    board_files = (res or {}).get("files", {})
    try:
        changes = sync.apply_from_device(src, board_files) if scope is None else sync.apply_paths(src, board_files, sorted(scope))
    except ValueError as e:
        raise HardwareError(str(e)) from e
    board_manifest = sync.manifest_of(board_files)
    if scope is None:
        ctx.set_baseline(board_manifest)
    else:
        # Reading a file is not handling its change: only the taken files move
        # to the board's state; every other board change stays visible to the
        # next compare_with_device. Without a baseline, only the taken files
        # are known, so all others will be reported (safe side).
        base = dict(ctx.get_baseline() or {})
        for rel in scope:
            if rel in board_manifest:
                base[rel] = board_manifest[rel]
            else:
                base.pop(rel, None)
        ctx.set_baseline(base)
    if ctx.on_synced:
        await ctx.on_synced("pull", changes)
    await ctx.on_mirror_changed()
    return changes


def _src(root: Path) -> Path:
    try:
        return sync.mirror_src(root)
    except sync.MirrorPathError as e:
        raise HardwareError(str(e)) from e


def _check_board(ctx: ToolContext) -> None:
    err = ctx.board_error()
    if err:
        raise HardwareError(err)


async def push_to_device(ctx: ToolContext) -> dict[str, Any]:
    root = ctx.project_dir()
    if root is None:
        raise HardwareError("No project is open.")
    if not ctx.bridge.connected:
        raise HardwareError("Device not connected.")
    _check_board(ctx)
    src = _src(root)
    # One snapshot for the plan, the transferred bytes and the baseline: edits
    # made while the upload runs are not part of it (they go with the next one).
    snap = sync.snapshot(src)
    snap_manifest = {rel: sync.sha256(data) for rel, data in snap.items()}
    plan = await ctx.bridge.request("fs.plan", {"manifest": snap_manifest}, timeout=300) or {}
    need = [p for p in plan.get("need", []) if p in snap]
    delete = [p for p in plan.get("delete", []) if not sync.excluded(p)]
    files = {rel: base64.b64encode(snap[rel]).decode() for rel in need}
    # The REPL position before the transfer: everything after it is the sync markers and
    # what the board prints after it (the reload the frontend triggers), never older output.
    since = ctx.bridge.buffers["repl"].end
    res = await ctx.bridge.request("fs.apply", {"files": files, "delete": delete}, timeout=600) or {}
    out = {"written": res.get("written", need), "deleted": res.get("deleted", delete), "since": since}
    for k in ("channel", "restarted", "note"):
        if k in res:
            out[k] = res[k]
    ctx.set_baseline(snap_manifest)  # the board now equals the snapshot that was sent
    if ctx.on_synced:
        await ctx.on_synced("push", out)
    return out


async def compare_with_device(ctx: ToolContext) -> dict[str, Any]:
    """Read the board into a buffer (the mirror is not touched) and compare.

    ``changed_on_board``: files that differ from the baseline (the board right
    after the last pull or upload) — changes made on the board itself, e.g. by
    the REPL or a running program. ``board_only`` / ``mirror_only`` / ``differs``:
    the board against the mirror (includes the mirror's own new edits).
    ``diffs``: short mirror->board diffs of those files (``+`` = the board's
    lines). ``edited_in_mirror``: files of ``changed_on_board`` that were also
    edited in the mirror since the baseline; their diff mixes both changes.
    """
    root = ctx.project_dir()
    if root is None:
        raise HardwareError("No project is open.")
    if not ctx.bridge.connected:
        raise HardwareError("Device not connected.")
    _check_board(ctx)
    src = _src(root)
    # one snapshot for the hashes and the diffs: a file saved while the board is read
    # must not appear in the diffs while edited_in_mirror says it was not edited
    local = sync.snapshot(src)
    mirror = {rel: sync.sha256(data) for rel, data in local.items()}
    baseline = ctx.get_baseline()
    # Files whose board hash equals a known one are not transferred (``same``). Every file
    # that needs a diff differs from what is sent here: the baseline when there is one
    # (diffs of changed_on_board), else the mirror (diffs of board_only / differs).
    known = baseline if baseline is not None else mirror
    res = await ctx.bridge.request("fs.read_all", {"known": known}, timeout=300) or {}
    board_files = {k.strip("/"): v for k, v in res.get("files", {}).items() if k.strip("/") and not sync.excluded(k)}
    board = sync.manifest_of(board_files)
    for p in res.get("same") or []:
        if isinstance(p, str) and p in known and p not in board and not sync.excluded(p):
            board[p] = known[p]
    out: dict[str, Any] = {
        "changed_on_board": None if baseline is None else sorted(
            p for p in set(board) | set(baseline) if board.get(p) != baseline.get(p)
        ),
        "board_only": sorted(set(board) - set(mirror)),
        "mirror_only": sorted(set(mirror) - set(board)),
        "differs": sorted(p for p in set(board) & set(mirror) if board[p] != mirror[p]),
    }
    if baseline is not None:
        out["edited_in_mirror"] = sorted(p for p in out["changed_on_board"] if mirror.get(p) != baseline.get(p))
    interesting = out["changed_on_board"] if baseline is not None else out["board_only"] + out["differs"]
    out["diffs"] = sync.text_diffs(local, board_files, interesting)
    if baseline is None:
        out["note"] = "No baseline yet (no pull or upload since boady started tracking this board): changed_on_board is unknown."
    return out


def build_server(ctx: ToolContext, only: set[str] | None = None, check_board: bool = True):
    """``check_board=False`` only for the identification call: it must talk to a
    board that is not identified yet (and it only gets read/write_repl)."""
    b = ctx.bridge

    async def _read(port: str, args: dict[str, Any]) -> dict[str, Any]:
        try:
            b.require_port(port)
        except HardwareError as e:
            return _err(str(e))
        r = await b.buffers[port].read(
            since=args.get("since"),
            tail=args.get("tail"),
            wait_for=_wait_arg(args.get("wait_for")),
            timeout_ms=int(args.get("timeout_ms") or 0),
        )
        return _ok(r.to_dict())

    async def _write(port: str, args: dict[str, Any]) -> dict[str, Any]:
        try:
            if check_board:
                _check_board(ctx)
            cursor = await b.write(port, decode_ctrl(str(args.get("data", ""))))
        except HardwareError as e:
            return _err(str(e))
        return _ok({"cursor": cursor})

    @tool("read_repl", "Read the REPL serial port history (never clears it).", READ_SCHEMA)
    async def read_repl(args):
        return await _read("repl", args)

    @tool("write_repl", "Write to the REPL serial port. Returns the cursor at write time; read with since=cursor.", WRITE_SCHEMA)
    async def write_repl(args):
        return await _write("repl", args)

    @tool("read_data", "Read the data serial port history (CircuitPython usb_cdc data).", READ_SCHEMA)
    async def read_data(args):
        return await _read("data", args)

    @tool("write_data", "Write to the data serial port. Returns the cursor at write time.", WRITE_SCHEMA)
    async def write_data(args):
        return await _write("data", args)

    @tool(
        "sync_from_device",
        "Pull board files into the mirror src/ (left uncommitted in git). Without `paths` the whole mirror becomes "
        "equal to the board; with `paths` (src-relative, e.g. ['data.txt']) only those files are taken from the board "
        "and all other mirror files are left as they are.",
        {"type": "object", "properties": {"paths": {"type": "array", "items": {"type": "string"}}}},
    )
    async def sync_from_device(args):
        paths = args.get("paths")
        try:
            res = await pull_from_device(ctx, paths=list(paths) if isinstance(paths, list) else None)
        except HardwareError as e:
            return _err(str(e))
        if res.get("declined"):
            return _err(USER_DECLINED)
        return _ok(res)

    @tool(
        "sync_to_device",
        "Sync the mirror src/ to the board (writes changed files, deletes extra ones). The result's `since` is the "
        "REPL cursor before the sync: read the board's output after it with read_repl(since=...).",
        {"type": "object", "properties": {}},
    )
    async def sync_to_device(args):
        try:
            return _ok(await push_to_device(ctx))
        except HardwareError as e:
            return _err(str(e))

    @tool(
        "install_library",
        "Install libraries into the mirror src/lib (CircuitPython: circup bundle names; MicroPython: "
        "mip package names, github:org/repo[/path], or URLs, optionally name@version). Reaches the board with the next sync.",
        {"type": "object", "properties": {"names": {"type": "array", "items": {"type": "string"}}}, "required": ["names"]},
    )
    async def install_library(args):
        info, root = ctx.project_info(), ctx.project_dir()
        if info is None or root is None:
            return _err("No project is open.")
        try:
            out = await libraries.install(info[0], sync.mirror_src(root), list(args.get("names") or []), info[1])
        except (libraries.LibraryError, sync.MirrorPathError) as e:
            return _err(str(e))
        await ctx.on_mirror_changed()
        return _ok({"output": out[-4000:]})

    @tool("list_libraries", "List libraries installed in the mirror src/lib.", {"type": "object", "properties": {}})
    async def list_libraries(args):
        info, root = ctx.project_info(), ctx.project_dir()
        if info is None or root is None:
            return _err("No project is open.")
        try:
            return _ok(await libraries.list_installed(info[0], sync.mirror_src(root)))
        except (libraries.LibraryError, sync.MirrorPathError) as e:
            return _err(str(e))

    @tool(
        "compare_with_device",
        "Read the board into a buffer and compare it with the mirror and with the board's state after the last "
        "pull/upload. Never changes the mirror. Call before every sync_to_device.",
        {"type": "object", "properties": {}},
    )
    async def compare_tool(args):
        try:
            return _ok(await compare_with_device(ctx))
        except HardwareError as e:
            return _err(str(e))

    tools = [read_repl, write_repl, read_data, write_data, sync_from_device, compare_tool, sync_to_device, install_library, list_libraries]
    if only is not None:
        tools = [t for t in tools if t.name in only]
    return create_sdk_mcp_server("boady", "1.0.0", tools), [t.name for t in tools]
