/// <reference types="node" />
/**
 * Review 4, finding 5: files written while the emulator runs (from the REPL or
 * by a program) must be saved without a sync or a disconnect, so a page reload
 * keeps them. Real MicroPython firmware on the emulated Pico.
 */
import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";
import { fromUtf8, utf8 } from "../bytes";
import { EmulatorLink, InProcessHost } from "./link";
import { PicoMachine } from "./pico";

const fw = () => new Uint8Array(readFileSync(new URL("../../../public/emulator/firmware/micropython-rpi_pico-1.29.0.uf2", import.meta.url)));
const uid = Uint8Array.from([1, 1, 2, 3, 5, 8, 13, 21]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function repl(pico: PicoMachine, out: () => string, line: string, expect: string) {
  pico.write(utf8(line + "\r"));
  for (let i = 0; i < 1500 && !out().includes(expect); i++) await sleep(20);
  return out();
}

describe("emulator persistence while running", () => {
  it("saves a file written from the REPL without sync or disconnect", async () => {
    const pico = new PicoMachine({ firmware: fw(), uid });
    let out = "";
    pico.onData = (b) => (out += fromUtf8(b));
    const host = new InProcessHost(pico);
    const saves: Uint8Array[] = [];
    const link = new EmulatorLink(host, { runtime: "micropython", firmware: "x", project: "p" }, async (f) => void saves.push(f));
    link.onData = (b) => (out += fromUtf8(b));
    pico.start();
    await host.ready();
    await repl(pico, () => out, "", ">>> ");
    await repl(pico, () => out, "f=open('review.txt','w');f.write('written in the REPL');f.close();print('CLOSED')", "CLOSED");
    for (let i = 0; i < 300 && saves.length === 0; i++) await sleep(20);
    expect(saves.length, "no save after the firmware wrote flash").toBeGreaterThan(0);
    pico.stop(); // like a page reload: no close(), no checkpoint

    const again = new PicoMachine({ firmware: fw(), flash: saves[saves.length - 1], uid });
    let out2 = "";
    again.onData = (b) => (out2 += fromUtf8(b));
    again.start();
    for (let i = 0; i < 500 && !again.connected; i++) await sleep(20);
    await repl(again, () => out2, "", ">>> ");
    const text = await repl(again, () => out2, "print(open('review.txt').read())", "written in the REPL\r\n");
    again.stop();
    expect(text).toContain("written in the REPL\r\n");
  }, 60000);

  it("saves during continuous writes, not only after they stop (review 5, finding 4)", async () => {
    const pico = new PicoMachine({ firmware: fw(), uid });
    let out = "";
    const host = new InProcessHost(pico);
    const savedWhileLooping: boolean[] = [];
    const link = new EmulatorLink(host, { runtime: "micropython", firmware: "x", project: "p" }, async () => {
      savedWhileLooping.push(!out.includes("LOOPDONE"));
    });
    link.onData = (b) => (out += fromUtf8(b));
    pico.start();
    await host.ready();
    await repl(pico, () => out, "", ">>> ");
    // a program logging without pause: never a quiet second
    await repl(
      pico,
      () => out,
      "exec(\"import time\\nfor i in range(400):\\n f=open('log.txt','w');f.write(str(i));f.close()\\n time.sleep(0.02)\\nprint('LOOP'+'DONE')\")",
      "LOOPDONE",
    );
    pico.stop();
    expect(out).toContain("LOOPDONE");
    expect(savedWhileLooping.filter(Boolean).length, "no save while the program kept writing").toBeGreaterThan(0);
  }, 180000);
});

