# boady — additional specs

Technical and design decisions made during implementation (spec「交接说明」). `specs.md` stays the single source of truth; where this file and `specs.md` disagree, `specs.md` wins and this file must be fixed.

## Status

| Phase | State |
| --- | --- |
| Pre-check (needs Master) | **Done 2026-11-23.** Web Serial fails in Chrome on the Pixel 10 Pro; resolved by Master's decision D18 (Android Chrome is an untested bonus; on Android only the app is tested). Still open: `claude setup-token` untested (item 5). |
| Phase 1: backend & chat | Implemented, automated tests pass, acceptance run done in desktop Chromium (create project → chat → approval → diff → commit → backend restart → session resumed). |
| Phase 2: CircuitPython | Runs on real hardware (Master, 2026-11-24, Seeed XIAO nRF52840 Sense, CircuitPython 10.2.0). Master has UI-detail complaints, to be handled in a usability pass before the APK. |
| Phase 3: MicroPython | Implemented; automated tests pass; a real `mip` install from micropython.org into a mirror works. **Acceptance on a MicroPython board not done** — needs Master (checklist below). |
| Usability pass | Next, before the APK (Master, 2026-11-24). |
| Emulator (D36) | Implemented and verified on both firmwares, in Node tests, with real Claude end to end, and in headless Chrome. |
| Phase 4–5 | Not started. |

Phase 1 does not depend on any pre-check result (desktop, no hardware), so it was built first.

## Decisions

**D1 — Spec file name.** The spec calls itself `Specs/specs.md`; the committed file was `Specs/Specs.md`. Renamed to match the spec text.

**D2 — Session id lifecycle.** A UUID is generated when the project is created or cloned and stored in the project table immediately. The first connect passes it as `session_id`; once a transcript exists (`get_session_info` / `get_session_messages` find it for the project directory) every connect uses `resume=<id>`. Existence is detected from the transcript, not from a flag, so a crash between "created" and "first message" cannot desync the two. Verified against the real CLI: the session survived a backend restart and the agent remembered the earlier turn.

