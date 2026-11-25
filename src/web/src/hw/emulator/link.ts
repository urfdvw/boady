/**
 * Makes an emulated Pico look like a serial port to DeviceManager (SerialLink).
 * The Pico runs either in this thread (tests) or in a Web Worker (browser).
 */
import type { SerialLink } from "../serial";
import { PicoMachine } from "./pico";

/** Where the emulated Pico runs. */
export interface PicoHost {
  onData: (b: Uint8Array) => void;
  write(b: Uint8Array): void;
  /** Resolves once the firmware's USB serial port is up. */
  ready(): Promise<void>;
  /** Copy of the 2 MB flash (firmware + filesystem). */
  flash(): Promise<Uint8Array>;
  stop(): void;
}

export class InProcessHost implements PicoHost {
  onData: (b: Uint8Array) => void = () => {};
  constructor(readonly pico: PicoMachine) {
    pico.onData = (b) => this.onData(b);
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
    readonly emulated: { runtime: string; firmware: string },
    /** Called with the flash image on checkpoint() and close(), for persistence. */
    private save: (flash: Uint8Array) => Promise<void> = async () => {},
  ) {
    host.onData = (b) => this.onData(b);
  }

  async write(b: Uint8Array): Promise<void> {
    if (this.closed) throw new Error("emulator stopped");
    this.host.write(b);
  }

  /** Persist the current flash (e.g. after a sync). */
  async checkpoint(): Promise<void> {
    if (!this.closed) await this.save(await this.host.flash());
  }

  async close(): Promise<void> {
    if (this.closed) return;
    try {
      await this.save(await this.host.flash());
    } finally {
      this.closed = true;
      this.host.stop();
    }
  }
}
