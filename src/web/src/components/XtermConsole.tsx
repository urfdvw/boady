import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef } from "react";
import type { SerialHistory } from "../hw/serialHistory";

interface Props {
  history: SerialHistory;
  readOnly: boolean;
  /** Keystrokes typed into the terminal (already terminal-encoded, e.g. "\r", "\x03", arrow escapes). */
  onInput(data: string): void;
}

/** A serial console: xterm.js showing a port's output, typing goes to the board. */
export function XtermConsole({ history, readOnly, onInput }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const term = useRef<Terminal | null>(null);
  const input = useRef(onInput);
  input.current = onInput;

  useEffect(() => {
    if (!host.current) return;
    const t = new Terminal({
      fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
      fontSize: 13,
      scrollback: 5000,
      cursorBlink: true,
      theme: { background: "#0f1115", foreground: "#d7dde8" },
    });
    const fit = new FitAddon();
    t.loadAddon(fit);
    t.open(host.current);
    term.current = t;
    const refit = () => {
      try {
        fit.fit();
      } catch {
        /* not laid out yet */
      }
    };
    refit();
    t.write(history.bytes());
    const off = history.subscribe((b) => (b ? t.write(b) : t.reset()));
    const typing = t.onData((d) => input.current(d));
    const ro = new ResizeObserver(refit);
    ro.observe(host.current);
    return () => {
      ro.disconnect();
      typing.dispose();
      off();
      t.dispose();
      term.current = null;
    };
  }, [history]);

  useEffect(() => {
    if (term.current) term.current.options.disableStdin = readOnly;
  }, [readOnly]);

  return <div className="xterm-host" ref={host} />;
}
