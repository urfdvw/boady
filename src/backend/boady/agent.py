"""Claude Code session for one project (Claude Agent SDK).

Every project has exactly one Claude session id, created with the project. The
first connect uses ``session_id=<id>``; once a transcript exists, every later
connect uses ``resume=<id>`` (decision D2).
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import shutil
import time
import uuid
from pathlib import Path
from typing import Any, Awaitable, Callable

from claude_agent_sdk import (
    AssistantMessage,
    ClaudeAgentOptions,
    ClaudeSDKClient,
    HookMatcher,
    PermissionResultAllow,
    PermissionResultDeny,
    ResultMessage,
    StreamEvent,
    SystemMessage,
    TextBlock,
    ToolResultBlock,
    ToolUseBlock,
    UserMessage,
    get_session_info,
    get_session_messages,
)

from . import permissions, projects, prompts
from .project_table import Project

log = logging.getLogger("boady.agent")

Emit = Callable[[dict[str, Any]], Awaitable[None]]
AskPermission = Callable[[str, dict[str, Any], str], Awaitable[tuple[bool, str]]]


def claude_env(claude_token_file: Path | None) -> dict[str, str]:
    env = {"DISABLE_AUTOUPDATER": "1"}
    if claude_token_file and claude_token_file.exists():
        token = claude_token_file.read_text(encoding="utf-8").strip()
        if token:
            env["CLAUDE_CODE_OAUTH_TOKEN"] = token
    return env


def cli_path() -> str | None:
    return os.environ.get("BOADY_CLAUDE_CLI") or shutil.which("claude")


def session_exists(session_id: str, directory: Path) -> bool:
    try:
        if get_session_info(session_id, directory=str(directory)) is not None:
            return True
        return bool(get_session_messages(session_id, directory=str(directory), limit=1))
    except Exception:  # pragma: no cover - defensive
        return False


def _new_id() -> str:
    return uuid.uuid4().hex[:12]


def _result_text(content: Any) -> str:
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    parts = []
    for c in content:
        if isinstance(c, dict):
            if c.get("type") == "text":
                parts.append(c.get("text", ""))
            else:
                parts.append(f"[{c.get('type', 'content')}]")
    return "\n".join(parts)


def history_items(session_id: str, directory: Path) -> list[dict[str, Any]]:
    """Convert a stored transcript into chat items for the frontend."""
    items: list[dict[str, Any]] = []
    try:
        msgs = get_session_messages(session_id, directory=str(directory))
    except Exception:
        return items
    for m in msgs:
        raw = m.message or {}
        content = raw.get("content")
        if m.type == "user":
            if isinstance(content, str):
                items.append({"id": m.uuid, "kind": "user", "text": content})
                continue
            for c in content or []:
                if c.get("type") == "text":
                    items.append({"id": _new_id(), "kind": "user", "text": c.get("text", "")})
                elif c.get("type") == "tool_result":
                    items.append({
                        "id": _new_id(),
                        "kind": "tool_result",
                        "tool_use_id": c.get("tool_use_id"),
                        "content": _result_text(c.get("content")),
                        "is_error": bool(c.get("is_error")),
                    })
        elif m.type == "assistant":
            for c in content or []:
                if c.get("type") == "text" and c.get("text"):
                    items.append({"id": _new_id(), "kind": "assistant", "text": c["text"]})
                elif c.get("type") == "tool_use":
                    items.append({
                        "id": _new_id(),
                        "kind": "tool_use",
                        "tool_use_id": c.get("id"),
                        "name": c.get("name"),
                        "input": c.get("input", {}),
                    })
    return items


class AgentSession:
    def __init__(
        self,
        project: Project,
        emit: Emit,
        ask_permission: AskPermission,
        mcp_server: Any | None,
        mcp_tool_names: list[str],
        env: dict[str, str],
        audit: Callable[[str], None] | None = None,
        client_factory: Callable[[ClaudeAgentOptions], Any] = ClaudeSDKClient,
    ):
        self.project = project
        self.emit = emit
        self.ask_permission = ask_permission
        self.mcp_server = mcp_server
        self.mcp_tool_names = mcp_tool_names
        self.env = env
        self.audit = audit or (lambda line: None)
        self.client_factory = client_factory
        self.client: Any | None = None
        self.items: list[dict[str, Any]] = history_items(project.session_id, project.path)
        self.running = False
        self.partial = ""  # streamed text of the current assistant block
        self._reader: asyncio.Task | None = None
        self._lock = asyncio.Lock()
        self._client_prompt: Any = None  # system prompt the current client was started with
        self.on_turn_end: Callable[[], Awaitable[None]] | None = None
        self.on_tool_result: Callable[[], Awaitable[None]] | None = None

    @property
    def root(self) -> Path:
        return self.project.path

    # -- options -----------------------------------------------------------
    def build_options(self) -> ClaudeAgentOptions:
        root = self.root
        claude_md = projects.own_file(root, "CLAUDE.md")  # never through a link (review 9)
        # board kind straight from boady.json: the first connection may have fixed it after this session was created
        append = prompts.system_prompt(self.project.type, projects.read_board(root))
        if claude_md is not None:
            append += "\n\n# Project CLAUDE.md (loaded by boady)\n\n" + claude_md.read_text(encoding="utf-8", errors="replace")
        opts = ClaudeAgentOptions(
            cwd=str(root),
            tools=list(permissions.BUILTIN_TOOLS),
            system_prompt={"type": "preset", "preset": "claude_code", "append": append},
            permission_mode="default",
            can_use_tool=self._can_use_tool,
            hooks={"PreToolUse": [HookMatcher(matcher=None, hooks=[self._pre_tool_use])]},
            setting_sources=[],
            include_partial_messages=True,
            env=self.env,
            cli_path=cli_path(),
            stderr=lambda line: log.debug("claude: %s", line),
        )
        if self.mcp_server is not None:
            opts.mcp_servers = {"boady": self.mcp_server}
            opts.strict_mcp_config = True
        if session_exists(self.project.session_id, root):
            opts.resume = self.project.session_id
        else:
            opts.session_id = self.project.session_id
        return opts

    # -- permission layers --------------------------------------------------
    async def _pre_tool_use(self, inp: dict[str, Any], tool_use_id: str | None, context: Any) -> dict[str, Any]:
        name = inp.get("tool_name", "")
        tinput = inp.get("tool_input", {}) or {}
        reason = permissions.hard_block(name, tinput, self.root)
        self.audit(json.dumps({"t": time.time(), "tool": name, "input": tinput, "blocked": reason}, ensure_ascii=False))
        if reason:
            return {
                "hookSpecificOutput": {
                    "hookEventName": "PreToolUse",
                    "permissionDecision": "deny",
                    "permissionDecisionReason": reason,
                }
            }
        return {}

    async def _can_use_tool(self, name: str, tinput: dict[str, Any], context: Any):
        if permissions.classify(name, tinput, self.root) == "allow":
            return PermissionResultAllow(updated_input=tinput)
        allowed, message = await self.ask_permission(name, tinput, getattr(context, "tool_use_id", None) or "")
        if allowed:
            return PermissionResultAllow(updated_input=tinput)
        return PermissionResultDeny(message=message or "The user denied this action.")

    # -- lifecycle ----------------------------------------------------------
    async def connect(self) -> None:
        """Connect, or reconnect (resuming the transcript) when the system prompt changed
        since the client was started, e.g. the first connection made the project a test
        project (review 8). Never during a turn: the next ``send`` picks it up."""
        async with self._lock:
            opts = self.build_options()
            if self.client is not None:
                if self.running or opts.system_prompt == self._client_prompt:
                    return
                await self.close()
                opts = self.build_options()  # the transcript may exist now: resume it
            client = self.client_factory(opts)
            await client.connect()
            self.client = client
            self._client_prompt = opts.system_prompt
            self._reader = asyncio.create_task(self._read_loop())

    async def close(self) -> None:
        client, self.client = self.client, None
        if self._reader:
            self._reader.cancel()
            self._reader = None
        if client is not None:
            try:
                await client.disconnect()
            except Exception:
                pass
        self.running = False

    async def send(self, text: str) -> None:
        if self.running:
            raise RuntimeError("agent is already running")
        await self.connect()
        item = {"id": _new_id(), "kind": "user", "text": text}
        self.items.append(item)
        self.running = True
        self.partial = ""
        await self.emit({"kind": "item", "item": item})
        await self.emit({"kind": "turn_start"})
        assert self.client is not None
        await self.client.query(text)

    async def interrupt(self) -> None:
        if self.client is not None and self.running:
            try:
                await self.client.interrupt()
            except Exception as e:  # pragma: no cover
                log.warning("interrupt failed: %s", e)

    async def _add(self, item: dict[str, Any]) -> None:
        self.items.append(item)
        await self.emit({"kind": "item", "item": item})

    async def _read_loop(self) -> None:
        assert self.client is not None
        try:
            async for msg in self.client.receive_messages():
                await self._handle(msg)
        except asyncio.CancelledError:
            raise
        except Exception as e:
            log.exception("agent stream failed")
            await self._add({"id": _new_id(), "kind": "notice", "level": "error", "text": f"Claude Code stopped: {e}"})
            self.client = None
            if self.running:
                self.running = False
                await self.emit({"kind": "turn_end", "result": {"is_error": True, "subtype": "crash"}})
                if self.on_turn_end:
                    await self.on_turn_end()

    async def _handle(self, msg: Any) -> None:
        if isinstance(msg, StreamEvent):
            ev = msg.event
            if msg.parent_tool_use_id is None and ev.get("type") == "content_block_delta":
                delta = ev.get("delta", {})
                if delta.get("type") == "text_delta":
                    self.partial += delta.get("text", "")
                    await self.emit({"kind": "delta", "text": delta.get("text", "")})
            return
        if isinstance(msg, AssistantMessage):
            if msg.parent_tool_use_id is not None:
                return
            if msg.error:
                await self._add({"id": _new_id(), "kind": "notice", "level": "error", "text": str(msg.error)})
            for block in msg.content:
                if isinstance(block, TextBlock) and block.text:
                    self.partial = ""
                    await self._add({"id": _new_id(), "kind": "assistant", "text": block.text})
                elif isinstance(block, ToolUseBlock):
                    await self._add({
                        "id": _new_id(), "kind": "tool_use", "tool_use_id": block.id,
                        "name": block.name, "input": block.input,
                    })
            return
        if isinstance(msg, UserMessage):
            if msg.parent_tool_use_id is not None or isinstance(msg.content, str):
                return
            for block in msg.content:
                if isinstance(block, ToolResultBlock):
                    await self._add({
                        "id": _new_id(), "kind": "tool_result", "tool_use_id": block.tool_use_id,
                        "content": _result_text(block.content), "is_error": bool(block.is_error),
                    })
            if self.on_tool_result:
                await self.on_tool_result()
            return
        if isinstance(msg, ResultMessage):
            self.running = False
            self.partial = ""
            if msg.is_error and msg.subtype not in ("success",):
                text = "; ".join(msg.errors or []) or msg.result or msg.subtype
                await self._add({"id": _new_id(), "kind": "notice", "level": "error", "text": str(text)})
            await self.emit({
                "kind": "turn_end",
                "result": {"subtype": msg.subtype, "is_error": msg.is_error, "cost_usd": msg.total_cost_usd},
            })
            if self.on_turn_end:
                await self.on_turn_end()
            return
        if isinstance(msg, SystemMessage):
            return
