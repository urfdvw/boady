import { useSyncExternalStore } from "react";
import type { Connection, Hardware } from "./adapters/types";

export type ProjectType = "circuitpython" | "micropython";

export interface ProjectInfo {
  id: string;
  name: string;
  type: ProjectType;
  board_uid: string | null;
  last_opened: number | null;
  created_at: number;
  dir: string;
}

export interface TreeEntry {
  path: string;
  dir: boolean;
  size?: number;
}

export interface GitChange {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed";
}

export interface Commit {
  hash: string;
  author: string;
  time: number;
  subject: string;
}

export interface DeviceInfo {
  attached: boolean;
  usb: Record<string, unknown>;
  ports: string[];
  uid: string | null;
  runtime: string | null;
  mpy_version: number | null;
  channel: string | null;
}

export interface BackendState {
  version: string;
  prefs: { language?: string; last_project?: string | null };
  projects: ProjectInfo[];
  project: ProjectInfo | null;
  device: DeviceInfo;
  serial: { lock: Record<string, string | null> };
  agent: { running: boolean };
  auth: { claude: any; github: any };
  tree: TreeEntry[];
  git: { status: GitChange[]; log: Commit[]; remotes: string[] };
}

export type ChatItem =
  | { id: string; kind: "user" | "assistant"; text: string }
  | { id: string; kind: "tool_use"; tool_use_id: string; name: string; input: any }
  | { id: string; kind: "tool_result"; tool_use_id: string; content: string; is_error: boolean }
  | { id: string; kind: "notice"; level: string; text: string }
  | {
      id: string;
      kind: "permission";
      request_id: string;
      perm_kind: "tool" | "confirm";
      status: "pending" | "allowed" | "denied";
      tool?: string;
      input?: any;
      what?: string;
      detail?: any;
    };

export type ConnStatus = "connecting" | "pairing" | "badtoken" | "connected" | "offline" | "replaced";

const TOKEN_KEY = "boady.token";

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function loadToken(): string | null {
  try {
    return storage()?.getItem(TOKEN_KEY) ?? null;
  } catch {
    return null;
  }
}

export function saveToken(token: string | null): void {
  try {
    if (token) storage()?.setItem(TOKEN_KEY, token);
    else storage()?.removeItem(TOKEN_KEY);
  } catch {
    /* ignore */
  }
}

/** Client for the backend protocol. Holds all state the UI renders. */
export class Backend {
  status: ConnStatus = "connecting";
  state: BackendState | null = null;
  items: ChatItem[] = [];
  partial = "";
  running = false;
  pending = new Map<string, any>(); // request_id -> permission_request
  selectRequired: any = null;
  /** set when a turn ends; cleared by the UI when the chat tab is visible */
  turnEndedUnseen = false;
  chatVisible = true;

  private version = 0;
  private listeners = new Set<() => void>();
  private actions = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private nextId = 1;
  private hwAborts = new Map<string, AbortController>();

  constructor(private conn: Connection, private hw: Hardware, private token: string | null) {
    conn.onOpen = () => this.hello();
    conn.onClose = () => {
      if (this.status !== "replaced" && this.status !== "badtoken" && this.status !== "pairing") this.set({ status: "offline" });
      for (const [, a] of this.actions) a.reject(new Error("disconnected"));
      this.actions.clear();
    };
    conn.onMessage = (m) => this.onMessage(m);
  }

  start(): void {
    if (!this.token) {
      this.set({ status: "pairing" });
      return;
    }
    this.set({ status: "connecting" });
    this.conn.open();
  }

  pair(token: string): void {
    this.token = token.trim();
    saveToken(this.token);
    this.conn.close();
    this.start();
  }

  reconnect(): void {
    this.conn.close();
    this.start();
  }

  // --- store plumbing ---
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getVersion = () => this.version;
  private set(patch: Partial<Backend>) {
    Object.assign(this, patch);
    this.bump();
  }
  bump() {
    this.version++;
    for (const l of this.listeners) l();
  }

