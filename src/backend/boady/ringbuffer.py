"""Per-port serial ring buffer with monotonic byte cursors.

Reading never clears the buffer. A cursor is the absolute byte position of the
stream since the backend started; old bytes are evicted when the buffer is full.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass


@dataclass
class ReadResult:
    text: str
    cursor: int  # new cursor: position after the returned text
    start: int  # position of the first returned byte
    truncated: bool  # requested data was already evicted
    matched: bool | None  # wait_for found (None if not requested)

    def to_dict(self) -> dict:
        return {
            "text": self.text,
            "cursor": self.cursor,
            "start": self.start,
            "truncated": self.truncated,
            "matched": self.matched,
        }


class RingBuffer:
    def __init__(self, capacity: int):
        self.capacity = capacity
        self._buf = bytearray()
        self._start = 0  # absolute position of _buf[0]
        self._cond = asyncio.Condition()

    @property
    def end(self) -> int:
        return self._start + len(self._buf)

    async def append(self, data: bytes) -> None:
        async with self._cond:
            self._buf += data
            overflow = len(self._buf) - self.capacity
            if overflow > 0:
                del self._buf[:overflow]
                self._start += overflow
            self._cond.notify_all()

    def _slice(self, since: int | None, tail: int | None) -> tuple[bytes, int, bool]:
        truncated = False
        if since is None:
            start = self._start
        elif since < self._start:
            start, truncated = self._start, True
        else:
            start = min(since, self.end)
        data = bytes(self._buf[start - self._start:])
        if tail is not None and tail >= 0:
            lines = data.split(b"\n")
            # a trailing newline gives an empty last element; keep it attached
            keep = tail + 1 if data.endswith(b"\n") else tail
            if len(lines) > keep:
                dropped = b"\n".join(lines[: len(lines) - keep]) + b"\n"
                start += len(dropped)
                data = data[len(dropped):]
        return data, start, truncated

    async def read(
        self,
        since: int | None = None,
        tail: int | None = None,
        wait_for: str | None = None,
        timeout_ms: int = 0,
    ) -> ReadResult:
        matched: bool | None = None
        if wait_for:
            needle = wait_for.encode()
            origin = since if since is not None else self._start

            def found() -> bool:
                lo = max(origin, self._start) - self._start
                return self._buf.find(needle, lo) >= 0

            async with self._cond:
                try:
                    await asyncio.wait_for(self._cond.wait_for(found), max(timeout_ms, 0) / 1000)
                    matched = True
                except asyncio.TimeoutError:
                    matched = found()
        data, start, truncated = self._slice(since, tail)
        return ReadResult(data.decode("utf-8", errors="replace"), start + len(data), start, truncated, matched)

    def clear(self) -> None:
        self._start = self.end
        self._buf.clear()
