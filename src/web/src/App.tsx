import { useEffect, useMemo, useState } from "react";
import { useBackend, type Backend } from "./backend";
import type { DeviceManager } from "./hw/device";
import { SplitView } from "./components/SplitView";
import { TabBar } from "./components/TabBar";
import { I18nContext, translate, type Lang } from "./i18n";
import { initialTabs, sanitize, selectOne, selectTwo, selectWithModifier, type TabId, type TabState } from "./layout/tabs";
import { useViewport } from "./layout/viewport";
import { Onboarding } from "./pages/Onboarding";
import { Offline, Pairing } from "./pages/Status";
import { ChatTab } from "./tabs/ChatTab";
import { FilesTab } from "./tabs/FilesTab";
import { DeviceTab, LibraryTab, PlotTab, SerialTab } from "./tabs/HardwareTabs";
import { SettingsTab } from "./tabs/SettingsTab";
import { VersionTab } from "./tabs/VersionTab";

const TABS_KEY = "boady.tabs";
const LANG_KEY = "boady.lang";

function load<T>(key: string, fallback: T): T {
  try {
    const v = window.localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
}

function store(key: string, value: unknown) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* ignore */
  }
}

export function App({ backend: b, hw }: { backend: Backend; hw: DeviceManager | null }) {
  const backend = useBackend(b);
  const { landscape, keyboard } = useViewport();
  const [tabs, setTabs] = useState<TabState>(() => sanitize(load(TABS_KEY, initialTabs())));
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [localLang, setLocalLang] = useState<Lang>(() => load<Lang>(LANG_KEY, "en"));

  const serverLang = backend.state?.prefs.language as Lang | undefined;
  const lang: Lang = serverLang === "en" || serverLang === "zh" ? serverLang : localLang;
  const i18n = useMemo(() => ({ lang, t: (k: string, v?: Record<string, string | number>) => translate(lang, k, v) }), [lang]);

  useEffect(() => {
    document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
  }, [lang]);

  const update = (s: TabState) => {
    setTabs(s);
    store(TABS_KEY, s);
  };

  const setLanguage = (l: Lang) => {
    setLocalLang(l);
    store(LANG_KEY, l);
    backend.action("prefs.set", { language: l }).catch(() => {});
  };

  const connected = backend.status === "connected" && backend.state !== null;
  const onboarding = connected && (!backend.state!.project || showOnboarding || !!backend.selectRequired);
  const chatVisible = connected && !onboarding && tabs.open.includes("chat");

  useEffect(() => {
    backend.setChatVisible(chatVisible);
  }, [backend, chatVisible]);

  // leave onboarding automatically when a project gets opened from there
  const projectId = backend.state?.project?.id;
  useEffect(() => {
    setShowOnboarding(false);
  }, [projectId]);

  let body;
  if (backend.status === "pairing" || backend.status === "badtoken") body = <Pairing backend={backend} />;
  else if (!connected) body = <Offline backend={backend} />;
  else if (onboarding)
    body = <Onboarding backend={backend} onDone={backend.state!.project ? () => setShowOnboarding(false) : undefined} />;
  else {
    const render = (id: TabId) => {
      switch (id) {
        case "chat":
          return <ChatTab backend={backend} />;
        case "files":
          return <FilesTab key={backend.state?.project?.id} backend={backend} landscape={landscape} />;
        case "version":
          return <VersionTab backend={backend} />;
        case "serial":
          return <SerialTab backend={backend} hw={hw} />;
        case "plot":
          return <PlotTab hw={hw} />;
        case "library":
          return <LibraryTab backend={backend} />;
        case "device":
          return <DeviceTab backend={backend} hw={hw} />;
        case "settings":
          return <SettingsTab backend={backend} onOpenOnboarding={() => setShowOnboarding(true)} onLanguage={setLanguage} />;
      }
    };
    const badge = { chat: !chatVisible && (backend.pending.size > 0 || backend.turnEndedUnseen) };
    body = (
      <div className={`shell ${landscape ? "shell-landscape" : "shell-portrait"}`}>
        <TabBar
          open={tabs.open}
          landscape={landscape}
          badge={badge}
          onSelect={(t) => update(selectOne(tabs, t))}
          onSelectModifier={(t) => update(selectWithModifier(tabs, t))}
          onSelectTwo={(a, c) => update(selectTwo(tabs, a, c))}
        />
        <main className="content">
          <SplitView panes={tabs.open.map((id) => <div key={id} className="pane-inner">{render(id)}</div>)} landscape={landscape} keyboard={keyboard} />
        </main>
      </div>
    );
  }

  return <I18nContext.Provider value={i18n as any}>{body}</I18nContext.Provider>;
}
