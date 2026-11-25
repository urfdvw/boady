/**
 * Browser start-up of the testing-only emulator: one virtual Pico per runtime,
 * its flash (firmware + files) and UID kept in IndexedDB across reloads.
 */
import { EmulatorLink, type PicoHost } from "./link";
import { FLASH_SIZE, randomUid } from "./pico";

export type Runtime = "circuitpython" | "micropython";

export const FIRMWARE: Record<Runtime, { file: string; label: string }> = {
  micropython: { file: "micropython-rpi_pico-1.29.0.uf2", label: "MicroPython 1.29.0" },
  circuitpython: { file: "circuitpython-raspberry_pi_pico-10.3.2.uf2", label: "CircuitPython 10.3.2" },
};

class WorkerHost implements PicoHost {
  onData: (b: Uint8Array) => void = () => {};
  private readyP: Promise<void>;
  private nextId = 1;
  private waits = new Map<number, (f: Uint8Array) => void>();

  constructor(private w: Worker) {
    let ready = () => {};
    this.readyP = new Promise((r) => (ready = r));
    w.onmessage = (e) => {
      const m = e.data;
      if (m.type === "data") this.onData(m.bytes);
      else if (m.type === "ready") ready();
      else if (m.type === "flash") {
        this.waits.get(m.id)?.(m.flash);
        this.waits.delete(m.id);
      }
    };
  }
  write(b: Uint8Array) {
    this.w.postMessage({ type: "write", bytes: b });
  }
  ready() {
    return this.readyP;
  }
  flash() {
    const id = this.nextId++;
    return new Promise<Uint8Array>((r) => {
      this.waits.set(id, r);
      this.w.postMessage({ type: "flash", id });
    });
  }
  stop() {
    this.w.postMessage({ type: "stop" });
    setTimeout(() => this.w.terminate(), 100);
  }
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

interface Saved {
  flash: Uint8Array | null;
  uid: Uint8Array;
}

async function load(rt: Runtime): Promise<Saved | undefined> {
  try {
    return await idb<Saved | undefined>("readonly", (s) => s.get(rt));
  } catch {
    return undefined;
  }
}

async function store(rt: Runtime, saved: Saved): Promise<void> {
  try {
    await idb("readwrite", (s) => s.put(saved, rt));
  } catch {
    /* storage unavailable: the emulator starts fresh next time */
  }
}

/** Forget the emulator's files (its UID is kept, so it stays bound to its project). */
export async function resetEmulatorStorage(rt: Runtime): Promise<void> {
  const saved = await load(rt);
  if (saved) await store(rt, { flash: null, uid: saved.uid });
}

export async function startEmulator(rt: Runtime): Promise<EmulatorLink> {
  const fw = FIRMWARE[rt];
  const saved = (await load(rt)) ?? { flash: null, uid: randomUid() };
  await store(rt, saved);
  const firmware = new Uint8Array(await (await fetch(`./emulator/firmware/${fw.file}`)).arrayBuffer());
  const worker = new Worker(new URL("./pico.worker.ts", import.meta.url), { type: "module" });
  const host = new WorkerHost(worker);
  const flash = saved.flash && saved.flash.length === FLASH_SIZE ? saved.flash : null;
  worker.postMessage({ type: "start", firmware, flash, uid: saved.uid });
  await host.ready();
  return new EmulatorLink(host, { runtime: rt, firmware: fw.label }, (f) => store(rt, { flash: f, uid: saved.uid }));
}
