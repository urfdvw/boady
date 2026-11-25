/// <reference types="node" />
/**
 * boady's hardware layer against an emulated Raspberry Pi Pico running the
 * official MicroPython and CircuitPython firmware (vendored rp2040js).
 * Same code path as a real board: DeviceManager -> SerialLink -> USB CDC.
 */
import { readFileSync } from "fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fromBase64, fromUtf8, sha256hex, toBase64, utf8 } from "../bytes";
import { DeviceManager } from "../device";
import { EmulatorLink, InProcessHost } from "./link";
import { PicoMachine } from "./pico";

const root = new URL("../../../", import.meta.url);
const read = (p: string) => readFileSync(new URL(p, root));
const FIRMWARE = {
  micropython: "public/emulator/firmware/micropython-rpi_pico-1.29.0.uf2",
  circuitpython: "public/emulator/firmware/circuitpython-raspberry_pi_pico-10.3.2.uf2",
} as const;
const UID = Uint8Array.from([0xde, 0x61, 0x18, 0x80, 0x4b, 0x2e, 0x3c, 0x2f]);

/** Code blocks of the identification prompt, in order. */
function identifyCommands(): string[] {
  const md = read("../prompts/tasks/identify_board.md").toString();
  return [...md.matchAll(/^[ \t]*```[ \t]*\n([\s\S]*?)\n[ \t]*```/gm)].map((m) => m[1].trim());
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

for (const runtime of ["micropython", "circuitpython"] as const) {
  describe(`on an emulated Pico: ${runtime}`, () => {
    let dm: DeviceManager;
    let link: EmulatorLink;
    let sent: any[] = [];
    let state: any;
    const stream = () =>
      sent.filter((m) => m.type === "serial.data" && m.port === "repl").map((m) => fromUtf8(fromBase64(m.b64))).join("");
    /** Wait for text in what the backend received (the REPL ring buffer), after position ``from``. */
    async function waitFor(text: string, from = 0, ms = 60000): Promise<number> {
      const end = Date.now() + ms;
      for (;;) {
        const s = stream();
        const i = s.indexOf(text, from);
        if (i >= 0) return i + text.length;
        if (Date.now() > end) throw new Error(`timeout waiting for ${JSON.stringify(text)}; tail ${JSON.stringify(s.slice(-300))}`);
        await sleep(20);
      }
    }
    /** Like the read_repl tool: text since ``since``, returned as soon as ``waitFor`` appears in it. */
    async function readRepl(since: number, waitFor: string, ms = 5000): Promise<string> {
      const end = Date.now() + ms;
      for (;;) {
        const s = stream().slice(since);
        if (s.includes(waitFor)) return s;
        if (Date.now() > end) return s;
        await sleep(1);
      }
    }
    /** os.listdir on the board, through a raw REPL session like a sync uses. */
    async function boardListdir(path: string): Promise<string[]> {
      const { RawRepl } = await import("../rawRepl");
      const r = new RawRepl(link, signal());
      const d = dm as unknown as { tap: unknown };
      const prev = d.tap;
      d.tap = r;
      try {
        await r.enter();
        const out = await r.exec(`import os\nprint(repr(sorted(os.listdir(${JSON.stringify(path)}))))`);
        await r.exit();
        return JSON.parse(out.trim().replace(/'/g, '"'));
      } finally {
        await sleep(100);
        d.tap = prev;
      }
    }
    /** wait_for stops at the first marker: it must be the executed result, not the echoed command. */
    function stopsAtResult(text: string, prefix: string) {
      const first = text.indexOf("BOADY_END");
      const line = text.search(new RegExp(`(^|\\n)${prefix} `));
      expect(line, JSON.stringify(text)).toBeGreaterThanOrEqual(0);
      expect(first, `first BOADY_END is in the echo: ${JSON.stringify(text)}`).toBeGreaterThan(line);
    }
    const type = (s: string) => dm.handle("serial.write", { port: "repl", data: s }, new AbortController().signal);
    const signal = () => new AbortController().signal;

    beforeAll(async () => {
      const pico = new PicoMachine({ firmware: new Uint8Array(read(FIRMWARE[runtime])), uid: UID });
      const host = new InProcessHost(pico);
      pico.start();
      await host.ready();
      link = new EmulatorLink(host, { runtime, firmware: runtime });
      dm = new DeviceManager();
      state = { project: { type: runtime }, device: { uid: null, channel: null }, serial: { lock: { repl: null, data: null } } };
      dm.bind({ send: (m) => sent.push(m), state: () => state });
      await dm.connectEmulator(link);
    }, 90000);

    afterAll(async () => {
      await link?.close();
    });

    it("announces itself as an emulator, without MSC", () => {
      const att = sent.find((m) => m.type === "device.attached");
      expect(att.usb.emulator).toEqual({ runtime, firmware: runtime });
      expect(att.ports).toEqual(["repl"]);
    });

    it("answers the identification commands from the prompt", async () => {
      const [rt, cpUid, mpUid] = identifyCommands();
      await type("\x03");
      await sleep(300);
      await type("\x03");
      await sleep(300);
      let at = stream().length;
      await type("\r");
      if (runtime === "circuitpython") {
        // "Press any key to enter the REPL" after Ctrl-C
        await sleep(500);
        await type("\r");
      }
      await waitFor(">>> ", at);
      // Same procedure as the prompt: write the line, then read_repl(since=cursor,
      // wait_for="BOADY_END") returns the text at the moment the marker first appears.
      at = stream().length;
      await type(rt + "\r");
      const rtText = await readRepl(at, "BOADY_END");
      stopsAtResult(rtText, "BOADY_RT");
      const m = rtText.match(/^BOADY_RT (\w+) (\d+\.\d+\.\d+) (\d+) BOADY_END\r?$/m);
      expect(m, JSON.stringify(rtText)).not.toBeNull();
      expect(m![1]).toBe(runtime);
      await waitFor(">>> ", at + rt.length);
      at = stream().length;
      const uidCmd = runtime === "circuitpython" ? cpUid : mpUid;
      await type(uidCmd + "\r");
      const uidText = await readRepl(at, "BOADY_END");
      stopsAtResult(uidText, "BOADY_UID");
      expect(uidText).toMatch(/^BOADY_UID DE6118804B2E3C2F BOADY_END\r?$/m);
      await waitFor(">>> ", at + uidCmd.length);
      state.device.uid = "DE6118804B2E3C2F";
    }, 60000);

    it("syncs files both ways through the raw REPL", async () => {
      const bin = new Uint8Array(700).map((_, i) => (i * 37) & 0xff);
      const files: Record<string, Uint8Array> = {
        [runtime === "circuitpython" ? "code.py" : "main.py"]: utf8("print('synced by boady')\n"),
        "lib/helper.py": utf8("X = 1\n"),
        "data/blob.bin": bin,
      };
      // like boady: pull first (the mirror starts as the board's content), then add files
      const first = await dm.handle("fs.read_all", {}, signal());
      if (runtime === "circuitpython") expect(fromUtf8(fromBase64(first.files["boot_out.txt"]))).toContain("UID:DE6118804B2E3C2F");
      const manifest: Record<string, string> = {};
      for (const [p, b64] of Object.entries(first.files as Record<string, string>)) manifest[p] = await sha256hex(fromBase64(b64));
      for (const [p, d] of Object.entries(files)) manifest[p] = await sha256hex(d);
      const at = stream().length;

      const plan = await dm.handle("fs.plan", { manifest }, signal());
      expect(plan.need.sort()).toEqual(Object.keys(files).sort());
      expect(plan.delete).toEqual([]);
      const enc = Object.fromEntries(Object.entries(files).map(([p, d]) => [p, toBase64(d)]));
      const res = await dm.handle("fs.apply", { files: enc, delete: plan.delete }, signal());
      expect(res.written.sort()).toEqual(Object.keys(files).sort());
      expect(res.channel).toBe("serial");
      expect(res.restarted).toBe(runtime === "circuitpython");

      // the backend sees sync markers, never raw REPL protocol bytes
      const during = stream().slice(at);
      expect(during).toContain("[boady: syncing files…]");
      expect(during).toContain("[boady: sync finished]");
      expect(during).not.toContain("raw REPL; CTRL-B to exit");

      if (runtime === "circuitpython") await waitFor("synced by boady", at, 60000); // soft reload ran code.py

      // now the board equals the mirror: nothing to do
      const again = await dm.handle("fs.plan", { manifest }, signal());
      expect(again.need).toEqual([]);

      // compare_with_device: files whose hash the backend already knows are not transferred
      const known = { ...manifest, "lib/helper.py": "0".repeat(64) };
      const cmp = await dm.handle("fs.read_all", { known }, signal());
      if (runtime === "micropython") {
        expect(Object.keys(cmp.files)).toEqual(["lib/helper.py"]);
        expect(cmp.same.sort()).toEqual(Object.keys(manifest).filter((p) => p !== "lib/helper.py").sort());
      } else {
        // CircuitPython's Pico build has no hashlib: everything is read, as before
        expect(cmp.same).toEqual([]);
        expect(Object.keys(cmp.files).sort()).toEqual(Object.keys(manifest).sort());
      }

      // pull everything back
      const all = await dm.handle("fs.read_all", {}, signal());
      expect(Array.from(fromBase64(all.files["data/blob.bin"]))).toEqual(Array.from(bin));
      expect(fromUtf8(fromBase64(all.files["lib/helper.py"]))).toBe("X = 1\n");
      if (runtime === "circuitpython") expect(Object.keys(all.files)).toContain("boot_out.txt");

      // delete: extra board files go, emptied directories are pruned
      delete manifest["data/blob.bin"];
      const p3 = await dm.handle("fs.plan", { manifest }, signal());
      expect(p3.delete).toContain("data/blob.bin");
      await dm.handle("fs.apply", { files: {}, delete: p3.delete }, signal());
      const after = await dm.handle("fs.read_all", {}, signal());
      expect(Object.keys(after.files)).not.toContain("data/blob.bin");
      expect(Object.keys(after.files).some((p) => p.startsWith("data/"))).toBe(false);
      // the file list cannot show an empty directory: ask the board itself
      expect(await boardListdir("/")).not.toContain("data");
      expect(await boardListdir("/")).toContain("lib");
    }, 240000);

    it("keeps the console read-only while a sync runs", async () => {
      const run = dm.handle("fs.read_all", {}, signal());
      await sleep(200);
      await expect(dm.consoleWrite("repl", "\x04")).rejects.toThrow("read_only");
      await run;
    }, 120000);

    it("stops a running program with Ctrl-C and plots tuples", async () => {
      dm.plot.clear();
      await type("\x03");
      await sleep(500);
      await type("\r");
      if (runtime === "circuitpython") {
        await sleep(500);
        await type("\r");
      }
      let at = stream().length;
      await waitFor(">>> ", Math.max(0, at - 10));
      at = stream().length;
      await type('exec("import time\\ni=0\\nwhile True:\\n print((i, i*i))\\n i+=1\\n time.sleep(0.05)")\r');
      await waitFor("(5, 25)", at, 60000);
      expect(dm.plot.points.length).toBeGreaterThanOrEqual(5);
      expect(dm.plot.points.find((p) => p[0] === 3)).toEqual([3, 9]);
      at = stream().length;
      await type("\x03");
      await waitFor("KeyboardInterrupt", at, 30000);
      await waitFor(">>> ", at, 30000);
    }, 120000);

    it("reports a real Traceback from the raw REPL as an error", async () => {
      const { RawRepl, ExecError } = await import("../rawRepl");
      const r = new RawRepl(link, signal());
      const prevTap = (dm as unknown as { tap: unknown }).tap;
      (dm as unknown as { tap: unknown }).tap = r; // receive the bytes like a sync does
      try {
        await r.enter();
        const err = await r.exec("open('/no_such_file')").catch((e) => e);
        expect(err).toBeInstanceOf(ExecError);
        expect(err.stderr).toMatch(/OSError: \[Errno 2\]/);
        await r.exit();
      } finally {
        (dm as unknown as { tap: unknown }).tap = prevTap;
      }
    }, 60000);

    if (runtime === "micropython") {
      it("soft reset runs the synced main.py", async () => {
        await type("\x03");
        await sleep(300);
        let at = stream().length;
        await type("\r");
        await waitFor(">>> ", at);
        at = stream().length;
        await type("\x04");
        await waitFor("synced by boady", at, 30000);
      }, 60000);
    }

    it("persists the filesystem in its flash image", async () => {
      await dm.handle("fs.apply", { files: { "persist.txt": toBase64(utf8("kept across restarts\n")) }, delete: [] }, signal());
      const flash = await (link as unknown as { host: InProcessHost }).host.flash();
      const pico2 = new PicoMachine({ firmware: new Uint8Array(read(FIRMWARE[runtime])), flash, uid: UID });
      let out = "";
      pico2.onData = (b) => (out += fromUtf8(b));
      pico2.start();
      for (let i = 0; i < 3000 && !pico2.connected; i++) await sleep(20);
      pico2.write(utf8("\x03\r"));
      await sleep(1000);
      pico2.write(utf8("\r"));
      for (let i = 0; i < 3000 && !out.includes(">>> "); i++) await sleep(20);
      pico2.write(utf8("print(repr(open('/persist.txt').read()))\r"));
      for (let i = 0; i < 3000 && !out.includes("'kept across restarts\\n'"); i++) await sleep(20);
      pico2.stop();
      expect(out).toContain("'kept across restarts\\n'"); // content, not just the name
    }, 120000);
  });
}
