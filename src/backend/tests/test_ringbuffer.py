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
