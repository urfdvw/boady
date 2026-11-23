"""Backend side of the hardware RPC (``hw.request`` / ``hw.response`` /
``hw.cancel``) plus device and serial state.

The backend never touches USB: every board operation is a request to the
frontend, which executes it according to project type and transport.
"""

from __future__ import annotations

import asyncio
import itertools
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable

from .config import HW_TIMEOUT, SERIAL_BUFFER_BYTES
from .ringbuffer import RingBuffer

Send = Callable[[dict[str, Any]], Awaitable[None]]

PORTS = ("repl", "data")


class HardwareError(Exception):
    """Error returned to the agent tool as a clear message."""


NOT_CONNECTED = "Device not connected."


@dataclass
class DeviceState:
    attached: bool = False
    usb: dict[str, Any] = field(default_factory=dict)  # VID/PID, has_msc ...
    ports: list[str] = field(default_factory=list)  # which of PORTS are open
    uid: str | None = None
    runtime: str | None = None
    mpy_version: int | None = None
    channel: str | None = None  # "msc" | "serial"

    def to_dict(self) -> dict[str, Any]:
        return {
            "attached": self.attached,
            "usb": self.usb,
            "ports": self.ports,
            "uid": self.uid,
            "runtime": self.runtime,
            "mpy_version": self.mpy_version,
            "channel": self.channel,
        }


class HardwareBridge:
    def __init__(self) -> None:
        self._send: Send | None = None
        self._ids = itertools.count(1)
        self._pending: dict[str, asyncio.Future] = {}
        self.device = DeviceState()
        self.buffers = {p: RingBuffer(SERIAL_BUFFER_BYTES) for p in PORTS}
        # serial write lock owner per port: None | "agent"
        self.lock_owner: dict[str, str | None] = {p: None for p in PORTS}
        self.on_lock_change: Callable[[], Awaitable[None]] | None = None

    # -- frontend link -----------------------------------------------------
    def attach_frontend(self, send: Send) -> None:
        self._send = send

    def detach_frontend(self) -> None:
        self._send = None
        self.fail_all("Frontend disconnected.")
        self.device = DeviceState()

    @property
    def connected(self) -> bool:
        return self._send is not None and self.device.attached

    # -- RPC ---------------------------------------------------------------
    async def request(self, op: str, params: dict[str, Any] | None = None, timeout: float = HW_TIMEOUT) -> Any:
        if not self.connected or self._send is None:
            raise HardwareError(NOT_CONNECTED)
        rid = f"hw{next(self._ids)}"
        fut: asyncio.Future = asyncio.get_running_loop().create_future()
        self._pending[rid] = fut
        try:
            await self._send({"type": "hw.request", "id": rid, "op": op, "params": params or {}, "timeout_ms": int(timeout * 1000)})
            return await asyncio.wait_for(fut, timeout)
        except asyncio.TimeoutError:
            await self._cancel_ids([rid])
            raise HardwareError(f"Hardware request '{op}' timed out after {timeout:.0f}s.")
        finally:
            self._pending.pop(rid, None)

    def handle_response(self, msg: dict[str, Any]) -> None:
        fut = self._pending.get(str(msg.get("id")))
        if fut is None or fut.done():
            return
        if msg.get("ok", True) and "error" not in msg:
            fut.set_result(msg.get("result"))
        else:
            fut.set_exception(HardwareError(str(msg.get("error") or "hardware error")))

    async def cancel_all(self, reason: str = "Cancelled.") -> None:
        ids = list(self._pending)
        for rid in ids:
            fut = self._pending.get(rid)
            if fut and not fut.done():
                fut.set_exception(HardwareError(reason))
        await self._cancel_ids(ids)

    async def _cancel_ids(self, ids: list[str]) -> None:
        if ids and self._send is not None:
            try:
                await self._send({"type": "hw.cancel", "ids": ids})
            except Exception:
                pass

    def fail_all(self, reason: str) -> None:
        for fut in self._pending.values():
            if not fut.done():
                fut.set_exception(HardwareError(reason))

    # -- serial ------------------------------------------------------------
    async def serial_data(self, port: str, data: bytes) -> None:
        if port in self.buffers:
            await self.buffers[port].append(data)

    def require_port(self, port: str) -> None:
        if not self.connected:
            raise HardwareError(NOT_CONNECTED)
        if port not in self.device.ports:
            if port == "data":
                raise HardwareError(
                    "No data serial port on this board. (CircuitPython: enable it in boot.py with "
                    "usb_cdc.enable(console=True, data=True) and reset.)"
                )
            raise HardwareError("REPL serial port is not open.")

    async def acquire(self, port: str) -> None:
        if self.lock_owner.get(port) != "agent":
            self.lock_owner[port] = "agent"
            if self.on_lock_change:
                await self.on_lock_change()

    async def release_all(self) -> None:
        changed = any(v is not None for v in self.lock_owner.values())
        self.lock_owner = {p: None for p in PORTS}
        if changed and self.on_lock_change:
            await self.on_lock_change()

    async def write(self, port: str, data: str) -> int:
        """Write to a serial port as the agent; returns the cursor at write time."""
        self.require_port(port)
        await self.acquire(port)
        cursor = self.buffers[port].end
        await self.request("serial.write", {"port": port, "data": data})
        return cursor
