"""Protocol tests over a real WebSocket with a fake Claude client."""

import asyncio
import json

import pytest
from aiohttp.test_utils import TestClient, TestServer
from claude_agent_sdk import AssistantMessage, ResultMessage, TextBlock, ToolResultBlock, ToolUseBlock, UserMessage

from boady import agent as agent_mod
from boady.app import App
from boady.server import make_app


class WS:
    def __init__(self, ws):
        self.ws = ws
        self.inbox: list[dict] = []

    async def send(self, msg):
        await self.ws.send_str(json.dumps(msg))

    async def recv(self, timeout=5):
        m = await self.ws.receive(timeout=timeout)
        if m.type.name != "TEXT":
            return {"type": f"_{m.type.name}"}
        return json.loads(m.data)

    async def wait(self, pred, timeout=5):
        loop = asyncio.get_running_loop()
        end = loop.time() + timeout
        while True:
            for i, m in enumerate(self.inbox):
                if pred(m):
                    return self.inbox.pop(i)
            m = await self.recv(max(0.01, end - loop.time()))
            self.inbox.append(m)

    async def action(self, name, params=None, rid="a1"):
        await self.send({"type": "action", "id": rid, "action": name, "params": params or {}})
        res = await self.wait(lambda m: m.get("type") == "action.result" and m.get("id") == rid, timeout=20)
        return res


@pytest.fixture
async def env(paths, fake_client, monkeypatch, tmp_path):
    monkeypatch.setattr(agent_mod, "session_exists", lambda sid, d: False)
    app = App(paths, client_factory=fake_client)
    client = TestClient(TestServer(make_app(app, web_dir=tmp_path / "noweb")))
    await client.start_server()
    yield app, client
    await client.close()


async def connect(client, token):
    ws = WS(await client.ws_connect("/ws"))
    await ws.send({"type": "hello", "token": token, "mode": "browser", "hw": {"serial": False, "msc": False}})
    return ws


async def test_bad_token_closes(env):
    app, client = env
    ws = await connect(client, "wrong")
    assert (await ws.recv())["type"] == "hello.error"
    assert (await ws.recv())["type"].startswith("_CLOS")


async def test_hello_sends_state_and_history(env):
    app, client = env
    ws = await connect(client, app.token)
    assert (await ws.recv())["type"] == "hello.ok"
    st = await ws.wait(lambda m: m["type"] == "state")
    assert st["project"] is None and st["projects"] == []
    h = await ws.wait(lambda m: m["type"] == "agent_event")
    assert h["kind"] == "history"


async def test_single_frontend(env):
    app, client = env
    ws1 = await connect(client, app.token)
    await ws1.wait(lambda m: m["type"] == "hello.ok")
    ws2 = await connect(client, app.token)
    await ws2.wait(lambda m: m["type"] == "hello.ok")
    assert (await ws1.wait(lambda m: m["type"] == "replaced"))["type"] == "replaced"


