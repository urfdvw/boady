import { Download, Pause, Play, RefreshCw, Trash2, Upload } from "lucide-react";
import { XtermConsole } from "../components/XtermConsole";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { Backend } from "../backend";
import type { DeviceManager, PortName } from "../hw/device";
import { translateError, useI18n } from "../i18n";

export function useDevice(dm: DeviceManager | null): DeviceManager | null {
  useSyncExternalStore(dm ? dm.subscribe : () => () => {}, dm ? dm.getVersion : () => 0);
  return dm;
}

function NoHw() {
  const { t } = useI18n();
  return <p className="muted">{t("device.noHw")}</p>;
}

// ------------------------------------------------------------------ Serial
export function SerialTab({ backend, hw }: { backend: Backend; hw: DeviceManager | null }) {
  const { t, lang } = useI18n();
  const dm = useDevice(hw);
  const [port, setPort] = useState<PortName>("repl");
  const [line, setLine] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const hasData = !!dm?.conns.data;
  const active: PortName = port === "data" && !hasData ? "repl" : port;

  if (!dm) return <div className="tab-page placeholder"><h3>{t("serial.title")}</h3><NoHw /></div>;
  if (!dm.attached) return <div className="tab-page placeholder"><h3>{t("serial.title")}</h3><p>{t("serial.needBoard")}</p></div>;

  const agentLock = backend.state?.serial.lock[active] === "agent";
  const syncing = active === "repl" && !!dm.busy;
  const readOnly = agentLock || syncing;
  const send = async (s: string) => {
    setErr(null);
    try {
      await dm.consoleWrite(active, s);
    } catch (e: any) {
      setErr(translateError(lang, e.message));
    }
  };

  return (
    <div className="tab-page serial">
      {hasData && (
        <div className="subtabs">
          {(["repl", "data"] as PortName[]).map((p) => (
            <button key={p} className={`btn ${active === p ? "primary" : ""}`} onClick={() => setPort(p)}>
              {t(`serial.${p}` as any)}
            </button>
          ))}
        </div>
      )}
      <XtermConsole key={active} history={dm.history[active]} readOnly={readOnly} onInput={(d) => !readOnly && send(d)} />
      {readOnly && <div className="notice">{agentLock ? t("serial.readonly") : t("serial.syncing")}</div>}
      {err && <div className="notice error">{err}</div>}
      <div className="serial-input">
        <input
          value={line}
          disabled={readOnly}
          placeholder={t("serial.input")}
          onChange={(e) => setLine(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              send(line + "\r");
              setLine("");
            }
          }}
        />
        <button className="btn" disabled={readOnly} onClick={() => send("\x03")}>
          Ctrl-C
        </button>
        <button className="btn" disabled={readOnly} onClick={() => send("\x04")}>
          Ctrl-D
        </button>
        <button className="btn" onClick={() => dm.clearTerminal(active)}>
          {t("serial.clear")}
        </button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ Plot
const COLORS = ["#2f6fde", "#e0663a", "#2c8a4b", "#b0408f", "#c48a10", "#16a3b8", "#6b5bd6", "#7a7a7a"];

export function PlotTab({ hw }: { hw: DeviceManager | null }) {
  const { t } = useI18n();
  const dm = useDevice(hw);
  const [paused, setPaused] = useState(false);
  const [frozen, setFrozen] = useState<number[][]>([]);
  const canvas = useRef<HTMLCanvasElement>(null);
  const points = paused ? frozen : (dm?.plot.points ?? []);

  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth;
    const h = c.clientHeight;
    c.width = w * dpr;
    c.height = h * dpr;
    const g = c.getContext("2d")!;
    g.scale(dpr, dpr);
    g.clearRect(0, 0, w, h);
    if (!points.length) return;
    const series = Math.max(...points.map((p) => p.length));
    let lo = Infinity;
    let hi = -Infinity;
    for (const p of points) for (const v of p) (lo = Math.min(lo, v)), (hi = Math.max(hi, v));
    if (lo === hi) (lo -= 1), (hi += 1);
    const pad = 28;
    const x = (i: number) => pad + (i / Math.max(1, points.length - 1)) * (w - pad - 8);
    const y = (v: number) => 8 + (1 - (v - lo) / (hi - lo)) * (h - 24);
    const muted = getComputedStyle(c).color;
    g.fillStyle = muted;
    g.font = "11px system-ui";
    g.fillText(hi.toPrecision(4), 2, 14);
    g.fillText(lo.toPrecision(4), 2, h - 18);
    g.strokeStyle = muted;
    g.globalAlpha = 0.3;
    g.beginPath();
    g.moveTo(pad, y(lo));
    g.lineTo(w - 8, y(lo));
    g.stroke();
    g.globalAlpha = 1;
    for (let s = 0; s < series; s++) {
      g.strokeStyle = COLORS[s % COLORS.length];
      g.lineWidth = 1.5;
      g.beginPath();
      let started = false;
      points.forEach((p, i) => {
        if (s >= p.length) return;
        if (!started) g.moveTo(x(i), y(p[s]));
        else g.lineTo(x(i), y(p[s]));
        started = true;
      });
      g.stroke();
    }
  });

  if (!dm) return <div className="tab-page placeholder"><h3>{t("tab.plot")}</h3><NoHw /></div>;
  const series = points.length ? Math.max(...points.map((p) => p.length)) : 0;
  return (
    <div className="tab-page plot">
      <div className="button-row">
        <button
          className="btn"
          onClick={() => {
            if (!paused) setFrozen(dm.plot.points.map((p) => [...p]));
            setPaused(!paused);
          }}
        >
          {paused ? <Play size={14} /> : <Pause size={14} />} {paused ? t("plot.resume") : t("plot.pause")}
        </button>
        <button
          className="btn"
          onClick={() => {
            dm.plot.clear();
            setFrozen([]);
          }}
        >
          <Trash2 size={14} /> {t("plot.clear")}
        </button>
        <span className="legend">
          {Array.from({ length: series }, (_, i) => (
            <span key={i} style={{ color: COLORS[i % COLORS.length] }}>
              ● {i + 1}
            </span>
          ))}
        </span>
      </div>
      {points.length === 0 && <p className="muted">{t("plot.empty")}</p>}
      <canvas ref={canvas} className="plot-canvas" />
    </div>
  );
}

