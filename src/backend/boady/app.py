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

from . import files, gitops, mcp_tools, pairing, projects, prompts
from .agent import AgentSession, claude_env, cli_path
from .config import Paths
from .hardware import HardwareBridge, HardwareError
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
            "id": p.id, "name": p.name, "type": p.type, "board_uid": p.board_uid,
            "last_opened": p.last_opened, "created_at": p.created_at, "dir": p.dir,
        }

    async def push_state(self) -> None:
        if self.conn is not None:
            await self.send(await self.snapshot())

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
    async def open_project(self, project_id: str, announce: bool = True) -> Project:
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
        if self.project and self.project.id == p.id and self.session:
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
    async def handle(self, msg: dict[str, Any]) -> None:
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
            elif t and t.startswith("project.") or t == "action":
                await self.on_action(msg)
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

    async def on_device_attached(self, msg: dict[str, Any]) -> None:
        d = self.bridge.device
        d.attached = True
        d.usb = dict(msg.get("usb") or {})
        d.ports = [p for p in msg.get("ports", ["repl"]) if p in ("repl", "data")]
        await self.push_state()
        # Board identification and project binding: phase 2 (see additional_specs.md).

    async def on_device_detached(self) -> None:
        await self.bridge.cancel_all("Device detached.")
        from .hardware import DeviceState

        self.bridge.device = DeviceState()
        await self.bridge.release_all()
        await self.push_state()

    # --------------------------------------------------------------- actions
    async def on_action(self, msg: dict[str, Any]) -> None:
        rid = msg.get("id")
        name = msg.get("type") if msg.get("type") != "action" else msg.get("action")
        params = msg.get("params") or {}
        try:
            result = await self.run_action(str(name), params)
            await self.send({"type": "action.result", "id": rid, "ok": True, "result": result})
        except (projects.ProjectError, files.PathError, ProcError, ValueError, HardwareError) as e:
            await self.send({"type": "action.result", "id": rid, "ok": False, "error": str(e)})
        except Exception as e:
            log.exception("action %s failed", name)
            await self.send({"type": "action.result", "id": rid, "ok": False, "error": str(e)})

    def _root(self) -> Path:
        if self.project is None:
            raise projects.ProjectError("no_project")
        return self.project.path

    async def run_action(self, name: str, p: dict[str, Any]) -> Any:
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
