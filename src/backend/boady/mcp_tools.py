"""The ``boady`` in-process MCP server: abstract file and serial tools.

Project type and transport differences are handled entirely by the frontend;
these tools do not distinguish them. JSON shapes: Specs/additional_specs.md (D7).
"""

from __future__ import annotations

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


def decode_ctrl(data: str) -> str:
    r"""Turn literal ``\x01``..``\x04`` escapes into Ctrl-A..Ctrl-D."""
    return _CTRL.sub(lambda m: chr(int(m.group(1))), data)


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


def _ok(data: Any) -> dict[str, Any]:
    return {"content": [{"type": "text", "text": json.dumps(data, ensure_ascii=False)}]}


def _err(msg: str) -> dict[str, Any]:
    return {"content": [{"type": "text", "text": json.dumps({"error": msg})}], "is_error": True}


READ_SCHEMA = {
    "type": "object",
    "properties": {
        "since": {"type": "integer", "description": "Cursor (byte position) to read from; use the cursor returned by a write."},
        "tail": {"type": "integer", "description": "Only return the last N lines."},
        "wait_for": {"type": "string", "description": "Wait until this text appears after `since`."},
        "timeout_ms": {"type": "integer", "description": "Max wait for `wait_for` (default 0)."},
    },
}
WRITE_SCHEMA = {
    "type": "object",
    "properties": {"data": {"type": "string", "description": "Text to write. \\x01-\\x04 mean Ctrl-A..Ctrl-D."}},
    "required": ["data"],
}


async def _dirty_src(root: Path) -> list[str]:
    return [f["path"] for f in await gitops.status(root) if f["path"].startswith("src/")]


async def pull_from_device(ctx: ToolContext, ask: bool = True) -> dict[str, Any]:
    """Shared by the tool and the user's pull button. Raises HardwareError.

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
    # fingerprint first: everything changed after this moment is asked about again,
    # including edits made while the first approval card is waiting
    before = sync.manifest(root / "src")
    dirty = await _dirty_src(root)
    if dirty and ask and not await ctx.confirm("pull_overwrites", {"files": dirty}):
        return {"declined": True}
    res = await ctx.bridge.request("fs.read_all", {}, timeout=300)
    while True:
        now = sync.manifest(root / "src")
        changed = sorted("src/" + p for p in set(before) | set(now) if before.get(p) != now.get(p))
        if not changed:
            break
        if not await ctx.confirm("pull_overwrites", {"files": changed}):
            return {"declined": True}
        before = now  # re-check: more edits may have arrived while asking
    changes = sync.apply_from_device(root / "src", (res or {}).get("files", {}))
    if ctx.on_synced:
        await ctx.on_synced("pull", changes)
    await ctx.on_mirror_changed()
    return changes


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
    src = root / "src"
    plan = await ctx.bridge.request("fs.plan", {"manifest": sync.manifest(src)}, timeout=300) or {}
    need = list(plan.get("need", []))
    delete = [p for p in plan.get("delete", []) if not sync.excluded(p)]
    res = await ctx.bridge.request(
        "fs.apply", {"files": sync.encode_files(src, need), "delete": delete}, timeout=600
    ) or {}
    out = {"written": res.get("written", need), "deleted": res.get("deleted", delete)}
    for k in ("channel", "restarted", "note"):
        if k in res:
            out[k] = res[k]
    if ctx.on_synced:
        await ctx.on_synced("push", out)
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
            wait_for=args.get("wait_for") or None,
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

    @tool("sync_from_device", "Pull all board files into the mirror src/ (left uncommitted in git).", {"type": "object", "properties": {}})
    async def sync_from_device(args):
        try:
            res = await pull_from_device(ctx)
        except HardwareError as e:
            return _err(str(e))
        if res.get("declined"):
            return _err(USER_DECLINED)
        return _ok(res)

    @tool("sync_to_device", "Sync the mirror src/ to the board (writes changed files, deletes extra ones).", {"type": "object", "properties": {}})
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
            out = await libraries.install(info[0], root / "src", list(args.get("names") or []), info[1])
        except libraries.LibraryError as e:
            return _err(str(e))
        await ctx.on_mirror_changed()
        return _ok({"output": out[-4000:]})

    @tool("list_libraries", "List libraries installed in the mirror src/lib.", {"type": "object", "properties": {}})
    async def list_libraries(args):
        info, root = ctx.project_info(), ctx.project_dir()
        if info is None or root is None:
            return _err("No project is open.")
        try:
            return _ok(await libraries.list_installed(info[0], root / "src"))
        except libraries.LibraryError as e:
            return _err(str(e))

    tools = [read_repl, write_repl, read_data, write_data, sync_from_device, sync_to_device, install_library, list_libraries]
    if only is not None:
        tools = [t for t in tools if t.name in only]
    return create_sdk_mcp_server("boady", "1.0.0", tools), [t.name for t in tools]
