"""Board identification, binding and the pull on connect (fake Claude + fake frontend)."""

import asyncio
import base64

import pytest
from claude_agent_sdk import ResultMessage

from boady import agent as agent_mod
from boady import identify
from test_server import WS, connect, env  # noqa: F401  (fixture reuse)

BOARD = {"uid": "4150325537323115", "runtime": "circuitpython"}


def test_parse():
    r = identify.parse("blah\nBOADY_ID uid=4150325537323115 runtime=circuitpython version=9.2.1 mpy=6")
    assert r == {"uid": "4150325537323115", "runtime": "circuitpython", "version": "9.2.1", "mpy_version": 6}
    assert identify.parse("BOADY_ID uid=abcd1234 runtime=micropython version=1.24.0 mpy=none")["mpy_version"] is None
    with pytest.raises(identify.IdentifyError):
        identify.parse("BOADY_ID error=no_prompt")
    with pytest.raises(identify.IdentifyError, match="hit your 5-hour limit"):
        identify.parse("You've hit your 5-hour limit · resets 11:20pm")  # shown to the user, not swallowed
    with pytest.raises(identify.IdentifyError, match="empty answer"):
        identify.parse("")


@pytest.fixture
def board(fake_client):
    async def script(c, text):
        if "Identify" in text:
            line = f"BOADY_ID uid={BOARD['uid']} runtime={BOARD['runtime']} version=9.2.1 mpy=6"
            await c.queue.put(ResultMessage(subtype="success", duration_ms=1, duration_api_ms=1, is_error=False, num_turns=1, session_id="x", result=line))

    fake_client.script = script
    return BOARD


async def attach(ws):
    await ws.send({"type": "device.attached", "usb": {"vid": 0x239A, "pid": 0x80F4}, "ports": ["repl", "data"]})


async def answer_pull(ws, files):
    req = await ws.wait(lambda m: m["type"] == "hw.request" and m["op"] == "fs.read_all", timeout=10)
    enc = {k: base64.b64encode(v).decode() for k, v in files.items()}
    await ws.send({"type": "hw.response", "id": req["id"], "ok": True, "result": {"files": enc}})


async def test_bind_new_project_and_pull(env, board):
    app, client = env
    ws = await connect(client, app.token)
    res = await ws.action("project.create", {"name": "p1", "type": "circuitpython"})
    pid = res["result"]["project"]["id"]
    await attach(ws)
    await answer_pull(ws, {"code.py": b"print('board')\n", "boot_out.txt": b"Adafruit CircuitPython 9.2.1\nUID:4150325537323115\n"})
    await ws.wait(lambda m: m.get("kind") == "item" and m["item"]["kind"] == "notice" and m["item"]["text"].startswith("pulled"))
    p = app.table.get(pid)
    assert p.board_uid == board["uid"] and p.mpy_version == 6
    assert (p.path / "src" / "code.py").read_text() == "print('board')\n"
    assert not (p.path / "src" / "CIRCUIT.md").exists()  # board is the truth; left in git working tree
    st = app.bridge.device
    assert st.uid == board["uid"] and st.version == "9.2.1" and st.last_sync["direction"] == "pull"


async def test_reconnect_opens_bound_project(env, board):
    app, client = env
    ws = await connect(client, app.token)
    pid = (await ws.action("project.create", {"name": "p1", "type": "circuitpython"}))["result"]["project"]["id"]
    await attach(ws)
    await answer_pull(ws, {"code.py": b"x"})
    await ws.wait(lambda m: m.get("kind") == "item" and m["item"].get("text", "").startswith("pulled"))
    assert (await ws.action("git.commit", {"message": "board state"}, "g"))["ok"]  # else the next pull asks first
    await ws.send({"type": "device.detached"})
    assert (await ws.action("project.close", {}, "c"))["ok"]
    assert app.project is None
    await attach(ws)
    await answer_pull(ws, {"code.py": b"x"})
    await ws.wait(lambda m: m.get("kind") == "item" and m["item"].get("text", "").startswith("pulled"))
    assert app.project.id == pid


