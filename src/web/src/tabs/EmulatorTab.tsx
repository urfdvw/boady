/**
 * Emulator tab (D42): the emulated Pico with a virtual LED (live level) and a
 * button (outside input) on every exposed GPIO. Only shown for test projects.
 */
import { Minus, Plus, RotateCcw } from "lucide-react";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { Backend } from "../backend";
import type { DeviceManager } from "../hw/device";
import type { EmulatorPins } from "../hw/emulator/link";
import type { PinState } from "../hw/emulator/pico";
import {
  DEFAULT_PARTS,
  LEFT_PINS,
  ONBOARD_LED,
  RIGHT_PINS,
  bit,
  driveOf,
  isLit,
  loadParts,
  partsOf,
  pinch,
  storeParts,
  zoomAt,
  type HeaderPin,
  type PinParts,
  type Point,
  type SavedParts,
  type View,
} from "../hw/emulator/parts";
import { useI18n } from "../i18n";
import { useDevice } from "./HardwareTabs";

const NO_PINS: PinState = { levels: 0, outputs: 0 };
const noSubscribe = () => () => {};

// board geometry (SVG units: 0.1 mm), the Pico is 21 x 51 mm with 2.54 mm pitch
const W = 210;
const H = 510;
const PITCH = 25.4;
const TOP = H / 2 - (19 * PITCH) / 2;
const PIN_X = { left: 16, right: W - 16 };
const LABEL_GAP = 14;
const LED_X = { left: -78, right: W + 78 };
const BTN_X = { left: -122, right: W + 122 };
const BTN_W = 30;
const BTN_H = 17;

