import type { Hardware, HardwareCaps } from "./types";

/**
 * Phase 1 hardware adapter: reports capabilities but implements no board
 * operations yet (Web Serial / MSC arrive in phase 2). Every request fails
 * with a clear error, and no device.attached is ever sent.
 */
export class NoHardware implements Hardware {
  caps: HardwareCaps;
  mode: "browser" | "nohw";

  constructor() {
    const nav = typeof navigator !== "undefined" ? (navigator as any) : {};
    const win = typeof window !== "undefined" ? (window as any) : {};
    this.caps = { serial: "serial" in nav, msc: "showDirectoryPicker" in win };
    this.mode = this.caps.serial ? "browser" : "nohw";
  }

  async handle(op: string): Promise<any> {
    throw new Error(`Hardware operation '${op}' is not supported by this frontend yet.`);
  }
}
