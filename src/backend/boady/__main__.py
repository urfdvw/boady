"""Entry point: ``python -m boady`` (normally started by run.py)."""

from __future__ import annotations

import argparse
import logging

from aiohttp import web

from .app import App
from .config import DEFAULT_HOST, DEFAULT_PORT, default_paths
from .server import make_app


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(prog="boady")
    ap.add_argument("--port", type=int, default=DEFAULT_PORT)
    ap.add_argument("--show-token", action="store_true", help="print the pairing token and exit")
    ap.add_argument("--reset-token", action="store_true", help="generate a new pairing token and exit")
    ap.add_argument("-v", "--verbose", action="store_true")
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")

    paths = default_paths()
    if args.reset_token:
        from .pairing import reset_token

        paths.ensure()
        print(reset_token(paths.token_file))
        return
    app = App(paths)
    if args.show_token:
        print(app.token)
        return
    url = f"http://{DEFAULT_HOST}:{args.port}/"
    print(f"boady backend: {url}")
    print(f"Pairing code: {app.token}")
    print(f"Open on this device: {url}#token={app.token}")
    web.run_app(make_app(app), host=DEFAULT_HOST, port=args.port, print=None)


if __name__ == "__main__":
    main()
