/// <reference types="node" />
/**
 * End-to-end without hardware: acts as the boady frontend (the real Backend
 * client + DeviceManager) with an emulated Pico as the board, against a
 * running backend and real Claude Code.
 *
 *   python run.py                                   # in another terminal
 *   BOADY_E2E_TYPE=circuitpython npm run e2e:emu    # or micropython
 *   BOADY_E2E_PROMPT="..." npm run e2e:emu          # optional chat turn
 *
 * Env: BOADY_URL (default ws://127.0.0.1:8765/ws), BOADY_TOKEN (default
 * ~/.boady/token), BOADY_E2E_PROJECT (project name, default e2e-<type>).
 */
import { readFileSync } from "fs";
import { homedir } from "os";
import { expect, it } from "vitest";
import { WebSocketConnection } from "../src/adapters/websocket";
import { Backend } from "../src/backend";
import { DeviceManager } from "../src/hw/device";
import { EmulatorLink, InProcessHost } from "../src/hw/emulator/link";
import { PicoMachine } from "../src/hw/emulator/pico";

const type = (process.env.BOADY_E2E_TYPE ?? "circuitpython") as "circuitpython" | "micropython";
const firmware = {
  micropython: "micropython-rpi_pico-1.29.0.uf2",
  circuitpython: "circuitpython-raspberry_pi_pico-10.3.2.uf2",
}[type];
const url = process.env.BOADY_URL ?? "ws://127.0.0.1:8765/ws";
const token = process.env.BOADY_TOKEN ?? readFileSync(`${homedir()}/.boady/token`, "utf8").trim();
const project = process.env.BOADY_E2E_PROJECT ?? `e2e-${type}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until<T>(what: string, fn: () => T | undefined | null | false, ms: number): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timeout: ${what}`);
    await sleep(100);
  }
}

it(`emulated ${type} board end to end`, async () => {
  const dm = new DeviceManager();
  const backend = new Backend(new WebSocketConnection(url), dm, token);
  backend.start();
  await until("backend connection", () => backend.status === "connected" && backend.state, 10000);
  console.log(`[e2e] connected; opening project ${project}`);

  const existing = backend.state!.projects.find((p) => p.name === project);
  if (existing) await backend.action("project.select", { id: existing.id });
  else await backend.action("project.create", { name: project, type });
  await until("project open", () => backend.state?.project?.name === project, 20000);

  const fw = new Uint8Array(readFileSync(new URL(`../public/emulator/firmware/${firmware}`, import.meta.url)));
  const uid = Uint8Array.from(Buffer.from(`e2e-${type}`.padEnd(8, "-").slice(0, 8)));
  const pico = new PicoMachine({ firmware: fw, uid });
  const host = new InProcessHost(pico);
  pico.start();
  await host.ready();
  await dm.connectEmulator(new EmulatorLink(host, { runtime: type, firmware }));
  console.log("[e2e] emulator attached; waiting for identification (real Claude)");

  const dev = await until("identification", () => {
    const d = backend.state?.device;
    if (d?.error) throw new Error(d.error);
    return d?.uid ? d : null;
  }, 180000);
  console.log(`[e2e] identified: uid=${dev.uid} runtime=${dev.runtime} version=${dev.version}`);
  expect(dev.runtime).toBe(type);
  await until("pull on connect", () => backend.items.find((i) => i.kind === "notice" && /^(pulled|pull_declined)/.test(i.text)), 180000);
  console.log("[e2e] pulled board files");

  const prompt = process.env.BOADY_E2E_PROMPT;
  if (prompt) {
    const before = backend.items.length;
    backend.sendMessage(prompt);
    await until("turn start", () => backend.running, 30000);
    await until("turn end", () => {
      for (const p of backend.pending.values()) {
        console.log(`[e2e] approving ${p.tool ?? p.what}`);
        backend.reply(p.request_id, true);
      }
      return !backend.running;
    }, 900000);
    for (const i of backend.items.slice(before)) {
      if (i.kind === "assistant") console.log(`[claude] ${i.text}`);
      else if (i.kind === "tool_use") console.log(`[tool] ${i.name} ${JSON.stringify(i.input).slice(0, 160)}`);
      else if (i.kind === "tool_result") console.log(`[result]${i.is_error ? " ERROR" : ""} ${i.content.slice(0, 200).replace(/\n/g, " ")}`);
      else if (i.kind === "notice") console.log(`[notice] ${i.text}`);
    }
  }
  await dm.disconnect(false);
  pico.stop();
}, 1200000);
