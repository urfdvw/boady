import { describe, expect, it } from "vitest";
import type { Connection, Hardware } from "./adapters/types";
import { Backend } from "./backend";

class FakeConn implements Connection {
  sent: any[] = [];
  opened = 0;
  onMessage: (m: any) => void = () => {};
  onOpen: () => void = () => {};
  onClose: () => void = () => {};
  open() {
    this.opened++;
    this.onOpen();
  }
  close() {}
  send(m: object) {
    this.sent.push(m);
  }
}

function setup() {
  const conn = new FakeConn();
  const signals: AbortSignal[] = [];
  let finish: (v: any) => void = () => {};
  const hw: Hardware = {
    caps: { serial: true, msc: false },
    mode: "browser",
    handle: (_op, _p, signal) => {
      signals.push(signal);
      return new Promise((res) => (finish = res));
    },
  };
  const b = new Backend(conn, hw, "old-token");
  b.start();
  conn.onMessage({ type: "hello.ok" });
  return { b, conn, signals, done: (v: any) => finish(v) };
}

describe("backend client review fixes", () => {
  it("aborts hardware work on disconnect and drops its late reply (finding 5)", async () => {
    const { conn, signals, done } = setup();
    conn.onMessage({ type: "hw.request", id: "hw1", op: "fs.apply", params: {} });
    expect(signals[0].aborted).toBe(false);
    conn.onClose();
    expect(signals[0].aborted).toBe(true);
    conn.onOpen(); // reconnected
    done({ written: [] });
    await new Promise((r) => setTimeout(r, 0));
    expect(conn.sent.some((m) => m.type === "hw.response")).toBe(false);
  });

  it("aborts hardware work when replaced by another frontend", () => {
    const { conn, signals } = setup();
    conn.onMessage({ type: "hw.request", id: "hw1", op: "fs.read_all", params: {} });
    conn.onMessage({ type: "replaced" });
    expect(signals[0].aborted).toBe(true);
  });

  it("action ids differ between page loads (review 2, finding 7)", () => {
    const a = setup();
    const b = setup();
    a.b.action("state.refresh");
    b.b.action("state.refresh");
    const id = (s: ReturnType<typeof setup>) => s.conn.sent.find((m) => m.type === "action").id;
    expect(id(a)).not.toBe(id(b));
  });

  it("uses a reset pairing code on the next reconnect (finding 10)", () => {
    const { b, conn } = setup();
    b.setToken("new-token");
    conn.onClose();
    conn.onOpen();
    const hellos = conn.sent.filter((m) => m.type === "hello");
    expect(hellos[hellos.length - 1].token).toBe("new-token");
  });
});

describe("test projects (D40)", () => {
  it("tells the hardware layer about every new state", () => {
    const conn = new FakeConn();
    let states = 0;
    const hw: Hardware = { caps: { serial: true, msc: false }, mode: "browser", handle: async () => ({}), onState: () => states++ };
    const b = new Backend(conn, hw, "t");
    b.start();
    conn.onMessage({ type: "hello.ok" });
    conn.onMessage({ type: "state", project: null });
    conn.onMessage({ type: "state", project: null });
    expect(states).toBe(2);
  });
});

