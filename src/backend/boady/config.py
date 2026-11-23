"""Paths and constants for the boady backend.

All backend state lives in the data directory (``BOADY_HOME``, default
``~/.boady``), never inside a project repository.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
PROMPTS_DIR = REPO_ROOT / "src" / "prompts"
SKELETON_DIR = Path(__file__).resolve().parent / "skeleton"
WEB_DIST_DIR = REPO_ROOT / "dist" / "web"

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8765

PROJECT_TYPES = ("circuitpython", "micropython")

# hw.request default timeout (seconds)
HW_TIMEOUT = 30.0
# Ring buffer size per serial port (bytes)
SERIAL_BUFFER_BYTES = 256 * 1024


@dataclass(frozen=True)
class Paths:
    home: Path

    @property
    def projects_dir(self) -> Path:
        return self.home / "projects"

    @property
    def table_file(self) -> Path:
        return self.home / "projects.json"

    @property
    def token_file(self) -> Path:
        return self.home / "token"

    @property
    def prefs_file(self) -> Path:
        return self.home / "prefs.json"

    @property
    def claude_token_file(self) -> Path:
        return self.home / "claude_oauth_token"

    @property
    def audit_log(self) -> Path:
        return self.home / "audit.log"

    def ensure(self) -> None:
        self.home.mkdir(parents=True, exist_ok=True)
        os.chmod(self.home, 0o700)
        self.projects_dir.mkdir(parents=True, exist_ok=True)


def default_paths() -> Paths:
    home = os.environ.get("BOADY_HOME") or str(Path.home() / ".boady")
    return Paths(Path(home).expanduser().resolve())
