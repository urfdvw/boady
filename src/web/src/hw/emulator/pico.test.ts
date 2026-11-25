/// <reference types="node" />
import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";
import { loadUf2, PicoMachine } from "./pico";

const fw = (name: string) => new Uint8Array(readFileSync(new URL(`../../../public/emulator/firmware/${name}`, import.meta.url)));

describe("emulated Pico", () => {
  it("loads a UF2 into flash", () => {
    const flash = new Uint8Array(2 * 1024 * 1024).fill(0xff);
    loadUf2(fw("micropython-rpi_pico-1.29.0.uf2"), flash);
    expect(flash[0]).not.toBe(0xff);
  });

  it("boots MicroPython and reports the configured UID", async () => {
    const pico = new PicoMachine({ firmware: fw("micropython-rpi_pico-1.29.0.uf2"), uid: Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]) });
    let out = "";
    pico.onData = (b) => (out += new TextDecoder().decode(b));
    pico.start();
    const until = async (s: string) => {
      for (let i = 0; i < 1500 && !out.includes(s); i++) await new Promise((r) => setTimeout(r, 20));
      expect(out).toContain(s);
    };
    for (let i = 0; i < 500 && !pico.connected; i++) await new Promise((r) => setTimeout(r, 20));
    pico.write(new TextEncoder().encode("\r\n"));
    await until(">>> ");
    pico.write(new TextEncoder().encode("import machine;print(machine.unique_id().hex())\r"));
    await until("0102030405060708");
    pico.stop();
  }, 60000);
});
