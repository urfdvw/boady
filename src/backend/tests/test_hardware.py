import asyncio

import pytest

from boady.hardware import HardwareBridge, HardwareError
import json
from pathlib import Path

from boady.mcp_tools import ToolContext, decode_ctrl, decode_wait_for


async def test_not_connected():
    b = HardwareBridge()
    with pytest.raises(HardwareError, match="not connected"):
        await b.request("fs.read_all")
    with pytest.raises(HardwareError, match="not connected"):
        await b.write("repl", "x")


async def _bridge_with_frontend():
    b = HardwareBridge()
    sent = []

    async def send(msg):
        sent.append(msg)

    b.attach_frontend(send)
    b.device.attached = True
    b.device.ports = ["repl"]
    return b, sent


async def test_request_response():
    b, sent = await _bridge_with_frontend()
    task = asyncio.create_task(b.request("fs.read_all", timeout=2))
    await asyncio.sleep(0.01)
    rid = sent[0]["id"]
    b.handle_response({"id": rid, "ok": True, "result": {"files": {}}})
    assert await task == {"files": {}}


async def test_request_timeout_sends_cancel():
    b, sent = await _bridge_with_frontend()
    with pytest.raises(HardwareError, match="timed out"):
        await b.request("fs.read_all", timeout=0.05)
    assert sent[-1]["type"] == "hw.cancel"


async def test_cancel_all():
    b, sent = await _bridge_with_frontend()
    task = asyncio.create_task(b.request("serial.write", {"port": "repl"}, timeout=5))
    await asyncio.sleep(0.01)
    await b.cancel_all("Interrupted")
    with pytest.raises(HardwareError, match="Interrupted"):
        await task
    assert sent[-1] == {"type": "hw.cancel", "ids": [sent[0]["id"]]}


async def test_frontend_disconnect_fails_pending():
    b, sent = await _bridge_with_frontend()
    task = asyncio.create_task(b.request("fs.read_all", timeout=5))
    await asyncio.sleep(0.01)
    b.detach_frontend()
    with pytest.raises(HardwareError, match="disconnected"):
        await task


async def test_data_port_missing():
    b, _ = await _bridge_with_frontend()
    with pytest.raises(HardwareError, match="No data serial port"):
        b.require_port("data")


async def test_write_returns_cursor_and_locks():
    b, sent = await _bridge_with_frontend()
    await b.serial_data("repl", b">>> ")
    task = asyncio.create_task(b.write("repl", "print(1)\r"))
    await asyncio.sleep(0.01)
    assert b.lock_owner["repl"] == "agent"
    b.handle_response({"id": sent[-1]["id"], "ok": True})
    assert await task == 4
    await b.release_all()
    assert b.lock_owner["repl"] is None


def test_decode_ctrl():
    assert decode_ctrl(r"\x03\x01abc\x04") == "\x03\x01abc\x04"
    # Enter written as escape text: decoded only at the end (found with the emulator)
    assert decode_ctrl(r"\r") == "\r"
    assert decode_ctrl(r"print(1)\r") == "print(1)\r"
    assert decode_ctrl(r"print(1)\r\n") == "print(1)\r"
    assert decode_ctrl(r"print(1)\n") == "print(1)\r"
    assert decode_ctrl("print(1)\r") == "print(1)\r"
    assert decode_ctrl(r'exec("a\nb")') == r'exec("a\nb")'
    assert decode_ctrl(r'exec("a\nb")\r') == r'exec("a\nb")' + "\r"
    assert decode_ctrl("\x03") == "\x03"
    assert decode_ctrl(r"\x05") == r"\x05"


def test_decode_wait_for():
    assert decode_wait_for(r"\x04>") == "\x04>"
    assert decode_wait_for(r"OK\x04") == "OK\x04"
    assert decode_wait_for(r"Code done running.\r\n") == "Code done running.\r\n"
    assert decode_wait_for(">>> ") == ">>> "
    assert decode_wait_for(r"\x05") == r"\x05"
    # review 10: repr() output keeps its backslashes; only a line end at the very end is decoded
    assert decode_wait_for(r"'done\n'") == r"'done\n'"
    assert decode_wait_for(r"b'\r\n' >>> ") == r"b'\r\n' >>> "


async def _ctx():
    b, sent = await _bridge_with_frontend()

    async def confirm(what, detail):
        return True

    async def changed():
        return None

    return ToolContext(bridge=b, project_dir=lambda: None, confirm=confirm, on_mirror_changed=changed), sent


async def test_read_repl_wait_for_understands_ctrl_escapes(tool_handlers):
    """Review 7, prompt finding 3: the agent writes Ctrl keys as escape text; wait_for must too."""
    ctx, _ = await _ctx()
    tools = tool_handlers(ctx)
    await ctx.bridge.serial_data("repl", b"OK\x04hello\r\n\x04>")
    res = await tools["read_repl"]({"since": 0, "wait_for": r"\x04>", "timeout_ms": 50})
    assert json.loads(res["content"][0]["text"])["matched"] is True


async def test_read_repl_wait_for_takes_alternatives(tool_handlers):
    ctx, _ = await _ctx()
    tools = tool_handlers(ctx)
    await ctx.bridge.serial_data("repl", b"\\r\\nKeyboardInterrupt\\r\\nPress any key to enter the REPL.\\r\\n")
    res = json.loads((await tools["read_repl"]({"since": 0, "wait_for": [">>> ", "Press any key"], "timeout_ms": 50}))["content"][0]["text"])
    assert res["matched"] is True and res["match"] == "Press any key"


async def test_tool_schemas_accept_real_calls_through_the_sdk(sdk_run_tool):
    """Review 11, finding 2: a wrong schema would make every real call fail with
    "Input validation error" while handler-level tests stay green."""
    ctx, _ = await _ctx()

    async def frontend(m):  # acknowledges every hardware request
        if m.get("type") == "hw.request":
            asyncio.get_running_loop().call_soon(ctx.bridge.handle_response, {"id": m["id"], "ok": True, "result": {}})

    ctx.bridge.attach_frontend(frontend)
    run = sdk_run_tool(ctx)
    await ctx.bridge.serial_data("repl", b">>> ")

    async def call(name, args):
        r = await run(name, args)
        return r.is_error, r.content[0].text

    ok = [
        ("read_repl", {"since": 0, "tail": 5, "wait_for": ">>> ", "timeout_ms": 10}),
        ("read_repl", {"since": 0, "wait_for": ["Press any key", ">>> "], "timeout_ms": 10}),
        ("read_repl", {}),
    ]
    for name, args in ok:
        err, text = await call(name, args)
        assert not err and json.loads(text)["matched"] in (True, None), (name, args, text)
    # validated, then refused by the handler for a reason other than the schema
    for name, args in [
        ("write_repl", {"data": "\\x03"}),
        ("sync_from_device", {"paths": ["data.txt"]}),
        ("sync_from_device", {}),
        ("sync_to_device", {}),
        ("compare_with_device", {}),
        ("install_library", {"names": ["adafruit_bme280"]}),
        ("list_libraries", {}),
    ]:
        err, text = await call(name, args)
        assert "Input validation error" not in text, (name, args, text)
    for name, args in [
        ("read_repl", {"wait_for": 3}),
        ("read_repl", {"since": "zero"}),
        ("write_repl", {}),
        ("install_library", {"names": "x"}),
        ("sync_from_device", {"paths": "data.txt"}),
    ]:
        err, text = await call(name, args)
        assert err and "Input validation error" in text, (name, args, text)
