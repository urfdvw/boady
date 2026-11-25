/**
 * Makes an emulated Pico look like a serial port to DeviceManager (SerialLink).
 * The Pico runs either in this thread (tests) or in a Web Worker (browser).
 */
import type { SerialLink } from "../serial";
import { PicoMachine } from "./pico";

/** Where the emulated Pico runs. */
export interface PicoHost {
  onData: (b: Uint8Array) => void;
  /** The emulator died while running (e.g. the Worker crashed). */
  onLost?: () => void;
  /** The firmware wrote flash (debounced): the image should be saved. */
  onFlashChanged?: () => void;
  write(b: Uint8Array): void;
  /** Resolves once the firmware's USB serial port is up. */
  ready(): Promise<void>;
  /** Copy of the 2 MB flash (firmware + filesystem). */
  flash(): Promise<Uint8Array>;
  stop(): void;
}

export class InProcessHost implements PicoHost {
  onData: (b: Uint8Array) => void = () => {};
  onFlashChanged: () => void = () => {};
  constructor(readonly pico: PicoMachine) {
    pico.onData = (b) => this.onData(b);
    pico.onFlashChanged = () => this.onFlashChanged();
  }
  write(b: Uint8Array) {
    this.pico.write(b);
  }
  async ready() {
    if (!this.pico.connected) await new Promise<void>((r) => (this.pico.onConnected = r));
  }
  async flash() {
    return this.pico.flash();
  }
  stop() {
    this.pico.stop();
  }
}

export class EmulatorLink implements SerialLink {
  readonly info = {};
  readonly port = null;
  onData: (b: Uint8Array) => void = () => {};
  onLost: () => void = () => {};
  private closed = false;

  constructor(
    private host: PicoHost,
    readonly emulated: { runtime: string; firmware: string; project?: string },
    /** Called with the flash image on checkpoint() and close(), for persistence. */
    private save: (flash: Uint8Array) => Promise<void> = async () => {},
  ) {
    host.onData = (b) => this.onData(b);
    // save whatever the firmware writes while running (REPL, programs), not only after syncs
    host.onFlashChanged = () => void this.checkpoint();
    host.onLost = () => {
      if (this.closed) return;
      this.closed = true;
      this.onLost();
    };
  }

  async write(b: Uint8Array): Promise<void> {
    if (this.closed) throw new Error("emulator stopped");
    this.host.write(b);
  }

  /** Persist the current flash (e.g. after a sync). */
  async checkpoint(): Promise<void> {
    if (this.closed) return;
    try {
      await this.save(await this.host.flash());
    } catch {
      /* a failed checkpoint must not fail the sync that triggered it */
    }
  }

  /** Saves the flash if the emulator still answers; always stops it. */
  async close(): Promise<void> {
    const wasOpen = !this.closed;
    this.closed = true;
    try {
      if (wasOpen) await this.save(await this.host.flash());
    } catch {
      /* emulator already broken: nothing to save */
    } finally {
      this.host.stop();
    }
  }
}
