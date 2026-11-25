/// <reference lib="webworker" />
// Runs the emulated Pico off the UI thread. Messages: see WorkerHost in browser.ts.
import { PicoMachine } from "./pico";

let pico: PicoMachine | null = null;

self.onmessage = (e: MessageEvent) => {
  const m = e.data;
  switch (m.type) {
    case "start":
      try {
        pico = new PicoMachine({ firmware: m.firmware, flash: m.flash ?? undefined, uid: m.uid });
        pico.onData = (b) => self.postMessage({ type: "data", bytes: b }, [b.buffer]);
        pico.onConnected = () => self.postMessage({ type: "ready" });
        pico.onFlashChanged = () => self.postMessage({ type: "flashChanged" });
        pico.onPins = (p) => self.postMessage({ type: "pins", pins: p });
        pico.start();
      } catch (e) {
        self.postMessage({ type: "error", message: String((e as Error)?.message || e) });
      }
      break;
    case "write":
      pico?.write(m.bytes);
      break;
    case "setPin":
      try {
        pico?.setPin(m.pin, m.value);
      } catch {
        /* not a GPIO: ignored */
      }
      break;
    case "flash": {
      const f = pico ? pico.flash() : new Uint8Array();
      self.postMessage({ type: "flash", id: m.id, flash: f }, [f.buffer]);
      break;
    }
    case "stop":
      pico?.stop();
      pico = null;
      break;
  }
};