export function EmulatorTab({ backend, hw }: { backend: Backend; hw: DeviceManager | null }) {
  const { t } = useI18n();
  const dm = useDevice(hw);
  const pins: EmulatorPins | null = dm?.emulatorPins ?? null;
  const subscribe = useMemo(() => (pins ? (fn: () => void) => pins.subscribe(fn) : noSubscribe), [pins]);
  const state = useSyncExternalStore(subscribe, () => pins?.pins ?? NO_PINS);
  const projectId = backend.state?.project?.id;
  const [saved, setSaved] = useState<SavedParts>(() => loadParts(projectId));
  // momentary buttons held right now (a ref: pointerup can come before the next render)
  const held = useRef(new Set<number>());
  const [, rerender] = useState(0);
  const [selected, setSelected] = useState<number | null>(null);
  const [view, setView] = useState<View>({ scale: 1, x: 0, y: 0 });
  const viewport = useRef<HTMLDivElement>(null);

  useEffect(() => setSaved(loadParts(projectId)), [projectId]);

  const update = (next: SavedParts) => {
    setSaved(next);
    storeParts(projectId, next);
  };

  // switches saved as on are applied by the emulator itself when it starts (browser.ts)

  const active = (g: number) => held.current.has(g) || saved.on.includes(g);

  const press = (g: number) => {
    const p = partsOf(saved.parts, g);
    if (p.button === "toggle") {
      const on = !saved.on.includes(g);
      update({ ...saved, on: on ? [...saved.on, g] : saved.on.filter((x) => x !== g) });
      pins?.setPin(g, driveOf(p, on));
    } else {
      held.current.add(g);
      rerender((n) => n + 1);
      pins?.setPin(g, driveOf(p, true));
    }
  };

  const release = (g: number) => {
    if (!held.current.delete(g)) return;
    rerender((n) => n + 1);
    pins?.setPin(g, null);
  };

  const setParts = (g: number, patch: Partial<PinParts>) => {
    const p = { ...partsOf(saved.parts, g), ...patch };
    const wasOn = saved.on.includes(g);
    const on = p.button === "toggle" ? saved.on : saved.on.filter((x) => x !== g);
    update({ parts: { ...saved.parts, [g]: p }, on });
    if (wasOn) pins?.setPin(g, p.button === "toggle" ? driveOf(p, true) : null);
  };

  // ---- pan and zoom: pointers on the background; two fingers pinch ----
  const pointers = useRef(new Map<number, Point>());
  const gesture = useRef<{ view: View; a0: Point; b0?: Point } | null>(null);
  const local = (e: { clientX: number; clientY: number }): Point => {
    const r = viewport.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const restart = () => {
    const [a, b] = [...pointers.current.values()];
    gesture.current = a ? { view, a0: a, b0: b } : null;
  };
  const onPointerDown = (e: React.PointerEvent) => {
    pointers.current.set(e.pointerId, local(e));
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    restart();
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!pointers.current.has(e.pointerId) || !gesture.current) return;
    pointers.current.set(e.pointerId, local(e));
    const g = gesture.current;
    const [a, b] = [...pointers.current.values()];
    if (g.b0 && b) setView(pinch(g.view, g.a0, g.b0, a, b));
    else if (!g.b0) setView({ ...g.view, x: g.view.x + a.x - g.a0.x, y: g.view.y + a.y - g.a0.y });
  };
  const onPointerUp = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
    restart();
  };

  // Ctrl/Cmd + wheel zooms (a non-passive listener, so the page itself does not zoom)
  useEffect(() => {
    const el = viewport.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      setView((v) => zoomAt(v, Math.exp(-e.deltaY / 300), { x: e.clientX - r.left, y: e.clientY - r.top }));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const zoomCenter = (f: number) => {
    const r = viewport.current?.getBoundingClientRect();
    setView((v) => zoomAt(v, f, { x: (r?.width ?? 0) / 2, y: (r?.height ?? 0) / 2 }));
  };

  const rows = useMemo(
    () => [
      ...LEFT_PINS.map((p, i) => ({ p, side: "left" as const, y: TOP + i * PITCH })),
      ...RIGHT_PINS.map((p, i) => ({ p, side: "right" as const, y: TOP + i * PITCH })),
    ],
    [],
  );

  const sel = selected === null ? null : partsOf(saved.parts, selected);

  return (
    <div className="emu-tab">
      <div className="emu-toolbar">
        <span className={pins ? "emu-status on" : "emu-status"}>{pins ? t("emu.running") : t("emu.notRunning")}</span>
        <span className="spacer" />
        <button className="btn icon" title={t("emu.zoomOut")} onClick={() => zoomCenter(1 / 1.25)}>
          <Minus size={16} />
        </button>
        <button className="btn icon" title={t("emu.zoomIn")} onClick={() => zoomCenter(1.25)}>
          <Plus size={16} />
        </button>
        <button className="btn icon" title={t("emu.zoomReset")} onClick={() => setView({ scale: 1, x: 0, y: 0 })}>
          <RotateCcw size={16} />
        </button>
      </div>
      {selected !== null && sel && (
        <div className="emu-options">
          <strong>GP{selected}</strong>
          <Choice
            label={t("emu.button")}
            value={sel.button}
            options={[["momentary", t("emu.momentary")], ["toggle", t("emu.toggle")]]}
            onChange={(v) => setParts(selected, { button: v as PinParts["button"] })}
          />
          <Choice
            label={t("emu.drive")}
            value={sel.drive}
            options={[["low", t("emu.low")], ["high", t("emu.high")]]}
            onChange={(v) => setParts(selected, { drive: v as PinParts["drive"] })}
          />
          <Choice
            label={t("emu.led")}
            value={sel.led}
            options={[["activeHigh", t("emu.activeHigh")], ["activeLow", t("emu.activeLow")]]}
            onChange={(v) => setParts(selected, { led: v as PinParts["led"] })}
          />
          <button className="btn" onClick={() => setSelected(null)}>
            {t("common.close")}
          </button>
        </div>
      )}
      <div
        className="emu-viewport"
        ref={viewport}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <div className="emu-canvas" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}>
          <svg viewBox={`${BTN_X.left - BTN_W / 2 - 8} -24 ${BTN_X.right - BTN_X.left + BTN_W + 16} ${H + 48}`} className={pins ? "" : "emu-off"}>
            <Board onboardLit={bit(state.levels, ONBOARD_LED)} />
            {rows.map(({ p, side, y }) => (
              <PinRow
                key={p.n}
                p={p}
                side={side}
                y={y}
                state={state}
                parts={p.gpio === null ? DEFAULT_PARTS : partsOf(saved.parts, p.gpio)}
                active={p.gpio !== null && active(p.gpio)}
                selected={p.gpio !== null && p.gpio === selected}
                enabled={!!pins}
                onSelect={() => p.gpio !== null && setSelected(p.gpio === selected ? null : p.gpio)}
                onPress={() => p.gpio !== null && press(p.gpio)}
                onRelease={() => p.gpio !== null && release(p.gpio)}
                t={t}
              />
            ))}
          </svg>
        </div>
      </div>
      <div className="emu-hint muted">{t("emu.hint")}</div>
    </div>
  );
}

function Choice(props: { label: string; value: string; options: [string, string][]; onChange: (v: string) => void }) {
  return (
    <div className="emu-choice" role="radiogroup" aria-label={props.label}>
      <span className="muted">{props.label}</span>
      {props.options.map(([v, text]) => (
        <button key={v} role="radio" aria-checked={props.value === v} className={`btn ${props.value === v ? "primary" : ""}`} onClick={() => props.onChange(v)}>
          {text}
        </button>
      ))}
    </div>
  );
}

