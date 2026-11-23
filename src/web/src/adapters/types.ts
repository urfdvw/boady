/**
 * Adapter layer between the UI and the platform. The browser build uses a
 * WebSocket + Web Serial / File System Access; the APK will provide the same
 * interfaces through a JS bridge to its native foreground service.
 */

export type FrontendMode = "browser" | "apk" | "nohw";

export interface Connection {
  open(): void;
  close(): void;
  send(msg: object): void;
  onMessage: (msg: any) => void;
  onOpen: () => void;
  onClose: () => void;
}

export interface HardwareCaps {
  serial: boolean;
  msc: boolean;
}

/** Hardware side of the RPC: executes hw.request ops from the backend. */
export interface Hardware {
  caps: HardwareCaps;
  mode: FrontendMode;
  /** Called with each hw.request; resolves with the result or throws. */
  handle(op: string, params: any, signal: AbortSignal): Promise<any>;
}
