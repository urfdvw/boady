/**
 * Browser hardware adapter: Web Serial (REPL + optional data port) and the
 * CIRCUITPY drive through File System Access. Implements the frontend side of
 * the hw RPC (spec「MCP 工具与前后端分工」): serial.write, fs.read_all,
 * fs.plan, fs.apply. Project type and transport differences live only here.
 */
import type { Hardware, HardwareCaps, HwSink } from "../adapters/types";
import { fromBase64, fromUtf8, sha256hex, sleep, toBase64, utf8 } from "./bytes";
import { hashFiles, listFiles, readFile, removeFiles, writeVerified } from "./boardFs";
import { cpAutoreloadOff, cpAutoreloadRestore, cpFinishWrite, cpPrepareWrite, type CpWriteState } from "./cpAccess";
import * as msc from "./msc";
import { PlotBuffer } from "./plot";
import { RawRepl } from "./rawRepl";
import { PortConn } from "./serial";
import { bootOutUid, excluded, plan } from "./syncRules";
import { Terminal } from "./terminal";

export type PortName = "repl" | "data";

const SYNC_START = "\r\n[boady: syncing files…]\r\n";
const SYNC_END = "[boady: sync finished]\r\n";

/** Score how much a probe response looks like a REPL. */
export function replScore(text: string): number {
  let s = 0;
  if (text.includes(">>>")) s += 3;
  if (/KeyboardInterrupt|Traceback|REPL|soft reboot/.test(text)) s += 2;
  if (/CircuitPython|MicroPython/.test(text)) s += 2;
  return s;
}

export class DeviceManager implements Hardware {
  caps: HardwareCaps;
  mode = "browser" as const;
  conns: Partial<Record<PortName, PortConn>> = {};
  terms: Record<PortName, Terminal> = { repl: new Terminal(), data: new Terminal() };
  plot = new PlotBuffer(500);
  drive: FileSystemDirectoryHandle | null = null;
  driveOk = false; // permission granted for the stored handle
  busy: string | null = null;
  error: string | null = null;

  private sink: HwSink | null = null;
  private tap: RawRepl | null = null;
  private mutex: Promise<unknown> = Promise.resolve();
  private decoders: Record<PortName, TextDecoder> = { repl: new TextDecoder(), data: new TextDecoder() };
  private outbox: Record<PortName, Uint8Array[]> = { repl: [], data: [] };
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private connecting = false;
  private version = 0;
  private listeners = new Set<() => void>();

  constructor() {
    this.caps = { serial: "serial" in navigator, msc: msc.mscSupported() };
  }

  // ---- store plumbing for React ----
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getVersion = () => this.version;
  private bump() {
    this.version++;
    for (const l of this.listeners) l();
  }

  // ---- lifecycle ----
  bind(sink: HwSink): void {
    this.sink = sink;
  }

  async init(): Promise<void> {
    this.drive = await msc.loadDriveHandle();
    if (this.drive) this.driveOk = await msc.hasPermission(this.drive).catch(() => false);
    if (!this.caps.serial) return;
    navigator.serial.addEventListener("connect", () => this.autoConnect());
    navigator.serial.addEventListener("disconnect", (e: Event) => {
      const port = (e as any).target as SerialPort;
      if (Object.values(this.conns).some((c) => c?.port === port)) this.disconnect(false);
    });
    await this.autoConnect();
  }

  /** Called after the backend accepted the hello: (re)announce the board. */
  onConnected(): void {
    if (this.conns.repl) this.announce();
  }

  get attached(): boolean {
    return !!this.conns.repl;
  }

  private announce() {
    const info = this.conns.repl!.info;
    this.sink?.send({
      type: "device.attached",
      usb: { vid: info.vid ?? null, pid: info.pid ?? null, msc: null },
      ports: (Object.keys(this.conns) as PortName[]).filter((p) => this.conns[p]),
    });
  }

  /** User gesture: pick the board's port. */
  async requestBoard(): Promise<void> {
    this.error = null;
    try {
      await navigator.serial.requestPort();
    } catch {
      return; // chooser cancelled
    }
    await this.disconnect(true);
    await this.autoConnect();
  }

  /** User gesture: grant the second CDC interface (CircuitPython data port). */
  async requestDataPort(): Promise<void> {
    const info = this.conns.repl?.info;
    try {
      await navigator.serial.requestPort(info?.vid ? { filters: [{ usbVendorId: info.vid, usbProductId: info.pid }] } : undefined);
    } catch {
      return;
    }
    await this.disconnect(true);
    await this.autoConnect();
  }