function Board({ onboardLit }: { onboardLit: boolean }) {
  return (
    <g className="emu-board">
      <rect x={0} y={0} width={W} height={H} rx={10} className="emu-pcb" />
      {/* micro USB */}
      <rect x={W / 2 - 40} y={-14} width={80} height={44} rx={4} className="emu-metal" />
      {/* on-board LED (GP25) and BOOTSEL */}
      <rect x={52} y={52} width={14} height={9} rx={2} className={onboardLit ? "emu-led-smd lit" : "emu-led-smd"}>
        <title>LED (GP25)</title>
      </rect>
      <text x={59} y={78} className="emu-silk" textAnchor="middle">
        LED
      </text>
      <rect x={W / 2 - 18} y={110} width={36} height={28} rx={3} className="emu-metal" />
      <circle cx={W / 2} cy={124} r={9} className="emu-bootsel" />
      <text x={W / 2} y={156} className="emu-silk" textAnchor="middle">
        BOOTSEL
      </text>
      {/* RP2040 and flash */}
      <rect x={W / 2 - 36} y={250} width={72} height={72} rx={4} className="emu-chip" />
      <text x={W / 2} y={290} className="emu-chip-text" textAnchor="middle">
        RP2040
      </text>
      <rect x={W / 2 - 22} y={370} width={44} height={28} rx={2} className="emu-chip" />
      <text x={W / 2} y={490} className="emu-silk" textAnchor="middle">
        Pico (rp2040js)
      </text>
    </g>
  );
}

interface RowProps {
  p: HeaderPin;
  side: "left" | "right";
  y: number;
  state: PinState;
  parts: PinParts;
  active: boolean;
  selected: boolean;
  enabled: boolean;
  onSelect(): void;
  onPress(): void;
  onRelease(): void;
  t: (k: any, v?: Record<string, string | number>) => string;
}

function PinRow({ p, side, y, state, parts, active, selected, enabled, onSelect, onPress, onRelease, t }: RowProps) {
  const x = PIN_X[side];
  const left = side === "left";
  const labelX = left ? -LABEL_GAP : W + LABEL_GAP;
  const anchor = left ? "end" : "start";
  const kind = p.label === "GND" ? "gnd" : p.gpio === null ? "power" : "gpio";
  const hole = (
    <g>
      <rect x={x - 9} y={y - 9} width={18} height={18} rx={kind === "gnd" ? 2 : 9} className="emu-pad" />
      <circle cx={x} cy={y} r={5} className="emu-hole" />
    </g>
  );
  if (p.gpio === null) {
    return (
      <g>
        {hole}
        <text x={labelX} y={y + 4} textAnchor={anchor} className={`emu-label ${kind}`}>
          {p.label}
        </text>
      </g>
    );
  }
  const g = p.gpio;
  const level = bit(state.levels, g);
  const out = bit(state.outputs, g);
  const lit = enabled && isLit(parts, level);
  const desc = t("emu.pinTitle", {
    pin: `GP${g}`,
    dir: out ? t("emu.output") : t("emu.input"),
    level: level ? t("emu.high") : t("emu.low"),
  });
  const stop = (e: React.PointerEvent) => e.stopPropagation();
  return (
    <g>
      {hole}
      <line x1={left ? LED_X.left + 9 : W + 6} x2={left ? -6 : LED_X.right - 9} y1={y} y2={y} className="emu-wire" />
      <circle cx={LED_X[side]} cy={y} r={8} className={`emu-led ${lit ? "lit" : ""}`}>
        <title>{desc}</title>
      </circle>
      <line x1={left ? BTN_X.left + BTN_W / 2 : LED_X.right + 9} x2={left ? LED_X.left - 9 : BTN_X.right - BTN_W / 2} y1={y} y2={y} className="emu-wire" />
      <text
        x={labelX}
        y={y + 4}
        textAnchor={anchor}
        className={`emu-label gpio ${out ? "out" : ""} ${selected ? "selected" : ""}`}
        role="button"
        tabIndex={0}
        onPointerDown={stop}
        onClick={onSelect}
        onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && onSelect()}
      >
        {p.label}
        <title>{desc}</title>
      </text>
      <g
        role="button"
        tabIndex={enabled ? 0 : -1}
        aria-pressed={active}
        aria-label={t("emu.buttonFor", { pin: `GP${g}` })}
        className={`emu-btn ${active ? "down" : ""} ${parts.button}`}
        onPointerDown={(e) => {
          stop(e);
          if (!enabled) return;
          (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
          onPress();
        }}
        onPointerUp={(e) => {
          stop(e);
          onRelease();
        }}
        onPointerCancel={onRelease}
        onLostPointerCapture={onRelease}
        onKeyDown={(e) => {
          if (enabled && (e.key === " " || e.key === "Enter") && !e.repeat) {
            e.preventDefault();
            onPress();
          }
        }}
        onKeyUp={(e) => (e.key === " " || e.key === "Enter") && onRelease()}
      >
        <rect x={BTN_X[side] - BTN_W / 2} y={y - BTN_H / 2} width={BTN_W} height={BTN_H} rx={parts.button === "toggle" ? 8 : 3} />
        <text x={BTN_X[side]} y={y + 4} textAnchor="middle">
          {parts.drive === "high" ? "H" : "L"}
        </text>
      </g>
    </g>
  );
}
