/** In-memory FileSystemDirectoryHandle for tests of the MSC channel. */
export class FakeDir {
  kind = "directory" as const;
  children = new Map<string, FakeDir | FakeFile>();
  constructor(public name = "") {}
  async queryPermission() {
    return "granted";
  }
  async requestPermission() {
    return "granted";
  }
  async getDirectoryHandle(name: string, opts?: { create?: boolean }) {
    let d = this.children.get(name);
    if (!d && opts?.create) this.children.set(name, (d = new FakeDir(name)));
    if (!(d instanceof FakeDir)) throw new DOMException("not found", "NotFoundError");
    return d;
  }
  async getFileHandle(name: string, opts?: { create?: boolean }) {
    let f = this.children.get(name);
    if (!f && opts?.create) this.children.set(name, (f = new FakeFile(name, new Uint8Array())));
    if (!(f instanceof FakeFile)) throw new DOMException("not found", "NotFoundError");
    return f;
  }
  onRemove: (name: string) => void = () => {};
  async removeEntry(name: string) {
    if (!this.children.delete(name)) throw new DOMException("not found", "NotFoundError");
    this.onRemove(name);
  }
  async *entries() {
    yield* this.children.entries();
  }
  async *keys() {
    yield* this.children.keys();
  }
}

export class FakeFile {
  kind = "file" as const;
  constructor(public name: string, public data: Uint8Array) {}
  async getFile() {
    const data = this.data;
    return { arrayBuffer: async () => data.slice().buffer, text: async () => new TextDecoder().decode(data) };
  }
  async createWritable() {
    const parts: Uint8Array[] = [];
    return {
      write: async (b: Uint8Array) => void parts.push(b),
      close: async () => {
        this.data = Uint8Array.from(parts.flatMap((p) => Array.from(p)));
      },
    };
  }
}
