import { ArrowLeft, ChevronDown, ChevronRight, File, Folder, Save } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { Backend, GitChange } from "../backend";
import { CodeEditor } from "../components/CodeEditor";
import { useI18n } from "../i18n";
import { getOpen, setOpen, type OpenFile } from "../state/drafts";

const MARK: Record<GitChange["status"], string> = { added: "A", modified: "M", deleted: "D", renamed: "R" };

export function FilesTab({ backend, landscape }: { backend: Backend; landscape: boolean }) {
  const { t } = useI18n();
  const st = backend.state;
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const projectId = st?.project?.id;
  const restored = getOpen(projectId);
  const [path, setPath] = useState<string | null>(restored?.path ?? null);
  const [file, setFile] = useState<OpenFile["file"] | null>(restored?.file ?? null);
  const [text, setText] = useState(restored?.text ?? "");
  const [saved, setSaved] = useState(restored?.saved ?? "");
  const [error, setError] = useState<string | null>(null);
  const dirty = file?.text !== undefined && text !== saved;

  // keep the open file and the draft outside the component (survives tab switches)
  useEffect(() => {
    setOpen(projectId, path && file ? { path, file, text, saved } : null);
  }, [projectId, path, file, text, saved]);

  const status = useMemo(() => {
    const m = new Map<string, GitChange["status"]>();
    for (const c of st?.git.status ?? []) {
      m.set(c.path, c.status);
      const parts = c.path.split("/");
      for (let i = 1; i < parts.length; i++) {
        const d = parts.slice(0, i).join("/");
        if (!m.has(d)) m.set(d, "modified");
      }
    }
    return m;
  }, [st?.git.status]);

  const open = async (p: string) => {
    if (dirty && !window.confirm(t("files.discard"))) return;
    setError(null);
    try {
      const f = await backend.action("file.read", { path: p });
      setPath(p);
      setFile(f);
      setText(f.text ?? "");
      setSaved(f.text ?? "");
    } catch (e: any) {
      setError(e.message);
    }
  };

  // reload the open file when it changed on disk and has no local edits
  const entry = st?.tree.find((e) => e.path === path);
  useEffect(() => {
    if (!path || dirty) return;
    if (!entry) {
      setPath(null);
      setFile(null);
      return;
    }
    backend
      .action("file.read", { path })
      .then((f) => {
        setFile(f);
        setText(f.text ?? "");
        setSaved(f.text ?? "");
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [st?.tree, st?.git.status]);

  const save = async () => {
    if (!path) return;
    try {
      await backend.action("file.write", { path, text });
      setSaved(text);
    } catch (e: any) {
      setError(e.message);
    }
  };

  const visible = (st?.tree ?? []).filter((e) => {
    const parts = e.path.split("/");
    for (let i = 1; i < parts.length; i++) if (collapsed.has(parts.slice(0, i).join("/"))) return false;
    return true;
  });

  const tree = (
    <div className="file-tree">
      {visible.length === 0 && <div className="empty">{t("files.empty")}</div>}
      {visible.map((e) => {
        const depth = e.path.split("/").length - 1;
        const name = e.path.split("/").pop();
        const s = status.get(e.path);
        return (
          <button
            key={e.path}
            className={`tree-row ${e.path === path ? "selected" : ""} ${s ? `git-${s}` : ""}`}
            style={{ paddingLeft: 8 + depth * 14 }}
            onClick={() => {
              if (e.dir) {
                const c = new Set(collapsed);
                c.has(e.path) ? c.delete(e.path) : c.add(e.path);
                setCollapsed(c);
              } else open(e.path);
            }}
          >
            {e.dir ? (collapsed.has(e.path) ? <ChevronRight size={14} /> : <ChevronDown size={14} />) : <span className="tree-pad" />}
            {e.dir ? <Folder size={14} /> : <File size={14} />}
            <span className="ellipsis">{name}</span>
            {s && !e.dir && <span className="git-mark">{MARK[s]}</span>}
          </button>
        );
      })}
    </div>
  );

  const editor = (
    <div className="editor-pane">
      {path ? (
        <>
          <div className="editor-head">
            {!landscape && (
              <button className="btn icon" title={t("common.back")} onClick={() => (!dirty || window.confirm(t("files.discard"))) && (setPath(null), setFile(null))}>
                <ArrowLeft size={16} />
              </button>
            )}
            <span className="ellipsis">{path}</span>
            {dirty && <span className="muted">● {t("files.unsaved")}</span>}
            <button className="btn primary" disabled={!dirty} onClick={save}>
              <Save size={14} /> {t("common.save")}
            </button>
          </div>
          {file?.binary ? <div className="empty">{t("files.binary", { size: file.size ?? 0 })}</div> : <CodeEditor path={path} value={text} onChange={setText} />}
        </>
      ) : (
        <div className="empty">{t("files.select")}</div>
      )}
    </div>
  );

  return (
    <div className="tab-page files">
      {error && <div className="notice error">{t("common.error", { msg: error })}</div>}
      {landscape ? (
        <div className="files-split">
          {tree}
          {editor}
        </div>
      ) : path ? (
        editor
      ) : (
        tree
      )}
    </div>
  );
}
