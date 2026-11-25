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
    pins: { levels: (1 << 14) | (1 << 25) | (1 << 5), outputs: (1 << 14) | (1 << 25) }, // GP14, GP25 outputs high; GP5 a pulled-up input
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

  it("a switch stays on until pressed again, and its options are saved per project (review 10, coverage)", () => {
    const label = () => [...host.querySelectorAll(".emu-label.gpio")].find((e) => e.textContent?.startsWith("GP14")) as HTMLElement;
    act(() => label().dispatchEvent(new MouseEvent("click", { bubbles: true })));
    const choose = (name: string) =>
      act(() => (([...host.querySelectorAll('.emu-options [role="radio"]')] as HTMLElement[]).find((b) => b.textContent === name)!.click()));
    choose("Switch");
    choose("high"); // "Pressed drives" high (first "high" in the options row)
    const press = () => {
      act(() => void button().dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1 })));
      act(() => void button().dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1 })));
    };
    press();
    expect(f.calls).toEqual([[14, true]]); // on: stays driven after the pointer goes up
    expect(button().getAttribute("aria-pressed")).toBe("true");
    press();
    expect(f.calls).toEqual([[14, true], [14, null]]); // off again
    press();
    const saved = JSON.parse(window.localStorage.getItem("boady.emulatorParts.p-dom")!);
    expect(saved).toEqual({ parts: { 14: { button: "toggle", drive: "high", led: "activeHigh" } }, on: [14] });
    // LED lit on low: GP14 is high in the fake pins, so its LED goes dark
    const leds = () => [...host.querySelectorAll(".emu-led")].filter((e) => e.closest("g")?.textContent?.includes("GP14"));
    expect(leds()[0].getAttribute("class")).toContain("lit");
    const lowButtons = ([...host.querySelectorAll('.emu-options [role="radio"]')] as HTMLElement[]).filter((b) => b.textContent === "low");
    act(() => lowButtons[1].click()); // "LED lights on" low
    expect(leds()[0].getAttribute("class")).not.toContain("lit");
  });

  it("drag pans, two fingers pinch, Ctrl+wheel and the buttons zoom (review 11, finding 3)", () => {
    const viewport = host.querySelector(".emu-viewport") as HTMLElement;
    const canvas = () => (host.querySelector(".emu-canvas") as HTMLElement).style.transform;
    const ptr = (type: string, id: number, x: number, y: number) =>
      act(() => void viewport.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: id, clientX: x, clientY: y })));
    expect(canvas()).toBe("translate(0px, 0px) scale(1)");
    // one pointer on the background drags the board
    ptr("pointerdown", 1, 10, 10);
    ptr("pointermove", 1, 40, 30);
    ptr("pointerup", 1, 40, 30);
    expect(canvas()).toBe("translate(30px, 20px) scale(1)");
    // two fingers 100 px apart spread to 200 px around the same midpoint: twice as big
    ptr("pointerdown", 1, 50, 100);
    ptr("pointerdown", 2, 150, 100);
    ptr("pointermove", 1, 0, 100);
    ptr("pointermove", 2, 200, 100);
    ptr("pointerup", 1, 0, 100);
    ptr("pointerup", 2, 200, 100);
    expect(canvas()).toBe("translate(-40px, -60px) scale(2)"); // (100,100) stays under the fingers
    // a press on a button does not move the board
    act(() => void button().dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 3, clientX: 0, clientY: 0 })));
    ptr("pointermove", 3, 90, 90);
    act(() => void button().dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 3 })));
    expect(canvas()).toBe("translate(-40px, -60px) scale(2)");
    // Ctrl+wheel zooms around the pointer; a plain wheel does not
    act(() => void viewport.dispatchEvent(new WheelEvent("wheel", { deltaY: 100, clientX: 0, clientY: 0, bubbles: true, cancelable: true })));
    expect(canvas()).toBe("translate(-40px, -60px) scale(2)");
    const wheel = new WheelEvent("wheel", { deltaY: -300 * Math.log(1.5), clientX: 0, clientY: 0, bubbles: true, cancelable: true });
    // happy-dom's WheelEvent ignores the mouse fields of its init (ctrlKey, clientX, clientY)
    for (const [k, v] of Object.entries({ ctrlKey: true, clientX: 0, clientY: 0 })) Object.defineProperty(wheel, k, { value: v });
    act(() => void viewport.dispatchEvent(wheel));
    expect(wheel.defaultPrevented).toBe(true); // the page itself does not zoom
    expect(canvas()).toMatch(/^translate\(-60(\.0+\d*)?px, -90(\.0+\d*)?px\) scale\(3(\.0+\d*)?\)$/);
    // reset
    act(() => (host.querySelector('[title="Reset zoom"]') as HTMLElement).click());
    expect(canvas()).toBe("translate(0px, 0px) scale(1)");
    act(() => (host.querySelector('[title="Zoom in"]') as HTMLElement).click());
    expect(canvas()).toBe("translate(0px, 0px) scale(1.25)"); // around the center of a 0x0 test viewport
  });

  it("LEDs light like real LEDs: only a driven pin lights its LED (review 11, Master)", () => {
    const ledOf = (pin: string) =>
      [...host.querySelectorAll(".emu-led")].find((e) => e.closest("g")?.querySelector(".emu-label")?.firstChild?.textContent === pin)!;
    expect(ledOf("GP14").getAttribute("class")).toContain("lit"); // output high
    expect(ledOf("GP5").getAttribute("class")).not.toContain("lit"); // pulled-up input, nothing drives it
    expect(host.querySelector(".emu-led-smd")!.getAttribute("class")).toContain("lit"); // GP25 output high
  });
});
