import { RotateCcw, Upload } from "lucide-react";
import { useEffect, useState } from "react";
import type { Backend } from "../backend";
import { DiffView } from "../components/DiffView";
import { translateError, useI18n } from "../i18n";

export function VersionTab({ backend }: { backend: Backend }) {
  const { t, lang } = useI18n();
  const st = backend.state;
  const changes = st?.git.status ?? [];
  const [selected, setSelected] = useState<string | null>(null);
  const [diff, setDiff] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    if (selected && !changes.some((c) => c.path === selected)) setSelected(null);
    if (!selected) {
      setDiff("");
      return;
    }
    backend
      .action("git.diff", { path: selected })
      .then((r) => setDiff(r.diff))
      .catch((e) => setDiff(String(e.message)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, st?.git.status]);

  const run = async (fn: () => Promise<any>, okText?: string) => {
    setBusy(true);
    setNote(null);
    try {
      await fn();
      if (okText) setNote({ ok: true, text: okText });
    } catch (e: any) {
      setNote({ ok: false, text: translateError(lang, e.message) });
    } finally {
      setBusy(false);
    }
  };

  const hasRemote = (st?.git.remotes ?? []).length > 0;

  return (
    <div className="tab-page version">
      <section>
        <h3>{t("version.changes")}</h3>
        {changes.length === 0 ? (
          <div className="empty">{t("version.noChanges")}</div>
        ) : (
          <ul className="changes">
            {changes.map((c) => (
              <li key={c.path} className={selected === c.path ? "selected" : ""}>
                <button className="change" onClick={() => setSelected(selected === c.path ? null : c.path)}>
                  <span className={`git-badge git-${c.status}`}>{t(`version.status.${c.status}` as any)}</span>
                  <span className="ellipsis">{c.path}</span>
                </button>
                <button
                  className="btn icon"
                  title={t("version.resetFile")}
                  disabled={busy}
                  onClick={() => window.confirm(t("version.confirmResetFile", { path: c.path })) && run(() => backend.action("git.reset_file", { path: c.path }))}
                >
                  <RotateCcw size={14} />
                </button>
              </li>
            ))}
          </ul>
        )}
        {selected && (
          <div className="diff-box">
            <div className="label">
              {t("version.diff")}: {selected}
            </div>
            <DiffView diff={diff} />
          </div>
        )}
        <div className="commit-row">
          <input value={message} placeholder={t("version.commitMsg")} onChange={(e) => setMessage(e.target.value)} />
          <button
            className="btn primary"
            disabled={busy || !message.trim() || changes.length === 0}
            onClick={() => run(async () => {
              await backend.action("git.commit", { message });
              setMessage("");
            })}
          >
            {t("version.commit")}
          </button>
        </div>
        <div className="button-row">
          <button
            className="btn"
            disabled={busy || changes.length === 0}
            onClick={() => window.confirm(t("version.confirmResetAll")) && run(() => backend.action("git.reset_all", { confirm: true }))}
          >
            <RotateCcw size={14} /> {t("version.resetAll")}
          </button>
          {hasRemote ? (
            <button className="btn" disabled={busy} onClick={() => run(() => backend.action("git.push"), t("version.pushed"))}>
              <Upload size={14} /> {t("version.push")}
            </button>
          ) : (
            <button
              className="btn"
              disabled={busy}
              onClick={() => window.confirm(t("version.confirmCreateRemote")) && run(() => backend.action("git.create_remote"), t("version.pushed"))}
            >
              <Upload size={14} /> {t("version.createRemote")}
            </button>
          )}
          {busy && <span className="spinner" />}
        </div>
        {note && <div className={`notice ${note.ok ? "ok" : "error"}`}>{note.text}</div>}
      </section>
      <section>
        <h3>{t("version.history")}</h3>
        {(st?.git.log ?? []).length === 0 ? (
          <div className="empty">{t("version.noHistory")}</div>
        ) : (
          <ul className="history">
            {st!.git.log.map((c) => (
              <li key={c.hash}>
                <code>{c.hash.slice(0, 7)}</code> <span>{c.subject}</span>
                <span className="muted">
                  {c.author} · {new Date(c.time * 1000).toLocaleString(lang)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