async def test_create_project_chat_and_permission(env, fake_client):
    app, client = env

    async def script(c, text):
        # an edit outside the project needs approval
        res = await c.options.can_use_tool("Write", {"file_path": "/etc/x", "content": "y"}, None)
        await c.queue.put(AssistantMessage(content=[ToolUseBlock(id="t1", name="Write", input={"file_path": "/etc/x"})], model="m"))
        await c.queue.put(UserMessage(content=[ToolResultBlock(tool_use_id="t1", content=res.behavior, is_error=res.behavior == "deny")]))
        await c.queue.put(AssistantMessage(content=[TextBlock(text=f"echo: {text}")], model="m"))
        await c.queue.put(ResultMessage(subtype="success", duration_ms=1, duration_api_ms=1, is_error=False, num_turns=1, session_id=c.options.session_id))

    fake_client.script = script
    ws = await connect(client, app.token)
    await ws.wait(lambda m: m["type"] == "hello.ok")
    res = await ws.action("project.create", {"name": "blinky", "type": "circuitpython"})
    assert res["ok"], res
    pid = res["result"]["project"]["id"]
    st = await ws.wait(lambda m: m["type"] == "state" and m["project"] is not None)
    assert st["project"]["name"] == "blinky"
    assert any(e["path"] == "src/code.py" for e in st["tree"])

    await ws.send({"type": "user_message", "text": "hi"})
    req = await ws.wait(lambda m: m["type"] == "permission_request")
    assert req["tool"] == "Write" and req["input"]["file_path"] == "/etc/x"
    await ws.send({"type": "permission_reply", "request_id": req["request_id"], "allow": False})
    end = await ws.wait(lambda m: m.get("kind") == "turn_end")
    assert end["result"]["subtype"] == "success"
    items = [m["item"] for m in ws.inbox if m.get("kind") == "item"]
    kinds = [i["kind"] for i in items]
    assert kinds[0] == "user" and "tool_use" in kinds and "tool_result" in kinds
    assert any(i["kind"] == "assistant" and i["text"] == "echo: hi" for i in items)
    tr = next(i for i in items if i["kind"] == "tool_result")
    assert tr["content"] == "deny" and tr["is_error"]

    # system prompt + CLAUDE.md injected; no filesystem settings; session id preset
    opts = fake_client.instances[-1].options
    assert opts.setting_sources == []
    assert "boady" in opts.system_prompt["append"] and "Project CLAUDE.md" in opts.system_prompt["append"]
    assert opts.session_id == app.table.get(pid).session_id and opts.resume is None
    assert "boady" in opts.mcp_servers


async def test_pending_permission_resent_on_reconnect(env, fake_client):
    app, client = env
    got = asyncio.Event()

    async def script(c, text):
        res = await c.options.can_use_tool("Read", {"file_path": "/etc/hosts"}, None)
        got.set()
        await c.queue.put(ResultMessage(subtype="success", duration_ms=1, duration_api_ms=1, is_error=False, num_turns=1, session_id="s"))

    fake_client.script = script
    ws = await connect(client, app.token)
    await ws.wait(lambda m: m["type"] == "hello.ok")
    assert (await ws.action("project.create", {"name": "p", "type": "micropython"}))["ok"]
    await ws.send({"type": "user_message", "text": "read hosts"})
    req = await ws.wait(lambda m: m["type"] == "permission_request")
    await ws.ws.close()

    ws2 = await connect(client, app.token)
    req2 = await ws2.wait(lambda m: m["type"] == "permission_request")
    assert req2["request_id"] == req["request_id"]
    hist = await ws2.wait(lambda m: m.get("kind") == "history")
    assert hist["running"] is True and hist["items"][0]["text"] == "read hosts"
    await ws2.send({"type": "permission_reply", "request_id": req2["request_id"], "allow": True})
    await asyncio.wait_for(got.wait(), 5)
    await ws2.wait(lambda m: m.get("kind") == "turn_end")


async def test_interrupt_denies_pending_and_calls_client(env, fake_client):
    app, client = env
    outcome = {}

    async def script(c, text):
        res = await c.options.can_use_tool("Read", {"file_path": "/etc/hosts"}, None)
        outcome["res"] = res

    fake_client.script = script
    ws = await connect(client, app.token)
    assert (await ws.action("project.create", {"name": "p", "type": "circuitpython"}))["ok"]
    await ws.send({"type": "user_message", "text": "x"})
    await ws.wait(lambda m: m["type"] == "permission_request")
    await ws.send({"type": "interrupt"})
    for _ in range(100):
        if "res" in outcome:
            break
        await asyncio.sleep(0.02)
    assert outcome["res"].behavior == "deny"
    assert fake_client.instances[-1].interrupted


