/**
 * CircuitPython: make the filesystem writable for code before writing over the
 * serial raw REPL, and give the drive back afterwards (spec「串口写文件」).
 *
 * Checked against CircuitPython source (shared-bindings/storage): after
 * `unsafe_disable_usb_drive()` CIRCUITPY is already read/write for code, and a
 * `remount()` done while the drive is disabled stays in effect after
 * `enable_usb_drive()` (the host would then get a read-only drive until a hard
 * reset). So `remount("/", readonly=False)` is only used as a fallback when the
 * filesystem is still read-only. See additional_specs.md D20.
 */
import type { RawRepl } from "./rawRepl";

export class OldFirmwareError extends Error {
  constructor() {
    super(
      "old_firmware: this CircuitPython cannot switch write access at runtime. Upgrade the firmware, or add storage.disable_usb_drive() to boot.py and reset the board.",
    );
  }
}

export interface CpWriteState {
  disabledUsb: boolean;
}

export async function cpPrepareWrite(r: RawRepl): Promise<CpWriteState> {
  const probe = (await r.exec("import storage\nprint(hasattr(storage,'unsafe_disable_usb_drive'), storage.getmount('/').readonly)")).trim();
  const [hasUnsafe, readonly] = probe.split(/\s+/);
  if (readonly === "False") return { disabledUsb: false }; // no MSC on this board, or already writable
  if (hasUnsafe !== "True") throw new OldFirmwareError();
  await r.exec("storage.unsafe_disable_usb_drive()", 15000); // waits ~2.5 s for the host
  const after = (await r.exec("print(storage.getmount('/').readonly)")).trim();
  if (after !== "False") await r.exec("storage.remount('/', readonly=False)", 15000);
  const final = (await r.exec("print(storage.getmount('/').readonly)")).trim();
  if (final !== "False") throw new Error("could not make CIRCUITPY writable");
  return { disabledUsb: true };
}

export async function cpFinishWrite(r: RawRepl, st: CpWriteState): Promise<void> {
  if (st.disabledUsb) await r.exec("storage.enable_usb_drive()", 15000);
}

/** Turn autoreload off (MSC sync); returns the previous value. */
export async function cpAutoreloadOff(r: RawRepl): Promise<boolean> {
  const prev = (await r.exec("import supervisor\nprint(supervisor.runtime.autoreload)\nsupervisor.runtime.autoreload=False")).trim();
  return prev === "True";
}

export async function cpAutoreloadRestore(r: RawRepl, value: boolean): Promise<void> {
  await r.exec(`import supervisor\nsupervisor.runtime.autoreload=${value ? "True" : "False"}`);
}
