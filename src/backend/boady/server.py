"""aiohttp server: the single WebSocket (``/ws``) and the built frontend (``dist/web``).

Binds to localhost only. The first frame on a socket must be ``hello`` carrying
the pairing token; anything else closes the socket.
"""

from __future__ import annotations

import asyncio
import json
import logging
from pathlib import Path

from aiohttp import WSMsgType, web

from .app import App, Connection, dumps
from .config import WEB_DIST_DIR

log = logging.getLogger("boady.server")

# message types handled in their own task (may run long, e.g. clone/push)
CONCURRENT = ("action", "project.")
BOADY_KEY = web.AppKey("boady", App)


async def ws_handler(request: web.Request) -> web.WebSocketResponse:
    app: App = request.app[BOADY_KEY]
    ws = web.WebSocketResponse(heartbeat=20, max_msg_size=64 * 1024 * 1024)
    await ws.prepare(request)
    send_lock = asyncio.Lock()

    async def send(msg: dict) -> None:
        async with send_lock:
            if not ws.closed:
                await ws.send_str(dumps(msg))

    conn = Connection(send, ws.close)
    tasks: set[asyncio.Task] = set()
    try:
        try:
            first = await ws.receive(timeout=30)
        except asyncio.TimeoutError:
            await ws.close()
            return ws
        if first.type != WSMsgType.TEXT:
            await ws.close()
            return ws
        try:
            hello = json.loads(first.data)
        except json.JSONDecodeError:
            await ws.close()
            return ws
        if not await app.authenticate(conn, hello):
            await ws.close()
            return ws
        async for raw in ws:
            if raw.type != WSMsgType.TEXT:
                continue
            if app.conn is not conn:
                break
            try:
                msg = json.loads(raw.data)
            except json.JSONDecodeError:
                continue
            t = str(msg.get("type", ""))
            if t.startswith(CONCURRENT):
                task = asyncio.create_task(app.handle(msg, conn))
                tasks.add(task)
                task.add_done_callback(tasks.discard)
            else:
                await app.handle(msg, conn)
    finally:
        await app.disconnected(conn)
    return ws


def make_app(boady: App, web_dir: Path = WEB_DIST_DIR) -> web.Application:
    wapp = web.Application()
    wapp[BOADY_KEY] = boady
    wapp.router.add_get("/ws", ws_handler)

    async def index(_req: web.Request) -> web.StreamResponse:
        f = web_dir / "index.html"
        if not f.exists():
            return web.Response(text="Frontend not built: run `npm run build` in src/web.", status=503)
        return web.FileResponse(f, headers={"Cache-Control": "no-cache"})

    wapp.router.add_get("/", index)
    if (web_dir / "assets").is_dir():
        wapp.router.add_static("/assets/", web_dir / "assets")

    async def on_shutdown(a: web.Application) -> None:
        await boady.close_project()

    wapp.on_shutdown.append(on_shutdown)
    return wapp
