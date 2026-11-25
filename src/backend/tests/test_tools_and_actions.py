"""MCP tool shells, the app's board checks and WebSocket actions not covered elsewhere (review 7)."""

import asyncio
import base64
import json
import subprocess

import pytest

from boady import mcp_tools, sync
from boady.hardware import DeviceState
from test_device_flow import BOARD, answer_pull, attach, board  # noqa: F401  (fixture reuse)
from test_libraries import fake_circup  # noqa: F401
from test_server import connect, env  # noqa: F401


def body(res):
    return json.loads(res["content"][0]["text"])


def set_device(app, **kw):
    d = DeviceState(attached=True)
    d.ports = ["repl"]
    for k, v in kw.items():
        setattr(d, k, v)
    app.bridge.device = d


async def test_write_repl_refuses_a_board_the_project_must_not_use(env, tool_handlers):
    """D34/D35: the agent's REPL writes go through the board check (app.board_error)."""
    app, client = env
    ws = await connect(client, app.token)
    await ws.action("project.create", {"name": "cp", "type": "circuitpython"})
    tools = tool_handlers(app.tool_ctx)
    cases = [
        ({"uid": None}, "not been identified"),
        ({"uid": "U1", "runtime": "micropython"}, "runtime_mismatch"),
        ({"uid": "U1", "runtime": "circuitpython", "usb": {"emulator": {"project": "other"}}}, "emulator_other_project"),
        ({"uid": "U1", "runtime": "circuitpython", "usb": {"emulator": True}}, None),  # first connection: no kind yet
    ]
    for dev, err in cases:
        set_device(app, **dev)
        if err is None:
            assert app.board_error() is None
            continue
        for name in ("write_repl", "write_data"):
            res = await tools[name]({"data": "\\x04"})
            assert res.get("is_error") and err in body(res)["error"], (dev, name, res)
    app.table.update(app.project.id, board="usb")
    app.project = app.table.get(app.project.id)
    set_device(app, uid="U1", runtime="circuitpython", usb={"emulator": True})
    assert "board_kind_mismatch" in body(await tools["write_repl"]({"data": "x"}))["error"]
    app.table.update(app.project.id, board_uid="OTHER")
    app.project = app.table.get(app.project.id)
    set_device(app, uid="U1", runtime="circuitpython")
    assert "board_other_project" in body(await tools["write_repl"]({"data": "x"}))["error"]
    assert not [m for m in ws.inbox if m.get("type") == "hw.request"]  # nothing reached the board


async def test_tool_shells_turn_errors_into_tool_errors(env, tool_handlers):
    app, client = env
    await connect(client, app.token)
    tools = tool_handlers(app.tool_ctx)
    for name in ("install_library", "list_libraries"):
        assert body(await tools[name]({"names": ["x"]}))["error"] == "No project is open."
    for name in ("sync_from_device", "sync_to_device", "compare_with_device"):
        assert body(await tools[name]({}))["error"] == "No project is open."
    assert "No data serial port" in body(await tools["read_data"]({}))["error"] or "not connected" in body(await tools["read_data"]({}))["error"].lower()


async def test_sync_from_device_tool_reports_declined_and_takes_paths(env, board, tool_handlers):
    app, client = env
    ws = await connect(client, app.token)
    await ws.action("project.create", {"name": "p", "type": "circuitpython"})
    await attach(ws)
    await answer_pull(ws, {"code.py": b"x", "data.txt": b"1"})
    await ws.wait(lambda m: m.get("kind") == "item" and m["item"].get("text", "").startswith("pulled"))
    tools = tool_handlers(app.tool_ctx)
    (app.project.path / "src" / "data.txt").write_text("local")
    task = asyncio.create_task(tools["sync_from_device"]({"paths": ["data.txt"]}))
    perm = await ws.wait(lambda m: m["type"] == "permission_request", timeout=10)
    await ws.send({"type": "permission_reply", "request_id": perm["request_id"], "allow": False})
    assert body(await task)["error"] == mcp_tools.USER_DECLINED
    res = await tools["sync_from_device"]({"paths": ["../x"]})
    assert res.get("is_error") and "plain src-relative" in body(res)["error"]


