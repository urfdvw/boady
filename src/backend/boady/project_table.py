"""Persistent project table, stored in the backend data directory.

Each entry: ``{id, name, dir, type, session_id, board_uid, mpy_version,
created_at, last_opened}``. ``type`` is only a cache of the project's
``boady.json``; ``session_id`` is created with the project and never changes.
"""

from __future__ import annotations

import time
import uuid
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

from .util import read_json, write_json


@dataclass
class Project:
    id: str
    name: str
    dir: str
    type: str
    session_id: str
    board_uid: str | None = None
    board: str | None = None  # cache of boady.json "board": "usb" | "rp2040js"
    mpy_version: int | None = None
    created_at: float = field(default_factory=time.time)
    last_opened: float | None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @property
    def path(self) -> Path:
        return Path(self.dir)


class ProjectTable:
    def __init__(self, file: Path):
        self.file = file
        self._projects: dict[str, Project] = {}
        self.load()

    def load(self) -> None:
        data = read_json(self.file, {"projects": []})
        self._projects = {}
        for raw in data.get("projects", []):
            known = {k: raw[k] for k in Project.__dataclass_fields__ if k in raw}
            p = Project(**known)
            self._projects[p.id] = p

    def save(self) -> None:
        write_json(self.file, {"projects": [p.to_dict() for p in self._projects.values()]}, mode=0o600)

    def all(self) -> list[Project]:
        return sorted(self._projects.values(), key=lambda p: -(p.last_opened or p.created_at))

    def get(self, project_id: str) -> Project | None:
        return self._projects.get(project_id)

    def by_name(self, name: str) -> Project | None:
        return next((p for p in self._projects.values() if p.name == name), None)

    def by_uid(self, uid: str) -> list[Project]:
        return [p for p in self._projects.values() if p.board_uid == uid]

    def add(self, name: str, dir: Path, type: str) -> Project:
        p = Project(
            id=uuid.uuid4().hex[:12],
            name=name,
            dir=str(dir),
            type=type,
            session_id=str(uuid.uuid4()),
        )
        self._projects[p.id] = p
        self.save()
        return p

    def update(self, project_id: str, **changes: Any) -> Project:
        p = self._projects[project_id]
        for k, v in changes.items():
            if k in ("id", "session_id", "dir"):
                raise ValueError(f"{k} is immutable")
            setattr(p, k, v)
        self.save()
        return p

    def remove(self, project_id: str) -> Project | None:
        p = self._projects.pop(project_id, None)
        self.save()
        return p
