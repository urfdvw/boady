/// <reference types="node" />
import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";
import { checkFirmware, WorkerHost, type WorkerLike } from "./browser";
import { EmulatorLink } from "./link";

class FakeWorker implements WorkerLike {
  sent: any[] = [];
  terminated = false;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  onmessageerror: ((e: MessageEvent) => void) | null = null;
  postMessage(msg: unknown) {
    this.sent.push(msg);
  }
  terminate() {
    this.terminated = true;
  }
  reply(data: unknown) {
    this.onmessage?.({ data } as MessageEvent);
  }
  crash(message: string) {
    this.onerror?.({ message } as ErrorEvent);
  }
}

describe("browser emulator failures (review 3, finding 5)", () => {
  it("a worker error during start rejects ready() instead of hanging", async () => {
    const w = new FakeWorker();
    const host = new WorkerHost(w);
    w.crash("boom");
    await expect(host.ready()).rejects.toThrow("emulator_failed: boom");
  });

  it("an error reported by the worker rejects ready()", async () => {
    const w = new FakeWorker();
    const host = new WorkerHost(w);
    w.reply({ type: "error", message: "not a UF2 block at offset 0" });
    await expect(host.ready()).rejects.toThrow("not a UF2 block");
  });

  it("ready() times out when the firmware never starts", async () => {
    const host = new WorkerHost(new FakeWorker(), { readyMs: 30, flashMs: 30 });
    await expect(host.ready()).rejects.toThrow("did not start");
  });

  it("a crash while running fails pending flash reads and reports the board lost", async () => {
    const w = new FakeWorker();
    const host = new WorkerHost(w);
    let lost = false;
    const link = new EmulatorLink(host, { runtime: "micropython", firmware: "x" });
    link.onLost = () => (lost = true);
    w.reply({ type: "ready" });
    await host.ready();
    const pending = host.flash();
    w.crash("out of memory");
    await expect(pending).rejects.toThrow("out of memory");
    expect(lost).toBe(true);
    await expect(host.flash()).rejects.toThrow("out of memory");
  });

  it("a flash read times out", async () => {
    const w = new FakeWorker();
    const host = new WorkerHost(w, { readyMs: 1000, flashMs: 30 });
    w.reply({ type: "ready" });
    await expect(host.flash()).rejects.toThrow("no flash image");
  });

  it("closing a broken emulator still stops it", async () => {
    const w = new FakeWorker();
    const host = new WorkerHost(w);
    const link = new EmulatorLink(host, { runtime: "micropython", firmware: "x" });
    w.reply({ type: "ready" });
    w.crash("gone");
    await link.close();
    expect(w.sent.some((m) => m.type === "stop")).toBe(true);
  });

  it("refuses something that is not a UF2 (e.g. an error page)", () => {
    expect(() => checkFirmware(new TextEncoder().encode("<html>404</html>"), "fw.uf2")).toThrow("not a UF2");
    const real = new Uint8Array(readFileSync(new URL("../../../public/emulator/firmware/micropython-rpi_pico-1.29.0.uf2", import.meta.url)));
    expect(checkFirmware(real, "fw.uf2")).toBe(real);
  });
});
