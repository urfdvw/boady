// @vitest-environment happy-dom
/**
 * The Emulator tab in a DOM (happy-dom): browser events must release held buttons (review 8/9).
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Backend } from "../backend";
import type { DeviceManager } from "../hw/device";
import { I18nContext, translate } from "../i18n";
import { EmulatorTab } from "./EmulatorTab";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function fakes() {
  const calls: [number, boolean | null][] = [];
  const pins = {
    pins: { levels: 1 << 14, outputs: 0 },
    subscribe: () => () => {},
    setPin: (g: number, v: boolean | null) => void calls.push([g, v]),
  };
  const hw = { subscribe: () => () => {}, getVersion: () => 0, emulated: { runtime: "micropython" }, emulatorPins: pins } as unknown as DeviceManager;
  const backend = { state: { project: { id: "p-dom", board: "rp2040js" } } } as unknown as Backend;
  return { calls, hw, backend };
}

describe("Emulator tab in a DOM", () => {
  let host: HTMLElement;
  let root: Root;
  let f: ReturnType<typeof fakes>;
  beforeEach(() => {
    window.localStorage.clear();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    f = fakes();
    act(() =>
      root.render(
        <I18nContext.Provider value={{ lang: "en", t: (k: string, v?: Record<string, string | number>) => translate("en", k, v) } as any}>
          <EmulatorTab backend={f.backend} hw={f.hw} />
          <button id="elsewhere">x</button>
        </I18nContext.Provider>,
      ),
    );
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });
  const button = () => host.querySelector('[aria-label="Button on GP14"]') as HTMLElement;
  const key = (el: Element, type: "keydown" | "keyup") => act(() => void el.dispatchEvent(new KeyboardEvent(type, { key: " ", bubbles: true })));

  it("pointer press and release drive the pin and let it go", () => {
    act(() => void button().dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1 })));
    act(() => void button().dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1 })));
    expect(f.calls).toEqual([[14, false], [14, null]]);
  });

  it("releases when the tab unmounts while a button is held", () => {
    button().focus();
    key(button(), "keydown");
    act(() => root.render(<div />));
    expect(f.calls).toEqual([[14, false], [14, null]]);
  });

  it("releases when the window loses focus while a button is held", () => {
    button().focus();
    key(button(), "keydown");
    act(() => void window.dispatchEvent(new Event("blur")));
    expect(f.calls).toEqual([[14, false], [14, null]]);
  });

  it("releases when focus moves away from a held button (Tab) and the key goes up elsewhere", () => {
    button().focus();
    key(button(), "keydown");
    const other = host.querySelector("#elsewhere") as HTMLElement;
    act(() => other.focus());
    key(other, "keyup");
    expect(f.calls).toEqual([[14, false], [14, null]]);
  });
});
