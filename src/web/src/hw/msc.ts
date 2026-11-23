/**
 * MSC channel (CircuitPython only): the CIRCUITPY drive mounted by the OS,
 * accessed through the File System Access API. The chosen directory handle is
 * kept in IndexedDB so the user picks the drive only once.
 */
import { excluded } from "./syncRules";

const DB = "boady";
const STORE = "handles";
const KEY = "circuitpy";

function idb(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}

export async function saveDriveHandle(h: FileSystemDirectoryHandle | null): Promise<void> {
  try {
    const db = await idb();
    await new Promise<void>((res, rej) => {
      const tx = db.transaction(STORE, "readwrite");
      if (h) tx.objectStore(STORE).put(h, KEY);
      else tx.objectStore(STORE).delete(KEY);
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
  } catch {
    /* storage unavailable: the drive must be chosen again next time */
  }
}

export async function loadDriveHandle(): Promise<FileSystemDirectoryHandle | null> {
  try {
    const db = await idb();
    return await new Promise((res) => {
      const req = db.transaction(STORE).objectStore(STORE).get(KEY);
      req.onsuccess = () => res((req.result as FileSystemDirectoryHandle) ?? null);
      req.onerror = () => res(null);
    });
  } catch {
    return null;
  }
}

export const mscSupported = () => typeof window !== "undefined" && "showDirectoryPicker" in window;

/** Must be called from a user gesture. */
export async function pickDrive(): Promise<FileSystemDirectoryHandle> {
  const h: FileSystemDirectoryHandle = await (window as any).showDirectoryPicker({ id: "circuitpy", mode: "readwrite" });
  await saveDriveHandle(h);
  return h;
}

export async function hasPermission(h: FileSystemDirectoryHandle, request = false): Promise<boolean> {
  const opts = { mode: "readwrite" } as any;
  if ((await (h as any).queryPermission(opts)) === "granted") return true;
  return request ? (await (h as any).requestPermission(opts)) === "granted" : false;
}

export async function walk(h: FileSystemDirectoryHandle, prefix = ""): Promise<Map<string, FileSystemFileHandle>> {
  const out = new Map<string, FileSystemFileHandle>();
  for await (const [name, entry] of (h as any).entries() as AsyncIterable<[string, FileSystemHandle]>) {
    const path = prefix + name;
    if (excluded(path)) continue;
    if (entry.kind === "directory") for (const [p, f] of await walk(entry as FileSystemDirectoryHandle, path + "/")) out.set(p, f);
    else out.set(path, entry as FileSystemFileHandle);
  }
  return out;
}

export async function readText(h: FileSystemDirectoryHandle, name: string): Promise<string | null> {
  try {
    return await (await (await h.getFileHandle(name)).getFile()).text();
  } catch {
    return null;
  }
}

export async function readBytes(f: FileSystemFileHandle): Promise<Uint8Array> {
  return new Uint8Array(await (await f.getFile()).arrayBuffer());
}

async function dirFor(root: FileSystemDirectoryHandle, path: string, create: boolean): Promise<FileSystemDirectoryHandle> {
  let d = root;
  for (const part of path.split("/").slice(0, -1)) d = await d.getDirectoryHandle(part, { create });
  return d;
}

export async function writeFile(root: FileSystemDirectoryHandle, path: string, data: Uint8Array): Promise<void> {
  const d = await dirFor(root, path, true);
  const f = await d.getFileHandle(path.split("/").pop()!, { create: true });
  const w = await (f as any).createWritable();
  await w.write(data);
  await w.close();
}

export async function removeFile(root: FileSystemDirectoryHandle, path: string): Promise<void> {
  const parts = path.split("/");
  try {
    const d = await dirFor(root, path, false);
    await d.removeEntry(parts[parts.length - 1]);
  } catch {
    return;
  }
  // prune directories that became empty
  for (let i = parts.length - 1; i > 0; i--) {
    try {
      const parent = await dirFor(root, parts.slice(0, i).join("/"), false);
      const name = parts[i - 1];
      const dir = await parent.getDirectoryHandle(name);
      let empty = true;
      for await (const _ of (dir as any).keys()) {
        empty = false;
        break;
      }
      if (!empty) break;
      await parent.removeEntry(name);
    } catch {
      break;
    }
  }
}
