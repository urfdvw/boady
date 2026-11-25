/**
 * Raw REPL protocol, ported from mpremote 1.29.0 (transport_serial.py):
 * enter with "\r\x03" + "\r\x01", run code by sending it followed by "\x04",
 * expect "OK", then stdout up to "\x04" and stderr up to "\x04".
 * Plain raw mode only (no raw-paste), 256-byte writes every 10 ms.
 */
import { concat, fromUtf8, indexOf, sleep, utf8 } from "./bytes";

export class ReplError extends Error {}
export class ExecError extends ReplError {
  constructor(public stdout: string, public stderr: string) {
    super(stderr.trim().split("\n").pop() || "exec error");
  }
}

export interface Writer {
  write(data: Uint8Array): Promise<void>;
}

const BANNER = utf8("raw REPL; CTRL-B to exit\r\n");

export class RawRepl {
  private buf: Uint8Array = new Uint8Array(0);
  private waiter: (() => void) | null = null;

  constructor(private out: Writer, private signal?: AbortSignal) {}

  /** Feed bytes received from the port while this session is active. */
  feed(chunk: Uint8Array): void {
    this.buf = concat(this.buf, chunk);
    this.waiter?.();
  }

  /** Use another abort signal, e.g. for cleanup after the original one was cancelled. */
  rearm(signal: AbortSignal): void {
    this.signal = signal;
  }

  private check() {
    if (this.signal?.aborted) throw new ReplError("cancelled");
  }

  async readUntil(pattern: Uint8Array, timeoutMs: number): Promise<Uint8Array> {
    const end = Date.now() + timeoutMs;
    for (;;) {
      this.check();
      const i = indexOf(this.buf, pattern);
      if (i >= 0) {
        const res = this.buf.slice(0, i + pattern.length);
        this.buf = this.buf.slice(i + pattern.length);
        return res;
      }
      const left = end - Date.now();
      if (left <= 0) throw new ReplError(`timeout waiting for ${JSON.stringify(fromUtf8(pattern))} (got ${JSON.stringify(fromUtf8(this.buf.slice(-80)))})`);
      await new Promise<void>((r) => {
        const t = setTimeout(r, Math.min(left, 200));
        this.waiter = () => {
          clearTimeout(t);
          r();
        };
      });
      this.waiter = null;
    }
  }

  async readExact(n: number, timeoutMs: number): Promise<Uint8Array> {
    const end = Date.now() + timeoutMs;
    while (this.buf.length < n) {
      this.check();
      if (Date.now() > end) throw new ReplError(`timeout reading ${n} bytes`);
      await sleep(10);
    }
    const res = this.buf.slice(0, n);
    this.buf = this.buf.slice(n);
    return res;
  }

  async enter(timeoutMs = 10000): Promise<void> {
    await this.out.write(utf8("\r\x03"));
    await sleep(100);
    await this.out.write(utf8("\x03"));
    await sleep(200);
    this.buf = new Uint8Array(0); // flush input
    await this.out.write(utf8("\r\x01"));
    await this.readUntil(BANNER, timeoutMs);
  }

  async exec(code: string, timeoutMs = 10000): Promise<string> {
    await this.readUntil(utf8(">"), timeoutMs);
    const bytes = utf8(code);
    for (let i = 0; i < bytes.length; i += 256) {
      this.check();
      await this.out.write(bytes.subarray(i, i + 256));
      await sleep(10);
    }
    await this.out.write(utf8("\x04"));
    const ok = await this.readExact(2, timeoutMs);
    if (fromUtf8(ok) !== "OK") throw new ReplError(`could not exec command (response: ${JSON.stringify(fromUtf8(ok))})`);
    const stdout = fromUtf8((await this.readUntil(utf8("\x04"), timeoutMs)).slice(0, -1));
    const stderr = fromUtf8((await this.readUntil(utf8("\x04"), timeoutMs)).slice(0, -1));
    if (stderr) throw new ExecError(stdout, stderr);
    return stdout;
  }

  async exit(): Promise<void> {
    await this.out.write(utf8("\r\x02"));
  }
}
