from __future__ import annotations

import asyncio
import os
from dataclasses import dataclass
from pathlib import Path


@dataclass
class ProcResult:
    code: int
    stdout: str
    stderr: str

    @property
    def ok(self) -> bool:
        return self.code == 0


class ProcError(RuntimeError):
    def __init__(self, cmd: list[str], result: ProcResult):
        msg = (result.stderr or result.stdout).strip() or f"exit code {result.code}"
        super().__init__(f"{cmd[0]}: {msg}")
        self.result = result


async def run(
    cmd: list[str],
    cwd: Path | str | None = None,
    check: bool = False,
    env: dict[str, str] | None = None,
    timeout: float | None = 300,
    stdin: str | None = None,
) -> ProcResult:
    full_env = dict(os.environ)
    full_env.setdefault("GIT_TERMINAL_PROMPT", "0")
    if env:
        full_env.update(env)
    p = await asyncio.create_subprocess_exec(
        *cmd,
        cwd=str(cwd) if cwd else None,
        stdin=asyncio.subprocess.PIPE if stdin is not None else asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        env=full_env,
    )
    try:
        out, err = await asyncio.wait_for(
            p.communicate(stdin.encode() if stdin is not None else None), timeout
        )
    except asyncio.TimeoutError:
        p.kill()
        await p.wait()
        raise
    res = ProcResult(p.returncode or 0, out.decode(errors="replace"), err.decode(errors="replace"))
    if check and not res.ok:
        raise ProcError(cmd, res)
    return res