async def test_unsupported_runtime_is_reported(env):
    app, client = env
    await connect(client, app.token)
    set_device(app, uid="U9", runtime="other")
    await app.project_for_device(explicit=False)
    assert app.bridge.device.error == "unsupported_runtime: other"


async def test_the_only_bound_project_of_another_runtime(env):
    """A board bound to one project whose type no longer matches the board's runtime."""
    app, client = env
    ws = await connect(client, app.token)
    pid = (await ws.action("project.create", {"name": "mp", "type": "micropython"}))["result"]["project"]["id"]
    app.table.update(pid, board_uid="U7")
    await ws.action("project.close", {}, "c")
    set_device(app, uid="U7", runtime="circuitpython")
    await app.project_for_device(explicit=False)
    sel = await ws.wait(lambda m: m["type"] == "project.select_required", timeout=5)
    assert sel["reason"] == "runtime_mismatch" and sel["expected"] == "micropython" and sel["project"] == "mp"
    assert app.project is None


async def test_project_ready_reports_start_and_pull_failures(env, monkeypatch):
    app, client = env
    ws = await connect(client, app.token)
    await ws.action("project.create", {"name": "p", "type": "circuitpython"})

    async def broken_connect():
        raise RuntimeError("no cli")

    monkeypatch.setattr(app.session, "connect", broken_connect)
    await app.project_ready()  # no device: the pull fails too
    texts = [m["item"]["text"] for m in ws.inbox if m.get("kind") == "item"]
    texts += [m["item"]["text"] for m in [await ws.wait(lambda m: m.get("kind") == "item" and "pull_failed" in m["item"]["text"])]]
    assert any("Claude Code could not start: no cli" in t for t in texts + [i.get("text", "") for i in app.session.items])
    assert any(t.startswith("pull_failed: ") for t in texts)


async def test_pull_asks_again_as_long_as_the_mirror_keeps_changing(env, board):
    app, client = env
    ws = await connect(client, app.token)
    await ws.action("project.create", {"name": "p", "type": "circuitpython"})
    await attach(ws)
    await answer_pull(ws, {"code.py": b"x"})
    await ws.wait(lambda m: m.get("kind") == "item" and m["item"].get("text", "").startswith("pulled"))
    src = app.project.path / "src"
    (src / "code.py").write_text("x")
    subprocess.run(["git", "add", "-A"], cwd=app.project.path, check=True)
    subprocess.run(["git", "commit", "-qm", "board"], cwd=app.project.path, check=True)
    await ws.send({"type": "action", "id": "pull", "action": "device.pull", "params": {}})
    req = await ws.wait(lambda m: m["type"] == "hw.request" and m["op"] == "fs.read_all", timeout=10)
    (src / "a.py").write_text("during transfer")
    await ws.send({"type": "hw.response", "id": req["id"], "ok": True, "result": {"files": {"code.py": base64.b64encode(b"x").decode()}}})
    first = await ws.wait(lambda m: m["type"] == "permission_request", timeout=10)
    assert first["detail"]["files"] == ["src/a.py"]
    (src / "b.py").write_text("while the card waits")
    await ws.send({"type": "permission_reply", "request_id": first["request_id"], "allow": True})
    second = await ws.wait(lambda m: m["type"] == "permission_request" and m["request_id"] != first["request_id"], timeout=10)
    assert second["detail"]["files"] == ["src/b.py"]
    await ws.send({"type": "permission_reply", "request_id": second["request_id"], "allow": True})
    res = await ws.wait(lambda m: m.get("type") == "action.result" and m.get("id") == "pull", timeout=10)
    assert res["ok"] and sorted(res["result"]["deleted"]) == ["a.py", "b.py"]