  async autoConnect(): Promise<void> {
    if (this.attached || this.connecting || !this.caps.serial) return;
    this.connecting = true;
    try {
      const ports = await navigator.serial.getPorts();
      if (!ports.length) return;
      const key = (p: SerialPort) => `${p.getInfo().usbVendorId}:${p.getInfo().usbProductId}`;
      const group = ports.filter((p) => key(p) === key(ports[0])).slice(0, 2);
      const conns: PortConn[] = [];
      for (const p of group) {
        const c = new PortConn(p);
        try {
          await c.open();
          conns.push(c);
        } catch (e: any) {
          this.error = `serial_open_failed: ${e?.message || e}`;
        }
      }
      if (!conns.length) return;
      const [repl, data] = conns.length > 1 ? await this.probeRoles(conns) : [conns[0], undefined];
      this.conns = { repl, ...(data ? { data } : {}) };
      for (const name of ["repl", "data"] as PortName[]) {
        const c = this.conns[name];
        if (!c) continue;
        c.onData = (b) => this.onData(name, b);
        c.onLost = () => this.disconnect(false);
      }
      this.error = null;
      this.announce();
    } finally {
      this.connecting = false;
      this.bump();
    }
  }

  /** Two ports from one board: the one answering Ctrl-C / Enter like a REPL is the console. */
  private async probeRoles(conns: PortConn[]): Promise<[PortConn, PortConn]> {
    const seen = conns.map(() => "");
    conns.forEach((c, i) => (c.onData = (b) => (seen[i] += fromUtf8(b))));
    for (const c of conns) await c.write(utf8("\r\x03")).catch(() => {});
    await sleep(300);
    for (const c of conns) await c.write(utf8("\r")).catch(() => {});
    await sleep(1200);
    const scores = seen.map(replScore);
    const replIdx = scores[1] > scores[0] ? 1 : 0;
    return [conns[replIdx], conns[1 - replIdx]];
  }

  async disconnect(silent: boolean): Promise<void> {
    const conns = Object.values(this.conns).filter(Boolean) as PortConn[];
    if (!conns.length) return;
    this.conns = {};
    this.tap = null;
    for (const c of conns) await c.close();
    if (!silent || this.sink) this.sink?.send({ type: "device.detached" });
    this.bump();
  }

  // ---- serial streams ----
  private onData(port: PortName, b: Uint8Array) {
    if (port === "repl" && this.tap) {
      this.tap.feed(b);
      return;
    }
    this.toBackend(port, b);
    const text = this.decoders[port].decode(b, { stream: true });
    this.terms[port].write(text);
    if (port === "repl") this.plot.feed(text);
    this.bump();
  }

  private toBackend(port: PortName, b: Uint8Array) {
    this.outbox[port].push(b);
    if (!this.flushTimer) this.flushTimer = setTimeout(() => this.flush(), 30);
  }

  private flush() {
    this.flushTimer = null;
    for (const port of ["repl", "data"] as PortName[]) {
      const parts = this.outbox[port];
      if (!parts.length) continue;
      this.outbox[port] = [];
      const total = parts.reduce((n, p) => n + p.length, 0);
      const all = new Uint8Array(total);
      let o = 0;
      for (const p of parts) {
        all.set(p, o);
        o += p.length;
      }
      this.sink?.send({ type: "serial.data", port, b64: toBase64(all) });
    }
  }

  private marker(text: string) {
    const b = utf8(text);
    this.toBackend("repl", b);
    this.terms.repl.write(text);
    this.bump();
  }

  /** Serialise everything that writes to the REPL port. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.mutex.then(fn, fn);
    this.mutex = run.catch(() => {});
    return run;
  }

  private port(name: PortName): PortConn {
    const c = this.conns[name];
    if (!c) throw new Error(name === "data" ? "No data serial port is open." : "Device not connected.");
    return c;
  }

  /** User console input. Refused while the agent holds the port or a sync runs. */
  async consoleWrite(port: PortName, text: string): Promise<void> {
    const lock = this.sink?.state()?.serial.lock[port];
    if (lock === "agent" || (port === "repl" && this.busy)) throw new Error("read_only");
    const c = this.port(port);
    await this.exclusive(() => c.write(utf8(text)));
  }

  clearTerminal(port: PortName) {
    this.terms[port].clear();
    this.bump();
  }

  private async withRaw<T>(signal: AbortSignal, fn: (r: RawRepl) => Promise<T>): Promise<T> {
    const c = this.port("repl");
    return this.exclusive(async () => {
      this.busy = "sync";
      this.marker(SYNC_START);
      const r = new RawRepl(c, signal);
      this.tap = r;
      try {
        await r.enter();
        return await fn(r);
      } finally {
        try {
          await r.exit();
        } catch {
          /* port gone */
        }
        await sleep(50);
        this.tap = null;
        this.busy = null;
        this.marker(SYNC_END);
      }
    });
  }