describe("chat state (review 7, coverage)", () => {
  it("builds the chat from history, items, deltas and turns", () => {
    const { b, conn } = setup();
    conn.onMessage({ type: "agent_event", kind: "history", items: [{ id: "u1", kind: "user", text: "hi" }], running: true, partial: "Wor" });
    expect(b.items.map((i) => i.id)).toEqual(["u1"]);
    expect(b.running).toBe(true);
    conn.onMessage({ type: "agent_event", kind: "delta", text: "king" });
    expect(b.partial).toBe("Working");
    conn.onMessage({ type: "agent_event", kind: "item", item: { id: "a1", kind: "assistant", text: "Working on it" } });
    expect(b.partial).toBe("");
    conn.onMessage({ type: "agent_event", kind: "turn_end", result: {} });
    expect(b.running).toBe(false);
    conn.onMessage({ type: "agent_event", kind: "turn_start" });
    expect(b.running).toBe(true);
    // a state without a project clears the chat
    conn.onMessage({ type: "state", project: null, device: {}, serial: { lock: {} } });
    expect(b.items).toEqual([]);
  });

  it("merges a re-sent approval into one card and resolves it", () => {
    const { b, conn } = setup();
    const req = { type: "permission_request", request_id: "perm1", kind: "tool", tool: "mcp__boady__sync_to_device", input: {} };
    conn.onMessage({ type: "agent_event", kind: "history", items: [{ id: "perm1", kind: "permission", request_id: "perm1", status: "pending" }] });
    conn.onMessage(req); // re-sent after a reconnect
    conn.onMessage(req);
    expect(b.items.filter((i) => i.id === "perm1")).toHaveLength(1);
    expect(b.pending.has("perm1")).toBe(true);
    b.reply("perm1", true);
    expect(conn.sent[conn.sent.length - 1]).toEqual({ type: "permission_reply", request_id: "perm1", allow: true });
    conn.onMessage({ type: "agent_event", kind: "permission_resolved", request_id: "perm1", allowed: true });
    expect(b.pending.has("perm1")).toBe(false);
    expect((b.items.find((i) => i.id === "perm1") as any).status).toBe("allowed");
    // a new request that is not in the history yet becomes a card
    conn.onMessage({ ...req, request_id: "perm2" });
    expect((b.items.find((i) => i.id === "perm2") as any).perm_kind).toBe("tool");
  });

  it("marks a turn that ended while the chat was hidden", () => {
    const { b, conn } = setup();
    b.setChatVisible(false);
    conn.onMessage({ type: "agent_event", kind: "turn_end", result: {} });
    expect(b.turnEndedUnseen).toBe(true);
    b.setChatVisible(true);
    expect(b.turnEndedUnseen).toBe(false);
    conn.onMessage({ type: "agent_event", kind: "turn_end", result: {} });
    expect(b.turnEndedUnseen).toBe(false);
  });

  it("routes action results to their caller and fails them on disconnect", async () => {
    const { b, conn } = setup();
    const ok = b.action("state.refresh");
    const bad = b.action("git.push");
    const lost = b.action("lib.list");
    const [a1, a2] = conn.sent.filter((m) => m.type === "action");
    conn.onMessage({ type: "action.result", id: a2.id, ok: false, error: "no remote" });
    conn.onMessage({ type: "action.result", id: a1.id, ok: true, result: { x: 1 } });
    conn.onMessage({ type: "action.result", id: "someone-else", ok: true, result: {} }); // ignored
    await expect(ok).resolves.toEqual({ x: 1 });
    await expect(bad).rejects.toThrow("no remote");
    conn.onClose();
    await expect(lost).rejects.toThrow("disconnected");
    await expect(b.action("state.refresh")).rejects.toThrow("not connected");
  });

  it("answers hardware requests and stops the ones the backend cancels", async () => {
    const { conn, signals, done } = setup();
    conn.onMessage({ type: "hw.request", id: "hw1", op: "fs.read_all", params: {} });
    conn.onMessage({ type: "hw.cancel", ids: ["hw1", "unknown"] });
    expect(signals[0].aborted).toBe(true);
    done({ files: {} });
    await new Promise((r) => setTimeout(r, 0));
    expect(conn.sent.find((m) => m.type === "hw.response")).toEqual({ type: "hw.response", id: "hw1", ok: true, result: { files: {} } });
  });

  it("keeps a select-required card until dismissed or a new hello", () => {
    const { b, conn } = setup();
    conn.onMessage({ type: "project.select_required", reason: "unknown_board", uid: "U" });
    expect(b.selectRequired.reason).toBe("unknown_board");
    b.dismissSelect();
    expect(b.selectRequired).toBeNull();
    conn.onMessage({ type: "project.select_required", reason: "runtime_mismatch" });
    conn.onMessage({ type: "hello.ok" });
    expect(b.selectRequired).toBeNull();
  });
});
