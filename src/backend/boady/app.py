"""The Python shell: one frontend connection, one open project, one agent session.

Protocol (JSON text frames) is documented in Specs/additional_specs.md (D6).
"""

from __future__ import annotations

import asyncio
import base64
import itertools
import json
import logging
import shutil
import time
from pathlib import Path
from typing import Any, Awaitable, Callable

from claude_agent_sdk import (
    AssistantMessage,
    ClaudeAgentOptions,
    ClaudeSDKClient,
    PermissionResultAllow,
    PermissionResultDeny,
    ResultMessage,
    TextBlock,
)

from . import files, gitops, sync, identify, libraries, mcp_tools, pairing, projects, prompts
from .agent import AgentSession, claude_env, cli_path
from .config import PROJECT_TYPES, Paths
from .hardware import DeviceState, HardwareBridge, HardwareError
from .proc import ProcError, run
from .project_table import Project, ProjectTable
from .util import is_within, read_json, write_json

log = logging.getLogger("boady.app")

VERSION = "0.1.0"
Send = Callable[[dict[str, Any]], Awaitable[None]]


class Connection:
    """A frontend connection (wraps a websocket send/close)."""

    def __init__(self, send: Send, close: Callable[[], Awaitable[None]]):
        self.send = send
        self.close = close
        self.mode = "browser"
        self.hw: dict[str, Any] = {}


