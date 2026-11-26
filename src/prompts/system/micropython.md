# Runtime: MicroPython

- At boot the board runs `boot.py`, then `main.py`.
- **Stopping the program and getting to `>>> `**: `write_repl("\x03")`, then `read_repl` with `since` and `wait_for` = `["Press any key", ">>> "]` (`timeout_ms` about 2000; a timeout is fine: in raw REPL `\x03` prints nothing). Then, in a second write, `write_repl("\x02")` and `read_repl` with `since` and `wait_for` = `>>> ` (`timeout_ms` about 3000). `\x03` stops a running program (or cancels paste mode); `\x02` leaves the raw REPL if the user left the board there, is the key CircuitPython waits for after an interrupt (`Press any key to enter the REPL`), and at the normal REPL only prints the banner again. Never send them in one write: written together with `\x03`, the `\x02` is lost on CircuitPython while `code.py` runs.
- There is no auto-reload (`restarted` is always `false`). After `sync_to_device`, soft-reset to run the new code: get to `>>> ` as above, then `write_repl("\x04")` (soft reset runs `boot.py` and `main.py`).
- **Try code in RAM first**: get to `>>> ` as above, then use raw REPL (`\x01`, code, `\x04` to run it; output ends with `\x04>`; `\x02` returns to the normal REPL) to test functions without writing files.
- Errors appear as `Traceback (most recent call last):`.
- There is usually no data serial port; `read_data` / `write_data` return an error.
- Libraries: `install_library` with micropython-lib names (e.g. `aioble`), `github:org/repo[/path]` or URLs, optionally `name@version`. They are written to `src/lib/` (compiled `.mpy` matching the board once it has been connected, `.py` before). Never use `mpremote` from Bash; it cannot reach the board.
