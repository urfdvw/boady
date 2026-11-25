/**
 * The Files tab's open file and unsaved text live here, outside React, so
 * closing the tab (only open tabs are mounted) or switching projects never
 * drops an edit. One entry per project.
 */
export interface OpenFile {
  path: string;
  file: { text?: string; binary?: boolean; size?: number };
  text: string; // editor content
  saved: string; // content on disk when last read or saved
}

const store = new Map<string, OpenFile | null>();

export const getOpen = (projectId: string | undefined): OpenFile | null => (projectId ? (store.get(projectId) ?? null) : null);

export function setOpen(projectId: string | undefined, f: OpenFile | null): void {
  if (projectId) store.set(projectId, f);
}

export const isDirty = (f: OpenFile | null): boolean => !!f && f.file.text !== undefined && f.text !== f.saved;

export const hasUnsaved = (): boolean => [...store.values()].some(isDirty);

if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", (e) => {
    if (hasUnsaved()) e.preventDefault();
  });
}

/** What the editor looked like when a file read was sent. */
export interface ReadTicket {
  seq: number; // increases with every read; only the newest may apply
  path: string;
  text: string; // editor text at request time
  opening: boolean; // user clicked a file (vs. background reload of the open one)
}

/**
 * Whether a read answer may replace the editor content. A late answer must
 * never overwrite typing: it applies only if no newer read started, the
 * editor text did not change since the request, and (for a background
 * reload) the same file is still open and has no unsaved edits.
 */
export function readApplies(
  ticket: ReadTicket,
  now: { seq: number; path: string | null; text: string; saved: string },
): boolean {
  if (ticket.seq !== now.seq || ticket.text !== now.text) return false;
  return ticket.opening || (now.path === ticket.path && now.text === now.saved);
}
