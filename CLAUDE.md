# boady — working agreement for agents

## Spec first

- Before any task, read `Specs/specs.md` (the single source of truth) and `Specs/additional_specs.md` (decisions made during implementation).
- If the implementation would conflict with the spec, follow the spec or propose a spec change first. Never deviate silently.
- Record every technical or design decision made during plan review or in prompts in `Specs/additional_specs.md`; merge important ones back into `specs.md` periodically.
- Items marked "需主人" in the spec's pending list must be asked; others: choose, then record the choice and reason.
- Check unfamiliar library APIs and version behaviour in official docs or source before using them.

## Tech debt — check at the start of every session

Workarounds for problems that belong upstream. **At the start of every session**, check each item's upstream status with the command given (no `gh` needed). If an item is resolved upstream, tell Master, remove the workaround in its own commit, and delete the row. Add a row whenever a new upstream workaround is introduced.

| Workaround in boady | Upstream item | Check | Resolved when |
| --- | --- | --- | --- |
| `src/web/vendor/rp2040js/` (vendored source, see its `VENDOR.md` and `boady-changes.patch`) carries PR #156 (SSI flash write emulation) so the emulated Pico can write its filesystem | wokwi/rp2040js PR #156 | `curl -s https://api.github.com/repos/wokwi/rp2040js/pulls/156 \| python3 -c "import json,sys;d=json.load(sys.stdin);print(d['state'],d['merged_at'])"`; where api.github.com is blocked (cloud sessions): `git ls-remote --tags https://github.com/wokwi/rp2040js` — a tag newer than `v1.4.2` is a new release whose changelog must be checked for the flash write emulation | merged and in a released rp2040js version |
| Same patch adds flash READ_UNIQUE_ID (`0x4B`), so the emulated board has a UID | not filed yet (rp2040js `src/peripherals/ssi.ts`) | `curl -s https://raw.githubusercontent.com/wokwi/rp2040js/main/src/peripherals/ssi.ts \| grep -ci unique` | upstream SSI answers `0x4B` |
| Emulator sets `qspi[1].padValue = 0x5a` and drives QSPI_SS high before boot, or CircuitPython hangs reading BOOTSEL (rp2040js pad reset value lacks IE; flash pull-up not modelled) | not filed yet (rp2040js `src/gpio-pin.ts` `padValue`) | `curl -s https://raw.githubusercontent.com/wokwi/rp2040js/main/src/gpio-pin.ts \| grep -n "padValue: number"` | pad reset values follow the datasheet and QSPI_SS idles high |
| `GPIOPin.inputValue` in the vendored rp2040js reads the pad level (`padLevel`), so firmware reading back its own output pin gets it (upstream reads only the outside value: CircuitPython `p.value = not p.value` never toggles) | not filed yet (rp2040js `src/gpio-pin.ts` `get inputValue`) | `curl -s https://raw.githubusercontent.com/wokwi/rp2040js/main/src/gpio-pin.ts \| grep -n -A3 "get inputValue"` | upstream's `inputValue` takes the output into account when the output is enabled |
| Library installs call mpremote's internal `mip._install_package` (pinned `mpremote==1.29.0`) | micropython `tools/mpremote/mpremote/mip.py` (internal API) | `pip index versions mpremote` and re-run `src/backend/tests/test_libraries.py` against a newer mpremote | a public API exists, or a newer version passes the tests (then bump the pin) |

## Layout

```
run.py                  start the backend (serves dist/web)
src/backend/boady/      Python shell: aiohttp WebSocket server, Agent SDK sessions, MCP tools, git, sync
src/backend/tests/      pytest suite
src/web/                React frontend (Vite + TypeScript); src/web/src/hw/ = Web Serial, raw REPL, MSC, sync
src/prompts/            ALL prompt text (.md): system prompts, project CLAUDE.md templates, one-shot tasks
src/shared/             data read by both backend and frontend (sync_exclude.json: files never synced)
src/android/            APK shell (phase 5)
dist/web/               built frontend — committed; it is the release
```

Prompts are files under `src/prompts/`; code only references them, never inline prompt strings.

## Build and test

```bash
pip install -r src/backend/requirements-dev.txt
cd src/backend && python -m pytest -q
cd src/web && npm ci && npm test && npm run build    # build writes ../../dist/web
python run.py -v                                     # http://127.0.0.1:8765/#token=...
```

Web tests: `npm test` runs everything (about 4 min, mostly the emulated Pico); `npm run test:fast` skips the emulator; `npm run test:emu` runs only the emulator tests. `npm run typecheck` also checks the vendored rp2040js with its own settings. Component tests render React in happy-dom: start the test file with `// @vitest-environment happy-dom` (see `src/tabs/EmulatorTab.test.tsx`); all other tests run in Node.

End to end without hardware, with real Claude: start a backend, then in `src/web`
`BOADY_E2E_TYPE=circuitpython npm run e2e:emu` (or `micropython`; add `BOADY_E2E_PROMPT="..."` for a chat turn and `BOADY_E2E_EXPECT="..."` for text the board must print; approvals are denied unless listed in `BOADY_E2E_APPROVE`, e.g. `mcp__boady__sync_to_device` or `all`; `BOADY_URL` / `BOADY_TOKEN` for a non-default backend). It uses or creates the project `e2e-<type>`, and fails if identification, the pull on connect, the turn or the expected output fails.

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
