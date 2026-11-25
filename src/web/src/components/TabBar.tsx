import { ChartLine, CircuitBoard, Cpu, FolderTree, GitBranch, Library, MessageSquare, Settings, Terminal } from "lucide-react";
import { useRef } from "react";
import type { ComponentType } from "react";
import { useI18n } from "../i18n";
import { TAB_IDS, type TabId } from "../layout/tabs";

export const TAB_ICONS: Record<TabId, ComponentType<{ size?: number }>> = {
  chat: MessageSquare,
  files: FolderTree,
  version: GitBranch,
  serial: Terminal,
  plot: ChartLine,
  library: Library,
  device: Cpu,
  emulator: CircuitBoard,
  settings: Settings,
};

interface Props {
  open: TabId[];
  /** Tabs not shown right now (D42: the Emulator tab outside test projects). */
  hidden?: readonly TabId[];
  landscape: boolean;
  badge: Partial<Record<TabId, boolean>>;
  onSelect(tab: TabId): void;
  onSelectModifier(tab: TabId): void;
  onSelectTwo(a: TabId, b: TabId): void;
}

export function TabBar({ open, hidden = [], landscape, badge, onSelect, onSelectModifier, onSelectTwo }: Props) {
  const { t } = useI18n();
  const twoFinger = useRef(false);

  const tabAt = (x: number, y: number): TabId | null => {
    const el = document.elementFromPoint(x, y)?.closest("[data-tab]") as HTMLElement | null;
    return (el?.dataset.tab as TabId) ?? null;
  };

  const onTouchStart = (e: React.TouchEvent) => {
    if (e.touches.length === 2) {
      const a = tabAt(e.touches[0].clientX, e.touches[0].clientY);
      const b = tabAt(e.touches[1].clientX, e.touches[1].clientY);
      if (a && b && a !== b) {
        twoFinger.current = true;
        e.preventDefault();
        onSelectTwo(a, b);
      }
    }
  };

  const onClick = (tab: TabId, e: React.MouseEvent) => {
    if (twoFinger.current) {
      // swallow the click synthesized after a two-finger press
      twoFinger.current = false;
      return;
    }
    if (e.ctrlKey || e.metaKey) onSelectModifier(tab);
    else onSelect(tab);
  };

  return (
    <nav className={`tabbar ${landscape ? "tabbar-top" : "tabbar-left"}`} onTouchStart={onTouchStart} role="tablist">
      {TAB_IDS.filter((id) => !hidden.includes(id)).map((id) => {
        const Icon = TAB_ICONS[id];
        const active = open.includes(id);
        return (
          <button
            key={id}
            data-tab={id}
            role="tab"
            aria-selected={active}
            title={t(`tab.${id}` as any)}
            className={`tab ${active ? "active" : ""}`}
            onClick={(e) => onClick(id, e)}
            onTouchEnd={() => setTimeout(() => (twoFinger.current = false), 400)}
          >
            <span className="tab-icon">
              <Icon size={20} />
              {badge[id] && <span className="badge" />}
            </span>
            {landscape && <span className="tab-label">{t(`tab.${id}` as any)}</span>}
          </button>
        );
      })}
    </nav>
  );
}
