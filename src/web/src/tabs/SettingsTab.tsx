import { useEffect, useState } from "react";
import type { Backend } from "../backend";
import { useI18n, type Lang } from "../i18n";

export function SettingsTab({ backend, onOpenOnboarding, onLanguage }: { backend: Backend; onOpenOnboarding(): void; onLanguage(l: Lang): void }) {
  const { t, lang } = useI18n();
  const st = backend.state;
  const [newCode, setNewCode] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const auth = st?.auth;

  const check = async () => {
    setChecking(true);
    try {
      await backend.action("auth.status");
    } catch {
      /* shown as missing */
    } finally {
      setChecking(false);
    }
  };

  useEffect(() => {
    if (!auth?.claude) check();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const resetPairing = async () => {
    if (!window.confirm(t("settings.confirmResetPairing"))) return;
    const r = await backend.action("pairing.reset");
    backend.setToken(r.token);
    setNewCode(r.token);
  };

  const gh = auth?.github;
  const ghState = !gh ? "…" : !gh.installed ? t("settings.notInstalled") : gh.logged_in ? t("settings.loggedIn") : t("settings.notLoggedIn");

  return (
    <div className="tab-page settings">
      <section>
        <h3>{t("settings.language")}</h3>
        <div className="button-row">
          {(["en", "zh"] as Lang[]).map((l) => (
            <button key={l} className={`btn ${lang === l ? "primary" : ""}`} onClick={() => onLanguage(l)}>
              {t(`lang.${l}` as any)}
            </button>
          ))}
        </div>
      </section>
      <section>
        <h3>{t("settings.accounts")}</h3>
        <div className="kv">
          <span>{t("settings.claude")}</span>
          <span className="muted">
            {t("settings.claudeCli", { path: auth?.claude?.cli ?? "—" })}
            <br />
            {t("settings.claudeToken", { state: auth?.claude?.token_file ? t("settings.present") : t("settings.absent") })}
          </span>
        </div>
        <div className="kv">
          <span>{t("settings.github")}</span>
          <span className="muted">{t("settings.ghState", { state: ghState })}</span>
        </div>
        <div className="button-row">
          <button className="btn" disabled={checking} onClick={check}>
            {t("settings.check")}
          </button>
          {checking && <span className="spinner" />}
        </div>
        <p className="muted">{t("settings.loginLater")}</p>
      </section>
      <section>
        <h3>{t("settings.backend")}</h3>
        <p className="muted">{t("settings.version", { v: st?.version ?? "?" })}</p>
        <button className="btn" onClick={resetPairing}>
          {t("settings.resetPairing")}
        </button>
        {newCode && (
          <p>
            {t("settings.newCode", { code: "" })}
            <code className="select-all">{newCode}</code>
          </p>
        )}
      </section>
      <section>
        <h3>{t("settings.keepalive")}</h3>
        <p className="muted">{t("settings.keepaliveHelp")}</p>
      </section>
      <section>
        <h3>{t("settings.onboarding")}</h3>
        <button className="btn" onClick={onOpenOnboarding}>
          {t("settings.openOnboarding")}
        </button>
      </section>
    </div>
  );
}
