/**
 * The Emulator tab's virtual parts (D42): the Pico's header, an LED and a
 * button on every exposed GPIO, their per-pin options, and pinch-zoom math.
 * Pure logic, no DOM.
 */

/** A header pin: its number (1–40), label, and GPIO number if it is one. */
export interface HeaderPin {
  n: number;
  label: string;
  gpio: number | null;
}

const pin = (n: number, label: string): HeaderPin => {
  const m = /^GP(\d+)$/.exec(label);
  return { n, label, gpio: m ? Number(m[1]) : null };
};

/** Left edge, top (USB end) to bottom: pins 1–20. */
export const LEFT_PINS: HeaderPin[] = [
  "GP0", "GP1", "GND", "GP2", "GP3", "GP4", "GP5", "GND", "GP6", "GP7",
  "GP8", "GP9", "GND", "GP10", "GP11", "GP12", "GP13", "GND", "GP14", "GP15",
].map((l, i) => pin(i + 1, l));

/** Right edge, top to bottom: pins 40 down to 21. */
export const RIGHT_PINS: HeaderPin[] = [
  "VBUS", "VSYS", "GND", "3V3_EN", "3V3(OUT)", "ADC_VREF", "GP28", "GND", "GP27", "GP26",
  "RUN", "GP22", "GND", "GP21", "GP20", "GP19", "GP18", "GND", "GP17", "GP16",
].map((l, i) => pin(40 - i, l));

/** The on-board LED of the Pico. */
export const ONBOARD_LED = 25;

/** Every GPIO with a header pin, sorted. */
export const HEADER_GPIOS: number[] = [...LEFT_PINS, ...RIGHT_PINS]
  .map((p) => p.gpio)
  .filter((g): g is number => g !== null)
  .sort((a, b) => a - b);

export interface PinParts {
  /** momentary: pressed while held; toggle: a switch, on until pressed again. */
  button: "momentary" | "toggle";
  /** Level the button applies when pressed / on; released / off applies nothing. */
  drive: "high" | "low";
  /** The LED is lit when the level is high (activeHigh) or low (activeLow). */
  led: "activeHigh" | "activeLow";
}

/** A button to GND with the pin's pull-up is the common wiring. */
export const DEFAULT_PARTS: PinParts = { button: "momentary", drive: "low", led: "activeHigh" };

export const isLit = (p: PinParts, level: boolean): boolean => (p.led === "activeHigh" ? level : !level);

/** What the button applies to the pin: a level, or ``null`` (not driven: the pull decides). */
export const driveOf = (p: PinParts, active: boolean): boolean | null => (active ? p.drive === "high" : null);

export const bit = (mask: number, i: number): boolean => ((mask >>> i) & 1) === 1;

/** Options of all pins of a project; anything unreadable falls back to the defaults. */
export function readParts(raw: unknown): Record<number, PinParts> {
  const out: Record<number, PinParts> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const g = Number(k);
    if (!HEADER_GPIOS.includes(g) || !v || typeof v !== "object") continue;
    const o = v as Partial<PinParts>;
    out[g] = {
      button: o.button === "toggle" ? "toggle" : "momentary",
      drive: o.drive === "high" ? "high" : "low",
      led: o.led === "activeLow" ? "activeLow" : "activeHigh",
    };
  }
  return out;
}

export const partsOf = (all: Record<number, PinParts>, gpio: number): PinParts => all[gpio] ?? DEFAULT_PARTS;

// ---- saved per project (a viewer convenience: localStorage) ----

/** Pin options and the switches that are on. */
export interface SavedParts {
  parts: Record<number, PinParts>;
  on: number[];
}

/** The part of Storage used here (``window.localStorage``, or a fake in tests). */
export interface KeyValue {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
}

const partsKey = (projectId: string) => `boady.emulatorParts.${projectId}`;

export function browserStorage(): KeyValue | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

export function loadParts(projectId: string | undefined, kv: KeyValue | null = browserStorage()): SavedParts {
  if (!projectId || !kv) return { parts: {}, on: [] };
  try {
    const raw = JSON.parse(kv.getItem(partsKey(projectId)) || "null");
    const parts = readParts(raw?.parts);
    const on = Array.isArray(raw?.on) ? raw.on.filter((g: unknown) => typeof g === "number" && parts[g]?.button === "toggle") : [];
    return { parts, on };
  } catch {
    return { parts: {}, on: [] };
  }
}

export function storeParts(projectId: string | undefined, s: SavedParts, kv: KeyValue | null = browserStorage()): void {
  if (!projectId || !kv) return;
  try {
    kv.setItem(partsKey(projectId), JSON.stringify(s));
  } catch {
    /* storage unavailable: options last until reload */
  }
}

/** What the switches saved as on apply, as [gpio, level] (review 8: the emulator applies them at start). */
export function savedDrives(s: SavedParts): [number, boolean][] {
  return s.on.map((g) => [g, driveOf(partsOf(s.parts, g), true) as boolean]);
}

// ---- zoom ----

export interface View {
  scale: number;
  x: number;
  y: number;
}

export const MIN_SCALE = 0.5;
export const MAX_SCALE = 4;
const clamp = (s: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));

export interface Point {
  x: number;
  y: number;
}

/**
 * Two-finger pinch: the content point under the fingers' first midpoint stays
 * under their current midpoint, scaled by the change of finger distance.
 */
export function pinch(start: View, a0: Point, b0: Point, a: Point, b: Point): View {
  const d0 = Math.hypot(b0.x - a0.x, b0.y - a0.y) || 1;
  const d = Math.hypot(b.x - a.x, b.y - a.y);
  const scale = clamp(start.scale * (d / d0));
  const m0 = { x: (a0.x + b0.x) / 2, y: (a0.y + b0.y) / 2 };
  const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  // content point under m0: (m0 - start.xy) / start.scale
  const cx = (m0.x - start.x) / start.scale;
  const cy = (m0.y - start.y) / start.scale;
  return { scale, x: m.x - cx * scale, y: m.y - cy * scale };
}

/** Zoom by ``factor`` around a point (buttons: the center; Ctrl+wheel: the pointer). */
export function zoomAt(v: View, factor: number, at: Point): View {
  const scale = clamp(v.scale * factor);
  const cx = (at.x - v.x) / v.scale;
  const cy = (at.y - v.y) / v.scale;
  return { scale, x: at.x - cx * scale, y: at.y - cy * scale };
}
