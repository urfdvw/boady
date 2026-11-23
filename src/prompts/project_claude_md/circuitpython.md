# {{name}}

Project type: see `boady.json` (CircuitPython). Goals and architecture: `DESIGN.md`. Hardware: `src/CIRCUIT.md`.

## How to work on a microcontroller project

- Test small pieces in the REPL first, then put them into the code.
- Change one thing at a time; run it and read the serial output before moving on.
- Keep `code.py` short; move logic into modules in `src/`.
- Keep memory in mind: avoid large lists and string concatenation in loops; use `gc.mem_free()` when in doubt.
- Record wiring, pins and part numbers in `src/CIRCUIT.md` as soon as they are known.

## References

- CircuitPython docs: https://docs.circuitpython.org/en/latest/
- Core module API: https://docs.circuitpython.org/en/latest/shared-bindings/index.html
- Adafruit Learn guides: https://learn.adafruit.com/
- Library bundle: https://docs.circuitpython.org/projects/bundle/en/latest/
- circup: https://github.com/adafruit/circup
- Downloads and board pages: https://circuitpython.org/downloads