async def test_pull_turns_a_refused_apply_into_a_hardware_error(env, board, monkeypatch):
    app, client = env
    ws = await connect(client, app.token)
    await ws.action("project.create", {"name": "p", "type": "circuitpython"})
    await attach(ws)
    await answer_pull(ws, {"code.py": b"x"})
    await ws.wait(lambda m: m.get("kind") == "item" and m["item"].get("text", "").startswith("pulled"))

    def refuse(src, files):
        raise ValueError("case_collision: the board has both 'a.py' and 'A.py'")

    await ws.action("git.commit", {"message": "board"}, "g")  # else the pull asks first
    monkeypatch.setattr(sync, "apply_from_device", refuse)
    await ws.send({"type": "action", "id": "pull", "action": "device.pull", "params": {}})
    await answer_pull(ws, {"a.py": b"1", "A.py": b"2"})
    res = await ws.wait(lambda m: m.get("type") == "action.result" and m.get("id") == "pull", timeout=10)
    assert not res["ok"] and res["error"].startswith("case_collision")


async def test_partial_pull_of_a_file_gone_from_the_board_updates_the_baseline(env, board, tool_handlers):
    app, client = env
    ws = await connect(client, app.token)
    await ws.action("project.create", {"name": "p", "type": "circuitpython"})
    await attach(ws)
    await answer_pull(ws, {"code.py": b"x", "data.txt": b"1"})
    await ws.wait(lambda m: m.get("kind") == "item" and m["item"].get("text", "").startswith("pulled"))
    await ws.action("git.commit", {"message": "board"}, "g")
    tools = tool_handlers(app.tool_ctx)
    task = asyncio.create_task(tools["sync_from_device"]({"paths": ["data.txt"]}))
    await answer_pull(ws, {"code.py": b"y"})  # data.txt is gone, code.py changed
    assert body(await task)["deleted"] == ["data.txt"]
    base = app.get_baseline()
    assert "data.txt" not in base and base["code.py"] == sync.sha256(b"x")  # code.py's change stays visible
    assert not (app.project.path / "src" / "data.txt").exists()


async def test_library_and_git_actions_over_the_websocket(env, fake_circup):
    app, client = env
    ws = await connect(client, app.token)
    await ws.action("project.create", {"name": "libs", "type": "circuitpython"})
    src = app.project.path / "src"
    (src / "boot_out.txt").write_text("Adafruit CircuitPython 9.2.1\n")
    r = await ws.action("lib.list", {}, "l")
    assert r["ok"] and r["result"]["libraries"][0]["name"] == "adafruit_bme280"
    assert (await ws.action("lib.search", {"query": "bme"}, "s"))["result"]["results"] == ["adafruit_bme280"]
    for name, params in (("lib.install", {"names": ["adafruit_bme280"]}), ("lib.update", {}), ("lib.uninstall", {"names": ["adafruit_bme280"]})):
        r = await ws.action(name, params, name)
        assert r["ok"] and r["result"]["output"].startswith("ok"), (name, r)
    assert not (await ws.action("lib.nope", {}, "n"))["ok"]

    (src / "code.py").write_text("edited")
    (src / "new.py").write_text("new")
    assert (await ws.action("git.reset_file", {"path": "src/code.py"}, "r1"))["ok"]
    assert (src / "code.py").read_text() != "edited" and (src / "new.py").exists()
    r = await ws.action("git.reset_all", {}, "r2")
    assert not r["ok"] and "confirmation" in r["error"]
    assert (await ws.action("git.reset_all", {"confirm": True}, "r3"))["ok"]
    assert not (src / "new.py").exists()
    r = await ws.action("git.push", {}, "p")
    assert not r["ok"] and "no remote" in r["error"]


