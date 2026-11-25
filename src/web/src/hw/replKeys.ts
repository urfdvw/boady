/**
 * REPL function keys of the Serial tab (D46). Both official firmwares answer them
 * the same way (checked in the emulator), so every project gets the same keys.
 */

export interface ReplKey {
  id: "ctrl-c" | "ctrl-d" | "ctrl-e" | "ctrl-a" | "ctrl-b";
  /** Shown on the button. */
  label: string;
  /** Sent to the REPL port. */
  data: string;
  /** i18n key of the short meaning shown next to the label. */
  meaning: string;
}

export const REPL_KEYS: readonly ReplKey[] = [
  { id: "ctrl-c", label: "Ctrl-C", data: "\x03", meaning: "serial.key.interrupt" },
  { id: "ctrl-d", label: "Ctrl-D", data: "\x04", meaning: "serial.key.softReset" },
  { id: "ctrl-e", label: "Ctrl-E", data: "\x05", meaning: "serial.key.paste" },
  { id: "ctrl-a", label: "Ctrl-A", data: "\x01", meaning: "serial.key.rawRepl" },
  { id: "ctrl-b", label: "Ctrl-B", data: "\x02", meaning: "serial.key.normalRepl" },
];
