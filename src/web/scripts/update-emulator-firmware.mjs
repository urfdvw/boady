// Prints the newest stable Pico firmware for MicroPython and CircuitPython (no downloads).
const mp = await (await fetch("https://micropython.org/download/RPI_PICO/")).text();
const mpv = [...new Set(mp.match(/RPI_PICO-\d+-v\d+\.\d+\.\d+\.uf2/g) ?? [])].sort().pop();
const cp = await (await fetch("https://adafruit-circuit-python.s3.amazonaws.com/?prefix=bin/raspberry_pi_pico/en_US/&list-type=2")).text();
const v = (s) => s.match(/(\d+)\.(\d+)\.(\d+)\.uf2$/).slice(1).map(Number);
const cpv = [...new Set(cp.match(/adafruit-circuitpython-raspberry_pi_pico-en_US-\d+\.\d+\.\d+\.uf2/g) ?? [])]
  .sort((a, b) => { const x = v(a), y = v(b); return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]; }).pop();
console.log("MicroPython:  https://micropython.org/resources/firmware/" + mpv);
console.log("CircuitPython: https://adafruit-circuit-python.s3.amazonaws.com/bin/raspberry_pi_pico/en_US/" + cpv);
