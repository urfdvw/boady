import { describe, expect, it } from "vitest";
import {
  DEFAULT_PARTS,
  HEADER_GPIOS,
  HeldButtons,
  LEFT_PINS,
  MAX_SCALE,
  RIGHT_PINS,
  driveOf,
  isLit,
  onboardLit,
  pinch,
  readParts,
  zoomAt,
} from "./parts";

describe("emulator tab parts (D42)", () => {
  it("has the Pico's 40 header pins with GP0–GP22 and GP26–GP28", () => {
    expect([...LEFT_PINS, ...RIGHT_PINS].map((p) => p.n).sort((a, b) => a - b)).toEqual(Array.from({ length: 40 }, (_, i) => i + 1));
    expect(HEADER_GPIOS).toEqual([...Array.from({ length: 23 }, (_, i) => i), 26, 27, 28]);
    expect(LEFT_PINS[0]).toEqual({ n: 1, label: "GP0", gpio: 0 });
    expect(RIGHT_PINS[0]).toEqual({ n: 40, label: "VBUS", gpio: null });
    expect(RIGHT_PINS[19]).toEqual({ n: 21, label: "GP16", gpio: 16 });
  });

  it("LEDs light on high or on low; buttons drive their level or nothing", () => {
    expect(isLit(DEFAULT_PARTS, true, true)).toBe(true);
    expect(isLit({ ...DEFAULT_PARTS, led: "activeLow" }, true, true)).toBe(false);
    expect(isLit({ ...DEFAULT_PARTS, led: "activeLow" }, false, true)).toBe(true);
    // a real LED: nothing drives the pin (an input with only its pull resistor): dark
    expect(isLit(DEFAULT_PARTS, true, false)).toBe(false);
    expect(isLit({ ...DEFAULT_PARTS, led: "activeLow" }, false, false)).toBe(false);
    expect(driveOf(DEFAULT_PARTS, true)).toBe(false); // default: a button to GND
    expect(driveOf({ ...DEFAULT_PARTS, drive: "high" }, true)).toBe(true);
    expect(driveOf({ ...DEFAULT_PARTS, drive: "high" }, false)).toBeNull(); // released: the pull decides
  });

  it("reads saved options defensively", () => {
    expect(readParts({ 3: { button: "toggle", drive: "high", led: "activeLow" } })).toEqual({
      3: { button: "toggle", drive: "high", led: "activeLow" },
    });
    expect(readParts({ 3: { button: "weird" }, 25: DEFAULT_PARTS, 99: DEFAULT_PARTS, x: 1 })).toEqual({ 3: DEFAULT_PARTS });
    expect(readParts(null)).toEqual({});
    expect(readParts("garbage")).toEqual({});
  });

  it("pinch keeps the point between the fingers in place", () => {
    const start = { scale: 1, x: 0, y: 0 };
    // fingers 100 px apart around (100, 100) spread to 200 px: twice as big, (100, 100) stays
    const v = pinch(start, { x: 50, y: 100 }, { x: 150, y: 100 }, { x: 0, y: 100 }, { x: 200, y: 100 });
    expect(v.scale).toBe(2);
    expect({ x: (100 - v.x) / v.scale, y: (100 - v.y) / v.scale }).toEqual({ x: 100, y: 100 });
    // dragging both fingers pans
    const p = pinch(start, { x: 0, y: 0 }, { x: 100, y: 0 }, { x: 30, y: 40 }, { x: 130, y: 40 });
    expect(p).toEqual({ scale: 1, x: 30, y: 40 });
    // clamped
    expect(pinch(start, { x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 0 }, { x: 1000, y: 0 }).scale).toBe(MAX_SCALE);
  });

  it("zooms around a point", () => {
    const v = zoomAt({ scale: 1, x: 10, y: 10 }, 2, { x: 110, y: 60 });
    expect(v.scale).toBe(2);
    expect((110 - v.x) / v.scale).toBe(100);
    expect((60 - v.y) / v.scale).toBe(50);
  });

  it("releases every held push button (review 8: tab unmounted or window blurred while held)", () => {
    const calls: [number, boolean | null][] = [];
    const b = new HeldButtons((g, v) => calls.push([g, v]));
    b.press(14, false);
    b.press(3, true);
    expect(b.has(14)).toBe(true);
    expect(b.release(14)).toBe(true);
    expect(b.release(14)).toBe(false); // pointerup and lostpointercapture both arrive: released once
    expect(b.releaseAll()).toBe(true);
    expect(b.releaseAll()).toBe(false);
    expect(calls).toEqual([[14, false], [3, true], [14, null], [3, null]]);
  });

  it("the on-board LED is GP25 -> resistor -> LED -> GND, lit only when driven high (datasheet 2.1)", () => {
    const g25 = 1 << 25;
    expect(onboardLit({ levels: g25, outputs: g25 })).toBe(true); // output high
    expect(onboardLit({ levels: 0, outputs: g25 })).toBe(false); // output low
    expect(onboardLit({ levels: g25, outputs: 0 })).toBe(false); // input pulled up: no current worth seeing
  });
});
