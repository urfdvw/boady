import asyncio

import pytest

from boady.hardware import HardwareBridge, HardwareError
from boady.mcp_tools import decode_ctrl


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