// ------------------------------------------------------------------ Library
interface Lib {
  name: string;
  version: string;
  latest: string | null;
  outdated: boolean;
}

export function LibraryTab({ backend }: { backend: Backend }) {
  const { t, lang } = useI18n();
  const type = backend.state?.project?.type;
  const [libs, setLibs] = useState<Lib[] | null>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);

  const run = async (fn: () => Promise<any>, ok?: string) => {
    setBusy(true);
    setNote(null);
    try {
      const r = await fn();
      if (ok) setNote({ ok: true, text: ok });
      return r;
    } catch (e: any) {
      setNote({ ok: false, text: translateError(lang, e.message) });
    } finally {
      setBusy(false);
    }
  };
  const refresh = () => run(async () => setLibs((await backend.action("lib.list")).libraries));

  useEffect(() => {
    if (type) refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type, backend.state?.project?.id, backend.state?.tree.length]);

  const mp = type === "micropython";

  return (
    <div className="tab-page library">
      <p className="muted small">
        {t("library.mirrorNote")} {mp && t("library.mipNote")}
      </p>
      <section>
        <div className="section-head">
          <h3>{t("library.installed")}</h3>
          <button className="btn icon" title={t("common.refresh")} disabled={busy} onClick={refresh}>
            <RefreshCw size={14} />
          </button>
          {!mp && (
            <button className="btn" disabled={busy || !libs?.some((l) => l.outdated)} onClick={() => run(() => backend.action("lib.update"), t("library.done")).then(refresh)}>
              {t("library.updateAll")}
            </button>
          )}
          {busy && <span className="spinner" />}
        </div>
        {libs && libs.length === 0 && <div className="empty">{t("library.none")}</div>}
        <ul className="lib-list">
          {(libs ?? []).map((l) => (
            <li key={l.name}>
              <span className="ellipsis">
                <b>{l.name}</b> <span className="muted">{l.version}</span>
                {l.outdated && <span className="pill warn">{t("library.outdated", { latest: l.latest ?? "?" })}</span>}
              </span>
              <button
                className="btn"
                disabled={busy}
                onClick={() => window.confirm(t("library.confirmUninstall", { name: l.name })) && run(() => backend.action("lib.uninstall", { names: [l.name] }), t("library.done")).then(refresh)}
              >
                {t("library.uninstall")}
              </button>
            </li>
          ))}
        </ul>
      </section>
      <section>
        <h3>{t("library.search")}</h3>
        <form
          className="commit-row"
          onSubmit={(e) => {
            e.preventDefault();
            run(async () => setResults((await backend.action("lib.search", { query })).results));
          }}
        >
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={mp ? "aioble" : "bme280"} />
          <button className="btn primary" disabled={busy} type="submit">
            {t("library.search")}
          </button>
          {mp && (
            <button className="btn" type="button" disabled={busy || !query.trim()} onClick={() => run(() => backend.action("lib.install", { names: [query.trim()] }), t("library.done")).then(refresh)}>
              {t("library.install")}
            </button>
          )}
        </form>
        <ul className="lib-list">
          {results.map((name) => (
            <li key={name}>
              <span className="ellipsis">{name}</span>
              <button className="btn" disabled={busy || !!libs?.some((l) => l.name === name)} onClick={() => run(() => backend.action("lib.install", { names: [name] }), t("library.done")).then(refresh)}>
                {t("library.install")}
              </button>
            </li>
          ))}
        </ul>
      </section>
      {note && <div className={`notice ${note.ok ? "ok" : "error"}`}>{note.text}</div>}
    </div>
  );
}

