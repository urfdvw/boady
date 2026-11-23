import { useState } from "react";
import type { Backend, ProjectType } from "../backend";
import { translateError, useI18n } from "../i18n";

export function Onboarding({ backend, onDone }: { backend: Backend; onDone?: () => void }) {
  const { t, lang } = useI18n();
  const st = backend.state;
  const [name, setName] = useState("");
  const [type, setType] = useState<ProjectType>("circuitpython");
  const [github, setGithub] = useState(false);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const candidates: string[] | null = backend.selectRequired?.candidates?.map((c: any) => c.id) ?? null;
  const projects = (st?.projects ?? []).filter((p) => !candidates || candidates.includes(p.id));

  const run = async (label: string, fn: () => Promise<any>, close = true) => {
    setBusy(label);
    setError(null);
    try {
      const r = await fn();
      if (r?.github_error) setError(translateError(lang, r.github_error));
      else if (close) onDone?.();
    } catch (e: any) {
      setError(translateError(lang, e.message));
    } finally {
      setBusy(null);
    }
  };

  const when = (ts: number | null) => (ts ? new Date(ts * 1000).toLocaleString(lang) : t("common.never"));

  return (
    <div className="onboarding">
      <header className="onb-head">
        <div>
          <h1>{t("onb.title")}</h1>
          <p className="muted">{backend.selectRequired ? t("onb.selectRequired") : t("onb.subtitle")}</p>
        </div>
        {st?.project && onDone && (
          <button className="btn" onClick={onDone}>
            {t("onb.back")}
          </button>
        )}
      </header>

      {error && <div className="notice error">{error}</div>}

      <section>
        <h3>{t("onb.list")}</h3>
        {projects.length === 0 && <div className="empty">{t("onb.none")}</div>}
        <ul className="project-list">
          {projects.map((p) => (
            <li key={p.id} className="card">
              <div className="card-body">
                <b>{p.name}</b> <span className="pill">{t(`type.${p.type}` as any)}</span>
                <div className="muted small">
                  {p.board_uid ? t("onb.board", { uid: p.board_uid }) : t("onb.noBoard")} · {t("onb.lastOpened", { when: when(p.last_opened) })}
                </div>
              </div>
              <div className="card-actions">
                {st?.project?.id === p.id ? (
                  <span className="muted">{t("onb.current")}</span>
                ) : (
                  <button className="btn primary" disabled={!!busy} onClick={() => run("open", () => backend.action("project.select", { id: p.id }))}>
                    {t("onb.open")}
                  </button>
                )}
                {confirmDelete === p.id ? (
                  <>
                    <button className="btn danger" disabled={!!busy} onClick={() => run("delete", () => backend.action("project.delete", { id: p.id, confirm: true }), false).then(() => setConfirmDelete(null))}>
                      {t("onb.reallyDelete")}
                    </button>
                    <button className="btn" onClick={() => setConfirmDelete(null)}>
                      {t("common.cancel")}
                    </button>
                  </>
                ) : (
                  <button className="btn" disabled={!!busy} onClick={() => window.confirm(t("onb.confirmDelete", { name: p.name })) && setConfirmDelete(p.id)}>
                    {t("onb.delete")}
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section className="card">
        <div className="card-body">
          <h3>{t("onb.new")}</h3>
          <label>
            {t("onb.name")}
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="my-project" />
          </label>
          <div className="label">{t("onb.type")}</div>
          <div className="button-row">
            {(["circuitpython", "micropython"] as ProjectType[]).map((x) => (
              <button key={x} className={`btn ${type === x ? "primary" : ""}`} onClick={() => setType(x)}>
                {t(`type.${x}` as any)}
              </button>
            ))}
          </div>
          <label className="check">
            <input type="checkbox" checked={github} onChange={(e) => setGithub(e.target.checked)} /> {t("onb.github")}
          </label>
          <div className="button-row">
            <button className="btn primary" disabled={!!busy || !name.trim()} onClick={() => run("create", () => backend.action("project.create", { name: name.trim(), type, github }))}>
              {t("onb.create")}
            </button>
            {busy === "create" && <span className="spinner" />}
          </div>
        </div>
      </section>

      <section className="card">
        <div className="card-body">
          <h3>{t("onb.clone")}</h3>
          <label>
            {t("onb.url")}
            <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://github.com/user/repo.git" />
          </label>
          <div className="button-row">
            <button className="btn primary" disabled={!!busy || !url.trim()} onClick={() => run("clone", () => backend.action("project.clone", { url: url.trim() }))}>
              {t("onb.cloneBtn")}
            </button>
            {busy === "clone" && (
              <>
                <span className="spinner" /> <span className="muted">{t("onb.cloning")}</span>
              </>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
