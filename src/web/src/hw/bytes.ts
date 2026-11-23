/** Byte helpers shared by the serial, raw REPL and MSC code. */

const enc = new TextEncoder();
const dec = new TextDecoder();

export const utf8 = (s: string): Uint8Array => enc.encode(s);
export const fromUtf8 = (b: Uint8Array): string => dec.decode(b);

export function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

export function indexOf(hay: Uint8Array, needle: Uint8Array, from = 0): number {
  outer: for (let i = Math.max(0, from); i <= hay.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

export function toBase64(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}

export function fromBase64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function sha256hex(b: Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", b as BufferSource));
  return Array.from(d, (x) => x.toString(16).padStart(2, "0")).join("");
}

/** Python bytes literal (b'...') that round-trips any data. */
export function pyBytes(b: Uint8Array): string {
  let s = "b'";
  for (const c of b) {
    if (c === 0x5c) s += "\\\\";
    else if (c === 0x27) s += "\\'";
    else if (c >= 0x20 && c < 0x7f) s += String.fromCharCode(c);
    else s += "\\x" + c.toString(16).padStart(2, "0");
  }
  return s + "'";
}

/** Python expression for a str path (works in MicroPython and CircuitPython). */
export const pyPath = (p: string): string => pyBytes(utf8(p)) + ".decode()";

/** Parse a Python ``repr(bytes)`` such as ``b'ab\\x00\\n'`` or ``b"it's"``. */
export function parsePyBytes(repr: string): Uint8Array {
  const s = repr.trim();
  if (!(s.startsWith("b'") || s.startsWith('b"')) || s[s.length - 1] !== s[1]) throw new Error(`not a bytes repr: ${s.slice(0, 40)}`);
  const body = s.slice(2, -1);
  const out: number[] = [];
  const simple: Record<string, number> = { n: 10, r: 13, t: 9, "\\": 92, "'": 39, '"': 34, a: 7, b: 8, f: 12, v: 11, "0": 0 };
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch !== "\\") {
      out.push(ch.charCodeAt(0) & 0xff);
      continue;
    }
    const n = body[++i];
    if (n === "x") {
      out.push(parseInt(body.slice(i + 1, i + 3), 16));
      i += 2;
    } else if (n in simple) out.push(simple[n]);
    else throw new Error(`bad escape \\${n}`);
  }
  return Uint8Array.from(out);
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
