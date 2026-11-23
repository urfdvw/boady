import { Download, Upload } from "lucide-react";
import type { Backend } from "../backend";
import { useI18n } from "../i18n";

/** Serial, Plot and Library need a connected board (phase 2+). */
export function SerialTab() {
  const { t } = useI18n();
  return (
    <div className="tab-page placeholder">
      <h3>{t("serial.title")}</h3>
      <p>{t("serial.needBoard")}</p>
      <p className="muted">{t("common.comingPhase", { phase: 2 })}</p>
    </div>
  );
}

export function PlotTab() {
  const { t } = useI18n();
  return (
    <div className="tab-page placeholder">
      <h3>{t("tab.plot")}</h3>
      <p>{t("plot.needBoard")}</p>
      <p className="muted">{t("common.comingPhase", { phase: 2 })}</p>
    </div>
  );
}

export function LibraryTab() {
  const { t } = useI18n();
  return (
    <div className="tab-page placeholder">
      <h3>{t("tab.library")}</h3>
      <p>{t("library.needBoard")}</p>
      <p className="muted">{t("common.comingPhase", { phase: "2 / 3" })}</p>
    </div>
  );
}

export function DeviceTab({ backend }: { backend: Backend }) {
  const { t } = useI18n();
  const st = backend.state;
  const d = st?.device;
  const row = (k: string, v: string | null | undefined) => (
    <div className="kv">
      <span className="muted">{k}</span>
      <span>{v || "—"}</span>
    </div>
  );
  const hasSerial = typeof navigator !== "undefined" && "serial" in navigator;
  return (
    <div className="tab-page device">
      <div className="card">
        <div className="card-body">
          {row(t("device.status"), d?.attached ? t("common.connected") : t("common.notConnected"))}
          {row(t("device.uid"), d?.uid)}
          {row(t("device.runtime"), d?.runtime)}
          {row(t("device.project"), st?.project?.name)}
          {row(t("device.type"), st?.project ? t(`type.${st.project.type}` as any) : null)}
          {row(t("device.channel"), d?.channel)}
        </div>
        <div className="card-actions">
          <button className="btn" disabled={!d?.attached} onClick={() => backend.action("device.pull").catch(() => {})}>
            <Download size={14} /> {t("device.pull")}
          </button>
          <button className="btn" disabled={!d?.attached} onClick={() => backend.action("device.push").catch(() => {})}>
            <Upload size={14} /> {t("device.sync")}
          </button>
        </div>
      </div>
      {!hasSerial && <p className="muted">{t("device.noHw")}</p>}
      <p className="muted">{t("common.comingPhase", { phase: 2 })}</p>
    </div>
  );
}
