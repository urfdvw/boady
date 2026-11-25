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

/** ``st.disabledUsb`` is set *before* the drive is disabled, so a cancel in the middle still gets cleaned up. */
export async function cpPrepareWrite(r: RawRepl, st: CpWriteState = { disabledUsb: false }): Promise<CpWriteState> {
  const probe = (await r.exec("import storage\nprint(hasattr(storage,'unsafe_disable_usb_drive'), storage.getmount('/').readonly)")).trim();
  const [hasUnsafe, readonly] = probe.split(/\s+/);
  if (readonly === "False") return st; // no MSC on this board, or already writable
  if (hasUnsafe !== "True") throw new OldFirmwareError();
  st.disabledUsb = true;
  await r.exec("storage.unsafe_disable_usb_drive()", 15000); // waits ~2.5 s for the host
  const after = (await r.exec("print(storage.getmount('/').readonly)")).trim();
  if (after !== "False") await r.exec("storage.remount('/', readonly=False)", 15000);
  const final = (await r.exec("print(storage.getmount('/').readonly)")).trim();
  if (final !== "False") throw new Error("could not make CIRCUITPY writable");
  return st;
}

export async function cpFinishWrite(r: RawRepl, st: CpWriteState): Promise<void> {
  if (st.disabledUsb) await r.exec("storage.enable_usb_drive()", 15000);
}

/**
 * Give the drive back after a cancelled or failed write. The session's own
 * signal may be aborted, so this runs with its own timeout; it interrupts
 * whatever ran, re-enters the raw REPL, closes a half-written file (an open
 * file makes enable_usb_drive() raise) and re-enables the drive.
 */
export async function cpRecover(r: RawRepl, st: CpWriteState, timeoutMs = 20000): Promise<void> {
  if (!st.disabledUsb) return;
  r.rearm(AbortSignal.timeout(timeoutMs));
  await r.enter();
  await r.exec("try:\n f.close()\nexcept Exception:\n pass");
  await r.exec("import storage\nstorage.enable_usb_drive()", 15000);
}

/** Turn autoreload off (MSC sync); returns the previous value. */
export async function cpAutoreloadOff(r: RawRepl): Promise<boolean> {
  const prev = (await r.exec("import supervisor\nprint(supervisor.runtime.autoreload)\nsupervisor.runtime.autoreload=False")).trim();
  return prev === "True";
}

export async function cpAutoreloadRestore(r: RawRepl, value: boolean): Promise<void> {
  await r.exec(`import supervisor\nsupervisor.runtime.autoreload=${value ? "True" : "False"}`);
}
