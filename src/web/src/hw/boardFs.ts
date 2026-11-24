/**
 * Board filesystem over the raw REPL (same approach as `mpremote fs`), using
 * only os.listdir / os.stat / open, which CircuitPython and MicroPython share.
 */
import { parsePyBytes, pyBytes, pyPath, sha256hex } from "./bytes";
import { ExecError, type RawRepl } from "./rawRepl";

export interface BoardEntry {
  path: string; // "code.py", "lib/x.mpy" (no leading slash)
  size: number;
}

/** ``skip``: absolute board paths not to descend into (e.g. MicroPython's read-only /rom). */
const listCode = (skip: string[]) => `import os
_bs=(${skip.map((s) => `'${s}'`).join(",")}${skip.length === 1 ? "," : ""})
def _bw(p):
 for n in os.listdir(p or '/'):
  q=p+'/'+n
  if q in _bs:
   continue
  s=os.stat(q)
  if s[0]&0x4000:
   _bw(q)
  else:
   print('F',s[6],q)
_bw('')
del _bw,_bs`;

export async function listFiles(r: RawRepl, skip: string[] = []): Promise<BoardEntry[]> {
  const out = await r.exec(listCode(skip), 30000);
  const files: BoardEntry[] = [];
  for (const line of out.split(/\r?\n/)) {
    const m = line.match(/^F (\d+) \/(.+)$/);
    if (m) files.push({ path: m[2], size: Number(m[1]) });
  }
  return files;
}

export async function readFile(r: RawRepl, path: string): Promise<Uint8Array> {
  const out = await r.exec(`with open(${pyPath("/" + path)},'rb') as f:\n while 1:\n  b=f.read(512)\n  if not b:break\n  print(repr(b))`, 60000);
  const parts = out.split(/\r?\n/).filter((l) => l.startsWith("b'") || l.startsWith('b"')).map(parsePyBytes);
  const total = parts.reduce((n, p) => n + p.length, 0);
  const data = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    data.set(p, o);
    o += p.length;
  }
  return data;
}

/** sha256 of each path computed on the board, or null if hashlib is missing. */
export async function hashOnBoard(r: RawRepl, paths: string[]): Promise<Record<string, string> | null> {
  try {
    await r.exec("import hashlib\nhashlib.sha256");
  } catch (e) {
    if (e instanceof ExecError) return null;
    throw e;
  }
  const out: Record<string, string> = {};
  for (const p of paths) {
    const res = await r.exec(
      `h=hashlib.sha256()\nwith open(${pyPath("/" + p)},'rb') as f:\n while 1:\n  b=f.read(512)\n  if not b:break\n  h.update(b)\nprint(''.join('%02x'%c for c in h.digest()))`,
      60000,
    );
    out[p] = res.trim();
  }
  return out;
}

export async function hashFiles(r: RawRepl, paths: string[]): Promise<Record<string, string>> {
  const onBoard = await hashOnBoard(r, paths);
  if (onBoard) return onBoard;
  const out: Record<string, string> = {};
  for (const p of paths) out[p] = await sha256hex(await readFile(r, p));
  return out;
}

export async function mkdirs(r: RawRepl, path: string): Promise<void> {
  const parts = path.split("/").slice(0, -1);
  if (!parts.length) return;
  const dirs = parts.map((_, i) => "/" + parts.slice(0, i + 1).join("/"));
  await r.exec(`import os\nfor d in (${dirs.map(pyPath).join(",")},):\n try:\n  os.mkdir(d)\n except OSError:\n  pass`);
}

export async function writeFile(r: RawRepl, path: string, data: Uint8Array): Promise<void> {
  await mkdirs(r, path);
  await r.exec(`f=open(${pyPath("/" + path)},'wb')\nw=f.write`);
  for (let i = 0; i < data.length; i += 256) await r.exec(`w(${pyBytes(data.subarray(i, i + 256))})`);
  await r.exec("f.close()\ndel f,w");
}

/** Write, then verify by hash (board hashlib or read back); one retry. */
export async function writeVerified(r: RawRepl, path: string, data: Uint8Array): Promise<void> {
  const want = await sha256hex(data);
  for (let attempt = 0; attempt < 2; attempt++) {
    await writeFile(r, path, data);
    const got = (await hashFiles(r, [path]))[path];
    if (got === want) return;
  }
  throw new Error(`verification failed for ${path}`);
}

export async function removeFiles(r: RawRepl, paths: string[]): Promise<void> {
  if (!paths.length) return;
  const dirs = new Set<string>();
  for (const p of paths) {
    const parts = p.split("/");
    for (let i = parts.length - 1; i > 0; i--) dirs.add("/" + parts.slice(0, i).join("/"));
  }
  const sortedDirs = [...dirs].sort((a, b) => b.split("/").length - a.split("/").length);
  await r.exec(
    `import os\nfor p in (${paths.map((p) => pyPath("/" + p)).join(",")},):\n try:\n  os.remove(p)\n except OSError:\n  pass\n` +
      (sortedDirs.length ? `for d in (${sortedDirs.map(pyPath).join(",")},):\n try:\n  os.rmdir(d)\n except OSError:\n  pass` : ""),
  );
}
