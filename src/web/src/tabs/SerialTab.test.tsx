// @vitest-environment happy-dom
/** Serial tab function keys (D46): per project type, no input line, Clear last. */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Backend } from "../backend";
import type { DeviceManager } from "../hw/device";
import { I18nContext, translate } from "../i18n";
import { SerialTab } from "./HardwareTabs";

vi.mock("../components/XtermConsole", () => ({ XtermConsole: () => <div className="xterm-stub" /> }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
});

function render(type: string | undefined, opts: { lock?: string | null; data?: boolean } = {}) {
  const sent: [string, string][] = [];
  const cleared: string[] = [];
  const dm = {
    subscribe: () => () => {},
    getVersion: () => 0,
    attached: true,
    busy: null,
    conns: { repl: {}, ...(opts.data ? { data: {} } : {}) },
    history: { repl: {}, data: {} },
    consoleWrite: async (port: string, s: string) => void sent.push([port, s]),
    clearTerminal: (port: string) => void cleared.push(port),
  } as unknown as DeviceManager;
  const backend = { state: { project: type ? { id: "p", type } : null, serial: { lock: { repl: opts.lock ?? null, data: null } } } } as unknown as Backend;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      <I18nContext.Provider value={{ lang: "en", t: (k: string, v?: Record<string, string | number>) => translate("en", k, v) } as any}>
        <SerialTab backend={backend} hw={dm} />
      </I18nContext.Provider>,
    ),
  );
  const keys = () => [...host.querySelectorAll(".serial-keys button")] as HTMLButtonElement[];
  return { sent, cleared, keys };
}

describe("Serial tab keys (D46)", () => {
  it("the same keys for both project types: Ctrl-C/D/E/A/B, then Clear; no input line", async () => {
    for (const type of ["micropython", "circuitpython"]) {
      const { sent, keys } = render(type);
      expect(keys().map((b) => b.querySelector(".serial-key-label")?.textContent ?? b.textContent)).toEqual([
        "Ctrl-C", "Ctrl-D", "Ctrl-E", "Ctrl-A", "Ctrl-B", "Clear",
      ]);
      expect(host.querySelector("input")).toBeNull();
      for (const b of keys().slice(0, 5)) await act(async () => b.click());
      expect(sent).toEqual([["repl", "\x03"], ["repl", "\x04"], ["repl", "\x05"], ["repl", "\x01"], ["repl", "\x02"]]);
      act(() => root!.unmount());
      host.remove();
      root = null;
    }
  });

  it("read-only: keys disabled, Clear still works", () => {
    const { keys, cleared } = render("micropython", { lock: "agent" });
    expect(keys().slice(0, -1).every((b) => b.disabled)).toBe(true);
    const clear = keys()[keys().length - 1];
    expect(clear.disabled).toBe(false);
    act(() => clear.click());
    expect(cleared).toEqual(["repl"]);
  });

  it("the data port shows only Clear", () => {
    const { keys } = render("circuitpython", { data: true });
    const dataTab = [...host.querySelectorAll(".subtabs button")].find((b) => b.textContent === "Data") as HTMLElement;
    act(() => dataTab.click());
    expect(keys().map((b) => b.textContent)).toEqual(["Clear"]);
  });
});
