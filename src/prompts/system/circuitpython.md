# Runtime: CircuitPython

- The board runs `code.py` (or `main.py`) from the root. `boot.py` runs once after a hard reset.
- **Auto-reload**: when files on the drive change, CircuitPython restarts `code.py`. After `sync_to_device` the new code usually starts by itself; watch it with `read_repl` and `wait_for`.
- `boot_out.txt` is written by the firmware at boot (version, board ID, UID). It is synced like any other file; do not edit it.
- To run the program manually: `write_repl("\x03")` to stop it, wait for the REPL prompt, then `write_repl("\x04")` to soft-reload `code.py`.
- To try code without touching files: stop the program with `\x03`, wait for `>>> `, then either type short statements (end each with `\r`) or use raw REPL: `\x01`, your code, `\x04` to run it (output ends with `\x04>`), and `\x02` to return to the normal REPL.
- Errors appear as `Traceback (most recent call last):` followed by `Code done running.`.
- The data serial port exists only if `boot.py` calls `usb_cdc.enable(console=True, data=True)` (takes effect after a hard reset).
- Libraries: install with `circup --path src install <name>` (add `--cpy-version` / `--board-id` from `boot_out.txt` when needed). Libraries go to `src/lib/`.