async def test_session_resumes_after_backend_restart(paths, fake_client, monkeypatch, tmp_path):
    exists = {"v": False}
    monkeypatch.setattr(agent_mod, "session_exists", lambda sid, d: exists["v"])
    app = App(paths, client_factory=fake_client)
    client = TestClient(TestServer(make_app(app, web_dir=tmp_path / "noweb")))
    await client.start_server()
    ws = await connect(client, app.token)
    res = await ws.action("project.create", {"name": "keep", "type": "circuitpython"})
    pid = res["result"]["project"]["id"]
    sid = app.table.get(pid).session_id
    await client.close()

    # "restart": a new App on the same data dir; transcript now exists
    exists["v"] = True
    app2 = App(paths, client_factory=fake_client)
    client2 = TestClient(TestServer(make_app(app2, web_dir=tmp_path / "noweb")))
    await client2.start_server()
    ws2 = await connect(client2, app2.token)
    st = await ws2.wait(lambda m: m["type"] == "state")
    assert st["project"]["id"] == pid  # last project reopened
    await ws2.send({"type": "user_message", "text": "again"})
    for _ in range(100):
        if fake_client.instances and fake_client.instances[-1].queries:
            break
        await asyncio.sleep(0.02)
    opts = fake_client.instances[-1].options
    assert opts.resume == sid and opts.session_id is None
    await client2.close()


async def test_file_and_git_actions(env):
    app, client = env
    ws = await connect(client, app.token)
    assert (await ws.action("project.create", {"name": "g", "type": "circuitpython"}))["ok"]
    assert (await ws.action("file.write", {"path": "src/code.py", "text": "print(2)\n"}, "w"))["ok"]
    r = await ws.action("file.read", {"path": "src/code.py"}, "r")
    assert r["result"]["text"] == "print(2)\n"
    bad = await ws.action("file.read", {"path": "../../etc/passwd"}, "bad")
    assert not bad["ok"]
    d = await ws.action("git.diff", {"path": "src/code.py"}, "d")
    assert "+print(2)" in d["result"]["diff"]
    c = await ws.action("git.commit", {"message": "two"}, "c")
    assert c["ok"]
    nr = await ws.action("git.reset_all", {}, "nr")
    assert not nr["ok"]  # needs confirm
    p = await ws.action("git.push", {}, "p")
    assert not p["ok"] and "no remote" in p["error"]


async def test_delete_project(env):
    app, client = env
    ws = await connect(client, app.token)
    res = await ws.action("project.create", {"name": "d", "type": "circuitpython"})
    pid = res["result"]["project"]["id"]
    root = app.table.get(pid).path
    assert not (await ws.action("project.delete", {"id": pid}, "x"))["ok"]
    assert (await ws.action("project.delete", {"id": pid, "confirm": True}, "y"))["ok"]
    assert not root.exists() and app.table.get(pid) is None and app.project is None


async def test_device_tools_report_not_connected(env):
    app, client = env
    ws = await connect(client, app.token)
    assert (await ws.action("project.create", {"name": "h", "type": "circuitpython"}))["ok"]
    r = await ws.action("device.pull", {}, "dp")
    assert not r["ok"] and "not connected" in r["error"].lower()


async def test_pairing_reset(env):
    app, client = env
    ws = await connect(client, app.token)
    old = app.token
    r = await ws.action("pairing.reset", {}, "pr")
    assert r["ok"] and r["result"]["token"] != old
    assert app.paths.token_file.read_text().strip() == r["result"]["token"]
    assert oct(app.paths.token_file.stat().st_mode & 0o777) == "0o600"


async def test_action_result_goes_to_the_asking_window(env, monkeypatch):
    """Review 2, finding 7: a slow action finishing after a reload is not delivered to the new window."""
    from boady import projects

    app, client = env
    gate = asyncio.Event()
    real = projects.create

    async def slow_create(*a, **k):
        await gate.wait()
        return await real(*a, **k)

    monkeypatch.setattr(projects, "create", slow_create)
    ws1 = await connect(client, app.token)
    await ws1.wait(lambda m: m["type"] == "hello.ok")
    await ws1.send({"type": "action", "id": "a1", "action": "project.create", "params": {"name": "slow", "type": "circuitpython"}})
    await asyncio.sleep(0.05)
    ws2 = await connect(client, app.token)  # page reloaded: replaces ws1
    await ws2.wait(lambda m: m["type"] == "hello.ok")
    gate.set()
    await ws2.wait(lambda m: m["type"] == "state" and m["project"] is not None, timeout=10)
    with pytest.raises(asyncio.TimeoutError):
        await ws2.wait(lambda m: m.get("type") == "action.result", timeout=1)