async def test_multiple_projects_need_selection(env, board):
    app, client = env
    ws = await connect(client, app.token)
    await ws.action("project.create", {"name": "p1", "type": "circuitpython"}, "1")
    await attach(ws)
    await answer_pull(ws, {"code.py": b"x"})
    await ws.wait(lambda m: m.get("kind") == "item" and m["item"].get("text", "").startswith("pulled"))
    # a second project created while the board is connected is bound to it too
    await ws.action("project.create", {"name": "p2", "type": "circuitpython"}, "2")
    await answer_pull(ws, {"code.py": b"x"})
    await ws.wait(lambda m: m.get("kind") == "item" and m["item"].get("text", "").startswith("pulled"))
    assert len(app.table.by_uid(board["uid"])) == 2
    await ws.send({"type": "device.detached"})
    await ws.action("project.close", {}, "c")
    await attach(ws)
    sel = await ws.wait(lambda m: m["type"] == "project.select_required", timeout=10)
    assert sel["reason"] == "multiple_projects" and len(sel["candidates"]) == 2


async def test_unknown_board(env, board):
    app, client = env
    ws = await connect(client, app.token)
    await attach(ws)
    sel = await ws.wait(lambda m: m["type"] == "project.select_required", timeout=10)
    assert sel["reason"] == "unknown_board" and sel["candidates"] is None


async def test_runtime_mismatch(env, board, monkeypatch):
    app, client = env
    ws = await connect(client, app.token)
    await ws.action("project.create", {"name": "mp", "type": "micropython"})
    await attach(ws)  # board says circuitpython
    sel = await ws.wait(lambda m: m["type"] == "project.select_required", timeout=10)
    assert sel["reason"] == "runtime_mismatch" and sel["expected"] == "micropython"
    assert app.project is None


async def test_pull_asks_when_mirror_dirty(env, board):
    app, client = env
    ws = await connect(client, app.token)
    await ws.action("project.create", {"name": "p1", "type": "circuitpython"})
    await ws.action("file.write", {"path": "src/code.py", "text": "local edit"}, "w")
    await attach(ws)
    req = await ws.wait(lambda m: m["type"] == "permission_request", timeout=10)
    assert req["kind"] == "confirm" and req["detail"]["files"] == ["src/code.py"]
    await ws.send({"type": "permission_reply", "request_id": req["request_id"], "allow": False})
    await ws.wait(lambda m: m.get("kind") == "item" and m["item"].get("text") == "pull_declined")
    assert (app.project.path / "src" / "code.py").read_text() == "local edit"


async def test_identify_failure_reported(env, fake_client):
    async def script(c, text):
        await c.queue.put(ResultMessage(subtype="success", duration_ms=1, duration_api_ms=1, is_error=False, num_turns=1, session_id="x", result="BOADY_ID error=no_prompt"))

    fake_client.script = script
    app, client = env
    ws = await connect(client, app.token)
    await attach(ws)
    st = await ws.wait(lambda m: m["type"] == "state" and (m["device"].get("error") or "").startswith("identify_failed"), timeout=10)
    assert "no_prompt" in st["device"]["error"]
    opts = fake_client.instances[-1].options
    assert opts.allowed_tools == ["mcp__boady__read_repl", "mcp__boady__write_repl"] and opts.tools == []


async def test_open_foreign_project_checks_runtime_and_blocks_sync(env, board):
    """Review finding 6."""
    app, client = env
    ws = await connect(client, app.token)
    cp = (await ws.action("project.create", {"name": "cp", "type": "circuitpython"}, "1"))["result"]["project"]["id"]
    await attach(ws)
    await answer_pull(ws, {"code.py": b"x"})
    await ws.wait(lambda m: m.get("kind") == "item" and m["item"].get("text", "").startswith("pulled"))
    # a MicroPython project bound to some other board
    mp = (await ws.action("project.create", {"name": "mp", "type": "micropython"}, "2"))["result"]["project"]["id"]
    sel = await ws.wait(lambda m: m["type"] == "project.select_required", timeout=10)
    assert sel["reason"] == "runtime_mismatch" and app.project is None
    app.table.update(mp, board_uid="FFFF0000")
    # a second CircuitPython project bound to another board: stays open, but no sync
    other = (await ws.action("project.create", {"name": "cp2", "type": "circuitpython"}, "3"))["result"]["project"]["id"]
    await answer_pull(ws, {"code.py": b"x"})  # created while connected -> bound to this board
    await ws.wait(lambda m: m.get("kind") == "item" and m["item"].get("text", "").startswith("pulled"))
    app.table.update(other, board_uid="FFFF0001")
    app.project = app.table.get(other)
    r = await ws.action("device.push", {}, "4")
    assert not r["ok"] and "board_other_project" in r["error"]
    r = await ws.action("device.pull", {}, "5")
    assert not r["ok"] and "board_other_project" in r["error"]
    assert cp


