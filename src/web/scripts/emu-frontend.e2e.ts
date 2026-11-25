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
 * Fails unless: the board is identified as the right runtime, the pull on
 * connect really happens, and (with a prompt) the turn ends without an error
 * notice and the board's REPL output contains BOADY_E2E_EXPECT.
 *
 * Env: BOADY_URL (default ws://127.0.0.1:8765/ws), BOADY_TOKEN (default
 * ~/.boady/token), BOADY_E2E_PROJECT (project name, default e2e-<type>),
 * BOADY_E2E_EXPECT (text the board must print during the turn),
 * BOADY_E2E_APPROVE: "none" (default, every approval is denied), "all", or a
 * comma list of tool names / confirmations (e.g. "mcp__boady__sync_to_device").
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
  const approve = (process.env.BOADY_E2E_APPROVE ?? "none").split(",").map((s) => s.trim());
  const allowed = (name: string) => approve.includes("all") || approve.includes(name);
  const answered = new Set<string>();
  /** Answer every new approval card by the BOADY_E2E_APPROVE policy. */
  const answer = () => {
    for (const p of backend.pending.values()) {
      if (answered.has(p.request_id)) continue;
      answered.add(p.request_id);
      const name = p.tool ?? p.what;
      const ok = allowed(name);
      console.log(`[e2e] ${ok ? "approving" : "denying"} ${name}`);
      backend.reply(p.request_id, ok);
    }
  };
  const attachedAt = backend.items.length; // ignore notices from earlier runs in the chat history
  await dm.connectEmulator(new EmulatorLink(host, { runtime: type, firmware }));
  console.log("[e2e] emulator attached; waiting for identification (real Claude)");

  const dev = await until("identification", () => {
    const d = backend.state?.device;
    if (d?.error) throw new Error(d.error);
    return d?.uid ? d : null;
  }, 180000);
  console.log(`[e2e] identified: uid=${dev.uid} runtime=${dev.runtime} version=${dev.version}`);
  expect(dev.runtime).toBe(type);
  const pull = await until("pull on connect", () => {
    answer();
    return backend.items.slice(attachedAt).find((i) => i.kind === "notice" && /^(pulled|pull_declined|pull_failed)/.test(i.text));
  }, 180000);
  expect((pull as { text: string }).text, "the pull on connect must happen").toMatch(/^pulled/);
  console.log("[e2e] pulled board files");

  const prompt = process.env.BOADY_E2E_PROMPT;
  if (prompt) {
    const before = backend.items.length;
    const replBefore = dm.terms.repl.text().length;
    backend.sendMessage(prompt);
    await until("turn start", () => backend.running, 30000);
    await until("turn end", () => {
      answer();
      return !backend.running;
    }, 900000);
    const turn = backend.items.slice(before);
    for (const i of turn) {
      if (i.kind === "assistant") console.log(`[claude] ${i.text}`);
      else if (i.kind === "tool_use") console.log(`[tool] ${i.name} ${JSON.stringify(i.input).slice(0, 160)}`);
      else if (i.kind === "tool_result") console.log(`[result]${i.is_error ? " ERROR" : ""} ${i.content.slice(0, 200).replace(/\n/g, " ")}`);
      else if (i.kind === "notice") console.log(`[notice] ${i.text}`);
    }
    const errors = turn.filter((i) => i.kind === "notice" && i.level === "error");
    expect(errors, "the turn must not end with an error").toEqual([]);
    const expectText = process.env.BOADY_E2E_EXPECT;
    if (expectText) {
      const output = dm.terms.repl.text().slice(replBefore);
      expect(output, "board output during the turn").toContain(expectText);
      console.log(`[e2e] board printed ${JSON.stringify(expectText)}`);
    }
  }
  await dm.disconnect(false);
  pico.stop();
}, 1200000);
