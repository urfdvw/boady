"""Board identification: a one-shot agent call (no project session) that may
only use ``read_repl`` / ``write_repl`` and answers in a fixed format."""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any, Callable

from claude_agent_sdk import AssistantMessage, ClaudeAgentOptions, ResultMessage, TextBlock

from . import prompts
from .agent import claude_env, cli_path

LINE_RE = re.compile(r"BOADY_ID\s+(.*)")


class IdentifyError(Exception):
    pass


def parse(text: str) -> dict[str, Any]:
    matches = LINE_RE.findall(text or "")
    if not matches:
        answer = " ".join((text or "").split())[:200]
        raise IdentifyError(f"no BOADY_ID line in the answer: {answer}" if answer else "empty answer from Claude Code")
    fields = dict(re.findall(r"(\w+)=(\S+)", matches[-1]))
    if "error" in fields:
        raise IdentifyError(fields["error"])
    uid = fields.get("uid", "").upper()
    if not re.fullmatch(r"[0-9A-F]{4,64}", uid):
        raise IdentifyError(f"bad uid: {uid!r}")
    runtime = fields.get("runtime", "other").lower()
    mpy = fields.get("mpy")
    return {
        "uid": uid,
        "runtime": runtime,
        "version": fields.get("version"),
        "mpy_version": int(mpy) if mpy and mpy.isdigit() else None,
    }


async def identify(
    mcp_server: Any,
    workdir: Path,
    token_file: Path | None,
    client_factory: Callable[[ClaudeAgentOptions], Any],
) -> dict[str, Any]:
    workdir.mkdir(parents=True, exist_ok=True)
    allowed = ["mcp__boady__read_repl", "mcp__boady__write_repl"]
    opts = ClaudeAgentOptions(
        cwd=str(workdir),
        tools=[],
        mcp_servers={"boady": mcp_server},
        strict_mcp_config=True,
        allowed_tools=allowed,
        permission_mode="dontAsk",
        setting_sources=[],
        system_prompt=prompts.task("identify_board"),
        max_turns=20,
        env=claude_env(token_file),
        cli_path=cli_path(),
    )
    text = ""
    client = client_factory(opts)
    await client.connect()
    try:
        await client.query("A board was just connected. Identify it now.")
        async for msg in client.receive_response():
            if isinstance(msg, AssistantMessage):
                for b in msg.content:
                    if isinstance(b, TextBlock):
                        text += b.text + "\n"
            elif isinstance(msg, ResultMessage) and msg.result:
                text += msg.result
    finally:
        await client.disconnect()
    return parse(text)
