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
import { REPL_KEYS } from "../replKeys";
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

/** The keys step 1 of the identification prompt writes, in order (each `write_repl`). */
function identifyStopKeys(): string[] {
  const md = read("../prompts/tasks/identify_board.md").toString();
  const step = md.split("\n").find((l) => l.startsWith("1. "))!;
  const keys = step.slice(0, step.indexOf("Read with")).match(/`\\(x0[1-4]|r)`/g) ?? [];
  return keys.map((k) => (k === "`\\r`" ? "\r" : String.fromCharCode(parseInt(k.slice(3, 5), 16))));
}

/** The writes of the agent's system prompt step that stops the program and reaches >>>, in order. */
function agentStopWrites(runtime: string): string[] {
  const md = read(`../prompts/system/${runtime}.md`).toString();
  const step = md.split("\n").find((l) => l.startsWith("- **Stopping the program"))!;
  return [...step.matchAll(/write_repl\("([^"]*)"\)/g)].map((m) =>
    m[1].replace(/\\x([0-9a-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))).replace(/\\r/g, "\r"),
  );
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

    it("identification step 1 reaches >>> even from a raw REPL left open", async () => {
      // review 7: an interrupted transfer can leave the board in raw REPL mode
      let at = stream().length;
      await type("\x01");
      await waitFor("raw REPL; CTRL-B to exit", at);
      at = stream().length;
      const keys = identifyStopKeys();
      expect(keys.slice(0, 2)).toEqual(["\x03", "\x03"]);
      for (const k of keys) {
        await type(k);
        await sleep(300);
      }
      // the prompt's own fallbacks: one more Enter, and Enter after "Press any key"
      if (!(await readRepl(at, ">>> ", 3000)).includes(">>> ")) {
        await type("\r");
        await sleep(500);
        if (stream().slice(at).includes("Press any key")) await type("\r");
      }
      await waitFor(">>> ", at, 3000);
    }, 60000);

    if (runtime === "micropython") {
      it("the /.boady_id fallback creates one ID and keeps it", async () => {
        const fallback = identifyCommands()[3];
        expect(fallback).toContain("/.boady_id");
        const ids: string[] = [];
        for (let i = 0; i < 2; i++) {
          const at = stream().length;
          await type(fallback + "\r");
          const text = await readRepl(at, "BOADY_END");
          stopsAtResult(text, "BOADY_UID");
          const m = text.match(/^BOADY_UID ([0-9A-F]{32}) BOADY_END\r?$/m);
          expect(m, JSON.stringify(text)).not.toBeNull();
          ids.push(m![1]);
          await waitFor(">>> ", at + fallback.length);
        }
        expect(ids[1]).toBe(ids[0]);
        const at = stream().length;
        await type("import os;os.remove('/.boady_id')\r");
        await waitFor(">>> ", at + 10);
      }, 60000);
    }

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

    it("turns a file into a directory of the same name and back (review 9, finding 5)", async () => {
      const apply = (files: Record<string, string>, del: string[]) => dm.handle("fs.apply", { files, delete: del }, signal());
      await apply({ data: toBase64(utf8("a file")) }, []);
      await apply({ "data/log.txt": toBase64(utf8("1")) }, ["data"]);
      expect(Object.keys((await dm.handle("fs.read_all", {}, signal())).files)).toContain("data/log.txt");
      await apply({ data: toBase64(utf8("a file again")) }, ["data/log.txt"]);
      const all = (await dm.handle("fs.read_all", {}, signal())).files;
      expect(fromUtf8(fromBase64(all["data"]))).toBe("a file again");
      await apply({}, ["data"]);
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

    it("the agent's stop step reaches >>> from every state, a running code.py included (reviews 12, 15)", async () => {
      const writes = agentStopWrites(runtime);
      expect(writes).toEqual(["\x03", "\x02"]);
      // the prompt's procedure: first write, wait (a timeout is fine), second write, wait for >>>
      const stop = async (what: string) => {
        let at = stream().length;
        await dm.consoleWrite("repl", writes[0]);
        await readRepl(at, runtime === "circuitpython" ? "Press any key" : ">>> ", 2000);
        at = stream().length;
        await dm.consoleWrite("repl", writes[1]);
        const text = await readRepl(at, ">>> ", 3000);
        expect(text, `${what}: ${JSON.stringify(text)}`).toContain(">>> ");
        await sleep(300);
      };
      const enter = async (setup: string, marker: string) => {
        const at = stream().length;
        await dm.consoleWrite("repl", setup);
        await waitFor(marker, at, 30000);
      };
      await enter("\x01", "raw REPL; CTRL-B to exit");
      await stop("raw REPL");
      await enter("\x05", "paste mode; Ctrl-C to cancel");
      await stop("paste mode");
      await enter("while True: pass\r\r", "... ");
      await stop("a loop typed at the REPL");
      await enter("\r", ">>> ");
      await stop("normal REPL");
      // review 15: the common case, the program file running (as after every sync)
      const main = runtime === "circuitpython" ? "code.py" : "main.py";
      const keep = (await dm.handle("fs.read_all", {}, signal())).files[main];
      const prog = "import time\nprint('PROGRAM RUNNING')\nwhile True:\n    time.sleep(0.05)\n";
      let at = stream().length;
      await dm.handle("fs.apply", { files: { [main]: toBase64(utf8(prog)) }, delete: [] }, signal());
      if (runtime === "micropython") await dm.consoleWrite("repl", "\x04"); // CircuitPython reloads by itself
      await waitFor("PROGRAM RUNNING", at, 60000);
      await sleep(300);
      await stop(`${main} running`);
      at = stream().length;
      await dm.handle("fs.apply", { files: keep ? { [main]: keep } : {}, delete: keep ? [] : [main] }, signal());
      if (runtime === "circuitpython") {
        await waitFor("Press any key", at, 60000);
        await dm.consoleWrite("repl", "\r");
        await waitFor(">>> ", at, 10000);
      }
    }, 180000);

    it("every Serial tab key does the same on this firmware (D46)", async () => {
      const key = (id: string) => REPL_KEYS.find((k) => k.id === id)!.data;
      expect(REPL_KEYS.map((k) => k.id)).toEqual(["ctrl-c", "ctrl-d", "ctrl-e", "ctrl-a", "ctrl-b"]);
      const press = async (data: string, expectText: string, ms = 30000) => {
        const at = stream().length;
        await dm.consoleWrite("repl", data);
        return waitFor(expectText, at, ms);
      };
      const banner = runtime === "micropython" ? "MicroPython v1.29.0" : "Adafruit CircuitPython 10.3.2";
      await press(key("ctrl-a"), "raw REPL; CTRL-B to exit"); // raw REPL
      await press(key("ctrl-b"), banner); // back to the normal REPL
      await waitFor(">>> ", stream().length - 10);
      await press(key("ctrl-e"), "paste mode; Ctrl-C to cancel, Ctrl-D to finish"); // paste mode (both firmwares)
      await press(key("ctrl-c"), ">>> "); // Ctrl-C cancels it
      await press("while True: pass\r\r", "... ");
      await press(key("ctrl-c"), "KeyboardInterrupt"); // interrupts a running program
      await waitFor(">>> ", stream().length - 10);
      await press(key("ctrl-d"), "soft reboot"); // soft reset / reload
      if (runtime === "circuitpython") {
        await waitFor("Press any key to enter the REPL", stream().length - 200, 30000);
        await press("\r", ">>> ");
      } else {
        await waitFor(">>> ", stream().length - 10);
      }
    }, 120000);

    it("shows GPIO levels and takes button input (Emulator tab, D42)", async () => {
      const pins = dm.emulatorPins!;
      expect(pins).toBe(link);
      const bitOf = (mask: number, i: number) => (mask >>> i) & 1;
      const until = async (ok: () => boolean, what: string) => {
        const end = Date.now() + 10000;
        while (!ok()) {
          if (Date.now() > end) throw new Error(`timeout: ${what}; pins ${JSON.stringify(pins.pins)}`);
          await sleep(20);
        }
      };
      const run = async (line: string, expect?: string) => {
        const at = stream().length;
        await type(line + "\r");
        if (expect) await waitFor(expect, at + line.length, 10000);
        await waitFor(">>> ", at + line.length, 10000);
      };
      if (runtime === "micropython") {
        await run("from machine import Pin;o=Pin(15,Pin.OUT);o.value(1);i=Pin(14,Pin.IN,Pin.PULL_UP);led=Pin('LED',Pin.OUT);led.value(1)");
      } else {
        await run(
          "import board,digitalio;o=digitalio.DigitalInOut(board.GP15);o.switch_to_output(True);i=digitalio.DigitalInOut(board.GP14);i.switch_to_input(digitalio.Pull.UP);led=digitalio.DigitalInOut(board.LED);led.switch_to_output(True)",
        );
      }
      const read = runtime === "micropython" ? "print('V%d' % i.value())" : "print('V%d' % i.value)";
      await until(() => bitOf(pins.pins.levels, 15) === 1 && bitOf(pins.pins.outputs, 15) === 1, "GP15 high output");
      await until(() => bitOf(pins.pins.levels, 25) === 1, "on-board LED lit");
      await until(() => bitOf(pins.pins.levels, 14) === 1 && bitOf(pins.pins.outputs, 14) === 0, "GP14 pulled up");
      pins.setPin(14, false); // button to GND pressed
      await until(() => bitOf(pins.pins.levels, 14) === 0, "GP14 driven low");
      await run(read, "V0");
      pins.setPin(14, null); // released: the pull-up decides again
      await until(() => bitOf(pins.pins.levels, 14) === 1, "GP14 released");
      await run(read, "V1");
      // review 8, finding 2: the firmware reads its own output back (and can toggle it)
      const readOut = runtime === "micropython" ? "print('O%d' % o.value())" : "print('O%d' % o.value)";
      await run(readOut, "O1");
      await run(runtime === "micropython" ? "o.value(not o.value())" : "o.value = not o.value");
      await until(() => bitOf(pins.pins.levels, 15) === 0, "GP15 toggled low");
      await run(readOut, "O0");
      await run(runtime === "micropython" ? "o.value(not o.value())" : "o.value = not o.value");
      await until(() => bitOf(pins.pins.levels, 15) === 1, "GP15 toggled high");
      await run(runtime === "micropython" ? "o.value(0)" : "o.value=False");
      await until(() => bitOf(pins.pins.levels, 15) === 0, "GP15 low");
      await run(runtime === "micropython" ? "led.value(0)" : "led.deinit();o.deinit();i.deinit()");
    }, 60000);

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

    if (runtime === "micropython") {
      it("a switch left on is wired before main.py runs (review 9, finding 3)", async () => {
        // read at boot, printed later: output before the USB serial port is up is lost
        const boot = "from machine import Pin\nb14 = Pin(14, Pin.IN, Pin.PULL_UP).value()\n";
        await dm.handle("fs.apply", { files: { "main.py": toBase64(utf8(boot)) }, delete: [] }, signal());
        const flash = await (link as unknown as { host: InProcessHost }).host.flash();
        const run = async (inputs?: [number, boolean][]) => {
          const pico = new PicoMachine({ firmware: new Uint8Array(read(FIRMWARE[runtime])), flash, uid: UID, inputs });
          let out = "";
          const host = new InProcessHost(pico);
          host.onData = (b) => (out += fromUtf8(b));
          pico.start();
          await host.ready();
          const end = Date.now() + 30000;
          while (!out.includes(">>> ") && Date.now() < end) {
            pico.write(utf8("\r"));
            await sleep(300);
          }
          pico.write(utf8("print('BOOT14=%d' % b14)\r"));
          while (!/BOOT14=\d\r/.test(out) && Date.now() < end) await sleep(20);
          pico.stop();
          return out.match(/BOOT14=\d/)?.[0];
        };
        expect(await run()).toBe("BOOT14=1"); // nothing wired: the pull-up
        expect(await run([[14, false]])).toBe("BOOT14=0"); // switch to GND on
        // review 13, finding 3: the UI learns the start-up state, though it never changes later
        // a fresh flash: no program changes any pin, so nothing else triggers a report
        const pico = new PicoMachine({ firmware: new Uint8Array(read(FIRMWARE[runtime])), uid: UID, inputs: [[3, true]] });
        const host = new InProcessHost(pico);
        const shown = new EmulatorLink(host, { runtime, firmware: runtime });
        pico.start();
        await host.ready();
        const end = Date.now() + 5000;
        while (!((shown.pins.levels >>> 3) & 1) && Date.now() < end) await sleep(20);
        pico.stop();
        expect((shown.pins.levels >>> 3) & 1, JSON.stringify(shown.pins)).toBe(1);
        await dm.handle("fs.apply", { files: {}, delete: ["main.py"] }, signal());
      }, 120000);
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
