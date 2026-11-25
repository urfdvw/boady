import asyncio
import os
import subprocess
from pathlib import Path
from typing import Any

import pytest

from boady.config import Paths

os.environ.setdefault("GIT_AUTHOR_NAME", "test")
os.environ.setdefault("GIT_AUTHOR_EMAIL", "test@example.com")
os.environ.setdefault("GIT_COMMITTER_NAME", "test")
os.environ.setdefault("GIT_COMMITTER_EMAIL", "test@example.com")


@pytest.fixture
def paths(tmp_path: Path) -> Paths:
    p = Paths(tmp_path / "home")
    p.ensure()
    return p


@pytest.fixture
def repo(tmp_path: Path) -> Path:
    r = tmp_path / "repo"
    r.mkdir()
    subprocess.run(["git", "init", "-q", "-b", "main"], cwd=r, check=True)
    return r


class FakeClient:
    """Stands in for ClaudeSDKClient. ``script`` decides what a query does."""

    instances: list["FakeClient"] = []
    script = None  # async fn(client, text)

    def __init__(self, options: Any):
        self.options = options
        self.queue: asyncio.Queue = asyncio.Queue()
        self.connected = False
        self.queries: list[str] = []
        self.interrupted = False
        FakeClient.instances.append(self)

    async def connect(self, prompt=None):
        self.connected = True

    async def disconnect(self):
        self.connected = False

    async def query(self, text: str, session_id: str = "default"):
        self.queries.append(text)
        if FakeClient.script:
            asyncio.create_task(FakeClient.script(self, text))

    async def interrupt(self):
        self.interrupted = True

    async def receive_messages(self):
        while True:
            yield await self.queue.get()

    async def receive_response(self):
        from claude_agent_sdk import ResultMessage

        while True:
            m = await self.queue.get()
            yield m
            if isinstance(m, ResultMessage):
                return


@pytest.fixture
def fake_client():
    FakeClient.instances = []
    FakeClient.script = None
    yield FakeClient
    FakeClient.instances = []
    FakeClient.script = None


@pytest.fixture
def tool_handlers(monkeypatch):
    """Build the boady MCP server and return its tools' handlers by name."""
    from boady import mcp_tools

    built: list[dict] = []
    real = mcp_tools.create_sdk_mcp_server

    def record(name, version, tools):
        built.append({t.name: t.handler for t in tools})
        return real(name, version, tools)

    monkeypatch.setattr(mcp_tools, "create_sdk_mcp_server", record)

    def build(ctx, **kw):
        mcp_tools.build_server(ctx, **kw)
        return built[-1]

    return build
