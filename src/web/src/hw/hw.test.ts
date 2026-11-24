import { describe, expect, it } from "vitest";
import { fromUtf8, parsePyBytes, pyBytes, pyPath, utf8 } from "./bytes";
import { listFiles, readFile, removeFiles, writeFile } from "./boardFs";
import { RawRepl, ExecError } from "./rawRepl";
import { parsePlotLine, PlotBuffer } from "./plot";
import { bootOutUid, excluded, plan } from "./syncRules";
import { Terminal } from "./terminal";

/**
 * A fake board speaking the raw REPL protocol. Each executed code block is
 * answered by `run(code)` returning [stdout, stderr].
 */
class FakeBoard {
  repl!: RawRepl;
  received = "";
  codes: string[] = [];
  private pending = "";
  private raw = false;
  constructor(private run: (code: string) => [string, string]) {}
  async write(data: Uint8Array) {
    const s = fromUtf8(data);
    this.received += s;
    for (const ch of s) {
      if (!this.raw) {
        if (ch === "\x01") {
          this.raw = true;
          this.emit("raw REPL; CTRL-B to exit\r\n>");
        }
        continue;
      }
      if (ch === "\x02") {
        this.raw = false;
      } else if (ch === "\x04") {
        const code = this.pending;
        this.pending = "";
        this.codes.push(code);
        const [out, err] = this.run(code);
        this.emit("OK" + out + "\x04" + err + "\x04>");
      } else if (ch === "\x03" || ch === "\r" && this.pending === "") {
        /* ignore */
      } else this.pending += ch;
    }
  }
  emit(s: string) {
    queueMicrotask(() => this.repl.feed(utf8(s)));
  }
}

async function session(run: (code: string) => [string, string]) {
  const board = new FakeBoard(run);
  const r = new RawRepl(board);
  board.repl = r;
  await r.enter(2000);
  return { r, board };
}

describe("bytes", () => {
  it("round-trips python bytes literals", () => {
    const data = Uint8Array.from([0, 1, 39, 92, 65, 10, 255, 34]);
    const lit = pyBytes(data);
    expect(lit).toBe("b'\\x00\\x01\\'\\\\A\\x0a\\xff\"'");
    expect(Array.from(parsePyBytes(lit))).toEqual(Array.from(data));
    expect(Array.from(parsePyBytes("b\"it's\\n\""))).toEqual(Array.from(utf8("it's\n")));
    expect(pyPath("/lib/ä.py")).toBe("b'/lib/\\xc3\\xa4.py'.decode()");
  });
});

