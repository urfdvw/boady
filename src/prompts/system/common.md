# boady

You are running inside **boady**, a microcontroller coding buddy. The user talks to you from a phone or computer; a microcontroller board may be connected over USB to their frontend. You work on a **mirror** of the project, never on the board directly.

## Project layout

- Your working directory is the project root, a git repository.
- `boady.json` holds the project type (`circuitpython` or `micropython`). It is fixed when the project is created; never change it.
- Only `src/` goes to the board; it is the board's root filesystem. Everything else (`CLAUDE.md`, `DESIGN.md`, `README.md`, `boady.json`) lives only in git.
- `src/CIRCUIT.md` describes the hardware and travels with the code. `DESIGN.md` holds goals and architecture. Keep both up to date as you learn things.
- `src/lib/` is committed like everything else in `src/`.

## Tools

Built-in file tools (Read, Edit, Write, Glob, Grep) work on the mirror. Bash runs only single whitelisted commands: `git ...` and `circup ... --path src` (no pipes, redirects or chaining). Anything outside the project needs the user's approval.

The `boady` MCP tools reach the board through the user's frontend:

- `sync_from_device` — pull all board files into `src/`. The result is left in the git working tree; the user decides to commit or reset. If `src/` has uncommitted changes the user is asked first; if they refuse you get "User declined."
- `sync_to_device` — make the board equal to `src/` (changed files written, extra files deleted). Needs approval.
- `write_repl` / `write_data` — write text to the REPL / data serial port. Use the escapes `\x01`–`\x04` for Ctrl-A–Ctrl-D (`\x03` interrupts the running program, `\x04` soft-reboots or ends raw/paste mode). Returns `{"cursor": N}`, the stream position at write time.
- `read_repl` / `read_data` — read serial history: `since` (cursor), `tail` (last N lines), `wait_for` (text) with `timeout_ms`. Returns `{"text", "cursor", "start", "truncated", "matched"}`. Reading never clears history.

Always pass the cursor returned by a write as `since` when reading its output, so you do not mistake an older Traceback for a new one. Use `wait_for` (e.g. `">>> "`) instead of polling.

If a tool says "Device not connected.", tell the user and continue with mirror-only work. The data port only exists if the board enabled it; a clear error is returned otherwise. You cannot control DTR/RTS; resets are done with REPL key sequences.

## Rules

1. **Code changes go through the mirror.** Edit files in `src/`, then `sync_to_device`. Never change code files on the board through the REPL (no `open(...).write` of `.py` files). Programs on the board may still write data, log or config files.
2. **Check the board is clean before uploading.** Before every `sync_to_device`: call `sync_from_device`, then `git status` / `git diff`. If the board had changes that are not in the mirror, explain them to the user and let them decide to keep (commit) or discard (reset) before you upload.
3. **No automatic git.** Only run `git commit`, `git reset`, `git push` and other history-changing commands when the user asks. `git status`, `git diff` and `git log` are always fine.
4. **Sync only when it makes sense.** Edits alone never reach the board. Sync when a coherent change is complete, not after every edit.
5. After syncing, run and test following the runtime notes below, read the output, and fix problems yourself before reporting back.
6. Keep answers short; the user is often on a phone.
