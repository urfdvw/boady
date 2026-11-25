import { describe, expect, it } from "vitest";
import { fromUtf8, parsePyBytes, pyBytes, toBase64, utf8 } from "./bytes";
import { choosePorts, DeviceManager, replScore } from "./device";
import { FakeDir, FakeFile } from "./fakeDrive";

/** A scripted CircuitPython-like board, for faults the emulator cannot produce on demand. */
function fakeCircuitPython(dm: DeviceManager, opts: { hashlib: boolean }) {
  const fs: Record<string, Uint8Array> = { "/code.py": utf8("old\n"), "/boot_out.txt": utf8("UID:ABCD\n"), "/gone.py": utf8("x") };
  const state = { raw: false, pending: "", usbDisabled: false, writing: null as null | { path: string; data: number[] }, sent: "" };
  const emit = (s: string) => queueMicrotask(() => (dm as any).onData("repl", utf8(s)));
  const run = (code: string): [string, string] => {
    const P = (m: RegExpMatchArray | null) => (m ? fromUtf8(parsePyBytes(m[1])) : "");
    if (code.includes("print(supervisor.runtime.autoreload)")) return ["True\r\n", ""];
    if (code.includes("hasattr(storage")) return [`True ${state.usbDisabled ? "False" : "True"}\r\n`, ""];
    if (code.includes("unsafe_disable_usb_drive()")) return ((state.usbDisabled = true), ["", ""]);
    if (code.includes("print(storage.getmount('/').readonly)")) return [state.usbDisabled ? "False\r\n" : "True\r\n", ""];
    if (code.includes("enable_usb_drive()")) return ((state.usbDisabled = false), ["", ""]);
    if (code.includes("def _bw")) return [Object.entries(fs).map(([p, d]) => `F ${d.length} ${p}\r\n`).join(""), ""];
    if (code.startsWith("import hashlib")) return opts.hashlib ? ["", ""] : ["", "ImportError: no module named 'hashlib'\r\n"];
    const rd = code.match(/with open\((b'[^']*')\.decode\(\),'rb'\)/);
    if (rd) return [`${pyBytes(fs[P(rd)])}\r\n`, ""];
    const w = code.match(/^f=open\((b'[^']*')\.decode\(\),'wb'\)/);
    if (w) {
      if (!state.usbDisabled) return ["", "OSError: [Errno 30] Read-only filesystem\r\n"];
      state.writing = { path: P(w), data: [] };
    }
    const chunk = code.match(/^w\((b'.*')\)$/s);
    if (chunk && state.writing) state.writing.data.push(...parsePyBytes(chunk[1]));
    if (code.startsWith("f.close()") && state.writing) {
      fs[state.writing.path] = Uint8Array.from(state.writing.data);
      state.writing = null;
    }
    if (code.includes("os.remove")) {
      const first = code.split("for d in")[0];
      for (const m of first.matchAll(/(b'[^']*')\.decode\(\)/g)) delete fs[fromUtf8(parsePyBytes(m[1]))];
    }
    return ["", ""];
  };
  const conn = {
    port: {} as SerialPort,
    async write(data: Uint8Array) {
      const s = fromUtf8(data);
      state.sent += s;
      for (const ch of s) {
        if (!state.raw) {
          if (ch === "\x01") {
            state.raw = true;
            emit("raw REPL; CTRL-B to exit\r\n>");
          } else if (ch === "\x04") emit("soft reboot\r\ncode.py output:\r\nhello\r\n");
          continue;
        }
        if (ch === "\x01") {
          state.pending = ""; // pyexec: Ctrl-A in raw mode resets the raw REPL
          emit("raw REPL; CTRL-B to exit\r\n>");
        } else if (ch === "\x03") {
          state.pending = ""; // pyexec: Ctrl-C clears the line
        } else if (ch === "\x02") {
          state.raw = false;
          emit("\r\nAdafruit CircuitPython 9.2.1\r\n>>> ");
        } else if (ch === "\x04") {
          const [o, e] = run(state.pending);
          state.pending = "";
          emit("OK" + o + "\x04" + e + "\x04>");
        } else if (!(ch === "\r" && state.pending === "")) state.pending += ch;
      }
    },
    close: async () => {},
    info: { vid: 0x239a, pid: 0x80f4 },
  };
  (dm as any).conns = { repl: conn };
  return { fs, state };
}

function setup(type: "circuitpython" | "micropython" = "circuitpython") {
  const dm = new DeviceManager();
  const sent: any[] = [];
  const st: any = { project: { type }, device: { uid: "ABCD", channel: null }, serial: { lock: { repl: null, data: null } } };
  dm.bind({ send: (m) => sent.push(m), state: () => st });
  return { dm, sent };
}

describe("DeviceManager with a scripted board (fault injection; real runs: emulator/onEmulator.test.ts)", () => {
  it("refuses console input while the agent holds the port", async () => {
    const { dm } = setup();
    fakeCircuitPython(dm, { hashlib: true });
    (dm as any).sink.state = () => ({ project: { type: "circuitpython" }, device: {}, serial: { lock: { repl: "agent" } } });
    await expect(dm.consoleWrite("repl", "x")).rejects.toThrow("read_only");
  });

  it("reports a missing data port", async () => {
    const { dm } = setup();
    fakeCircuitPython(dm, { hashlib: true });
    await expect(dm.handle("serial.write", { port: "data", data: "x" }, new AbortController().signal)).rejects.toThrow("No data serial port");
  });
});

describe("review fixes", () => {
  it("gives the drive back when a serial sync is cancelled (finding 7)", async () => {
    const { dm } = setup();
    const { state } = fakeCircuitPython(dm, { hashlib: false });
    const ac = new AbortController();
    const timer = setInterval(() => state.usbDisabled && state.writing && ac.abort(), 1);
    const big = toBase64(new Uint8Array(4000));
    await expect(dm.handle("fs.apply", { files: { "big.bin": big }, delete: [] }, ac.signal)).rejects.toThrow("cancelled");
    clearInterval(timer);
    expect(state.usbDisabled).toBe(false);
    expect(state.sent).toContain("storage.enable_usb_drive()");
  });

  it("opens only the port the user picked (finding 3)", () => {
    const port = (vid: number) => ({ getInfo: () => ({ usbVendorId: vid, usbProductId: 1 }) });
    const a = port(1);
    const b = port(2);
    const b2 = port(2);
    expect(choosePorts([a, b], [b])).toEqual([b]);
    expect(choosePorts([a, b, b2], [b, b2])).toEqual([b, b2]);
    expect(choosePorts([a], [b])).toEqual([]); // picked board gone: do not fall back to another board
    expect(choosePorts([b, a, b2], [])).toEqual([b, b2]); // no choice yet (page load)
  });
});

function withDrive(dm: DeviceManager) {
  const root = new FakeDir();
  root.children.set("boot_out.txt", new FakeFile("boot_out.txt", utf8("UID:ABCD\n")));
  for (const n of ["a.py", "b.py", "c.py"]) root.children.set(n, new FakeFile(n, utf8(n)));
  dm.drive = root as unknown as FileSystemDirectoryHandle;
  return root;
}

describe("MSC channel", () => {
  it("stops deleting when cancelled (review 2, finding 5)", async () => {
    const { dm } = setup();
    fakeCircuitPython(dm, { hashlib: true });
    const root = withDrive(dm);
    const ac = new AbortController();
    root.onRemove = () => ac.abort(); // cancel right after the first deletion
    await expect(dm.handle("fs.apply", { files: {}, delete: ["a.py", "b.py", "c.py"] }, ac.signal)).rejects.toThrow("cancelled");
    expect([...root.children.keys()].sort()).toEqual(["b.py", "boot_out.txt", "c.py"]);
  });
});

describe("file <-> directory on the drive (review 9, finding 5)", () => {
  it("replaces a file by a directory of the same name and back", async () => {
    const { dm } = setup();
    fakeCircuitPython(dm, { hashlib: true });
    const root = withDrive(dm);
    const b64 = (t: string) => btoa(t);
    await dm.handle("fs.apply", { files: { data: b64("a file") }, delete: [] }, new AbortController().signal);
    await dm.handle("fs.apply", { files: { "data/log.txt": b64("1") }, delete: ["data"] }, new AbortController().signal);
    expect(root.children.get("data")?.kind).toBe("directory");
    await dm.handle("fs.apply", { files: { data: b64("a file again") }, delete: ["data/log.txt"] }, new AbortController().signal);
    expect(root.children.get("data")?.kind).toBe("file");
  });
});

describe("MSC lock", () => {
  it("keeps the console read-only for the whole MSC sync (review 2, finding 6)", async () => {
    const { dm } = setup();
    const { state } = fakeCircuitPython(dm, { hashlib: true });
    const root = withDrive(dm);
    let duringWrite: unknown = "not tried";
    root.onRemove = () => {
      duringWrite = dm.consoleWrite("repl", "\x04").then(
        () => "sent",
        (e) => e.message,
      );
    };
    await dm.handle("fs.apply", { files: {}, delete: ["a.py"] }, new AbortController().signal);
    expect(await duringWrite).toBe("read_only");
    expect(dm.busy).toBeNull();
    expect(state.sent).toContain("supervisor.runtime.autoreload=False");
    expect(state.sent).toContain("supervisor.runtime.autoreload=True");
  });
});

describe("test projects use only their emulator (D40)", () => {
  it("drops a real board when the open project is a test project", async () => {
    const { dm } = setup();
    fakeCircuitPython(dm, { hashlib: true });
    let closed = false;
    (dm.conns.repl as any).close = async () => void (closed = true);
    (dm as any).sink.state = () => ({ project: { type: "circuitpython", board: "rp2040js" }, device: {}, serial: { lock: {} } });
    dm.onState();
    await new Promise((r) => setTimeout(r, 0));
    expect(dm.attached).toBe(false);
    expect(closed).toBe(true);
  });

  it("drops another test project's emulator when a project is opened (review 4, finding 3)", async () => {
    const { dm } = setup();
    let closed = false;
    const link: any = { info: {}, port: null, emulated: { runtime: "circuitpython", firmware: "x", project: "A" }, onData: () => {}, onLost: () => {}, write: async () => {}, close: async () => void (closed = true) };
    await dm.connectEmulator(link);
    (dm as any).sink.state = () => ({ project: { id: "A", type: "circuitpython", board: "rp2040js" }, device: {}, serial: { lock: {} } });
    dm.onState();
    expect(dm.attached).toBe(true); // its own project: kept
    (dm as any).sink.state = () => ({ project: { id: "B", type: "circuitpython", board: null }, device: {}, serial: { lock: {} } });
    dm.onState();
    await new Promise((r) => setTimeout(r, 0));
    expect(dm.attached).toBe(false);
    expect(closed).toBe(true);
  });

  it("does not auto-connect real ports for a test project", async () => {
    const { dm } = setup();
    (dm as any).caps = { serial: true, msc: false };
    (dm as any).sink.state = () => ({ project: { type: "micropython", board: "rp2040js" }, device: {}, serial: { lock: {} } });
    let asked = false;
    (globalThis as any).navigator.serial = { getPorts: async () => ((asked = true), []) };
    await dm.autoConnect();
    expect(asked).toBe(false);
    delete (globalThis as any).navigator.serial;
  });
});

describe("role probe", () => {
  it("scores REPL-like output", () => {
    expect(replScore("\r\nKeyboardInterrupt\r\n>>> ")).toBeGreaterThan(replScore("12,34\r\n"));
    expect(replScore("")).toBe(0);
  });
});