  private hello() {
    this.conn.send({ type: "hello", token: this.token, mode: this.hw.mode, hw: this.hw.caps });
  }

  // --- incoming ---
  private onMessage(m: any) {
    switch (m.type) {
      case "hello.ok":
        this.set({ status: "connected" });
        break;
      case "hello.error":
        saveToken(null);
        this.token = null;
        this.conn.close();
        this.set({ status: "badtoken" });
        break;
      case "replaced":
        this.conn.close();
        this.set({ status: "replaced" });
        break;
      case "state":
        this.state = m as BackendState;
        if (!this.state.project) this.items = [];
        this.bump();
        break;
      case "agent_event":
        this.onAgentEvent(m);
        break;
      case "permission_request":
        this.pending.set(m.request_id, m);
        if (!this.items.some((i) => i.id === m.request_id)) {
          const { type: _t, request_id, kind, ...rest } = m;
          this.items = [...this.items, { id: request_id, kind: "permission", request_id, perm_kind: kind, status: "pending", ...rest }];
        }
        this.bump();
        break;
      case "project.select_required":
        this.selectRequired = m;
        this.bump();
        break;
      case "action.result": {
        const a = this.actions.get(m.id);
        if (a) {
          this.actions.delete(m.id);
          if (m.ok) a.resolve(m.result);
          else a.reject(new Error(m.error || "error"));
        }
        break;
      }
      case "hw.request":
        this.onHwRequest(m);
        break;
      case "hw.cancel":
        for (const id of m.ids || []) this.hwAborts.get(id)?.abort();
        break;
      case "error":
        console.warn("backend error:", m.error);
        break;
    }
  }

  private onAgentEvent(m: any) {
    switch (m.kind) {
      case "history":
        this.items = m.items || [];
        this.running = !!m.running;
        this.partial = m.partial || "";
        // pending approvals are re-sent separately; keep their status pending
        break;
      case "item":
        this.items = [...this.items, m.item];
        if (m.item.kind === "assistant") this.partial = "";
        break;
      case "delta":
        this.partial += m.text;
        break;
      case "turn_start":
        this.running = true;
        this.partial = "";
        break;
      case "turn_end":
        this.running = false;
        this.partial = "";
        if (!this.chatVisible) this.turnEndedUnseen = true;
        break;
      case "permission_resolved":
        this.pending.delete(m.request_id);
        this.items = this.items.map((i) =>
          i.kind === "permission" && i.request_id === m.request_id ? { ...i, status: m.allowed ? "allowed" : "denied" } : i,
        );
        break;
    }
    this.bump();
  }

  private async onHwRequest(m: any) {
    const ac = new AbortController();
    this.hwAborts.set(m.id, ac);
    try {
      const result = await this.hw.handle(m.op, m.params, ac.signal);
      this.conn.send({ type: "hw.response", id: m.id, ok: true, result });
    } catch (e: any) {
      this.conn.send({ type: "hw.response", id: m.id, ok: false, error: String(e?.message || e) });
    } finally {
      this.hwAborts.delete(m.id);
    }
  }

  // --- outgoing ---
  action<T = any>(action: string, params: object = {}): Promise<T> {
    const id = `a${this.nextId++}`;
    return new Promise<T>((resolve, reject) => {
      if (this.status !== "connected") {
        reject(new Error("not connected"));
        return;
      }
      this.actions.set(id, { resolve, reject });
      this.conn.send({ type: "action", id, action, params });
    });
  }

  sendMessage(text: string) {
    this.conn.send({ type: "user_message", text });
  }

  interrupt() {
    this.conn.send({ type: "interrupt" });
  }

  reply(requestId: string, allow: boolean) {
    this.conn.send({ type: "permission_reply", request_id: requestId, allow });
  }

  setChatVisible(v: boolean) {
    if (this.chatVisible === v) return;
    this.chatVisible = v;
    if (v) this.turnEndedUnseen = false;
    this.bump();
  }
}

/** Re-render on any backend change. */
export function useBackend(b: Backend): Backend {
  useSyncExternalStore(b.subscribe, b.getVersion);
  return b;
}
