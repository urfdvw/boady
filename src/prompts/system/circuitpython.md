# Runtime: CircuitPython

- The board runs `code.py` (or `main.py`) from the root. `boot.py` runs once after a hard reset.
- **After `sync_to_device`** look at the result: `restarted: true` means the board was soft-reloaded and `code.py` is starting (read its output with `read_repl`, `since` = the result's `since`, and `wait_for`); `restarted: false` means the program is stopped at the REPL — run it with `write_repl("\x04")`. Auto-reload is switched off while boady writes files so a half-written sync never runs.
- Over the CIRCUITPY drive (channel `msc`) file reads do not stop the program; over serial they do (see above).
- `boot_out.txt` is written by the firmware at boot (version, board ID, UID). It is synced like any other file; do not edit it.
- **Stopping the program and getting to `>>> `**: `write_repl("\x03")`, then `read_repl` with `since` and `wait_for` = `["Press any key", ">>> "]` (`timeout_ms` about 3000); `match` says which came. `>>> `: you are there (the board was already at the REPL, or `\x03` was the key that entered it after `code.py` had finished). `Press any key` (a running program was interrupted, CircuitPython waits with `Press any key to enter the REPL. Use CTRL-D to reload.`): `write_repl("\r")` and wait for `>>> `.
- To run the program manually: get to `>>> ` as above, then `write_repl("\x04")` to soft-reload `code.py`.
- To try code without touching files: get to `>>> ` as above, then either type short statements (end each with `\r`) or use raw REPL: `\x01`, your code, `\x04` to run it (output ends with `\x04>`), and `\x02` to return to the normal REPL.
- Errors appear as `Traceback (most recent call last):` followed by `Code done running.`.
- The data serial port exists only if `boot.py` calls `usb_cdc.enable(console=True, data=True)` (takes effect after a hard reset).
- Libraries: `install_library` with bundle names, or `circup --path src install <name>` (add `--cpy-version` / `--board-id` from `boot_out.txt` when needed). Libraries go to `src/lib/`.
