# boady — working agreement for agents

## Spec first

- Before any task, read `Specs/specs.md` (the single source of truth) and `Specs/additional_specs.md` (decisions made during implementation).
- If the implementation would conflict with the spec, follow the spec or propose a spec change first. Never deviate silently.
- Record every technical or design decision made during plan review or in prompts in `Specs/additional_specs.md`; merge important ones back into `specs.md` periodically.
- Items marked "需主人" in the spec's pending list must be asked; others: choose, then record the choice and reason.
- Check unfamiliar library APIs and version behaviour in official docs or source before using them.

## Layout

```
run.py                  start the backend (serves dist/web)
src/backend/boady/      Python shell: aiohttp WebSocket server, Agent SDK sessions, MCP tools, git, sync
src/backend/tests/      pytest suite
src/web/                React frontend (Vite + TypeScript); src/web/src/hw/ = Web Serial, raw REPL, MSC, sync
src/prompts/            ALL prompt text (.md): system prompts, project CLAUDE.md templates, one-shot tasks
src/android/            APK shell (phase 5)
dist/web/               built frontend — committed; it is the release
```

Prompts are files under `src/prompts/`; code only references them, never inline prompt strings.

## Build and test

```bash
python3 -m venv .venv                                # git-ignored
.venv/bin/pip install -r src/backend/requirements-dev.txt
cd src/backend && ../../.venv/bin/python -m pytest -q
cd src/web && npm ci && npm test && npm run build    # build writes ../../dist/web
.venv/bin/python run.py -v                           # http://127.0.0.1:8765/#token=...
```

During frontend work `npm run dev` in `src/web` proxies `/ws` to a backend on port 8765.

## Release

Every release rebuilds `dist/` (`npm run build`) and commits it. No GitHub Releases. Users upgrade with `git pull` and a restart. The APK signing key lives in the project directory but is git-ignored and must be backed up separately.

## At the end of every phase

Rebuild and commit `dist/`; update README.md (user guide) and this file (build/test steps); write automated tests for logic that does not need hardware and a manual checklist for what does; report what was done, which decisions went into `additional_specs.md`, and what Master has to test on real hardware.

## References

- Claude Agent SDK (Python): https://docs.claude.com/en/docs/agent-sdk/python — source: https://github.com/anthropics/claude-agent-sdk-python
- CircuitPython: https://docs.circuitpython.org/en/latest/
- MicroPython: https://docs.micropython.org/en/latest/
- mpremote: https://docs.micropython.org/en/latest/reference/mpremote.html — source: https://github.com/micropython/micropython/tree/master/tools/mpremote
- circup: https://github.com/adafruit/circup
- usb-serial-for-android: https://github.com/mik3y/usb-serial-for-android
- Web Serial API: https://developer.mozilla.org/docs/Web/API/Web_Serial_API — https://wicg.github.io/serial/
