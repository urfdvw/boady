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
