"""Per-port serial ring buffer with monotonic byte cursors.

Reading never clears the buffer. A cursor is the absolute byte position of the
stream since the backend started; old bytes are evicted when the buffer is full.
"""

from __future__ import annotations

import asyncio
import codecs
import itertools
from dataclasses import dataclass


@dataclass
class ReadResult:
    text: str
    cursor: int  # new cursor: position after the returned text
    start: int  # position of the first returned byte
    truncated: bool  # requested data was already evicted
    matched: bool | None  # wait_for found (None if not requested)
    match: str | None = None  # which wait_for alternative appeared first in the stream

    def to_dict(self) -> dict:
        return {
            "text": self.text,
            "cursor": self.cursor,
            "start": self.start,
            "truncated": self.truncated,
            "matched": self.matched,
            "match": self.match,
        }


def _complete_utf8(data: bytes) -> int:
    """Length of ``data`` without a trailing UTF-8 character that may still be completed.

    The standard incremental decoder decides: it keeps back only bytes that a following
    byte could still turn into a valid character; invalid ones (``C0``, ``C1``, ``F5``,
    ``E0 80`` ...) are decoded at once as replacement characters (review 17)."""
    dec = codecs.getincrementaldecoder("utf-8")("replace")
    dec.decode(data, final=False)
    held = dec.getstate()[0]
    # the decoder also holds a few prefixes no byte can complete (ED A0 = a surrogate)
    return len(data) - len(held) if held and _completable(held) else len(data)


def _completable(prefix: bytes) -> bool:
    """Whether some continuation bytes turn ``prefix`` into a valid UTF-8 character."""
    for extra in range(1, 5 - len(prefix)):
        for tail in itertools.product((0x80, 0x8F, 0x90, 0x9F, 0xA0, 0xBF), repeat=extra):
            try:
                (prefix + bytes(tail)).decode("utf-8")
                return True
            except UnicodeDecodeError:
                pass
    return False


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
        wait_for: str | list[str] | None = None,
        timeout_ms: int = 0,
    ) -> ReadResult:
        """``wait_for``: a text, or several alternatives (returns when any appears;
        ``match`` says which one came first)."""
        matched: bool | None = None
        match: str | None = None
        needles = [w for w in ([wait_for] if isinstance(wait_for, str) else (wait_for or [])) if w]
        if needles:
            origin = since if since is not None else self._start

            def first() -> str | None:
                lo = max(origin, self._start) - self._start
                hits = [(i, w) for w in needles if (i := self._buf.find(w.encode(), lo)) >= 0]
                return min(hits)[1] if hits else None

            async with self._cond:
                try:
                    await asyncio.wait_for(self._cond.wait_for(lambda: first() is not None), max(timeout_ms, 0) / 1000)
                except asyncio.TimeoutError:
                    pass
                match = first()
                matched = match is not None
        data, start, truncated = self._slice(since, tail)
        if start + len(data) == self.end:
            # a character whose bytes have not all arrived stays for the next read: the
            # cursor stops before it (review 16: "你好" read in two parts gave "���好")
            data = data[: _complete_utf8(data)]
        return ReadResult(data.decode("utf-8", errors="replace"), start + len(data), start, truncated, matched, match)

    def clear(self) -> None:
        self._start = self.end
        self._buf.clear()