**D3 — Bash: whitelist, not full wrapping (待定 item).** Bash stays available but a PreToolUse hook hard-denies everything except single commands (no `; & | \` $( > <` or newlines):
- `git <subcommand>` from a fixed list; no global options (`-C`, `-c`), no `git config` writes (could install aliases/hooks that run code).
- `circup ... --path src` (the path must resolve to the project's `src/`).
- `mpremote` is denied: the backend never reaches the board. MicroPython packages will be installed through a boady MCP tool (`install_library`, phase 3) that calls `mip._install_package` with a mirror transport, as the spec describes.

`can_use_tool` then auto-allows read-only git (`status diff log show blame ls-files rev-parse shortlog`, bare `branch`, `config --get`) and circup `install update uninstall list freeze show`; every other git command (commit, reset, push, checkout, …) asks the user. Any argument pointing outside the project also asks. Writing inside `.git/` is hard-blocked for Edit/Write. Rules live in `src/backend/boady/permissions.py` and are unit-tested.

**D4 — No filesystem settings; CLAUDE.md injected.** Sessions run with `setting_sources=[]` so a cloned repository's `.claude/settings.json` cannot add hooks or permission rules (that would bypass D3). Because the SDK only loads CLAUDE.md through the `project` setting source, the backend appends the project's `CLAUDE.md` to the system prompt itself at every session start. System prompt = Claude Code preset + `src/prompts/system/common.md` + `src/prompts/system/<type>.md` + project `CLAUDE.md`.

**D5 — Permission flow.** `permission_mode="default"`; tools limited to Read, Edit, Write, Glob, Grep, Bash, TodoWrite and the boady MCP tools (`strict_mcp_config`). File tools inside the project are allowed, outside ask. MCP: `sync_to_device` asks, the others are allowed. Pending approvals are denied automatically on interrupt, turn end and project close. Every tool call is appended to `$BOADY_HOME/audit.log` by the PreToolUse hook.

**D6 — Protocol details.** JSON text frames on `/ws`.
- First frame must be `{"type":"hello","token","mode":"browser|apk|nohw","hw":{"serial","msc"}}` (the spec's `hello` / `auth` are one frame). Reply `hello.ok {version}` or `hello.error {reason}` + close. A newly authenticated frontend replaces the old one, which receives `{"type":"replaced"}` and is closed.
- After `hello.ok` the backend sends `state`, then `agent_event {kind:"history", items, running, partial}`, then every pending `permission_request`, then `project.select_required` if one is pending.
- `state`: `{version, prefs, projects[], project, device, serial:{lock:{repl,data}}, agent:{running}, auth, tree[], git:{status[], log[], remotes[]}}` — always a full snapshot.
- `agent_event` kinds: `history`, `item` (`user | assistant | tool_use | tool_result | permission | notice`), `delta` (streamed text), `turn_start`, `turn_end {result}`, `permission_resolved {request_id, allowed}`.
- `permission_request {request_id, kind:"tool", tool, input, tool_use_id}` or `{request_id, kind:"confirm", what, detail}`; reply `permission_reply {request_id, allow, message?}`.
- `action {id, action, params}` → `action.result {id, ok, result | error}`. Actions: `project.create {name,type,github?}`, `project.clone {url}`, `project.select {id}`, `project.delete {id, confirm:true}`, `project.close`, `file.read {path}`, `file.write {path,text}`, `git.diff {path?}`, `git.commit {message}`, `git.reset_file {path}`, `git.reset_all {confirm:true}`, `git.push`, `git.create_remote`, `device.pull`, `device.push`, `prefs.set {language}`, `pairing.reset`, `auth.status`, `state.refresh`.
- Hardware: `hw.request {id, op, params, timeout_ms}` → `hw.response {id, ok, result | error}`; `hw.cancel {ids}`. `serial.data {port:"repl"|"data", b64}`. `device.attached {usb, ports}` / `device.detached`.
- Error codes the UI translates: `invalid_name`, `name_taken`, `invalid_type`, `invalid_url`, `no_project`, `boady_json_missing`, `project_dir_missing`; anything else is shown verbatim.

**D7 — MCP tool JSON.** Results are a JSON text block; errors set `is_error` with `{"error": "..."}`.
- `read_repl` / `read_data {since?, tail?, wait_for?, timeout_ms?}` → `{text, cursor, start, truncated, matched}`. `cursor` = position after the returned text; `truncated` = requested bytes were already evicted; `matched` = `null` without `wait_for`. `wait_for` only looks at text after `since`.
- `write_repl` / `write_data {data}` → `{cursor}` (stream position at write time). Literal `\x01`–`\x04` in `data` become Ctrl-A–D; real control characters pass through.
- `sync_from_device {}` → `{added[], modified[], deleted[]}` or error `User declined.`
- `sync_to_device {}` → `{written[], deleted[]}`.
- Not connected → `Device not connected.`; missing data port → a message explaining `usb_cdc.enable(console=True, data=True)`.

**D8 — Serial write lock.** The agent takes a port's write lock at its first write and keeps it until the turn ends or is interrupted, so the user cannot type into the middle of a test sequence. `state.serial.lock` tells the console to go read-only.

**D9 — Sync wire ops (frontend implements in phase 2).** Hash = SHA-256 of file bytes. `fs.read_all {}` → `{files: {path: base64}}`; `fs.plan {manifest: {path: sha256}}` → `{need: [path], delete: [path]}`; `fs.apply {files: {path: base64}, delete: [path]}` → `{written, deleted}`. The backend excludes OS junk (`.DS_Store`, `._*`, `.Trashes`, `.fseventsd`, `.Spotlight-V100`, `System Volume Information`, `Thumbs.db`) and the root `/.boady_id` in both directions and refuses paths escaping `src/`. Before a pull the backend asks the user (permission card, `what:"pull_overwrites"`) if `src/` has uncommitted changes.

**D10 — Creating and cloning.** New project: skeleton (boady.json, CLAUDE.md from `src/prompts/project_claude_md/<type>.md`, DESIGN.md, README.md, src/CIRCUIT.md, src/code.py or src/main.py), `git init -b main`, and one initial commit "Create boady project" as part of creating the repository (otherwise reset has nothing to return to). The user's git identity is used; `boady <boady@localhost>` only if none is configured. Optional `gh repo create <name> --private --source . --push`. Clone: if `boady.json` is missing a one-shot agent (Read/Glob/Grep inside the repo only, prompt `src/prompts/tasks/classify_clone.md`) answers `{"type": circuitpython|micropython|reject, reason}`; on reject the clone is deleted. A `boady.json` written this way is left uncommitted (git stays manual). Name collisions get `-2`, `-3`, …

**D11 — Paths and pairing.** Data dir `$BOADY_HOME` (default `~/.boady`, mode 700): `projects.json` (600), `prefs.json`, `token` (600, 192-bit `token_urlsafe(24)`), `audit.log`, `claude_oauth_token` (phase 4), `projects/<name>/`. Port 8765 on 127.0.0.1. `run.py` prints the code and a link `http://127.0.0.1:8765/#token=…`; the page stores the token in localStorage and strips it from the URL. QR display comes with the install script (phase 4).

**D12 — Chat history.** Rebuilt from the Claude transcript when a project opens; streamed and live items are appended in memory. Approval cards are not part of the transcript and disappear after a backend restart.

**D13 — Frontend state.** Language is a backend preference (shared by browser and APK) with a localStorage fallback. Open tabs and the "recent" list are per-device localStorage. Orientation: landscape when the layout viewport is wider than tall; on touch devices a height-only shrink of >120 px keeps the previous orientation (soft keyboard), and in a portrait split only the pane holding focus stays visible while the keyboard is open. `interactive-widget=resizes-content` in the viewport meta.

**D14 — Stack and versions (pinned).** Backend: Python ≥3.10, claude-agent-sdk 0.2.187, aiohttp 3.14.5, circup 3.2.1, mpremote 1.29.0. Frontend: React 19.3.1, Vite 8.3.8, TypeScript 5.9.3, CodeMirror 6, lucide-react, Vitest. Tested with Claude Code CLI 2.1.330.

**D15 — Escape set.** The spec only defines `\x01`–`\x04` for `write_repl`, so the system prompts use raw REPL (Ctrl-A … Ctrl-D, Ctrl-B to leave) instead of paste mode (Ctrl-E) for running code from RAM.

**D16 — APK shell (待定).** Not decided yet; it belongs to phase 5. The adapter interfaces (`src/web/src/adapters/types.ts`) are written so that a Capacitor bridge or a hand-made WebView bridge can implement them.

**D20 — CircuitPython write access over serial: remount only as a fallback (spec deviation, needs Master's approval).** Master (2026-11-23): host write access after a serial sync does not need testing — in CircuitPython write access is either the host's or the code's. The spec says `storage.unsafe_disable_usb_drive()` and then `storage.remount("/", readonly=False)`. CircuitPython's own docs (shared-bindings/storage, `main` branch) say that after `unsafe_disable_usb_drive()` CIRCUITPY is already read/write for code, and that a `remount()` done while the drive is disabled *stays in effect after `enable_usb_drive()`*; `main.c` only resets USB write access at a hard reset. Following the spec literally would leave the drive read-only for the computer after every serial sync until the board is hard-reset, which also breaks the MSC channel. Implemented: probe `hasattr(storage, "unsafe_disable_usb_drive")` and `storage.getmount("/").readonly`; if already writable, write directly (boards without MSC); otherwise `unsafe_disable_usb_drive()`, re-check, and call `remount("/", readonly=False)` only if still read-only; after writing `enable_usb_drive()`, leave raw REPL, then Ctrl-D. Old firmware without the function returns a clear error with the offline fix (upgrade, or `storage.disable_usb_drive()` in boot.py). Write access is re-checked before every apply. Code: `src/web/src/hw/cpAccess.ts`.

**D21 — Autoreload around MSC syncs.** Checked in CircuitPython `main.c` / `supervisor/shared/reload.c`: `supervisor.runtime.autoreload` is turned on only at startup after a hard reset and otherwise keeps its value across soft reloads. So the frontend reads the old value, sets it to `False` over the raw REPL before writing through the drive, and restores the old value afterwards (re-enabling does not trigger a reload for the writes that happened while it was off). `sync_to_device` returns `restarted: false` for MSC (the program stays stopped at the REPL; the agent runs it with Ctrl-D) and `restarted: true` for serial (soft reload after the write, as the spec's step 4). The CircuitPython system prompt tells the agent how to read this flag. Risk to check on hardware: the host OS may cache drive writes; if code.py sometimes runs stale files after an MSC sync, a delay or a forced serial channel is needed.

**D22 — Which port is the REPL.** Web Serial does not expose the USB interface number, and both CDC interfaces of a CircuitPython board share VID/PID. With two granted ports, the frontend opens both, sends Ctrl-C and Enter to each, and picks the one whose answer looks like a REPL (`>>>`, `KeyboardInterrupt`, banner); the other becomes the data port. This stops the running program, which identification does anyway. Only ports of the same VID/PID as the first granted port are used (one board at a time). The data port is granted with a second "Add data port" click (Chrome shows one port per chooser).

**D23 — Safe DTR/RTS.** Every port is opened at 115200 baud and then set to DTR = RTS = asserted. Native USB CDC boards need DTR to send console output; on ESP32-style auto-reset circuits both-asserted is the no-reset state. Not verified on hardware yet (CH34x/CP210x ESP32 boards matter mostly for phase 3).

**D24 — Identification call.** One-shot `ClaudeSDKClient` in `$BOADY_HOME/identify` (not a project directory), no built-in tools, only `mcp__boady__read_repl` / `write_repl` (`permission_mode="dontAsk"` + `allowed_tools`), prompt `src/prompts/tasks/identify_board.md`. The answer line is `BOADY_ID uid=<HEX> runtime=<name> version=<x.y.z> mpy=<n|none>` (UID uppercase hex, same as `boot_out.txt`). MicroPython falls back to `/.boady_id` as the spec says. The frontend re-announces the board after every backend reconnect, so identification runs again then. Failures show in the Device tab (`identify_failed: …`).

**D25 — Board → project details.** Follows spec「连接板子时」. Additions: a project created or cloned while an identified board is connected is bound to it immediately (spec step 2, "刚新建或克隆"); opening a project that is bound to a *different* board keeps it open, shows a notice and does not pull; for an unknown board the project page lists all projects (create, clone, or open one — opening an unbound project binds it). Runtime mismatch interrupts the agent, cancels hardware requests, closes the project and shows the reason on the project page.

**D26 — Serial file transfer.** Listing uses `os.listdir` + `os.stat` (CircuitPython has no `os.ilistdir`). Reads print `repr()` of 512-byte chunks in one exec per file; writes send 256-byte `b'…'` literals (as mpremote). After each write the file is verified by SHA-256 (on-board `hashlib` if present, otherwise read back) and retried once. Directories that become empty after deletions are removed. While a raw REPL session runs, its bytes are not forwarded to the backend buffers; the frontend inserts `[boady: syncing files…]` / `[boady: sync finished]` instead.

**D27 — Library tab (CircuitPython).** Backend actions `lib.list` (circup `freeze` + `list`), `lib.search` (`show <match>`), `lib.install`, `lib.update` (`update --all`, no prompts), `lib.uninstall`, always with `--path <project>/src`. circup reads the version and board id from `src/boot_out.txt`, so the board must have been connected once; otherwise the error `no_boot_out` is shown. Bundles are cached by circup in the backend's user data directory.

**D28 — User console.** The console writes straight to the port from the frontend and is refused (read-only notice) while the agent holds the port lock (D8) or a file sync uses the REPL port. Enter sends the line plus `\r`; Ctrl-C / Ctrl-D buttons send `\x03` / `\x04`.

**D29 — mip into the mirror.** `src/backend/boady/mip_mirror.py` calls `mpremote.mip._install_package(transport, package, "https://micropython.org/pi/v2", "lib", version, mpy)` exactly as the spec describes, with `MirrorTransport` (the six methods; paths confined to `src/`). `mpy` is true when the project table has a `.mpy` version (from identification, `sys.implementation._mpy`); `eval` returns `_mpy & 0xFF` like mpremote. mip prints progress; it is captured and returned. Runs in a worker thread. Accepted names: index names, `github:` / `gitlab:` / `codeberg:` paths and `https://` URLs, optionally `@version`; local file paths are refused (the agent must not copy arbitrary local files into the mirror). Verified with a real install of `aioble` (mpy 6 → `.mpy` files).

**D30 — Library tools for the agent.** Instead of opening Bash to `mpremote`, two boady MCP tools: `install_library {names}` and `list_libraries {}` (auto-allowed, mirror only). They work for both project types (circup for CircuitPython, mip for MicroPython); for CircuitPython the whitelisted `circup --path src …` Bash command stays available. This resolves the pending "Bash whitelist or wrap everything" item for libraries.

**D31 — MicroPython library list.** mip keeps no manifest, so the Library tab lists the top-level entries of `src/lib` (file stem or package directory). Uninstall removes that entry. There is no "update all"; installing again overwrites. Search uses the micropython.org `index.json` (name and description). A typed `github:…` / URL can be installed directly.

**D32 — `/rom` is skipped on MicroPython.** Newer MicroPython ports mount a read-only ROMFS at `/rom` (mpremote ignores `/rom` too). It is not part of the board's writable files, so MicroPython projects do not pull it and never try to delete from it. This is outside the spec's two exclusion classes; Master may veto.

**D33 — DTR/RTS confirmed against mpremote.** mpremote 1.29.0 keeps pyserial's default (DTR and RTS asserted on open) on macOS/Linux, same as boady's D23 setting; only Windows + CP210x gets a special order, which Web Serial cannot reproduce.

**D34 — Fixes from the code review (2026-11-24).** Behaviour rules that changed:
- *git options (amends D3):* options that write files or run programs (`--output`, `--output-directory`, `--upload-pack`, `--receive-pack`, `--exec`, `--ext-diff`, `--open-files-in-pager`, `--config-env`, `--template`, `--separate-git-dir`) are hard-denied for every subcommand. Read-only commands run without approval only when all their options are on a safe list; any other option asks. Option values (`--x=/path`) are path-checked like plain arguments. `git config` runs without approval only with `--get` / `--get-all` / `--list`.
- *Pull consent (amends D9):* the mirror is fingerprinted before the board is read; if `src/` changed during the transfer, the user is asked again with the changed files before anything is overwritten.
- *Board guard (amends D25):* the runtime check runs before the board-binding check, also when the user opens a project. Sync in either direction and agent writes to the serial ports are refused while the connected board is unidentified, runs another runtime, or is bound to a different project.
- *Port choice (amends D22):* the port picked in Chrome's chooser is the one opened (plus the data port picked next); other granted boards are not used.
- *Cancelled CircuitPython serial sync:* the drive is given back with its own timeout (interrupt, re-enter raw REPL, close a half-written file, `enable_usb_drive()`); if that fails the error says to press reset.
- *Frontend disconnect:* hardware work in progress is aborted and its late replies are never sent on a newer connection.
- *Files tab:* the open file and unsaved text are kept per project outside the tab, so switching tabs does not lose them; closing the page with unsaved edits asks first.

**D35 — Second review round (2026-11-24).** Rules changed or clarified:
- *Board guard (amends D34):* the identification call's two tools are exempt; it has to talk to the board before it has a UID.
- *Mirror root:* `src/` must be a real directory inside the project. A `src` symlink (or one resolving outside) is refused by sync and library operations, and a cloned repository with one is unfit. Inside `src/`, symlinks are neither listed, synced nor followed when deleting.
- *Pull consent (amends D34):* the fingerprint is taken before the first overwrite question, so edits made while that card waits are asked about too.
- *Action results* go only to the window that sent the request; request ids carry a per-page prefix.
- *MSC sync* holds the REPL lock and the busy flag from turning autoreload off to restoring it, and checks for cancellation between deletions.
- *Files tab:* a file read answer applies only if no newer read started and the editor text did not change meanwhile.

**D36 — Emulator: a virtual Raspberry Pi Pico for testing without hardware (Master, 2026-11-24).** Master asked for an in-browser stand-in board for testing only, and for the hardware tests to run on it; Master preferred an emulated Pico running official firmware over interpreters compiled to WebAssembly.
- *Emulator:* rp2040js (Wokwi, MIT) vendored as TypeScript source in `src/web/vendor/rp2040js/` — release 1.4.2 + unmerged PR #156 (SPI-NOR flash writes) + READ_UNIQUE_ID (`0x4B`) so the board has a UID; full diff in `boady-changes.patch`. Compiled with its own tsconfig (it needs `useDefineForClassFields: false`), imported as `@vendor/rp2040js`. Two more workarounds in boady's wrapper (`src/hw/emulator/pico.ts`): QSPI_SS pad reset value `0x5a` and QSPI_SS idling high, without which CircuitPython hangs reading BOOTSEL. All listed as tech debt in CLAUDE.md.
- *Firmware:* official, unmodified Pico UF2s — MicroPython 1.29.0, CircuitPython 10.3.2 — in `src/web/public/emulator/firmware/` with sources and SHA-256 in `SOURCE.md`; `scripts/update-emulator-firmware.mjs` lists newer versions.
- *Integration:* the emulated Pico's USB CDC is wrapped as a `SerialLink` (the interface a Web Serial port also implements), so identification, raw REPL sync, CircuitPython write switching, console, plot and the agent tools run unchanged; the backend sees `device.attached` with `usb.emulator`. Host-side flow control (the emulated USB FIFO drops bytes when full). Never MSC, no data port. In the browser it runs in a Web Worker, its 2 MB flash and UID are kept in IndexedDB — per test project since D40 (firmware is rewritten over a saved image, keeping the filesystem). Connection UI and project binding: see D40. Chat header says "emulator". Available even without Web Serial.
- *Speed:* about 0.35× a real Pico in Node; boot to `>>>` 0.6 s (MicroPython) / 4 s (CircuitPython); raw REPL writes ≈1.5 KB/s.
- *Tests:* `src/web/src/hw/emulator/onEmulator.test.ts` runs both firmwares through `DeviceManager`: identification with the commands from `identify_board.md`, pull-then-sync both ways, deletion/pruning, sync markers, console lock, Ctrl-C, plot, real Traceback, MicroPython soft reset, flash persistence. Scripted fake boards remain only for fault injection. `npm run e2e:emu` drives a running backend with real Claude (verified: CircuitPython full loop; MicroPython identify + pull; browser Worker path with IndexedDB in headless Chrome).
- *Fallback not needed:* official MicroPython WebAssembly and John Fletcher's experimental CircuitPython WebAssembly port (`johnnohj/circuitpython`, branch `browser-board`, `ports/wasm`; The CircuitPython Show ep. 47) were evaluated but not used.

**D37 — Enter in `write_repl` (amends D7).** The agent sometimes writes Enter as escape text (a backslash and `r`), like the Ctrl escapes; the board then never runs the line. Seen in Master's real-board identification transcripts and reproduced on the emulator. A literal `\r` / `\n` run at the very end of `data` is now one Enter; inside `data` nothing else changes, so Python escapes in code (`exec("a\nb")`) are untouched.

**D38 — Pre-upload check reads the board into a buffer (Master, 2026-11-24; merged into specs.md).** Found with the emulator end-to-end run: following the old rule (`sync_from_device` right before `sync_to_device`), the pull overwrote the agent's own uncommitted fix with the board's older copy. New MCP tool `compare_with_device` (auto-allowed): reads all board files into a backend buffer, never the mirror, and returns `changed_on_board` (against a baseline), `board_only` / `mirror_only` / `differs` (against the mirror) and board→mirror text diffs (≤6000 chars). The baseline is the board's file hashes right after the last pull or upload, stored per project in `$BOADY_HOME/sync/<project id>.json` together with the board UID (a different board has no baseline → `changed_on_board: null` with a note). The system prompt's rule 2 uses it; `sync_from_device` stays the way to bring board changes into the mirror (with its approval); its optional `paths` takes only those files, so keeping a board change never overwrites the agent's other edits (review 3). After a partial pull only the taken files move to the board's state in the baseline; other board changes stay reported by the next compare (reading a file is not handling its change — corrected after review 4; the first version updated the whole baseline). The agent never commits on its own. The user's own Sync button is unchanged.

**D39 — Serial console uses xterm.js (Master, 2026-11-25; merged into specs.md).** `@xterm/xterm` 6.0.0 + `@xterm/addon-fit` 0.11.0 (`src/web/src/components/XtermConsole.tsx`). DeviceManager keeps each port's raw output in a bounded `SerialHistory` (256 KB); a console replays it when the Serial tab opens and then follows new chunks, so switching tabs loses nothing. Keystrokes typed into the terminal go to the board as xterm encodes them; the terminal is read-only (`disableStdin`) while the agent holds the port or a sync runs. The input line and the Ctrl-C / Ctrl-D / Clear buttons from the spec's first draft stay. Replaces the hand-written terminal model (D28's console).

**D40 — The emulator is a board like any other; the test unit is the project (Master, 2026-11-25; merged into specs.md; amends D36).** The first connection fixes `boady.json` `"board"`: `"rp2040js"` (Wokwi's rp2040js emulating a Raspberry Pi Pico — a test project) or `"usb"` (real boards); written by the backend when it binds the board, left uncommitted. A board of the other kind is not bound, not pulled from, and sync and agent serial writes are refused (`board_kind_mismatch`). Device tab: one connection card — "Connect board" starts the test project's own emulator or opens the Web Serial chooser; a project without a board kind offers "Connect USB board" and "Connect emulator (test project)". Each test project has its own virtual board: flash + UID in IndexedDB keyed `project:<id>` (was: one per runtime). The frontend reports the owning project with the board (`usb.emulator.project`); the backend never binds an emulator to another project and refuses sync / serial writes for it (`emulator_other_project`), and the frontend disconnects an emulator when another project is opened (review 4). Real ports never auto-connect while a test project is open, and a real board that connected before the project was known is dropped. The project list marks test projects. The project table caches `board` like `type`.

## Pre-check checklist (needs Master)

Record each result below. If any step fails, stop and report before phase 2. (Results: see the next section.)

1. **Web Serial in Chrome on the Pixel 10 Pro.** Plug a CircuitPython board in via USB-C OTG. Open https://googlechromelabs.github.io/serial-terminal/ in Chrome, tap Connect, pick the board, press Enter: a `>>>` prompt (or program output) must appear. Note the Chrome version.
2. **Native serial.** Install "Serial USB Terminal" (Kai Morich) from Play. Connect to the same board (and, if available, a CH34x / CP210x board such as an ESP32 dev board): typing must reach the REPL.
3. **termux-usb.** In Termux with Termux:API installed: `termux-usb -l` must list the board's device path.
4. **Claude Code in Termux.** Install with the community method, set `DISABLE_AUTOUPDATER=1`, run `claude --version` and one prompt (`claude -p "say hi"`). Note which Termux build (Play or F-Droid/GitHub) and the CLI version.
5. **setup-token.** In Termux run `claude setup-token`, complete the browser authorisation, paste the code back; then `CLAUDE_CODE_OAUTH_TOKEN=<token> claude -p "say hi"` must work.

## Pre-check results (reported by Master, 2026-11-23)

- [x] 1 — **Failed.** Chrome on the Pixel 10 Pro cannot connect to the USB serial port. (Chrome version not recorded.)
- [x] 2 — **Passed.** Serial USB Terminal (usb-serial-for-android) connects and talks to the board.
- [—] 3 — **Dropped by Master:** `termux-usb` is not something boady needs to consider, because the backend never touches USB (D17).
- [x] 4 — **Passed.** Claude Code runs in Termux.
- [ ] 5 — **Partly verified.** Claude Code in Termux signs in to the subscription account with `/login`. `claude setup-token` (the spec's path, used to avoid the ~24 h expiry of `/login` on Termux) has **not been tested yet**. Termux build (Play or F-Droid/GitHub) not recorded.

**Impact of failure 1.** Phone browser mode has no hardware access on the target phone: only the APK's native serial (usb-serial-for-android, the same library Serial USB Terminal uses, which works) can reach the board. Desktop Chrome is unaffected. Master resolved this with D18.

**D17 — termux-usb is out of scope (Master).** The backend never touches USB, so `termux-usb` is not a pre-check item and not a fallback. `specs.md` still lists it under「设备连接 / 目标手机」and in the pending list; it should be removed when this decision is merged back.

**D18 — Android Chrome is an untested bonus (Master, 2026-11-23).** The web frontend stays mandatory because it is the desktop frontend. Android Chrome may keep working as a side effect of the shared web code, but it is not a supported or tested target. On Android only the app (APK) is tested. Consequences for `specs.md` when merged back:
- 「前端与 UI 职责 / 运行形态」「部署形态」: phone Chrome becomes an untested bonus, not a deployment form.
- 「设备连接 / 目标手机」: the Web Serial test is no longer a requirement; the native channel (passed) is the phone path.
- 「实现顺序」: resolved by D19.

**D19 — Phases 4 and 5 are accepted together (Master, 2026-11-23).** Phone Chrome browser mode is removed from phase 4. Phase 4 (install script, login in the frontend, keep-alive guide) has no separate phone acceptance; one joint acceptance at the end of phase 5 tests the APK frontend and the Termux backend together: install from scratch on the Pixel 10 Pro, run the phase 2 loop through the APK, and the agent still finishes sync and testing while the app is in the background.

**Merged into specs.md (2026-11-23):** D17, D18, D19 and the pre-check results — 「部署形态」, 「运行形态」, 「目标手机」, risk table, pending list, 「实现顺序」.

## Phase 1 manual test checklist (desktop, no hardware)

1. `pip install -r src/backend/requirements.txt`, then `python run.py`; open the printed `#token=` link in Chrome. With no projects the project page appears.
2. Create a CircuitPython project. Files tab shows `boady.json`, `CLAUDE.md`, `DESIGN.md`, `README.md`, `src/CIRCUIT.md`, `src/code.py`; Version tab shows one commit and no changes.
3. Ask Claude to change `src/code.py`: tool cards stream in; no approval is needed for edits inside the project.
4. Ask Claude to read a file outside the project (e.g. `/etc/hostname`): an approval card appears; Deny and Allow both behave.
5. Ask Claude to `git commit`: an approval card appears. Ask for `cat /etc/passwd` via Bash: it is refused without a card.
6. Version tab: click the change to see the diff, commit with a message, try reset of one file and reset all (confirmations shown).
7. Stop the backend (Ctrl-C) and start it again: the page reconnects, the conversation is still there, and Claude remembers it.
8. Tabs: click opens one tab; Ctrl/Cmd-click opens the two most recent; narrow the window until it is taller than wide — the bar moves to the left with icons only and the split becomes top/bottom. (Two-finger tab selection is a touch feature; it is tested in the Android app, not in phone Chrome — D18.)
9. Open the page in a second window: the first one shows "disconnected because another boady window connected".
10. Settings → 中文: all UI text switches; reload keeps it.
11. Settings → Reset pairing code: the page keeps working; a different browser needs the new code.

## Phase 2 manual test checklist (desktop Chrome + CircuitPython board)

Use a board with native USB (e.g. QT Py RP2040, Feather ESP32-S3) running a recent CircuitPython 9.x. Start the backend with `python run.py` and open the link in desktop Chrome.

1. **Connect.** Create a CircuitPython project, open the Device tab, click "Connect board" and pick the board. Status shows "Identifying…", then UID / runtime / firmware. The UID must equal the `UID:` line of `boot_out.txt`.
2. **Pull on connect.** The chat shows "Pulled the board files into src/…"; Version tab lists the board's files as changes against the skeleton. Commit them.
3. **Dirty mirror.** Edit `src/code.py` in the Files tab without committing, click "Pull from board": an approval card lists `src/code.py`; Deny keeps your edit; Allow overwrites it.
4. **Serial sync (no drive chosen).** Ask Claude to change `code.py` to print a counter every second and sync it. Expect: the drive disappears from the computer for a few seconds, comes back writable, the board soft-reloads, Claude reads the output.
5. **Closed loop.** Ask Claude to introduce a bug on purpose, sync, read the Traceback and fix it. This is the spec's acceptance loop.
6. **MSC channel.** Device tab → "Choose CIRCUITPY drive" and pick the mounted drive. Ask Claude to sync again: channel shows `msc`, the drive does not disappear, the program stays stopped until Claude sends Ctrl-D. Check that `code.py` runs the new content (D21 cache risk).
7. **Data port.** Add `import usb_cdc; usb_cdc.enable(console=True, data=True)` to `boot.py`, sync, hard-reset the board. Click "Add data port" and pick the second interface. The Serial tab shows REPL and Data; a program writing to `usb_cdc.data` appears under Data; Claude can use `read_data`.
8. **Console lock.** While Claude writes to the REPL, the Serial tab input is disabled with the read-only notice; it unlocks at the end of the turn.
9. **Plot.** Run `while True: print((time.monotonic() % 5, math.sin(time.monotonic())))` with a short sleep: two curves scroll; Pause/Resume and Clear work.
10. **Libraries.** Library tab: search `bme280`, install, see it in `src/lib` and in the Version tab; update all; remove. Sync to the board.
11. **Reconnect.** Unplug and replug the board (Chrome reconnects automatically to a granted port): the same project opens and the conversation continues. With two projects bound to the same board, the project page asks which one.
12. **Runtime mismatch.** Create a MicroPython project and connect the CircuitPython board: everything stops and the project page explains the mismatch.
13. **Old firmware (optional).** On CircuitPython 8.x without `unsafe_disable_usb_drive`, a serial sync fails with the "upgrade or boot.py" message.

## Phase 3 manual test checklist (desktop Chrome + MicroPython board)

Use a native-USB board (e.g. Raspberry Pi Pico / Pico W) and, if available, an ESP32 dev board with a CP210x / CH34x USB-serial chip.

1. Create a MicroPython project; Device tab → Connect board. UID (`machine.unique_id()`), runtime `micropython`, firmware version appear; the board files are pulled into `src/` (no `/rom`, no `.boady_id`).
2. ESP32 with a USB-serial chip: connecting must **not** reset the board (watch for a boot banner in the Serial tab right after connecting).
3. Ask Claude to change `main.py` to blink the LED and print a counter, sync it and test it. Claude soft-resets (`\x03`, `\x04`) and reads the output. Then the closed loop: an intentional bug, Traceback, fix.
4. Ask Claude to try a function in RAM first (raw REPL) before writing it into the code.
5. Library tab: search `aioble`, install, see `src/lib/aioble/*.mpy`; remove it; install `github:org/repo` of a small package. Ask Claude to install a package (it uses `install_library`).
6. A port without `machine.unique_id()` (rare): `/.boady_id` is created on the board and stays out of the mirror.
7. Connecting the MicroPython board while a CircuitPython project is open: everything stops and the project page explains the mismatch.
