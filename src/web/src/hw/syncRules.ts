/** Files never synced in either direction (mirrors backend sync.py). */
const EXCLUDE_NAMES = new Set([".DS_Store", ".Trashes", ".fseventsd", ".Spotlight-V100", "System Volume Information", "Thumbs.db"]);

export function excluded(path: string): boolean {
  const p = path.replace(/^\/+|\/+$/g, "");
  if (p === ".boady_id") return true;
  return p.split("/").some((part) => EXCLUDE_NAMES.has(part) || part.startsWith("._"));
}

/** Given the mirror manifest and board hashes, what to write and delete. */
export function plan(manifest: Record<string, string>, board: Record<string, string>): { need: string[]; delete: string[] } {
  const need = Object.keys(manifest)
    .filter((p) => !excluded(p) && board[p] !== manifest[p])
    .sort();
  const del = Object.keys(board)
    .filter((p) => !excluded(p) && !(p in manifest))
    .sort();
  return { need, delete: del };
}

/** UID line of boot_out.txt (CircuitPython), e.g. "UID:4150325537323115". */
export function bootOutUid(text: string): string | null {
  const m = text.match(/^UID:\s*([0-9A-Fa-f]+)\s*$/m);
  return m ? m[1].toUpperCase() : null;
}
