"""AgentSession pieces that need no real Claude: options, hooks, transcript history."""

import json

import pytest

from boady import agent as agent_mod
from boady import projects
from boady.agent import AgentSession
from boady.project_table import Project


@pytest.fixture
async def project(tmp_path, monkeypatch):
    monkeypatch.setattr(agent_mod, "session_exists", lambda sid, d: False)
    root = await projects.create(tmp_path / "projects", "p", "circuitpython")
    return Project(id="p1", name="p", dir=str(root), type="circuitpython", session_id="00000000-0000-4000-8000-000000000001")


def session(project, audit=None, emit=None):
    async def _emit(ev):
        if emit is not None:
            emit.append(ev)

    async def ask(name, tinput, tid):
        return False, "no"

    return AgentSession(project, _emit, ask, None, [], env={}, audit=audit)


async def test_test_project_prompt_describes_the_emulator(project):
    """Review 7, prompt finding 6: the agent must know a test project's board is the emulator."""
    s = session(project)
    assert "emulated Raspberry Pi Pico" not in s.build_options().system_prompt["append"]
    # the first connection writes the board kind after the session object exists
    projects.write_board(project.path, "rp2040js")
    append = s.build_options().system_prompt["append"]
    assert "emulated Raspberry Pi Pico" in append and "Emulator tab" in append
    projects.write_board(project.path, "usb")
    assert "emulated Raspberry Pi Pico" not in s.build_options().system_prompt["append"]


async def test_pre_tool_use_denies_in_the_hook_format_and_audits(project):
    lines: list[str] = []
    s = session(project, audit=lines.append)
    out = await s._pre_tool_use({"tool_name": "Bash", "tool_input": {"command": "git status | cat"}}, "t1", None)
    assert out["hookSpecificOutput"]["hookEventName"] == "PreToolUse"
    assert out["hookSpecificOutput"]["permissionDecision"] == "deny"
    assert "single whitelisted commands" in out["hookSpecificOutput"]["permissionDecisionReason"]
    assert await s._pre_tool_use({"tool_name": "Bash", "tool_input": {"command": "git status"}}, "t2", None) == {}
    logged = [json.loads(x) for x in lines]
    assert [x["tool"] for x in logged] == ["Bash", "Bash"]
    assert logged[0]["blocked"] and logged[1]["blocked"] is None
    assert logged[0]["input"] == {"command": "git status | cat"}


def test_history_items_rebuild_the_chat(project, monkeypatch):
    """D12: the chat is rebuilt from the stored transcript."""
    from types import SimpleNamespace as NS

    msgs = [
        NS(type="user", uuid="u1", message={"content": "make it blink"}),
        NS(type="assistant", uuid="a1", message={"content": [
            {"type": "text", "text": "Sure."},
            {"type": "tool_use", "id": "tu1", "name": "Edit", "input": {"file_path": "src/code.py"}},
        ]}),
        NS(type="user", uuid="u2", message={"content": [
            {"type": "tool_result", "tool_use_id": "tu1", "content": [{"type": "text", "text": "ok"}, {"type": "image"}], "is_error": False},
            {"type": "text", "text": "thanks"},
        ]}),
        NS(type="assistant", uuid="a2", message={"content": [{"type": "text", "text": ""}]}),  # empty text dropped
    ]
    monkeypatch.setattr(agent_mod, "get_session_messages", lambda sid, directory: msgs)
    items = agent_mod.history_items("sid", project.path)
    assert [(i["kind"], i.get("text") or i.get("name") or i.get("content")) for i in items] == [
        ("user", "make it blink"), ("assistant", "Sure."), ("tool_use", "Edit"), ("tool_result", "ok\n[image]"), ("user", "thanks"),
    ]
    assert items[2]["tool_use_id"] == "tu1" and items[3]["tool_use_id"] == "tu1" and items[3]["is_error"] is False

    def broken(sid, directory):
        raise RuntimeError("corrupt transcript")

    monkeypatch.setattr(agent_mod, "get_session_messages", broken)
    assert agent_mod.history_items("sid", project.path) == []


async def test_stream_deltas_errors_and_turn_end(project):
    from claude_agent_sdk import AssistantMessage, ResultMessage, StreamEvent, TextBlock

    events: list[dict] = []
    s = session(project, emit=events)
    ended = []

    async def on_end():
        ended.append(True)

    s.on_turn_end = on_end
    s.running = True
    delta = {"type": "content_block_delta", "delta": {"type": "text_delta", "text": "Hel"}}
    await s._handle(StreamEvent(uuid="e1", session_id="x", event=delta, parent_tool_use_id=None))
    await s._handle(StreamEvent(uuid="e2", session_id="x", event=delta, parent_tool_use_id="sub"))  # subagent: ignored
    assert s.partial == "Hel" and [e for e in events if e["kind"] == "delta"] == [{"kind": "delta", "text": "Hel"}]
    await s._handle(AssistantMessage(content=[TextBlock(text="Hello")], model="m", error="rate_limit"))
    assert s.partial == ""
    await s._handle(ResultMessage(subtype="error_during_execution", duration_ms=1, duration_api_ms=1, is_error=True,
                                  num_turns=1, session_id="x", result="boom"))
    kinds = [(e["kind"], e.get("item", {}).get("kind"), e.get("item", {}).get("text")) for e in events if e["kind"] == "item"]
    assert ("item", "notice", "rate_limit") in kinds and ("item", "assistant", "Hello") in kinds and ("item", "notice", "boom") in kinds
    assert events[-1]["kind"] == "turn_end" and events[-1]["result"]["is_error"] is True
    assert s.running is False and ended == [True]


async def test_stream_crash_ends_the_turn(project):
    events: list[dict] = []
    s = session(project, emit=events)
    ended = []

    async def on_end():
        ended.append(True)

    class Broken:
        async def receive_messages(self):
            raise RuntimeError("cli died")
            yield  # pragma: no cover

    s.on_turn_end = on_end
    s.client = Broken()
    s.running = True
    await s._read_loop()
    assert s.client is None and s.running is False and ended == [True]
    assert any(e.get("item", {}).get("text") == "Claude Code stopped: cli died" for e in events)
    assert events[-1] == {"kind": "turn_end", "result": {"is_error": True, "subtype": "crash"}}
