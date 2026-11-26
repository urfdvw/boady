import asyncio

from boady.ringbuffer import RingBuffer


async def test_cursor_and_since():
    rb = RingBuffer(1024)
    await rb.append(b"old Traceback\n>>> ")
    cursor = rb.end
    await rb.append(b"hello\n>>> ")
    r = await rb.read(since=cursor)
    assert r.text == "hello\n>>> "
    assert r.cursor == rb.end
    # reading does not clear
    r2 = await rb.read()
    assert r2.text.startswith("old Traceback")


async def test_tail():
    rb = RingBuffer(1024)
    await rb.append(b"a\nb\nc\nd\n")
    assert (await rb.read(tail=2)).text == "c\nd\n"
    await rb.append(b"e")
    assert (await rb.read(tail=2)).text == "d\ne"


async def test_eviction_truncated():
    rb = RingBuffer(10)
    await rb.append(b"0123456789")
    await rb.append(b"abcde")
    r = await rb.read(since=0)
    assert r.truncated and r.text == "56789abcde" and r.start == 5


async def test_wait_for():
    rb = RingBuffer(1024)
    cursor = rb.end

    async def later():
        await asyncio.sleep(0.05)
        await rb.append(b"Code done running.\n")

    asyncio.create_task(later())
    r = await rb.read(since=cursor, wait_for="done running", timeout_ms=2000)
    assert r.matched is True and "done" in r.text


async def test_wait_for_timeout():
    rb = RingBuffer(1024)
    r = await rb.read(wait_for=">>>", timeout_ms=50)
    assert r.matched is False


async def test_wait_for_ignores_text_before_since():
    rb = RingBuffer(1024)
    await rb.append(b">>> ")
    r = await rb.read(since=rb.end, wait_for=">>>", timeout_ms=50)
    assert r.matched is False


async def test_wait_for_alternatives_returns_the_first_that_appears():
    """Review 10, prompt 2: CircuitPython after Ctrl-C shows either "Press any key" or >>>."""
    rb = RingBuffer(1000)
    await rb.append(b"old >>> ")
    task = asyncio.create_task(rb.read(since=rb.end, wait_for=["Press any key", ">>> "], timeout_ms=2000))
    await asyncio.sleep(0.01)
    await rb.append(b"KeyboardInterrupt\r\nPress any key to enter the REPL. Use CTRL-D to reload.\r\n")
    r = await task
    assert r.matched is True and r.match == "Press any key" and r.to_dict()["match"] == "Press any key"
    r = await rb.read(since=0, wait_for=["nope", ">>> "], timeout_ms=0)
    assert r.match == ">>> "
    r = await rb.read(since=0, wait_for=["nope"], timeout_ms=10)
    assert r.matched is False and r.match is None


async def test_a_character_split_across_packets_is_read_whole():
    """Review 16, finding 2: reading between the bytes of one character lost it."""
    rb = RingBuffer(1000)
    data = "你好".encode()
    await rb.append(data[:1])
    r1 = await rb.read(since=0)
    assert r1.text == "" and r1.cursor == 0  # nothing complete yet; the cursor waits before it
    await rb.append(data[1:4])
    r2 = await rb.read(since=r1.cursor)
    assert r2.text == "你" and r2.cursor == 3
    await rb.append(data[4:] + b">>> ")
    r3 = await rb.read(since=r2.cursor)
    assert r1.text + r2.text + r3.text == "你好>>> "
    await rb.append("é".encode()[:1])
    assert (await rb.read(since=r3.cursor)).text == ""
    await rb.append(b"\xff")  # not UTF-8 at all: returned (replaced), never held forever
    assert (await rb.read(since=r3.cursor)).text.endswith("�")



async def test_bytes_that_can_never_be_a_character_are_returned_at_once():
    """Review 17: invalid UTF-8 lead bytes were held back forever (cursor stuck)."""
    for bad in (b"\xc0", b"\xc1", b"\xf5", b"\xe0\x80", b"\xed\xa0", b"\xff", b"\x80"):
        rb = RingBuffer(100)
        await rb.append(b"ok " + bad)
        r = await rb.read(since=0)
        assert r.cursor == rb.end and r.text.startswith("ok ") and "\ufffd" in r.text, (bad, r)
    for wait in (b"\xe4", b"\xe4\xbd", b"\xf0\x9f\x98", b"\xc3"):  # can still be completed: held
        rb = RingBuffer(100)
        await rb.append(b"ok " + wait)
        r = await rb.read(since=0)
        assert r.text == "ok " and r.cursor == 3, (wait, r)