describe("raw REPL", () => {
  it("execs code and returns stdout", async () => {
    const { r, board } = await session((code) => [code === "print(1)" ? "1\r\n" : "", ""]);
    expect(await r.exec("print(1)")).toBe("1\r\n");
    expect(board.codes).toEqual(["print(1)"]);
  });

  it("raises ExecError with stderr", async () => {
    const { r } = await session(() => ["", "Traceback...\r\nOSError: [Errno 2] ENOENT\r\n"]);
    await expect(r.exec("open('x')")).rejects.toBeInstanceOf(ExecError);
  });

  it("lists, reads, writes and removes files", async () => {
    const fs: Record<string, Uint8Array> = { "/code.py": utf8("print('hi')\n"), "/lib/a.mpy": Uint8Array.from([0, 1, 2]) };
    let writing: { path: string; data: number[] } | null = null;
    const { r, board } = await session((code) => {
      if (code.includes("def _bw")) return [Object.entries(fs).map(([p, d]) => `F ${d.length} ${p}\r\n`).join(""), ""];
      const open = code.match(/with open\((b'[^']*')\.decode\(\),'rb'\)/);
      if (open) {
        const p = fromUtf8(parsePyBytes(open[1]));
        return [`${pyBytes(fs[p])}\r\n`, ""];
      }
      const w = code.match(/^f=open\((b'[^']*')\.decode\(\),'wb'\)/);
      if (w) writing = { path: fromUtf8(parsePyBytes(w[1])), data: [] };
      const chunk = code.match(/^w\((b'.*')\)$/s);
      if (chunk && writing) writing.data.push(...parsePyBytes(chunk[1]));
      if (code.startsWith("f.close()") && writing) {
        fs[writing.path] = Uint8Array.from(writing.data);
        writing = null;
      }
      if (code.includes("os.remove")) for (const m of code.matchAll(/(b'[^']*')\.decode\(\)/g)) delete fs[fromUtf8(parsePyBytes(m[1]))];
      return ["", ""];
    });
    expect(await listFiles(r)).toEqual([
      { path: "code.py", size: 12 },
      { path: "lib/a.mpy", size: 3 },
    ]);
    expect(fromUtf8(await readFile(r, "code.py"))).toBe("print('hi')\n");
    const big = new Uint8Array(700).map((_, i) => i % 256);
    await writeFile(r, "lib/new.bin", big);
    expect(Array.from(fs["/lib/new.bin"])).toEqual(Array.from(big));
    expect(board.codes.some((c) => c.includes("os.mkdir"))).toBe(true);
    await removeFiles(r, ["lib/a.mpy"]);
    expect(fs["/lib/a.mpy"]).toBeUndefined();
  });
});

describe("list skip", () => {
  it("does not descend into skipped mounts", async () => {
    let code = "";
    const { r } = await session((c) => {
      code = c;
      return ["F 3 /main.py\r\n", ""];
    });
    expect(await listFiles(r, ["/rom"])).toEqual([{ path: "main.py", size: 3 }]);
    expect(code).toContain("_bs=('/rom',)");
    expect(code).toContain("if q in _bs:");
  });
});

describe("sync rules", () => {
  it("excludes OS junk and the ID file", () => {
    expect(excluded(".DS_Store")).toBe(true);
    expect(excluded("lib/._x.py")).toBe(true);
    expect(excluded(".boady_id")).toBe(true);
    expect(excluded("code.py")).toBe(false);
  });

  it("plans writes and deletions", () => {
    const p = plan({ "code.py": "a", "lib/x.py": "b", "new.py": "c" }, { "code.py": "a", "lib/x.py": "old", "gone.py": "z", ".boady_id": "q" });
    expect(p).toEqual({ need: ["lib/x.py", "new.py"], delete: ["gone.py"] });
  });

  it("reads the UID from boot_out.txt", () => {
    expect(bootOutUid("Adafruit CircuitPython 9.2.1 on 2024\r\nBoard ID:x\r\nUID:de6118804b2e3c2f\r\n")).toBe("DE6118804B2E3C2F");
    expect(bootOutUid("nothing")).toBeNull();
  });
});

describe("terminal", () => {
  it("handles CR, backspace and escapes", () => {
    const t = new Terminal();
    t.write("\x1b]0;🐍code.py | 9.2.1\x1b\\>>> prinx\bt(1)\r\n1\r\n>>> ");
    t.write("abc\rX");
    expect(t.text()).toBe(">>> print(1)\n1\nX>> abc");
    t.write("\x1b[K");
    expect(t.lines[t.lines.length - 1]).toBe("X");
  });
});

describe("plot", () => {
  it("parses Mu-style tuples", () => {
    expect(parsePlotLine("(1, 2.5, -3e2)")).toEqual([1, 2.5, -300]);
    expect(parsePlotLine("(4,)")).toEqual([4]);
    expect(parsePlotLine("(a, 1)")).toBeNull();
    expect(parsePlotLine("1, 2")).toBeNull();
  });

  it("buffers across chunks", () => {
    const b = new PlotBuffer(3);
    b.feed("(1, 2)\r\n(3,");
    b.feed(" 4)\r\nnoise\r\n(5, 6)\n(7, 8)\n");
    expect(b.points).toEqual([[3, 4], [5, 6], [7, 8]]);
  });
});
