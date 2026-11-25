# rp2040js (vendored source)

Raspberry Pi Pico (RP2040) emulator by Uri Shaked / Wokwi — https://github.com/wokwi/rp2040js — MIT (see `LICENSE`).
Used only by boady's emulator (a stand-in board for testing without hardware).

Base: release **1.4.2** (`cab5fae`). Changes on top, all in `boady-changes.patch` (`git diff v1.4.2 -- src`):

1. PR **#156** (`d18c7cd`, o-murphy, not merged upstream yet) — JEDEC SPI-NOR flash command emulation in `src/peripherals/ssi.ts`, real `IO_QSPI` pins, pull resolution in `src/gpio-pin.ts`. Without it the emulated flash cannot be written.
2. boady: `ssi.ts` answers READ_UNIQUE_ID (`0x4B`) with the settable `uniqueId` (the board UID firmware reports).
3. boady (D42, Emulator tab): `GPIOPin.releaseInput()` (stop driving a pin from outside, e.g. a released button, so the pull resistor decides again) and `GPIOPin.padLevel` (the pad's electrical level). Not an upstream workaround but a feature; offer it upstream if they want it.

Not copied: `*.spec.ts`, `gdb/gdb-tcp-server.ts` (Node `net`). `src/bootrom.ts` comes from the repo's `demo/bootrom.ts`: RP2040 bootrom B1 built from https://github.com/raspberrypi/pico-bootrom (BSD-3-Clause, Raspberry Pi).

Remove a change when upstream has it — see "Tech debt" in the repository's CLAUDE.md.
