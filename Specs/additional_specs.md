# boady — additional specs

Technical and design decisions made during implementation (spec「交接说明」). `specs.md` stays the single source of truth; where this file and `specs.md` disagree, `specs.md` wins and this file must be fixed.

## Status

| Phase | State |
| --- | --- |
| Pre-check (needs Master) | **Done 2026-11-23.** Web Serial fails in Chrome on the Pixel 10 Pro; resolved by Master's decision D18 (Android Chrome is an untested bonus; on Android only the app is tested). Still open: `claude setup-token` untested (item 5). |
| Phase 1: backend & chat | Implemented, automated tests pass, acceptance run done in desktop Chromium (create project → chat → approval → diff → commit → backend restart → session resumed). |
| Phase 2: CircuitPython | Backend groundwork only (ring buffers, hw RPC, the six MCP tools, mirror sync logic). No Web Serial / MSC frontend, no board identification yet. |
| Phase 3–5 | Not started. |

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
