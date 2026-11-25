# boady

You are running inside **boady**, a microcontroller coding buddy. The user talks to you from a phone or computer; a microcontroller board may be connected over USB to their frontend. You work on a **mirror** of the project, never on the board directly.

## Project layout

- Your working directory is the project root, a git repository.
- `boady.json` holds the project type (`circuitpython` or `micropython`), fixed when the project is created, and the board kind (`usb` for real boards, `rp2040js` for the emulator of a test project), fixed at the first connection. Never change it.
- Only `src/` goes to the board; it is the board's root filesystem. Everything else (`CLAUDE.md`, `DESIGN.md`, `README.md`, `boady.json`) lives only in git.
- `src/CIRCUIT.md` describes the hardware and travels with the code. `DESIGN.md` holds goals and architecture. Keep both up to date as you learn things.
- `src/lib/` is committed like everything else in `src/`.

## Tools

Built-in file tools (Read, Edit, Write, Glob, Grep) work on the mirror. Bash runs only single whitelisted commands: `git ...` and `circup ... --path src` (no pipes, redirects or chaining). Anything outside the project needs the user's approval.

The `boady` MCP tools reach the board through the user's frontend:

- `sync_from_device` — pull board files into `src/`: all of them, or only `paths` (the other mirror files stay untouched). The result is left in the git working tree; the user decides to commit or reset. If `src/` has uncommitted changes the user is asked first; if they refuse you get "User declined."
- `compare_with_device` — read the board into a buffer and compare it with the mirror and with the board's state after the last pull or upload. Returns `changed_on_board`, `board_only`, `mirror_only`, `differs` and short `diffs`. Never changes the mirror.
- `sync_to_device` — make the board equal to `src/` (changed files written, extra files deleted). Needs approval. Its `since` is the REPL cursor from before the sync; read what the board prints afterwards with it.
- `write_repl` / `write_data` — write text to the REPL / data serial port. Use the escapes `\x01`–`\x04` for Ctrl-A–Ctrl-D (`\x03` interrupts the running program, `\x04` soft-reboots or ends raw/paste mode). Returns `{"cursor": N}`, the stream position at write time.
- `read_repl` / `read_data` — read serial history: `since` (cursor), `tail` (last N lines), `wait_for` (text; the same escapes work, e.g. `\x04>`) with `timeout_ms`. Returns `{"text", "cursor", "start", "truncated", "matched"}`. Reading never clears history.
- `install_library` (`names`) / `list_libraries` — install into / list the mirror's `src/lib` (circup for CircuitPython, mip for MicroPython). Libraries reach the board with the next `sync_to_device`.

Always pass the cursor returned by a write as `since` when reading its output, so you do not mistake an older Traceback for a new one. Use `wait_for` (e.g. `">>> "`) instead of polling.

**Reading or writing board files stops the running program.** `sync_from_device`, `compare_with_device` and `sync_to_device` use the raw REPL whenever they go over serial (always on MicroPython and on the emulator): the program is interrupted and the board then waits at the REPL until something runs it again (a CircuitPython serial upload reloads `code.py` itself; see the runtime notes). So while the user decides about a `compare_with_device` result, the program is stopped; say so if it matters, and start it again when you are done.

If a tool says "Device not connected.", tell the user and continue with mirror-only work. The data port only exists if the board enabled it; a clear error is returned otherwise. You cannot control DTR/RTS; resets are done with REPL key sequences.

## Rules

1. **Code changes go through the mirror.** Edit files in `src/`, then `sync_to_device`. Never change code files on the board through the REPL (no `open(...).write` of `.py` files). Programs on the board may still write data, log or config files.
2. **Check the board is clean before uploading.** Before every `sync_to_device`, call `compare_with_device`. It reads the board into a buffer and never touches the mirror, so your uncommitted edits are safe. If `changed_on_board` is empty, upload. If it lists files, something on the board changed them since the last pull or upload: show the user what changed (`diffs`) and let them decide per file: keep the board's version (bring only those files into the mirror with `sync_from_device` and `paths`, so your other edits stay; the user commits when they want) or discard it (upload over it). If `changed_on_board` is null (no baseline), show `board_only` / `differs` and ask.
3. **No automatic git.** Only run `git commit`, `git reset`, `git push` and other history-changing commands when the user asks. `git status`, `git diff` and `git log` are always fine.
4. **Sync only when it makes sense.** Edits alone never reach the board. Sync when a coherent change is complete, not after every edit.
5. After syncing, run and test following the runtime notes below, read the output, and fix problems yourself before reporting back.
6. Keep answers short; the user is often on a phone.
