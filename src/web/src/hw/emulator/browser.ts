/**
 * Browser start-up of the emulator: one virtual Pico per test project (D40),
 * its flash (firmware + files) and UID kept in IndexedDB across reloads.
 */
import { EmulatorLink, type PicoHost } from "./link";
import { FLASH_SIZE, randomUid, type PinState } from "./pico";

export type Runtime = "circuitpython" | "micropython";

export const FIRMWARE: Record<Runtime, { file: string; label: string }> = {
  micropython: { file: "micropython-rpi_pico-1.29.0.uf2", label: "MicroPython 1.29.0" },
  circuitpython: { file: "circuitpython-raspberry_pi_pico-10.3.2.uf2", label: "CircuitPython 10.3.2" },
};

/** The part of a Worker that WorkerHost uses (a real Worker, or a fake in tests). */
export interface WorkerLike {
  postMessage(msg: unknown, transfer?: Transferable[]): void;
  terminate(): void;
  onmessage: ((e: MessageEvent) => void) | null;
  onerror: ((e: ErrorEvent) => void) | null;
  onmessageerror: ((e: MessageEvent) => void) | null;
}

/**
 * Talks to pico.worker.ts. Every wait can fail: a Worker error, an error
 * reported by the Worker, or a timeout rejects it, and a crash while running
 * calls onLost (like an unplugged board).
 */
export class WorkerHost implements PicoHost {
  onData: (b: Uint8Array) => void = () => {};
  onLost: () => void = () => {};
  onFlashChanged: () => void = () => {};
  onPins: (p: PinState) => void = () => {};
  private readyP: Promise<void>;
  private readyRes!: () => void;
  private readyRej!: (e: Error) => void;
  private nextId = 1;
  private waits = new Map<number, { res: (f: Uint8Array) => void; rej: (e: Error) => void }>();
  private dead: Error | null = null;
  private started = false;

  constructor(
    private w: WorkerLike,
    private timeouts = { readyMs: 60000, flashMs: 20000 },
  ) {
    this.readyP = new Promise((res, rej) => ((this.readyRes = res), (this.readyRej = rej)));
    this.readyP.catch(() => {}); // observed via ready()
    w.onmessage = (e) => {
      const m = e.data;
      if (m.type === "data") this.onData(m.bytes);
      else if (m.type === "ready") {
        this.started = true;
        this.readyRes();
      } else if (m.type === "flash") {
        this.waits.get(m.id)?.res(m.flash);
        this.waits.delete(m.id);
      } else if (m.type === "flashChanged") this.onFlashChanged();
      else if (m.type === "pins") this.onPins(m.pins);
      else if (m.type === "error") this.fail(new Error(`emulator_failed: ${m.message}`));
    };
    w.onerror = (e) => this.fail(new Error(`emulator_failed: ${e.message || "worker error"}`));
    w.onmessageerror = () => this.fail(new Error("emulator_failed: unreadable message from the worker"));
  }

  private fail(err: Error) {
    if (this.dead) return;
    this.dead = err;
    this.readyRej(err);
    for (const w of this.waits.values()) w.rej(err);
    this.waits.clear();
    if (this.started) this.onLost();
  }

  write(b: Uint8Array) {
    if (!this.dead) this.w.postMessage({ type: "write", bytes: b });
  }

  setPin(pin: number, value: boolean | null) {
    if (!this.dead) this.w.postMessage({ type: "setPin", pin, value });
  }

  ready(): Promise<void> {
    return withTimeout(this.readyP, this.timeouts.readyMs, "emulator_failed: the firmware did not start");
  }

  flash(): Promise<Uint8Array> {
    if (this.dead) return Promise.reject(this.dead);
    const id = this.nextId++;
    const p = new Promise<Uint8Array>((res, rej) => this.waits.set(id, { res, rej }));
    this.w.postMessage({ type: "flash", id });
    return withTimeout(p, this.timeouts.flashMs, "emulator_failed: no flash image from the worker").finally(() => this.waits.delete(id));
  }

  stop() {
    try {
      this.w.postMessage({ type: "stop" });
    } catch {
      /* already gone */
    }
    setTimeout(() => this.w.terminate(), 100);
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([p, new Promise<T>((_, rej) => (timer = setTimeout(() => rej(new Error(message)), ms)))]).finally(() =>
    clearTimeout(timer),
  );
}

/** A UF2 starts with its block magic; anything else (an error page, a truncated file) is refused. */
export function checkFirmware(bytes: Uint8Array, name: string): Uint8Array {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 512 || bytes.length % 512 !== 0 || v.getUint32(0, true) !== 0x0a324655 || v.getUint32(4, true) !== 0x9e5d5157) {
    throw new Error(`emulator_failed: ${name} is not a UF2 firmware image`);
  }
  return bytes;
}

// ---- IndexedDB: { flash, uid } per runtime ----
const DB = "boady-emulator";
const STORE = "boards";

function db(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

async function idb<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const d = await db();
  return new Promise((res, rej) => {
    const req = fn(d.transaction(STORE, mode).objectStore(STORE));
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}

export interface Saved {
  flash: Uint8Array | null;
  uid: Uint8Array;
}

/** Storage key of a project's virtual board. */
const key = (projectId: string) => `project:${projectId}`;

/** Exported for tests. */
export async function load(projectId: string): Promise<Saved | undefined> {
  try {
    return await idb<Saved | undefined>("readonly", (s) => s.get(key(projectId)));
  } catch {
    return undefined;
  }
}

/** Exported for tests. */
export async function store(projectId: string, saved: Saved): Promise<void> {
  try {
    await idb("readwrite", (s) => s.put(saved, key(projectId)));
  } catch {
    /* storage unavailable: the emulator starts fresh next time */
  }
}

/** Forget the emulator's files (its UID is kept, so it stays bound to its project). */
export async function resetEmulatorStorage(projectId: string): Promise<void> {
  const saved = await load(projectId);
  if (saved) await store(projectId, { flash: null, uid: saved.uid });
}

/** Start the virtual board of a test project (its own files and UID). */
export async function startEmulator(projectId: string, rt: Runtime): Promise<EmulatorLink> {
  const fw = FIRMWARE[rt];
  const saved = (await load(projectId)) ?? { flash: null, uid: randomUid() };
  await store(projectId, saved);
  const res = await fetch(`./emulator/firmware/${fw.file}`);
  if (!res.ok) throw new Error(`emulator_failed: firmware download returned HTTP ${res.status}`);
  const firmware = checkFirmware(new Uint8Array(await res.arrayBuffer()), fw.file);
  const worker = new Worker(new URL("./pico.worker.ts", import.meta.url), { type: "module" });
  const host = new WorkerHost(worker);
  const flash = saved.flash && saved.flash.length === FLASH_SIZE ? saved.flash : null;
  worker.postMessage({ type: "start", firmware, flash, uid: saved.uid });
  try {
    await host.ready();
  } catch (e) {
    host.stop();
    throw e;
  }
  return new EmulatorLink(host, { runtime: rt, firmware: fw.label, project: projectId }, (f) => store(projectId, { flash: f, uid: saved.uid }));
}