async def test_pull_reasks_when_mirror_changes_during_transfer(env, board):
    """Review finding 2: edits saved while the board is read are not lost silently."""
    app, client = env
    ws = await connect(client, app.token)
    await ws.action("project.create", {"name": "p1", "type": "circuitpython"})
    await attach(ws)
    req = await ws.wait(lambda m: m["type"] == "hw.request" and m["op"] == "fs.read_all", timeout=10)
    # mirror was clean when the pull started; the user saves an edit mid-transfer
    (app.project.path / "src" / "code.py").write_text("saved during transfer")
    await ws.send({"type": "hw.response", "id": req["id"], "ok": True, "result": {"files": {"code.py": base64.b64encode(b"board").decode()}}})
    perm = await ws.wait(lambda m: m["type"] == "permission_request", timeout=10)
    assert perm["detail"]["files"] == ["src/code.py"]
    await ws.send({"type": "permission_reply", "request_id": perm["request_id"], "allow": False})
    await ws.wait(lambda m: m.get("kind") == "item" and m["item"].get("text") == "pull_declined")
    assert (app.project.path / "src" / "code.py").read_text() == "saved during transfer"


async def test_identification_tools_work_before_the_board_is_known(env, fake_client, monkeypatch):
    """Review 2, finding 1: the identification call really calls write_repl
    while a project is open and the board has no UID yet."""
    import json as _json

    from boady import mcp_tools

    built = []
    real = mcp_tools.create_sdk_mcp_server

    def record(name, version, tools):
        built.append({t.name: t for t in tools})
        return real(name, version, tools)

    monkeypatch.setattr(mcp_tools, "create_sdk_mcp_server", record)

    async def script(c, text):
        if "Identify" not in text:
            return
        tools = next(b for b in reversed(built) if set(b) == {"read_repl", "write_repl"})
        res = await tools["write_repl"].handler({"data": "\\x03"})
        body = _json.loads(res["content"][0]["text"])
        line = "BOADY_ID error=write_failed" if res.get("is_error") else "BOADY_ID uid=ABCD1234 runtime=circuitpython version=9 mpy=6"
        await c.queue.put(ResultMessage(subtype="success", duration_ms=1, duration_api_ms=1, is_error=False, num_turns=1, session_id="x", result=line))

    fake_client.script = script
    app, client = env
    ws = await connect(client, app.token)
    await ws.action("project.create", {"name": "p", "type": "circuitpython"})
    await attach(ws)
    req = await ws.wait(lambda m: m["type"] == "hw.request" and m["op"] == "serial.write", timeout=10)
    assert req["params"]["data"] == "\x03"
    await ws.send({"type": "hw.response", "id": req["id"], "ok": True, "result": {}})
    await ws.wait(lambda m: m["type"] == "state" and m["device"].get("uid") == "ABCD1234", timeout=10)


async def test_pull_reasks_for_edits_made_while_the_first_card_waits(env, board):
    """Review 2, finding 3."""
    app, client = env
    ws = await connect(client, app.token)
    await ws.action("project.create", {"name": "p1", "type": "circuitpython"})
    await ws.action("file.write", {"path": "src/code.py", "text": "local"}, "w")
    await attach(ws)
    first = await ws.wait(lambda m: m["type"] == "permission_request", timeout=10)
    assert first["detail"]["files"] == ["src/code.py"]
    (app.project.path / "src" / "new.py").write_text("written while the card waits")
    await ws.send({"type": "permission_reply", "request_id": first["request_id"], "allow": True})
    req = await ws.wait(lambda m: m["type"] == "hw.request" and m["op"] == "fs.read_all", timeout=10)
    await ws.send({"type": "hw.response", "id": req["id"], "ok": True, "result": {"files": {"code.py": base64.b64encode(b"board").decode()}}})
    second = await ws.wait(lambda m: m["type"] == "permission_request" and m["request_id"] != first["request_id"], timeout=10)
    assert second["detail"]["files"] == ["src/new.py"]
    await ws.send({"type": "permission_reply", "request_id": second["request_id"], "allow": False})
    await ws.wait(lambda m: m.get("kind") == "item" and m["item"].get("text") == "pull_declined")
    assert (app.project.path / "src" / "new.py").exists()


