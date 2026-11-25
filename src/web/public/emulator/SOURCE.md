# Emulator firmware

Official, unmodified UF2 images for the Raspberry Pi Pico (RP2040), run by the emulated Pico (`vendor/rp2040js`). Testing only.

| File | Source | SHA-256 | License |
| --- | --- | --- | --- |
| `firmware/micropython-rpi_pico-1.29.0.uf2` | https://micropython.org/resources/firmware/RPI_PICO-20260824-v1.29.0.uf2 | `e1160e602e277d85920adb5fe741435edccba9ba6ecadc85fdab75252eeff4e9` | MIT (MicroPython) |
| `firmware/circuitpython-raspberry_pi_pico-10.3.2.uf2` | https://adafruit-circuit-python.s3.amazonaws.com/bin/raspberry_pi_pico/en_US/adafruit-circuitpython-raspberry_pi_pico-en_US-10.3.2.uf2 | `e62df4b66a4f2f68c5920dbca151e1a2caccb66bd1de7545e8d3fe19cfc7b913` | MIT (CircuitPython) |

Update: `node scripts/update-emulator-firmware.mjs`, which prints the latest stable versions; then download, check, rename and update this table and `src/hw/emulator/firmware.ts`.
