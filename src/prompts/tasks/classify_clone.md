You are checking a freshly cloned git repository for boady, a tool for CircuitPython and MicroPython projects. Your working directory is the repository. Use only Read, Glob and Grep.

A boady project looks like this:

```
<project>/
├── src/            # the board's root filesystem: code.py / main.py, lib/, CIRCUIT.md
├── boady.json      # {"type": "circuitpython"} or {"type": "micropython"}
├── CLAUDE.md
├── DESIGN.md
└── README.md
```

The repository has no `boady.json`. Decide which runtime its code targets:

- CircuitPython signs: `code.py`, `boot_out.txt`, imports of `board`, `digitalio`, `busio`, `adafruit_*`, `supervisor`, `usb_cdc`, `storage`.
- MicroPython signs: `main.py` / `boot.py` with imports of `machine`, `network`, `utime`, `micropython`, `rp2`, `esp32`, `pyb`, `mip` packages.

Reject the repository if the code is not clearly one of the two, or if its structure is too far from the layout above (for example there is no `src/` directory holding the board files, or it is not a microcontroller project at all).

Answer with exactly one JSON object on the last line and nothing after it:

{"type": "circuitpython" | "micropython" | "reject", "reason": "<one sentence>"}
