"""Pairing token: generated at install / first start, 192 random bits, file mode 600."""

from __future__ import annotations

import hmac
import secrets
from pathlib import Path

from .util import atomic_write_text


def load_or_create_token(path: Path) -> str:
    try:
        token = path.read_text(encoding="utf-8").strip()
        if token:
            return token
    except FileNotFoundError:
        pass
    return reset_token(path)


def reset_token(path: Path) -> str:
    token = secrets.token_urlsafe(24)  # 192 bits
    atomic_write_text(path, token + "\n", mode=0o600)
    return token


def check_token(expected: str, given: object) -> bool:
    if not isinstance(given, str) or not given:
        return False
    return hmac.compare_digest(expected.encode(), given.encode())
