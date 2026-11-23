/**
 * Tab opening rules (spec「UI 初步设计」):
 * - tap / click: open only that tab;
 * - two fingers on two tabs: open both;
 * - Ctrl/Cmd click: open the two most recently selected tabs (incl. this one);
 *   Ctrl/Cmd clicking the tab that is already open alone changes nothing.
 * Every selection moves the tab to the front of the "recent" list. Open tabs
 * are always shown in fixed tab order (at most two).
 */

export const TAB_IDS = ["chat", "files", "version", "serial", "plot", "library", "device", "settings"] as const;
export type TabId = (typeof TAB_IDS)[number];

export interface TabState {
  open: TabId[]; // 1 or 2 tabs, in tab order
  recent: TabId[]; // most recently selected first
}

export const initialTabs = (): TabState => ({ open: ["chat"], recent: [...TAB_IDS] });

const order = (tabs: TabId[]): TabId[] => [...new Set(tabs)].sort((a, b) => TAB_IDS.indexOf(a) - TAB_IDS.indexOf(b));

const touch = (recent: TabId[], tab: TabId): TabId[] => [tab, ...recent.filter((t) => t !== tab)];

export function selectOne(s: TabState, tab: TabId): TabState {
  return { open: [tab], recent: touch(s.recent, tab) };
}

export function selectTwo(s: TabState, a: TabId, b: TabId): TabState {
  if (a === b) return selectOne(s, a);
  return { open: order([a, b]), recent: touch(touch(s.recent, a), b) };
}

export function selectWithModifier(s: TabState, tab: TabId): TabState {
  if (s.open.length === 1 && s.open[0] === tab) return s;
  const recent = touch(s.recent, tab);
  return { open: order(recent.slice(0, 2)), recent };
}

export function sanitize(s: unknown): TabState {
  const ok = (t: unknown): t is TabId => typeof t === "string" && (TAB_IDS as readonly string[]).includes(t);
  const v = s as Partial<TabState> | null;
  if (!v || !Array.isArray(v.open) || !Array.isArray(v.recent)) return initialTabs();
  const open = order(v.open.filter(ok)).slice(0, 2);
  const recent = [...new Set(v.recent.filter(ok))];
  for (const t of TAB_IDS) if (!recent.includes(t)) recent.push(t);
  return open.length ? { open, recent } : initialTabs();
}
