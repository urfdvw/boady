/**
 * Raw bytes a serial port produced, for the console (xterm.js does the
 * terminal emulation). Bounded: the oldest chunks are dropped beyond
 * ``limit`` bytes. A console replays ``bytes()`` when it opens and then
 * follows ``subscribe``.
 */
export class SerialHistory {
  private chunks: Uint8Array[] = [];
  private size = 0;
  private listeners = new Set<(b: Uint8Array | null) => void>();

  constructor(private limit = 256 * 1024) {}

  push(b: Uint8Array): void {
    this.chunks.push(b);
    this.size += b.length;
    while (this.size > this.limit && this.chunks.length > 1) this.size -= this.chunks.shift()!.length;
    for (const l of this.listeners) l(b);
  }

  /** Everything kept so far, as one array. */
  bytes(): Uint8Array {
    const out = new Uint8Array(this.size);
    let o = 0;
    for (const c of this.chunks) {
      out.set(c, o);
      o += c.length;
    }
    return out;
  }

  text(): string {
    return new TextDecoder().decode(this.bytes());
  }

  /** Called with each new chunk, and with null when the history is cleared. */
  subscribe(fn: (b: Uint8Array | null) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  clear(): void {
    this.chunks = [];
    this.size = 0;
    for (const l of this.listeners) l(null);
  }
}