class App:
    def __init__(self, paths: Paths, client_factory: Callable[[ClaudeAgentOptions], Any] = ClaudeSDKClient):
        self.paths = paths
        paths.ensure()
        self.token = pairing.load_or_create_token(paths.token_file)
        self.table = ProjectTable(paths.table_file)
        self.prefs: dict[str, Any] = read_json(paths.prefs_file, {"language": "en", "last_project": None})
        self.client_factory = client_factory
        self.conn: Connection | None = None
        self.bridge = HardwareBridge()
        self.bridge.on_lock_change = self.push_state
        self.project: Project | None = None
        self.session: AgentSession | None = None
        self.select_required: dict[str, Any] | None = None
        self._perm_ids = itertools.count(1)
        self.pending_perms: dict[str, tuple[asyncio.Future, dict[str, Any]]] = {}
        self.tool_ctx = mcp_tools.ToolContext(
            bridge=self.bridge,
            project_dir=lambda: self.project.path if self.project else None,
            confirm=self.confirm,
            on_mirror_changed=self.push_state,
        )
        self.auth_status: dict[str, Any] = {"claude": None, "github": None}
        self.tool_ctx.on_synced = self.on_synced
        self.tool_ctx.board_error = self.board_error
        self.tool_ctx.get_baseline = self.get_baseline
        self.tool_ctx.set_baseline = self.set_baseline
        self.tool_ctx.get_baseline_texts = self.get_baseline_texts
        # a DeviceState is replaced on every attach/detach, so its identity names one connection
        self.tool_ctx.binding = lambda: (self.project.id if self.project else None, id(self.bridge.device), self.bridge.device.uid)
        self.tool_ctx.project_info = lambda: (self.project.type, self.project.mpy_version) if self.project else None
        self._tasks: set[asyncio.Task] = set()
        self._state_seq = itertools.count(1)
        self._state_sent = 0
        self._identify_task: asyncio.Task | None = None

    # ------------------------------------------------------------------ io
    async def send(self, msg: dict[str, Any]) -> None:
        conn = self.conn
        if conn is None:
            return
        try:
            await conn.send(msg)
        except Exception as e:  # connection went away
            log.debug("send failed: %s", e)

    async def emit_agent(self, ev: dict[str, Any]) -> None:
        await self.send({"type": "agent_event", **ev})

    def audit(self, line: str) -> None:
        try:
            with open(self.paths.audit_log, "a", encoding="utf-8") as f:
                f.write(line + "\n")
        except OSError:
            pass

    # ---------------------------------------------------------- connection
    async def authenticate(self, conn: Connection, hello: dict[str, Any]) -> bool:
        if hello.get("type") not in ("hello", "auth") or not pairing.check_token(self.token, hello.get("token")):
            await conn.send({"type": "hello.error", "reason": "bad_token"})
            return False
        old, self.conn = self.conn, conn
        if old is not None and old is not conn:
            try:
                await old.send({"type": "replaced"})
                await old.close()
            except Exception:
                pass
            self.bridge.detach_frontend()
        conn.mode = str(hello.get("mode", "browser"))
        conn.hw = dict(hello.get("hw") or {})
        self.bridge.attach_frontend(self.send)
        await conn.send({"type": "hello.ok", "version": VERSION})
        if self.project is None and self.prefs.get("last_project") and self.table.get(self.prefs["last_project"]):
            try:
                await self.open_project(self.prefs["last_project"], announce=False)
            except Exception as e:
                log.warning("could not reopen last project: %s", e)
        await self.resync()
        return True

    async def resync(self) -> None:
        """Full state snapshot + chat history + pending approvals (after hello)."""
        await self.push_state()
        if self.session:
            await self.emit_agent({"kind": "history", "items": self.session.items, "running": self.session.running, "partial": self.session.partial})
        else:
            await self.emit_agent({"kind": "history", "items": [], "running": False, "partial": ""})
        for _, req in self.pending_perms.values():
            await self.send(req)
        if self.select_required:
            await self.send(self.select_required)

    async def disconnected(self, conn: Connection) -> None:
        if self.conn is conn:
            self.conn = None
            self.bridge.detach_frontend()
            await self.bridge.release_all()

    # --------------------------------------------------------------- state
    async def snapshot(self) -> dict[str, Any]:
        p = self.project
        state: dict[str, Any] = {
            "type": "state",
            "version": VERSION,
            "prefs": self.prefs,
            "projects": [self._project_info(x) for x in self.table.all()],
            "project": self._project_info(p) if p else None,
            "device": self.bridge.device.to_dict(),
            "serial": {"lock": self.bridge.lock_owner},
            "agent": {"running": bool(self.session and self.session.running)},
            "auth": self.auth_status,
            "tree": [],
            "git": {"status": [], "log": [], "remotes": []},
        }
        if p and p.path.is_dir():
            try:
                state["tree"] = files.tree(p.path)
                state["git"] = {
                    "status": await gitops.status(p.path),
                    "log": await gitops.log(p.path),
                    "remotes": await gitops.remotes(p.path),
                }
            except Exception as e:
                log.warning("state failed: %s", e)
        return state

    def _project_info(self, p: Project) -> dict[str, Any]:
        return {
            "id": p.id, "name": p.name, "type": p.type, "board": p.board, "board_uid": p.board_uid,
            "last_opened": p.last_opened, "created_at": p.created_at, "dir": p.dir,
        }

    async def push_state(self) -> None:
        """Send a full state. Building it awaits git; a snapshot overtaken meanwhile by a
        newer one or by a project switch is dropped, so an old project's state can never
        arrive after the new one's (review 13)."""
        if self.conn is None:
            return
        seq = next(self._state_seq)
        snap = await self.snapshot()
        current = self.project.id if self.project else None
        if seq < self._state_sent or (snap.get("project") or {}).get("id") != current:
            return
        self._state_sent = seq
        await self.send(snap)

    def save_prefs(self) -> None:
        write_json(self.paths.prefs_file, self.prefs)

    # ---------------------------------------------------------- approvals
    async def _ask(self, kind: str, payload: dict[str, Any]) -> tuple[bool, str]:
        rid = f"perm{next(self._perm_ids)}"
        req = {"type": "permission_request", "request_id": rid, "kind": kind, **payload}
        fut: asyncio.Future = asyncio.get_running_loop().create_future()
        self.pending_perms[rid] = (fut, req)
        if self.session:
            item = {"id": rid, "kind": "permission", "request_id": rid, "perm_kind": kind, "status": "pending", **payload}
            self.session.items.append(item)
        await self.send(req)
        try:
            allowed, message = await fut
        finally:
            self.pending_perms.pop(rid, None)
        if self.session:
            for it in self.session.items:
                if it.get("id") == rid:
                    it["status"] = "allowed" if allowed else "denied"
        await self.emit_agent({"kind": "permission_resolved", "request_id": rid, "allowed": allowed})
        return allowed, message

    async def ask_tool_permission(self, tool: str, tinput: dict[str, Any], tool_use_id: str) -> tuple[bool, str]:
        return await self._ask("tool", {"tool": tool, "input": tinput, "tool_use_id": tool_use_id})

    async def confirm(self, what: str, detail: dict[str, Any]) -> bool:
        allowed, _ = await self._ask("confirm", {"what": what, "detail": detail})
        return allowed

    def resolve_permission(self, rid: str, allow: bool, message: str = "") -> None:
        entry = self.pending_perms.get(rid)
        if entry and not entry[0].done():
            entry[0].set_result((allow, message))

    def deny_all_permissions(self, message: str) -> None:
        for rid in list(self.pending_perms):
            self.resolve_permission(rid, False, message)

    # ------------------------------------------------------------- projects
    async def open_project(self, project_id: str, announce: bool = True, device_check: bool = True) -> Project:
        p = self.table.get(project_id)
        if p is None:
            raise projects.ProjectError("unknown_project")
        if not p.path.is_dir():
            raise projects.ProjectError("project_dir_missing")
        actual = projects.read_type(p.path)
        if actual is None:
            raise projects.ProjectError("boady_json_missing")
        if actual != p.type:
            p = self.table.update(p.id, type=actual)
        board = projects.read_board(p.path)
        if board != p.board:
            p = self.table.update(p.id, board=board)
        if self.project and self.project.id == p.id and self.session:
            self.select_required = None
            return p
        await self.close_project()
        self.project = self.table.update(p.id, last_opened=time.time())
        self.prefs["last_project"] = p.id
        self.save_prefs()
        self.select_required = None
        server, names = mcp_tools.build_server(self.tool_ctx)
        self.session = AgentSession(
            self.project, self.emit_agent, self.ask_tool_permission, server, names,
            env=claude_env(self.paths.claude_token_file), audit=self.audit, client_factory=self.client_factory,
        )
        self.session.on_turn_end = self._turn_ended
        self.session.on_tool_result = self.push_state
        if announce:
            await self.resync()
        if device_check and self.bridge.device.uid:
            self._spawn(self.project_for_device(explicit=True))
        return self.project

    async def close_project(self) -> None:
        if self.session:
            self.deny_all_permissions("Project closed.")
            await self.bridge.cancel_all("Project closed.")
            await self.session.close()
        self.session = None
        self.project = None

    async def _turn_ended(self) -> None:
        await self.bridge.release_all()
        self.deny_all_permissions("Turn ended.")
        await self.push_state()

    async def classify_clone(self, root: Path) -> dict[str, Any]:
        """One-shot read-only agent call deciding the type of a cloned repo."""

        async def can_use(name: str, tinput: dict[str, Any], _ctx: Any):
            path = tinput.get("file_path") or tinput.get("path") or str(root)
            target = Path(path) if Path(path).is_absolute() else root / path
            if name in ("Read", "Glob", "Grep") and is_within(target, root):
                return PermissionResultAllow(updated_input=tinput)
            return PermissionResultDeny(message="Only read-only access inside the repository is allowed.")

        opts = ClaudeAgentOptions(
            cwd=str(root), tools=["Read", "Glob", "Grep"], setting_sources=[],
            system_prompt=prompts.task("classify_clone"), can_use_tool=can_use,
            max_turns=20, env=claude_env(self.paths.claude_token_file), cli_path=cli_path(),
        )
        text = ""
        client = self.client_factory(opts)
        await client.connect()
        try:
            await client.query("Classify this repository now.")
            async for msg in client.receive_response():
                if isinstance(msg, AssistantMessage):
                    for b in msg.content:
                        if isinstance(b, TextBlock):
                            text += b.text + "\n"
                elif isinstance(msg, ResultMessage) and msg.result:
                    text += msg.result
        finally:
            await client.disconnect()
        return projects.parse_verdict(text)

    # ------------------------------------------------------------- dispatch
    async def handle(self, msg: dict[str, Any], conn: Connection | None = None) -> None:
        t = msg.get("type")
        try:
            if t == "user_message":
                await self.on_user_message(str(msg.get("text", "")))
            elif t == "interrupt":
                await self.on_interrupt()
            elif t == "permission_reply":
                self.resolve_permission(str(msg.get("request_id")), bool(msg.get("allow")), str(msg.get("message", "")))
            elif t == "hw.response":
                self.bridge.handle_response(msg)
            elif t == "serial.data":
                data = base64.b64decode(msg["b64"]) if "b64" in msg else str(msg.get("data", "")).encode()
                await self.bridge.serial_data(str(msg.get("port", "repl")), data)
            elif t == "device.attached":
                await self.on_device_attached(msg)
            elif t == "device.detached":
                await self.on_device_detached()
            elif t == "device.update":
                if msg.get("channel") in ("msc", "serial", None):
                    self.bridge.device.channel = msg.get("channel")
                await self.push_state()
            elif t and t.startswith("project.") or t == "action":
                await self.on_action(msg, conn)
            elif t == "hello":
                await self.resync()
            else:
                await self.send({"type": "error", "error": f"unknown message type: {t}"})
        except Exception as e:
            log.exception("handling %s failed", t)
            await self.send({"type": "error", "error": str(e)})

    async def on_user_message(self, text: str) -> None:
        if not text.strip():
            return
        if self.session is None:
            await self.send({"type": "error", "error": "no_project"})
            return
        try:
            await self.session.send(text)
        except Exception as e:
            await self.emit_agent({"kind": "item", "item": {"id": f"n{time.time()}", "kind": "notice", "level": "error", "text": f"Claude Code could not start: {e}"}})
            await self.emit_agent({"kind": "turn_end", "result": {"is_error": True, "subtype": "start_failed"}})
            if self.session:
                self.session.running = False
                await self.session.close()
        await self.push_state()

    async def on_interrupt(self) -> None:
        self.deny_all_permissions("Interrupted by the user.")
        await self.bridge.cancel_all("Interrupted by the user.")
        if self.session:
            await self.session.interrupt()
        await self.bridge.release_all()

    def _spawn(self, coro) -> asyncio.Task:
        task = asyncio.create_task(coro)
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)
        return task

    async def notice(self, text: str, level: str = "info") -> None:
        item = {"id": f"n{time.time_ns()}", "kind": "notice", "level": level, "text": text}
        if self.session:
            self.session.items.append(item)
        await self.emit_agent({"kind": "item", "item": item})

    async def on_device_attached(self, msg: dict[str, Any]) -> None:
        if self._identify_task:
            self._identify_task.cancel()
        d = DeviceState(attached=True)
        d.usb = dict(msg.get("usb") or {})
        d.ports = [p for p in msg.get("ports", ["repl"]) if p in ("repl", "data")]
        self.bridge.device = d
        await self.push_state()
        self._identify_task = self._spawn(self.identify_and_bind())

    async def on_device_detached(self) -> None:
        if self._identify_task:
            self._identify_task.cancel()
            self._identify_task = None
        await self.bridge.cancel_all("Device detached.")
        self.bridge.device = DeviceState()
        await self.bridge.release_all()
        await self.push_state()

    async def identify_and_bind(self) -> None:
        """Identification call, then the board -> project flow (spec「连接板子时」)."""
        d = self.bridge.device
        d.identifying, d.error = True, None
        await self.push_state()
        try:
            server, _ = mcp_tools.build_server(self.tool_ctx, only={"read_repl", "write_repl"}, check_board=False)
            info = await identify.identify(server, self.paths.home / "identify", self.paths.claude_token_file, self.client_factory)
        except asyncio.CancelledError:
            raise
        except Exception as e:
            log.warning("identification failed: %s", e)
            if self.bridge.device is d:
                d.identifying, d.error = False, f"identify_failed: {e}"
                await self.bridge.release_all()
                await self.push_state()
            return
        if self.bridge.device is not d:
            return
        await self.bridge.release_all()
        d.identifying = False
        d.uid, d.runtime, d.version, d.mpy_version = info["uid"], info["runtime"], info["version"], info["mpy_version"]
        await self.push_state()
        await self.project_for_device(explicit=False)

    async def project_for_device(self, explicit: bool) -> None:
        """Find / bind the project for the identified board.

        ``explicit``: the user just opened this project; then a project bound to
        another board is kept open (with a notice) instead of being switched.
        """
        d = self.bridge.device
        uid, runtime = d.uid, d.runtime
        if not uid:
            return
        if runtime not in PROJECT_TYPES:
            d.error = f"unsupported_runtime: {runtime}"
            await self.push_state()
            return
        p = self.project
        kind = self.device_kind()
        owner = self.emulator_owner()
        if p is not None and owner and owner != p.id:
            # Another test project's emulator is not this project's board at all (D40): checked
            # before the runtime, so opening a project of the other runtime does not close it
            # because of a leftover emulator (the frontend disconnects that emulator).
            await self.notice(f"emulator_other_project: {uid}", "warning")
            return
        if p is not None and (explicit or p.board_uid in (None, uid)) and p.type != runtime:
            # runtime check, independent of which board the project is bound to
            await self.runtime_mismatch(p, runtime)
            return
        if p is not None and p.board_uid in (None, uid):
            if p.board and p.board != kind:
                # a test project only uses its emulator, a real project only real boards (D40)
                await self.notice(f"board_kind_mismatch: {kind}", "warning")
                return
            changes: dict[str, Any] = {"board_uid": uid, "mpy_version": d.mpy_version}
            if not p.board:  # the first connection fixes the board kind
                projects.write_board(p.path, kind)
                changes["board"] = kind
            self.project = self.table.update(p.id, **changes)
            await self.project_ready()
            return
        if p is not None and explicit:
            await self.notice(f"board_other_project: {uid}", "warning")
            return
        cands = self.table.by_uid(uid)
        if len(cands) == 1:
            c = cands[0]
            if c.type != runtime:
                await self.runtime_mismatch(c, runtime)
                return
            await self.open_project(c.id, device_check=False)
            self.project = self.table.update(c.id, mpy_version=d.mpy_version)
            await self.project_ready()
            return
        self.select_required = {
            "type": "project.select_required",
            "reason": "multiple_projects" if cands else "unknown_board",
            "uid": uid,
            "runtime": runtime,
            "candidates": [self._project_info(c) for c in cands] if cands else None,
        }
        await self.send(self.select_required)

    def _baseline_file(self) -> Path | None:
        return self.paths.home / "sync" / f"{self.project.id}.json" if self.project else None

    def get_baseline(self) -> dict[str, str] | None:
        """The board's file hashes after the last pull/upload, if recorded for this board."""
        f, uid = self._baseline_file(), self.bridge.device.uid
        data = read_json(f, None) if f else None
        if not data or not uid or data.get("uid") != uid:
            return None
        return dict(data.get("manifest") or {})

    def get_baseline_texts(self) -> dict[str, str]:
        f, uid = self._baseline_file(), self.bridge.device.uid
        data = read_json(f, None) if f else None
        if not data or not uid or data.get("uid") != uid:
            return {}
        return {k: v for k, v in (data.get("texts") or {}).items() if isinstance(v, str)}

    def set_baseline(self, manifest: dict[str, str], texts: dict[str, str] | None = None) -> None:
        f, uid = self._baseline_file(), self.bridge.device.uid
        if f and uid:
            write_json(f, {"uid": uid, "manifest": manifest, "texts": texts or {}}, mode=0o600)

    def device_kind(self) -> str:
        """Board kind of the connected device: the emulator or a real USB board."""
        return "rp2040js" if (self.bridge.device.usb or {}).get("emulator") else "usb"

    def emulator_owner(self) -> str | None:
        """The test project whose virtual board is connected (None for real boards)."""
        emu = (self.bridge.device.usb or {}).get("emulator")
        return emu.get("project") if isinstance(emu, dict) else None

    def board_error(self) -> str | None:
        """Reason why the connected board must not be written to for the open project."""
        d, p = self.bridge.device, self.project
        if p is None or not d.attached:
            return None
        owner = self.emulator_owner()
        if owner and owner != p.id:
            return "emulator_other_project: the connected emulator is the virtual board of another test project."
        if p.board and p.board != self.device_kind():
            return f"board_kind_mismatch: the project uses {p.board}, the connected board is {self.device_kind()}."
        if not d.uid:
            return "The board has not been identified yet."
        if d.runtime != p.type:
            return f"runtime_mismatch: the board runs {d.runtime}, the project is {p.type}."
        if p.board_uid and p.board_uid != d.uid:
            return f"board_other_project: the connected board ({d.uid}) is bound to another project, not to '{p.name}' ({p.board_uid})."
        return None

    async def runtime_mismatch(self, p: Project, runtime: str) -> None:
        """Stop everything, tell the user, back to the project page."""
        await self.on_interrupt()
        await self.close_project()
        self.select_required = {
            "type": "project.select_required",
            "reason": "runtime_mismatch",
            "uid": self.bridge.device.uid,
            "runtime": runtime,
            "expected": p.type,
            "project": p.name,
            "candidates": None,
        }
        await self.resync()

    async def project_ready(self) -> None:
        """Project determined: resume its session, then pull the board files."""
        await self.push_state()
        if self.session:
            try:
                await self.session.connect()
            except Exception as e:
                await self.notice(f"Claude Code could not start: {e}", "error")
        try:
            res = await mcp_tools.pull_from_device(self.tool_ctx)
        except HardwareError as e:
            await self.notice(f"pull_failed: {e}", "error")
            return
        if res.get("declined"):
            await self.notice("pull_declined", "info")
        else:
            await self.notice("pulled: " + json.dumps(res), "info")

    async def on_synced(self, direction: str, result: dict[str, Any]) -> None:
        summary = {k: len(v) for k, v in result.items() if isinstance(v, list)}
        self.bridge.device.last_sync = {"time": time.time(), "direction": direction, "summary": summary}
        if "channel" in result:
            self.bridge.device.channel = result["channel"]

    # --------------------------------------------------------------- actions
    async def reply_to(self, conn: Connection | None, msg: dict[str, Any]) -> None:
        """Answer the connection that asked; drop the answer if it was replaced meanwhile."""
        if conn is None:
            await self.send(msg)
        elif conn is self.conn:
            try:
                await conn.send(msg)
            except Exception as e:
                log.debug("reply failed: %s", e)

    async def on_action(self, msg: dict[str, Any], conn: Connection | None = None) -> None:
        rid = msg.get("id")
        name = msg.get("type") if msg.get("type") != "action" else msg.get("action")
        params = msg.get("params") or {}
        try:
            result = await self.run_action(str(name), params)
            await self.reply_to(conn, {"type": "action.result", "id": rid, "ok": True, "result": result})
        except (projects.ProjectError, files.PathError, ProcError, ValueError, HardwareError, libraries.LibraryError, sync.MirrorPathError) as e:
            await self.reply_to(conn, {"type": "action.result", "id": rid, "ok": False, "error": str(e)})
        except Exception as e:
            log.exception("action %s failed", name)
            await self.reply_to(conn, {"type": "action.result", "id": rid, "ok": False, "error": str(e)})

    def _root(self) -> Path:
        if self.project is None:
            raise projects.ProjectError("no_project")
        return self.project.path

    # actions on the open project's files, git or board: refused if the page meant another project
    _PROJECT_SCOPED = ("file.", "git.", "lib.", "device.")

    async def run_action(self, name: str, p: dict[str, Any]) -> Any:
        if name.startswith(self._PROJECT_SCOPED) and "project" in p:
            if p["project"] != (self.project.id if self.project else None):
                raise projects.ProjectError("project_changed")
        # --- onboarding (project.*) ---
        if name == "project.create":
            root = await projects.create(self.paths.projects_dir, p.get("name", ""), p.get("type", ""))
            proj = self.table.add(root.name, root, p["type"])
            out: dict[str, Any] = {"project": self._project_info(proj)}
            if p.get("github"):
                try:
                    out["github"] = await projects.create_github_remote(root, root.name, private=not p.get("public"))
                except projects.ProjectError as e:
                    out["github_error"] = str(e)
            await self.open_project(proj.id)
            return out
        if name == "project.clone":
            taken = {x.name for x in self.table.all()}
            root, pname, ptype = await projects.clone(self.paths.projects_dir, p.get("url", ""), taken, self.classify_clone)
            proj = self.table.add(pname, root, ptype)
            await self.open_project(proj.id)
            return {"project": self._project_info(proj)}
        if name == "project.select":
            proj = await self.open_project(str(p.get("id")))
            return {"project": self._project_info(proj)}
        if name == "project.delete":
            if p.get("confirm") is not True:
                raise ValueError("confirmation required")
            proj = self.table.get(str(p.get("id")))
            if proj is None:
                raise projects.ProjectError("unknown_project")
            if self.project and self.project.id == proj.id:
                await self.close_project()
                self.prefs["last_project"] = None
                self.save_prefs()
            projects.delete_dir(self.paths.projects_dir, proj.path)
            self.table.remove(proj.id)
            await self.resync()
            return {}
        if name == "project.close":
            await self.close_project()
            self.prefs["last_project"] = None
            self.save_prefs()
            await self.resync()
            return {}
        # --- files ---
        if name == "file.read":
            return files.read(self._root(), str(p.get("path", "")))
        if name == "file.write":
            files.write(self._root(), str(p.get("path", "")), str(p.get("text", "")))
            await self.push_state()
            return {}
        # --- git ---
        if name == "git.diff":
            return {"diff": await gitops.diff(self._root(), p.get("path"))}
        if name == "git.commit":
            h = await gitops.commit(self._root(), str(p.get("message", "")))
            await self.push_state()
            return {"hash": h}
        if name == "git.reset_file":
            await gitops.reset_file(self._root(), str(p.get("path")))
            await self.push_state()
            return {}
        if name == "git.reset_all":
            if p.get("confirm") is not True:
                raise ValueError("confirmation required")
            await gitops.reset_all(self._root())
            await self.push_state()
            return {}
        if name == "git.push":
            out = await gitops.push(self._root())
            await self.push_state()
            return {"output": out}
        if name == "git.create_remote":
            assert self.project
            out = await projects.create_github_remote(self._root(), self.project.name, private=not p.get("public"))
            await self.push_state()
            return {"output": out}
        # --- device (phase 2 frontends) ---
        if name == "device.pull":
            res = await mcp_tools.pull_from_device(self.tool_ctx)
            return res
        if name == "device.push":
            return await mcp_tools.push_to_device(self.tool_ctx)
        # --- libraries (mirror only) ---
        if name.startswith("lib."):
            src = sync.mirror_src(self._root())
            ptype = self.project.type if self.project else ""
            if name == "lib.list":
                return {"libraries": await libraries.list_installed(ptype, src)}
            if name == "lib.search":
                return {"results": await libraries.search(ptype, src, str(p.get("query", "")))}
            if name == "lib.install":
                out = await libraries.install(ptype, src, list(p.get("names") or []), self.project.mpy_version if self.project else None)
            elif name == "lib.update":
                out = await libraries.update(ptype, src)
            elif name == "lib.uninstall":
                out = await libraries.uninstall(ptype, src, list(p.get("names") or []))
            else:
                raise ValueError(f"unknown action: {name}")
            await self.push_state()
            return {"output": out}
        # --- settings ---
        if name == "prefs.set":
            for k in ("language",):
                if k in p:
                    self.prefs[k] = p[k]
            self.save_prefs()
            await self.push_state()
            return {}
        if name == "pairing.reset":
            self.token = pairing.reset_token(self.paths.token_file)
            return {"token": self.token}
        if name == "auth.status":
            self.auth_status = await self.check_auth()
            await self.push_state()
            return self.auth_status
        if name == "state.refresh":
            await self.push_state()
            return {}
        raise ValueError(f"unknown action: {name}")

    async def check_auth(self) -> dict[str, Any]:
        claude = {"cli": cli_path(), "token_file": self.paths.claude_token_file.exists()}
        gh: dict[str, Any] = {"installed": shutil.which("gh") is not None, "logged_in": False}
        if gh["installed"]:
            res = await run(["gh", "auth", "status"], timeout=20)
            gh["logged_in"] = res.ok
        return {"claude": claude, "github": gh}


def dumps(msg: dict[str, Any]) -> str:
    return json.dumps(msg, ensure_ascii=False, default=str)
