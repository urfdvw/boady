/**
 * One open Web Serial port. Every port is opened with the same safe line
 * settings: DTR and RTS both asserted. Native USB CDC boards need DTR to send
 * console output; on ESP32-style auto-reset circuits (DTR->IO0, RTS->EN)
 * "both asserted" is the no-reset state. Never changed afterwards and never
 * exposed to the agent.
 */
export const BAUD = 115200;

/** What DeviceManager needs from a serial connection: a real port or the emulator. */
export interface SerialLink {
  readonly info: { vid?: number; pid?: number };
  /** The Web Serial port, or null for the emulator. */
  readonly port: SerialPort | null;
  /** Set for the testing-only emulator. */
  readonly emulated?: { runtime: string; firmware: string; /** owning test project */ project?: string };
  onData: (b: Uint8Array) => void;
  onLost: () => void;
  write(b: Uint8Array): Promise<void>;
  close(): Promise<void>;
}

export class PortConn implements SerialLink {
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private loop: Promise<void> | null = null;
  closed = false;
  onData: (b: Uint8Array) => void = () => {};
  onLost: () => void = () => {};

  constructor(public port: SerialPort) {}

  get info(): { vid?: number; pid?: number } {
    const i = this.port.getInfo();
    return { vid: i.usbVendorId, pid: i.usbProductId };
  }

  async open(): Promise<void> {
    await this.port.open({ baudRate: BAUD, bufferSize: 64 * 1024 });
    try {
      await this.port.setSignals({ dataTerminalReady: true, requestToSend: true });
    } catch {
      /* some adapters do not support control lines */
    }
    this.writer = this.port.writable!.getWriter();
    this.loop = this.readLoop();
  }

  private async readLoop(): Promise<void> {
    while (!this.closed && this.port.readable) {
      this.reader = this.port.readable.getReader();
      try {
        for (;;) {
          const { value, done } = await this.reader.read();
          if (done) break;
          if (value?.length) this.onData(value);
        }
      } catch {
        break; // device lost
      } finally {
        this.reader.releaseLock();
        this.reader = null;
      }
    }
    if (!this.closed) {
      this.closed = true;
      this.onLost();
    }
  }

  async write(b: Uint8Array): Promise<void> {
    if (!this.writer || this.closed) throw new Error("serial port is closed");
    await this.writer.write(b);
  }

  async close(): Promise<void> {
    this.closed = true;
    try {
      await this.reader?.cancel();
    } catch {
      /* ignore */
    }
    await this.loop?.catch(() => {});
    try {
      this.writer?.releaseLock();
      await this.port.close();
    } catch {
      /* already gone */
    }
  }
}
