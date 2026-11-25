/**
 * An emulated Raspberry Pi Pico (vendored rp2040js) running an official UF2,
 * reached through its USB CDC serial port. Environment-agnostic: used directly
 * in Node tests and inside the browser Worker (pico.worker.ts).
 *
 * Testing only — see Specs/additional_specs.md D36.
 */
import { bootromB1, ConsoleLogger, LogLevel, Simulator, USBCDC } from "@vendor/rp2040js";

export const FLASH_SIZE = 2 * 1024 * 1024;
const FLASH_START = 0x10000000;
const UF2_MAGIC_START0 = 0x0a324655;
const UF2_MAGIC_START1 = 0x9e5d5157;
const UF2_MAGIC_END = 0x0ab16f30;
/** RP2040 datasheet reset value of PADS_QSPI GPIO_QSPI_SS (IE, PUE, SCHMITT). */
const QSPI_SS_PAD_RESET = 0x5a;

/** Write a UF2 image into a flash buffer (pure; exported for tests). */
export function loadUf2(uf2: Uint8Array, flash: Uint8Array): void {
  const view = new DataView(uf2.buffer, uf2.byteOffset, uf2.byteLength);
  for (let off = 0; off + 512 <= uf2.length; off += 512) {
    if (view.getUint32(off, true) !== UF2_MAGIC_START0 || view.getUint32(off + 4, true) !== UF2_MAGIC_START1) {
      throw new Error(`not a UF2 block at offset ${off}`);
    }
    if (view.getUint32(off + 508, true) !== UF2_MAGIC_END) throw new Error(`bad UF2 block end at offset ${off}`);
    const addr = view.getUint32(off + 12, true) - FLASH_START;
    const size = view.getUint32(off + 16, true);
    if (addr < 0 || addr + size > flash.length || size > 476) throw new Error(`UF2 block outside flash at offset ${off}`);
    flash.set(uf2.subarray(off + 32, off + 32 + size), addr);
  }
}

export interface PicoOptions {
  /** The firmware UF2 (used when ``flash`` is not given). */
  firmware: Uint8Array;
  /** A saved flash image from a previous run (its filesystem is kept). */
  flash?: Uint8Array;
  /** 8-byte flash unique ID: the board UID the firmware reports. */
  uid: Uint8Array;
  /** GPIOs driven from outside from the very first instruction (switches left on), as [gpio, level]. */
  inputs?: [number, boolean][];
}

/** GPIOs of the RP2040 (GP0–GP29). */
export const GPIO_COUNT = 30;

/** Bit i = GPIO i. ``levels``: the pad's level; ``outputs``: the chip drives the pin. */
export interface PinState {
  levels: number;
  outputs: number;
}

export class PicoMachine {
  private sim = new Simulator();
  private cdc: USBCDC;
  private queue: number[] = [];
  private pump: ReturnType<typeof setInterval> | null = null;
  connected = false;
  onData: (b: Uint8Array) => void = () => {};
  onConnected: () => void = () => {};
  /**
   * Time to save the image: the firmware wrote flash and was then quiet for
   * ``quietMs``, or it kept writing for ``maxMs`` since the first unsaved write
   * (a program logging continuously must not postpone saving forever).
   */
  onFlashChanged: () => void = () => {};
  quietMs = 1000;
  maxMs = 5000;
  /** GPIO levels changed (sampled every ``pinsMs`` while running). */
  onPins: (p: PinState) => void = () => {};
  pinsMs = 50;
  private pinTimer: ReturnType<typeof setInterval> | null = null;
  private lastPins: PinState = { levels: -1, outputs: -1 };
  private flashTimer: ReturnType<typeof setTimeout> | null = null;
  private firstUnsaved: number | null = null;

  private flashWritten() {
    const now = Date.now();
    if (this.firstUnsaved === null) this.firstUnsaved = now;
    if (this.flashTimer) clearTimeout(this.flashTimer);
    const wait = Math.max(0, Math.min(this.quietMs, this.firstUnsaved + this.maxMs - now));
    this.flashTimer = setTimeout(() => {
      this.flashTimer = null;
      this.firstUnsaved = null;
      this.onFlashChanged();
    }, wait);
  }

