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
    assert "emulated Raspberry Pi Pico" in append and "Nothing is wired to it" in append
    projects.write_board(project.path, "usb")
    assert "emulated Raspberry Pi Pico" not in s.build_options().system_prompt["append"]
