import { describe, expect, it } from "vitest";
import { fromBase64, fromUtf8, parsePyBytes, pyBytes, sha256hex, toBase64, utf8 } from "./bytes";
import { choosePorts, DeviceManager, replScore } from "./device";
import { FakeDir, FakeFile } from "./fakeDrive";

/** A CircuitPython-like board behind a fake serial port, driven through DeviceManager. */
function fakeCircuitPython(dm: DeviceManager, opts: { hashlib: boolean }) {
  const fs: Record<string, Uint8Array> = { "/code.py": utf8("old\n"), "/boot_out.txt": utf8("UID:ABCD\n"), "/gone.py": utf8("x") };
  const state = { raw: false, pending: "", usbDisabled: false, writing: null as null | { path: string; data: number[] }, sent: "" };
  const emit = (s: string) => queueMicrotask(() => (dm as any).onData("repl", utf8(s)));
  const run = (code: string): [string, string] => {
    const P = (m: RegExpMatchArray | null) => (m ? fromUtf8(parsePyBytes(m[1])) : "");
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

const backendText = (sent: any[]) =>
  sent.filter((m) => m.type === "serial.data").map((m) => fromUtf8(fromBase64(m.b64))).join("");

describe("DeviceManager over the serial raw REPL (CircuitPython)", () => {
  it("pulls all files, hiding protocol bytes from the backend buffer", async () => {
    const { dm, sent } = setup();
    fakeCircuitPython(dm, { hashlib: false });
    const res = await dm.handle("fs.read_all", {}, new AbortController().signal);
    expect(Object.keys(res.files).sort()).toEqual(["boot_out.txt", "code.py", "gone.py"]);
    expect(fromUtf8(fromBase64(res.files["code.py"]))).toBe("old\n");
    await new Promise((r) => setTimeout(r, 60));
    const text = backendText(sent);
    expect(text).toContain("[boady: syncing files…]");
    expect(text).toContain("[boady: sync finished]");
    expect(text).not.toContain("raw REPL");
    expect(sent.some((m) => m.type === "device.update" && m.channel === "serial")).toBe(true);
  });

  it("plans and applies a sync with write access switching and soft reload", async () => {
    const { dm, sent } = setup();
    const { fs, state } = fakeCircuitPython(dm, { hashlib: false });
    const manifest = { "code.py": await sha256hex(utf8("new\n")), "boot_out.txt": await sha256hex(utf8("UID:ABCD\n")), "lib/x.py": await sha256hex(utf8("lib")) };
    const p = await dm.handle("fs.plan", { manifest }, new AbortController().signal);
    expect(p).toEqual({ need: ["code.py", "lib/x.py"], delete: ["gone.py"] });
    const res = await dm.handle(
      "fs.apply",
      { files: { "code.py": toBase64(utf8("new\n")), "lib/x.py": toBase64(utf8("lib")) }, delete: ["gone.py"] },
      new AbortController().signal,
    );
    expect(res).toMatchObject({ written: ["code.py", "lib/x.py"], deleted: ["gone.py"], channel: "serial", restarted: true });
    expect(fromUtf8(fs["/code.py"])).toBe("new\n");
    expect(fromUtf8(fs["/lib/x.py"])).toBe("lib");
    expect(fs["/gone.py"]).toBeUndefined();
    expect(state.usbDisabled).toBe(false); // drive given back
    expect(state.sent.endsWith("\x04")).toBe(true); // soft reload after leaving raw REPL
    await new Promise((r) => setTimeout(r, 60));
    expect(backendText(sent)).toContain("code.py output");
  });

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

describe("role probe", () => {
  it("scores REPL-like output", () => {
    expect(replScore("\r\nKeyboardInterrupt\r\n>>> ")).toBeGreaterThan(replScore("12,34\r\n"));
    expect(replScore("")).toBe(0);
  });
});
