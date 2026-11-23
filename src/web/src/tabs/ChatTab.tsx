import { ChevronDown, ChevronRight, Send, Square } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Backend, ChatItem } from "../backend";
import { translateNotice, useI18n } from "../i18n";

function Text({ text }: { text: string }) {
  // minimal markdown: fenced code blocks and inline code
  const parts = text.split(/```(?:\w*\n)?([\s\S]*?)```/g);
  return (
    <>
      {parts.map((p, i) =>
        i % 2 === 1 ? (
          <pre key={i} className="code">
            {p}
          </pre>
        ) : (
          <span key={i} className="prose">
            {p.split(/(`[^`\n]+`)/g).map((s, j) => (s.startsWith("`") && s.endsWith("`") && s.length > 1 ? <code key={j}>{s.slice(1, -1)}</code> : s))}
          </span>
        ),
      )}
    </>
  );
}

function summarize(input: any, root?: string): string {
  if (!input) return "";
  if (input.file_path) return root && input.file_path.startsWith(root + "/") ? input.file_path.slice(root.length + 1) : input.file_path;
  if (input.command) return input.command;
  if (input.pattern) return input.pattern;
  if (typeof input.data === "string") return JSON.stringify(input.data).slice(0, 60);
  const s = JSON.stringify(input);
  return s === "{}" ? "" : s.slice(0, 80);
}

function ToolCard({ use, result, root }: { use: Extract<ChatItem, { kind: "tool_use" }>; result?: Extract<ChatItem, { kind: "tool_result" }>; root?: string }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const name = use.name.replace(/^mcp__boady__/, "");
  return (
    <div className={`card tool ${result?.is_error ? "error" : ""}`}>
      <button className="card-head" onClick={() => setOpen(!open)}>
        {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        <b>{name}</b> <span className="muted ellipsis">{summarize(use.input, root)}</span>
        {!result && <span className="spinner" />}
      </button>
      {open && (
        <div className="card-body">
          <div className="label">{t("chat.input")}</div>
          <pre className="code">{JSON.stringify(use.input, null, 2)}</pre>
          <div className="label">{t("chat.result")}</div>
          <pre className="code">{result ? result.content : t("chat.noResult")}</pre>
        </div>
      )}
    </div>
  );
}

function PermissionCard({ item, backend }: { item: Extract<ChatItem, { kind: "permission" }>; backend: Backend }) {
  const { t } = useI18n();
  const pending = item.status === "pending" && backend.pending.has(item.request_id);
  let body;
  if (item.perm_kind === "confirm") {
    body = (
      <>
        <div>{t(`chat.confirm.${item.what}` as any)}</div>
        {Array.isArray(item.detail?.files) && (
          <ul className="files-list">
            {item.detail.files.map((f: string) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
        )}
      </>
    );
  } else {
    const tool = (item.tool || "").replace(/^mcp__boady__/, "");
    body = (
      <>
        <div>
          <b>{t("chat.permTitle", { tool })}</b>
        </div>
        <pre className="code">{JSON.stringify(item.input, null, 2)}</pre>
      </>
    );
  }
  return (
    <div className={`card perm ${item.status}`}>
      <div className="card-body">{body}</div>
      <div className="card-actions">
        {pending ? (
          <>
            <button className="btn primary" onClick={() => backend.reply(item.request_id, true)}>
              {t("chat.approve")}
            </button>
            <button className="btn" onClick={() => backend.reply(item.request_id, false)}>
              {t("chat.deny")}
            </button>
          </>
        ) : (
          <span className="muted">{item.status === "allowed" ? t("chat.allowed") : t("chat.denied")}</span>
        )}
      </div>
    </div>
  );
}

export function ChatTab({ backend }: { backend: Backend }) {
  const { t, lang } = useI18n();
  const [draft, setDraft] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const st = backend.state;
  const items = backend.items;

  const results = useMemo(() => {
    const m = new Map<string, Extract<ChatItem, { kind: "tool_result" }>>();
    for (const i of items) if (i.kind === "tool_result") m.set(i.tool_use_id, i);
    return m;
  }, [items]);

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [items.length, backend.partial]);

  const send = () => {
    const text = draft.trim();
    if (!text || backend.running) return;
    backend.sendMessage(text);
    setDraft("");
  };

  const device = st?.device.attached ? t("common.connected") : t("common.notConnected");

  return (
    <div className="tab-page chat">
      <header className="page-head">
        <b>{st?.project?.name ?? t("chat.noProject")}</b>
        <span className={`dot ${st?.device.attached ? "on" : ""}`} />
        <span className="muted">{t("chat.device", { status: device })}</span>
      </header>
      <div className="messages" ref={listRef}>
        {items.length === 0 && !backend.partial && <div className="empty">{t("chat.empty")}</div>}
        {items.map((it) => {
          switch (it.kind) {
            case "user":
              return (
                <div key={it.id} className="msg user">
                  <Text text={it.text} />
                </div>
              );
            case "assistant":
              return (
                <div key={it.id} className="msg assistant">
                  <Text text={it.text} />
                </div>
              );
            case "tool_use":
              return <ToolCard key={it.id} use={it} result={results.get(it.tool_use_id)} root={st?.project?.dir} />;
            case "tool_result":
              return null;
            case "permission":
              return <PermissionCard key={it.id} item={it} backend={backend} />;
            case "notice":
              return (
                <div key={it.id} className={`notice ${it.level}`}>
                  {translateNotice(lang, it.text)}
                </div>
              );
          }
        })}
        {backend.partial && (
          <div className="msg assistant streaming">
            <Text text={backend.partial} />
          </div>
        )}
        {backend.running && !backend.partial && <div className="muted running">{t("chat.running")}</div>}
      </div>
      <div className="composer">
        <textarea
          value={draft}
          placeholder={t("chat.placeholder")}
          rows={2}
          disabled={!st?.project}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              send();
            }
          }}
        />
        {backend.running ? (
          <button className="btn danger icon" title={t("chat.interrupt")} onClick={() => backend.interrupt()}>
            <Square size={18} />
          </button>
        ) : (
          <button className="btn primary icon" title={t("chat.send")} disabled={!draft.trim() || !st?.project} onClick={send}>
            <Send size={18} />
          </button>
        )}
      </div>
    </div>
  );
}