async def test_src_symlink_never_reaches_outside(env, board, tmp_path):
    """Review 2, finding 2: a src symlink must not let a pull delete files elsewhere."""
    app, client = env
    ws = await connect(client, app.token)
    await ws.action("project.create", {"name": "p1", "type": "circuitpython"})
    await attach(ws)
    await answer_pull(ws, {"code.py": b"x"})
    await ws.wait(lambda m: m.get("kind") == "item" and m["item"].get("text", "").startswith("pulled"))
    outside = tmp_path / "victim"
    outside.mkdir()
    (outside / "keep.txt").write_text("keep")
    src = app.project.path / "src"
    import shutil

    shutil.rmtree(src)
    src.symlink_to(outside)
    for action in ("device.pull", "device.push", "lib.list"):
        r = await ws.action(action, {}, action)
        assert not r["ok"] and "symbolic link" in r["error"], (action, r)
    assert (outside / "keep.txt").read_text() == "keep"


async def test_compare_with_device_buffers_and_finds_board_changes(env, board, monkeypatch):
    """Master 2026-11-24: the pre-upload check reads the board into a buffer, never into the mirror."""
    from boady import mcp_tools

    app, client = env
    ws = await connect(client, app.token)
    await ws.action("project.create", {"name": "cmp", "type": "circuitpython"})
    await attach(ws)
    on_board = {"code.py": b"print('old')\n", "data.txt": b"1\n"}
    await answer_pull(ws, on_board)
    await ws.wait(lambda m: m.get("kind") == "item" and m["item"].get("text", "").startswith("pulled"))
    src = app.project.path / "src"
    assert app.get_baseline() == {"code.py": mcp_tools.sync.sha256(b"print('old')\n"), "data.txt": mcp_tools.sync.sha256(b"1\n")}

    async def compare(board_now):
        task = asyncio.create_task(mcp_tools.compare_with_device(app.tool_ctx))
        await answer_pull(ws, board_now)
        return await task

    # 1) the agent fixed code.py in the mirror; the board is unchanged
    (src / "code.py").write_text("print('fixed')\n")
    r = await compare(on_board)
    assert r["changed_on_board"] == [] and r["differs"] == ["code.py"]
    assert (src / "code.py").read_text() == "print('fixed')\n"  # mirror untouched, no approval asked

    # 2) a program on the board changed data.txt meanwhile
    r = await compare({**on_board, "data.txt": b"2\n"})
    assert r["changed_on_board"] == ["data.txt"]
    d = r["diffs"]["data.txt"]
    assert "\n-2\n" in d and "\n+1\n" in d  # board -> mirror
    assert (src / "data.txt").read_text() == "1\n"

    # 3) after an upload the baseline is the mirror
    task = asyncio.create_task(mcp_tools.push_to_device(app.tool_ctx))
    plan = await ws.wait(lambda m: m["type"] == "hw.request" and m["op"] == "fs.plan", timeout=10)
    await ws.send({"type": "hw.response", "id": plan["id"], "ok": True, "result": {"need": ["code.py"], "delete": []}})
    apply = await ws.wait(lambda m: m["type"] == "hw.request" and m["op"] == "fs.apply", timeout=10)
    await ws.send({"type": "hw.response", "id": apply["id"], "ok": True, "result": {"written": ["code.py"], "deleted": []}})
    await task
    assert app.get_baseline()["code.py"] == mcp_tools.sync.sha256(b"print('fixed')\n")


async def test_compare_without_baseline_says_so(env, board):
    from boady import mcp_tools

    app, client = env
    ws = await connect(client, app.token)
    await ws.action("project.create", {"name": "nb", "type": "circuitpython"})
    await attach(ws)
    await answer_pull(ws, {"code.py": b"x"})
    await ws.wait(lambda m: m.get("kind") == "item" and m["item"].get("text", "").startswith("pulled"))
    app.paths.home.joinpath("sync", f"{app.project.id}.json").unlink()
    task = asyncio.create_task(mcp_tools.compare_with_device(app.tool_ctx))
    await answer_pull(ws, {"code.py": b"y"})
    r = await task
    assert r["changed_on_board"] is None and "baseline" in r["note"] and r["differs"] == ["code.py"]



async def test_upload_uses_one_snapshot_for_plan_transfer_and_baseline(env, board):
    """Review 3, finding 2: an edit made during the upload is neither sent nor recorded."""
    from boady import mcp_tools

    app, client = env
    ws = await connect(client, app.token)
    await ws.action("project.create", {"name": "snap", "type": "circuitpython"})
    await attach(ws)
    await answer_pull(ws, {"code.py": b"A0"})
    await ws.wait(lambda m: m.get("kind") == "item" and m["item"].get("text", "").startswith("pulled"))
    src = app.project.path / "src"
    (src / "code.py").write_text("A")
    task = asyncio.create_task(mcp_tools.push_to_device(app.tool_ctx))
    plan = await ws.wait(lambda m: m["type"] == "hw.request" and m["op"] == "fs.plan", timeout=10)
    (src / "code.py").write_text("B")  # edited while the upload runs
    await ws.send({"type": "hw.response", "id": plan["id"], "ok": True, "result": {"need": ["code.py"], "delete": []}})
    apply = await ws.wait(lambda m: m["type"] == "hw.request" and m["op"] == "fs.apply", timeout=10)
    assert base64.b64decode(apply["params"]["files"]["code.py"]) == b"A"
    await ws.send({"type": "hw.response", "id": apply["id"], "ok": True, "result": {"written": ["code.py"], "deleted": []}})
    await task
    assert app.get_baseline()["code.py"] == mcp_tools.sync.sha256(b"A")