async def test_clone_action_opens_the_cloned_project(env, tmp_path):
    app, client = env
    ws = await connect(client, app.token)
    origin = tmp_path / "origin"
    (origin / "src").mkdir(parents=True)
    (origin / "src" / "main.py").write_text("print(1)\n")
    (origin / "boady.json").write_text(json.dumps({"type": "micropython"}))
    for cmd in (["git", "init", "-q", "-b", "main"], ["git", "add", "-A"], ["git", "commit", "-qm", "init"]):
        subprocess.run(cmd, cwd=origin, check=True)
    r = await ws.action("project.clone", {"url": str(origin)}, "c")
    assert r["ok"] and r["result"]["project"]["type"] == "micropython"
    assert app.project.name == "origin" and (app.project.path / "src" / "main.py").exists()


async def test_first_emulator_binding_reaches_a_session_that_already_chatted(env, board, fake_client):
    """Review 8, finding 4: chat first, then connect the emulator for the first time:
    the agent's client must get the test-project prompt, not keep the old one."""
    from claude_agent_sdk import ResultMessage

    async def script(c, text):
        if "Identify" in text:
            line = f"BOADY_ID uid={BOARD['uid']} runtime={BOARD['runtime']} version=10.3.2 mpy=6"
        else:
            line = "ok"
        await c.queue.put(ResultMessage(subtype="success", duration_ms=1, duration_api_ms=1, is_error=False,
                                        num_turns=1, session_id="x", result=line))

    fake_client.script = script
    app, client = env
    ws = await connect(client, app.token)
    await ws.action("project.create", {"name": "t", "type": "circuitpython"})
    await ws.send({"type": "user_message", "text": "hello"})
    await ws.wait(lambda m: m.get("kind") == "turn_end", timeout=10)
    first = app.session.client
    assert "Emulator tab" not in first.options.system_prompt["append"]
    await ws.send({"type": "device.attached", "usb": {"vid": None, "pid": None, "emulator": {"runtime": "circuitpython", "firmware": "x"}}, "ports": ["repl"]})
    await answer_pull(ws, {"code.py": b"x"})
    await ws.wait(lambda m: m.get("kind") == "item" and m["item"].get("text", "").startswith("pulled"))
    assert app.project.board == "rp2040js"
    assert app.session.client is not first and not first.connected
    assert "Emulator tab" in app.session.client.options.system_prompt["append"]


async def test_reads_say_whether_the_program_was_stopped(env, board, tool_handlers):
    """Review 10, prompt 3: over the drive the program keeps running; over serial it is stopped."""
    app, client = env
    ws = await connect(client, app.token)
    await ws.action("project.create", {"name": "ch", "type": "circuitpython"})
    await attach(ws)
    await answer_pull(ws, {"code.py": b"x"})
    await ws.wait(lambda m: m.get("kind") == "item" and m["item"].get("text", "").startswith("pulled"))
    await ws.action("git.commit", {"message": "board"}, "g")
    tools = tool_handlers(app.tool_ctx)
    for channel, stopped in (("msc", False), ("serial", True)):
        for name in ("compare_with_device", "sync_from_device"):
            task = asyncio.create_task(tools[name]({}))
            req = await ws.wait(lambda m: m["type"] == "hw.request" and m["op"] == "fs.read_all", timeout=10)
            await ws.send({"type": "hw.response", "id": req["id"], "ok": True,
                           "result": {"files": {"code.py": base64.b64encode(b"x").decode()}, "channel": channel}})
            out = body(await task)
            assert out["channel"] == channel and out["program_stopped"] is stopped, (name, out)


async def test_library_tools_succeed_for_the_agent(env, fake_circup, tool_handlers):
    app, client = env
    ws = await connect(client, app.token)
    await ws.action("project.create", {"name": "libtools", "type": "circuitpython"})
    (app.project.path / "src" / "boot_out.txt").write_text("Adafruit CircuitPython 9.2.1\n")
    tools = tool_handlers(app.tool_ctx)
    res = await tools["install_library"]({"names": ["adafruit_bme280"]})
    assert not res.get("is_error") and body(res)["output"].startswith("ok")
    assert "install adafruit_bme280" in fake_circup.read_text()
    libs = body(await tools["list_libraries"]({}))
    assert libs[0]["name"] == "adafruit_bme280" and libs[0]["outdated"] is True