// ------------------------------------------------------------------ Device
export function DeviceTab({ backend, hw }: { backend: Backend; hw: DeviceManager | null }) {
  const { t, lang } = useI18n();
  const dm = useDevice(hw);
  const st = backend.state;
  const d = st?.device;
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);

  const row = (k: string, v: string | null | undefined) => (
    <div className="kv">
      <span className="muted">{k}</span>
      <span>{v || "—"}</span>
    </div>
  );
  const run = async (fn: () => Promise<any>, summarize?: (r: any) => string) => {
    setBusy(true);
    setNote(null);
    try {
      const r = await fn();
      if (summarize) setNote({ ok: true, text: summarize(r) });
    } catch (e: any) {
      setNote({ ok: false, text: translateError(lang, e.message) });
    } finally {
      setBusy(false);
    }
  };
  const counts = (r: any) =>
    Object.entries(r || {})
      .filter(([, v]) => Array.isArray(v))
      .map(([k, v]) => `${k} ${(v as unknown[]).length}`)
      .join(", ");

  const ls = d?.last_sync;
  const driveState = !dm?.drive ? t("device.driveNone") : dm.driveOk ? t("device.driveOk") : t("device.driveNoPerm");
  const ports = dm ? (Object.keys(dm.conns) as PortName[]).map((p) => t(`serial.${p}` as any)).join(", ") : "";

  return (
    <div className="tab-page device">
      <div className="card">
        <div className="card-body">
          {row(t("device.status"), d?.attached ? (d.identifying ? t("device.identifying") : t("common.connected")) : t("common.notConnected"))}
          {row(t("device.uid"), d?.uid)}
          {row(t("device.runtime"), d?.runtime)}
          {row(t("device.firmware"), d?.version)}
          {row(t("device.project"), st?.project?.name)}
          {row(t("device.type"), st?.project ? t(`type.${st.project.type}` as any) : null)}
          {row(t("device.channel"), d?.channel)}
          {row(t("device.ports"), ports)}
          {ls && row(t("device.lastSync"), t("device.syncSummary", { direction: ls.direction === "pull" ? t("device.pullDir") : t("device.pushDir"), when: new Date(ls.time * 1000).toLocaleTimeString(lang), summary: Object.entries(ls.summary).map(([k, v]) => `${k} ${v}`).join(", ") }))}
          {d?.error && <div className="notice error">{translateError(lang, d.error)}</div>}
          {dm?.error && <div className="notice error">{translateError(lang, dm.error)}</div>}
        </div>
        <div className="card-actions">
          <button className="btn" disabled={busy || !d?.uid || !st?.project} onClick={() => run(() => backend.action("device.pull"), (r) => (r?.declined ? t("notice.pull_declined") : t("device.done", { summary: counts(r) })))}>
            <Download size={14} /> {t("device.pull")}
          </button>
          <button className="btn" disabled={busy || !d?.uid || !st?.project} onClick={() => run(() => backend.action("device.push"), (r) => t("device.done", { summary: counts(r) }))}>
            <Upload size={14} /> {t("device.sync")}
          </button>
          {busy && <span className="spinner" />}
        </div>
      </div>
      {note && <div className={`notice ${note.ok ? "ok" : "error"}`}>{note.text}</div>}
      {!dm ? (
        <NoHw />
      ) : (
        <>
          <ConnectSection backend={backend} dm={dm} />
          {st?.project?.type === "circuitpython" && dm.caps.msc && !dm.emulated && (
            <section>
              <h3>{t("device.drive")}</h3>
              <p className="muted small">{t("device.mscHelp")}</p>
              <div className="kv">
                <span className="muted">{t("device.drive")}</span>
                <span>{driveState}</span>
              </div>
              <div className="button-row">
                <button className="btn" onClick={() => dm.chooseDrive().catch(() => {})}>
                  {t("device.chooseDrive")}
                </button>
                {dm.drive && !dm.driveOk && (
                  <button className="btn" onClick={() => dm.reauthorizeDrive()}>
                    {t("device.reauth")}
                  </button>
                )}
                {dm.drive && (
                  <button className="btn" onClick={() => dm.forgetDrive()}>
                    {t("device.forgetDrive")}
                  </button>
                )}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ Connect (real board or emulator, D40)
const EMULATOR_NAME = "rp2040js · Raspberry Pi Pico";

/**
 * One entry for connecting, whatever the board is. A test project (board
 * "rp2040js") connects its own emulator; a real project ("usb") opens the
 * serial port chooser; a project with no board yet offers both, and the first
 * connection fixes the kind.
 */
function ConnectSection({ backend, dm }: { backend: Backend; dm: DeviceManager }) {
  const { t, lang } = useI18n();
  const project = backend.state?.project;
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  if (!project) return null;
  const kind = project.board;

  const run = async (fn: () => Promise<void>, done?: string) => {
    setBusy(true);
    setNote(null);
    try {
      await fn();
      if (done) setNote(done);
    } catch (e: any) {
      setNote(translateError(lang, e.message));
    } finally {
      setBusy(false);
    }
  };
  const emu = () => import("../hw/emulator/browser"); // loaded only when used
  const connectEmulator = () => run(async () => dm.connectEmulator(await (await emu()).startEmulator(project.id, project.type)));
  const connectUsb = () => run(() => dm.requestBoard());

  return (
    <section className="card">
      <div className="card-body">
        <div className="kv">
          <span className="muted">{t("device.boardKind")}</span>
          <span>{kind === "rp2040js" ? `${t("emu.kind")} (${EMULATOR_NAME})` : kind === "usb" ? t("device.kindUsb") : t("device.kindUnset")}</span>
        </div>
        {kind === "rp2040js" && <p className="muted small">{t("emu.help")}</p>}
        {!kind && <p className="muted small">{t("device.kindHelp")}</p>}
        {kind === "usb" && !dm.caps.serial && <p className="muted small">{t("device.noHw")}</p>}
        {note && <div className="notice">{note}</div>}
      </div>
      <div className="card-actions">
        {!dm.attached && kind === "rp2040js" && (
          <button className="btn primary" disabled={busy} onClick={connectEmulator}>
            {t("device.connect")}
          </button>
        )}
        {!dm.attached && kind === "usb" && (
          <button className="btn primary" disabled={busy || !dm.caps.serial} onClick={connectUsb}>
            {t("device.connect")}
          </button>
        )}
        {!dm.attached && !kind && (
          <>
            <button className="btn primary" disabled={busy || !dm.caps.serial} onClick={connectUsb}>
              {t("device.connectUsb")}
            </button>
            <button className="btn" disabled={busy} onClick={connectEmulator}>
              {t("device.connectEmulator")}
            </button>
          </>
        )}
        {dm.attached && !dm.emulated && project.type === "circuitpython" && !dm.conns.data && (
          <button className="btn" onClick={() => dm.requestDataPort()}>
            {t("device.addData")}
          </button>
        )}
        {dm.attached && (
          <button className="btn" disabled={busy} onClick={() => run(() => dm.disconnect(false))}>
            {t("device.disconnect")}
          </button>
        )}
        {!dm.attached && kind === "rp2040js" && (
          <button
            className="btn"
            disabled={busy}
            onClick={() => window.confirm(t("emu.confirmReset")) && run(async () => (await emu()).resetEmulatorStorage(project.id), t("emu.resetDone"))}
          >
            {t("emu.reset")}
          </button>
        )}
        {busy && <span className="spinner" />}
      </div>
    </section>
  );
}