  // ---- CIRCUITPY drive ----
  async chooseDrive(): Promise<void> {
    this.drive = await msc.pickDrive();
    this.driveOk = await msc.hasPermission(this.drive, true);
    this.bump();
  }

  async reauthorizeDrive(): Promise<void> {
    if (this.drive) this.driveOk = await msc.hasPermission(this.drive, true);
    this.bump();
  }

  async forgetDrive(): Promise<void> {
    this.drive = null;
    this.driveOk = false;
    await msc.saveDriveHandle(null);
    this.bump();
  }

  /** MSC only for CircuitPython, a granted drive, and a matching boot_out.txt UID. */
  async pickChannel(): Promise<"msc" | "serial"> {
    const st = this.sink?.state();
    let ch: "msc" | "serial" = "serial";
    if (st?.project?.type === "circuitpython" && this.drive && st.device.uid) {
      this.driveOk = await msc.hasPermission(this.drive).catch(() => false);
      if (this.driveOk) {
        const uid = bootOutUid((await msc.readText(this.drive, "boot_out.txt")) ?? "");
        if (uid && uid === st.device.uid) ch = "msc";
      }
    }
    if (st?.device.channel !== ch) this.sink?.send({ type: "device.update", channel: ch });
    return ch;
  }

  // ---- hw RPC ----
  async handle(op: string, params: any, signal: AbortSignal): Promise<any> {
    switch (op) {
      case "serial.write": {
        const c = this.port(params.port === "data" ? "data" : "repl");
        if (params.port !== "data" && this.busy) throw new Error("A file sync is running on the REPL port; try again when it finishes.");
        await this.exclusive(() => c.write(utf8(String(params.data ?? ""))));
        return {};
      }
      case "fs.read_all":
        return this.readAll(signal);
      case "fs.plan":
        return this.planSync(params.manifest || {}, signal);
      case "fs.apply":
        return this.apply(params.files || {}, params.delete || [], signal);
      default:
        throw new Error(`unknown hardware op ${op}`);
    }
  }

  private async readAll(signal: AbortSignal) {
    const files: Record<string, string> = {};
    if ((await this.pickChannel()) === "msc") {
      for (const [p, f] of await msc.walk(this.drive!)) {
        if (signal.aborted) throw new Error("cancelled");
        files[p] = toBase64(await msc.readBytes(f));
      }
      return { files, channel: "msc" };
    }
    await this.withRaw(signal, async (r) => {
      for (const e of await listFiles(r)) if (!excluded(e.path)) files[e.path] = toBase64(await readFile(r, e.path));
    });
    return { files, channel: "serial" };
  }

  private async planSync(manifest: Record<string, string>, signal: AbortSignal) {
    const board: Record<string, string> = {};
    if ((await this.pickChannel()) === "msc") {
      for (const [p, f] of await msc.walk(this.drive!)) {
        if (signal.aborted) throw new Error("cancelled");
        board[p] = await sha256hex(await msc.readBytes(f));
      }
    } else {
      await this.withRaw(signal, async (r) => {
        const paths = (await listFiles(r)).map((e) => e.path).filter((p) => !excluded(p));
        Object.assign(board, await hashFiles(r, paths));
      });
    }
    return plan(manifest, board);
  }

  private async apply(files: Record<string, string>, del: string[], signal: AbortSignal) {
    const type = this.sink?.state()?.project?.type;
    const written = Object.keys(files).sort();
    const deleted = del.filter((p) => !excluded(p)).sort();
    if ((await this.pickChannel()) === "msc") {
      let prev = true;
      await this.withRaw(signal, async (r) => {
        prev = await cpAutoreloadOff(r);
      });
      try {
        for (const p of written) {
          if (signal.aborted) throw new Error("cancelled");
          await msc.writeFile(this.drive!, p, fromBase64(files[p]));
        }
        for (const p of deleted) await msc.removeFile(this.drive!, p);
      } finally {
        await this.withRaw(new AbortController().signal, (r) => cpAutoreloadRestore(r, prev)).catch(() => {});
      }
      return { written, deleted, channel: "msc", restarted: false };
    }
    let restart = false;
    await this.withRaw(signal, async (r) => {
      let st: CpWriteState | null = null;
      try {
        if (type === "circuitpython") st = await cpPrepareWrite(r);
        for (const p of written) await writeVerified(r, p, fromBase64(files[p]));
        await removeFiles(r, deleted);
      } finally {
        if (st) await cpFinishWrite(r, st).catch(() => {});
      }
      restart = type === "circuitpython";
    });
    if (restart) await this.exclusive(() => this.port("repl").write(utf8("\x04"))); // soft reload runs code.py
    return { written, deleted, channel: "serial", restarted: restart };
  }
}
