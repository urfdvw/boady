// @vitest-environment happy-dom
/**
 * Test project "blink" (Master, 2026-11-25): fixed code blinks the on-board LED on the
 * emulated Pico with the official firmware. Checks both GP25 (the emulator's pin state)
 * and the LED drawn in the Emulator tab's DOM, which must follow it (D45).
 */
import { readFileSync } from "fs";
import { URL as NodeURL } from "url"; // the global URL is happy-dom's here
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterAll, describe, expect, it } from "vitest";
import type { Backend } from "../../backend";
import { I18nContext, translate } from "../../i18n";
import { EmulatorTab } from "../../tabs/EmulatorTab";
import { toBase64, utf8 } from "../bytes";
import { DeviceManager } from "../device";
import { EmulatorLink, InProcessHost } from "./link";
import { onboardLit } from "./parts";
import { PicoMachine } from "./pico";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const root = new NodeURL("../../../", import.meta.url);
const FIRMWARE = {
  micropython: "public/emulator/firmware/micropython-rpi_pico-1.29.0.uf2",
  circuitpython: "public/emulator/firmware/circuitpython-raspberry_pi_pico-10.3.2.uf2",
} as const;

/** The blink programs of the test project, one per runtime. */
const BLINK = {
  micropython: {
    file: "main.py",
    code: "from machine import Pin\nimport time\nled = Pin('LED', Pin.OUT)\nwhile True:\n    led.toggle()\n    time.sleep(0.3)\n",
  },
  circuitpython: {
    file: "code.py",
    code:
      "import board, digitalio, time\nled = digitalio.DigitalInOut(board.LED)\nled.switch_to_output()\n" +
      "while True:\n    led.value = not led.value\n    time.sleep(0.3)\n",
  },
} as const;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

for (const runtime of ["micropython", "circuitpython"] as const) {
  describe(`test project blink: ${runtime}`, () => {
    const cleanup: (() => void | Promise<void>)[] = [];
    afterAll(async () => {
      for (const c of cleanup.reverse()) await c();
    });

    it("blinks GP25, and the Emulator tab's on-board LED follows it", async () => {
      const pico = new PicoMachine({ firmware: new Uint8Array(readFileSync(new NodeURL(FIRMWARE[runtime], root))), uid: new Uint8Array(8).fill(7) });
      const host = new InProcessHost(pico);
      pico.start();
      await host.ready();
      const link = new EmulatorLink(host, { runtime, firmware: runtime, project: "blink" });
      cleanup.push(() => link.close());
      const dm = new DeviceManager();
      const state = { project: { id: "blink", type: runtime, board: "rp2040js" }, device: { uid: null, channel: null }, serial: { lock: { repl: null, data: null } } };
      dm.bind({ send: () => {}, state: () => state as any });
      await dm.connectEmulator(link);

      const el = document.createElement("div");
      document.body.appendChild(el);
      const view = createRoot(el);
      cleanup.push(() => act(() => view.unmount()));
      const backend = { state } as unknown as Backend;
      act(() =>
        view.render(
          <I18nContext.Provider value={{ lang: "en", t: (k: string, v?: Record<string, string | number>) => translate("en", k, v) } as any}>
            <EmulatorTab backend={backend} hw={dm} />
          </I18nContext.Provider>,
        ),
      );
      const domLit = () => el.querySelector(".emu-led-smd")!.getAttribute("class")!.split(" ").includes("lit");

      const signal = new AbortController().signal;
      await dm.handle("fs.apply", { files: { [BLINK[runtime].file]: toBase64(utf8(BLINK[runtime].code)) }, delete: [] }, signal);
      // CircuitPython reloads code.py itself after a serial sync; MicroPython runs main.py on a soft reset
      if (runtime === "micropython") await dm.handle("serial.write", { port: "repl", data: "\x04" }, signal);

      // watch: every sample, the DOM must show what GP25 says (after React rendered it)
      const seen: boolean[] = [];
      const end = Date.now() + 90000;
      while (Date.now() < end) {
        await act(async () => {
          await sleep(40);
        });
        const pin = onboardLit(dm.emulatorPins!.pins);
        expect(domLit(), `DOM LED vs GP25 after ${seen.length} samples`).toBe(pin);
        if (seen[seen.length - 1] !== pin) seen.push(pin);
        if (seen.length >= 5) break; // on, off, on, off, on (or the reverse): it blinks
      }
      expect(seen.length, `GP25 states seen: ${JSON.stringify(seen)}`).toBeGreaterThanOrEqual(5);
      expect(seen).toContain(true);
      expect(seen).toContain(false);
    }, 180000);
  });
}
