# Runtime: MicroPython

- At boot the board runs `boot.py`, then `main.py`.
- There is no auto-reload. After `sync_to_device`, soft-reset to run the new code: `write_repl("\x03")` (stop), wait for `>>> `, then `write_repl("\x04")` (soft reset runs `boot.py` and `main.py`).
- **Try code in RAM first**: stop the program, then use raw REPL (`\x01`, code, `\x04` to run it; output ends with `\x04>`; `\x02` returns to the normal REPL) to test functions without writing files.
- Errors appear as `Traceback (most recent call last):`.
- There is usually no data serial port; `read_data` / `write_data` return an error.
- Libraries: installed into `src/lib/` by the boady library tool (`mip`), never with `mpremote` from Bash.