  constructor(opts: PicoOptions) {
    const mcu = this.sim.rp2040;
    mcu.logger = new ConsoleLogger(LogLevel.Error);
    mcu.loadBootrom(bootromB1);
    if (opts.flash) {
      if (opts.flash.length !== FLASH_SIZE) throw new Error("saved flash image has the wrong size");
      mcu.flash.set(opts.flash);
    }
    // Always (re)write the firmware: a saved image keeps its filesystem (the UF2 does not cover
    // it) but gets the current firmware, e.g. after boady updates the pinned version.
    loadUf2(opts.firmware, mcu.flash);
    const ssi = Object.values(mcu.peripherals).find((p) => (p as object).constructor.name === "RPSSI") as unknown as {
      uniqueId: Uint8Array;
      txBuffer: number[];
      applyCommand(): void;
    };
    ssi.uniqueId = Uint8Array.from(opts.uid.subarray(0, 8));
    // Notice flash writes (page program / sector or block erase) so the image can be saved while
    // the firmware runs: files written from the REPL or by a program must survive a page reload.
    const apply = ssi.applyCommand.bind(ssi);
    ssi.applyCommand = () => {
      const op = ssi.txBuffer[0];
      apply();
      if (op === 0x02 || op === 0x20 || op === 0xd8) this.flashWritten();
    };
    // Workarounds (tech debt, see CLAUDE.md): rp2040js' pad reset value lacks IE, and the flash
    // chip's pull-up on QSPI_SS is not modelled. Without these, CircuitPython hangs reading BOOTSEL.
    const ss = mcu.qspi[1];
    ss.padValue = QSPI_SS_PAD_RESET;
    ss.setInputValue(true);
    this.cdc = new USBCDC(mcu.usbCtrl);
    this.cdc.onDeviceConnected = () => {
      this.connected = true;
      this.onConnected();
    };
    this.cdc.onSerialData = (v: Uint8Array) => this.onData(Uint8Array.from(v));
    for (const [g, level] of opts.inputs ?? []) this.setPin(g, level);
    // nothing has been reported yet (no listener existed): the first sample sends the full state,
    // even if it never changes again (review 13: a saved switch was never shown)
    this.lastPins = { levels: -1, outputs: -1 };
  }

  start(): void {
    this.sim.rp2040.core.PC = FLASH_START;
    this.sim.execute();
    // Host-side flow control: the CDC FIFO drops bytes when full; real USB would make the host wait.
    this.pump = setInterval(() => {
      const fifo = this.cdc.txFIFO;
      while (this.queue.length && !fifo.full) this.cdc.sendSerialByte(this.queue.shift()!);
    }, 1);
    this.pinTimer = setInterval(() => this.samplePins(), this.pinsMs);
  }

  /** Current level and direction of every GPIO. */
  pins(): PinState {
    let levels = 0;
    let outputs = 0;
    const gpio = this.sim.rp2040.gpio;
    for (let i = 0; i < GPIO_COUNT; i++) {
      if (gpio[i].padLevel) levels |= 1 << i;
      if (gpio[i].outputEnable) outputs |= 1 << i;
    }
    return { levels: levels >>> 0, outputs: outputs >>> 0 };
  }

  /** Drive a GPIO from outside (a pressed button): ``true`` high, ``false`` low, ``null`` released. */
  setPin(pin: number, value: boolean | null): void {
    if (!Number.isInteger(pin) || pin < 0 || pin >= GPIO_COUNT) throw new Error(`no GPIO ${pin}`);
    const g = this.sim.rp2040.gpio[pin];
    if (value === null) g.releaseInput();
    else g.setInputValue(value);
    this.samplePins();
  }

  private samplePins() {
    const p = this.pins();
    if (p.levels !== this.lastPins.levels || p.outputs !== this.lastPins.outputs) {
      this.lastPins = p;
      this.onPins(p);
    }
  }

  write(b: Uint8Array): void {
    for (const x of b) this.queue.push(x);
  }

  /** Bytes still waiting to enter the emulated USB endpoint. */
  get pending(): number {
    return this.queue.length;
  }

  /** Copy of the Pico's 2 MB flash (firmware + filesystem) for persistence. */
  flash(): Uint8Array {
    return this.sim.rp2040.flash.slice(0, FLASH_SIZE);
  }

  stop(): void {
    if (this.flashTimer) clearTimeout(this.flashTimer);
    this.flashTimer = null;
    this.firstUnsaved = null;
    if (this.pump) clearInterval(this.pump);
    this.pump = null;
    if (this.pinTimer) clearInterval(this.pinTimer);
    this.pinTimer = null;
    this.sim.stop();
  }
}

export function randomUid(): Uint8Array {
  const u = new Uint8Array(8);
  crypto.getRandomValues(u);
  return u;
}
