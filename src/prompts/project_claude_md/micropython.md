# {{name}}

Project type: see `boady.json` (MicroPython). Goals and architecture: `DESIGN.md`. Hardware: `src/CIRCUIT.md`.

## How to work on a microcontroller project

- Test small pieces in the REPL (or run them from RAM) first, then put them into the code.
- Change one thing at a time; run it and read the serial output before moving on.
- Keep `main.py` short; move logic into modules in `src/`.
- Keep memory in mind: avoid large lists and string concatenation in loops; use `gc.mem_free()` when in doubt.
- Record wiring, pins and part numbers in `src/CIRCUIT.md` as soon as they are known.

## References

- MicroPython docs: https://docs.micropython.org/en/latest/
- Port-specific quick references: https://docs.micropython.org/en/latest/index.html (see "Quick reference" for your board)
- micropython-lib packages (mip): https://github.com/micropython/micropython-lib
- mip package manager: https://docs.micropython.org/en/latest/reference/packages.html
- Firmware downloads: https://micropython.org/download/
