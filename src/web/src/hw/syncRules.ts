import EXCLUDE from "../../../shared/sync_exclude.json";

/** Files never synced in either direction; one list with the backend (src/shared, D47). */
const EXCLUDE_NAMES = new Set(EXCLUDE.names);

export function excluded(path: string): boolean {
  const p = path.replace(/^\/+|\/+$/g, "");
  if (EXCLUDE.root_files.includes(p)) return true;
  return p.split("/").some((part) => EXCLUDE_NAMES.has(part) || EXCLUDE.prefixes.some((x) => part.startsWith(x)));
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
