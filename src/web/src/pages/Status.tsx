import { useState } from "react";
import type { Backend } from "../backend";
import { useI18n } from "../i18n";

export function Pairing({ backend }: { backend: Backend }) {
  const { t } = useI18n();
  const [code, setCode] = useState("");
  return (
    <div className="center-page">
      <h1>boady</h1>
      <h3>{t("pair.title")}</h3>
      <p className="muted">{t("pair.help")}</p>
      {backend.status === "badtoken" && <div className="notice error">{t("pair.bad")}</div>}
      <form
        className="pair-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (code.trim()) backend.pair(code);
        }}
      >
        <input value={code} autoFocus placeholder={t("pair.code")} onChange={(e) => setCode(e.target.value)} />
        <button className="btn primary" type="submit" disabled={!code.trim()}>
          {t("pair.submit")}
        </button>
      </form>
    </div>
  );
}

export function Offline({ backend }: { backend: Backend }) {
  const { t } = useI18n();
  if (backend.status === "replaced") {
    return (
      <div className="center-page">
        <h1>boady</h1>
        <p>{t("conn.replaced")}</p>
        <button className="btn primary" onClick={() => backend.reconnect()}>
          {t("conn.reconnect")}
        </button>
      </div>
    );
  }
  if (backend.status === "connecting") {
    return (
      <div className="center-page">
        <span className="spinner" /> <p>{t("conn.connecting")}</p>
      </div>
    );
  }
  return (
    <div className="center-page">
      <h1>boady</h1>
      <h3>{t("conn.offline")}</h3>
      <p className="muted">{t("conn.offlineHelp")}</p>
      <span className="spinner" />
    </div>
  );
}