async def test_pull_selected_paths_keeps_local_edits(env, board):
    """Review 3, finding 4: keeping the board's data.txt must not overwrite the local code.py fix."""
    from boady import mcp_tools

    app, client = env
    ws = await connect(client, app.token)
    await ws.action("project.create", {"name": "sel", "type": "circuitpython"})
    await attach(ws)
    await answer_pull(ws, {"code.py": b"old\n", "data.txt": b"1\n"})
    await ws.wait(lambda m: m.get("kind") == "item" and m["item"].get("text", "").startswith("pulled"))
    await ws.action("git.commit", {"message": "board"}, "c")
    src = app.project.path / "src"
    (src / "code.py").write_text("fixed\n")  # uncommitted local fix
    task = asyncio.create_task(mcp_tools.pull_from_device(app.tool_ctx, paths=["data.txt"]))
    await answer_pull(ws, {"code.py": b"old\n", "data.txt": b"2\n"})
    res = await task  # no approval: data.txt has no local edits
    assert res == {"added": [], "modified": ["data.txt"], "deleted": []}
    assert (src / "data.txt").read_text() == "2\n"
    assert (src / "code.py").read_text() == "fixed\n"
    assert not any(m["type"] == "permission_request" for m in ws.inbox)


async def attach_emulator(ws):
    await ws.send({"type": "device.attached", "usb": {"vid": None, "pid": None, "msc": None, "emulator": {"runtime": "circuitpython", "firmware": "x"}}, "ports": ["repl"]})


async def test_first_connection_fixes_board_kind(env, board):
    """Master 2026-11-25: a project becomes a test (emulator) project by its first connection."""
    import json as _json

    app, client = env
    ws = await connect(client, app.token)
    pid = (await ws.action("project.create", {"name": "t1", "type": "circuitpython"}))["result"]["project"]["id"]
    assert app.table.get(pid).board is None
    await attach_emulator(ws)
    await answer_pull(ws, {"code.py": b"x"})
    await ws.wait(lambda m: m.get("kind") == "item" and m["item"].get("text", "").startswith("pulled"))
    p = app.table.get(pid)
    assert p.board == "rp2040js"
    assert _json.loads((p.path / "boady.json").read_text()) == {"type": "circuitpython", "board": "rp2040js"}
    st = await ws.wait(lambda m: m["type"] == "state" and m["project"] and m["project"].get("board") == "rp2040js")
    assert st["project"]["board"] == "rp2040js"


async def test_real_board_refused_for_a_test_project(env, board):
    app, client = env
    ws = await connect(client, app.token)
    pid = (await ws.action("project.create", {"name": "t2", "type": "circuitpython"}))["result"]["project"]["id"]
    await attach_emulator(ws)
    await answer_pull(ws, {"code.py": b"x"})
    await ws.wait(lambda m: m.get("kind") == "item" and m["item"].get("text", "").startswith("pulled"))
    await ws.send({"type": "device.detached"})
    # same UID (fake identification), but a real USB board this time
    app.table.update(pid, board_uid=None)
    await attach(ws)
    await ws.wait(lambda m: m.get("kind") == "item" and m["item"].get("text", "").startswith("board_kind_mismatch"), timeout=10)
    assert app.table.get(pid).board == "rp2040js"
    r = await ws.action("device.push", {}, "p")
    assert not r["ok"] and "board_kind_mismatch" in r["error"]


async def test_first_real_connection_marks_usb(env, board):
    app, client = env
    ws = await connect(client, app.token)
    pid = (await ws.action("project.create", {"name": "t3", "type": "circuitpython"}))["result"]["project"]["id"]
    await attach(ws)
    await answer_pull(ws, {"code.py": b"x"})
    await ws.wait(lambda m: m.get("kind") == "item" and m["item"].get("text", "").startswith("pulled"))
    assert app.table.get(pid).board == "usb"
