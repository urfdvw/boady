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
