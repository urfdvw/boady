#!/usr/bin/env python3
"""Start the boady backend; it also serves the frontend from dist/web.

    .venv/bin/python run.py [--port 8765] [--show-token] [--reset-token] [-v]
"""

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / "src" / "backend"))

try:
    import aiohttp  # noqa: F401
    import claude_agent_sdk  # noqa: F401
except ImportError as e:
    sys.exit(
        f"Missing dependency ({e.name}). Install into a virtual environment and start with its Python:\n"
        f"  python3 -m venv {ROOT / '.venv'}\n"
        f"  {ROOT / '.venv/bin/pip'} install -r {ROOT / 'src/backend/requirements.txt'}\n"
        f"  {ROOT / '.venv/bin/python'} {ROOT / 'run.py'}"
    )

from boady.__main__ import main  # noqa: E402

if __name__ == "__main__":
    main()
