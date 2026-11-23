import type { Connection } from "./types";

/** Browser WebSocket to the local backend, with automatic reconnect. */
export class WebSocketConnection implements Connection {
  private ws: WebSocket | null = null;
  private retry = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  onMessage: (msg: any) => void = () => {};
  onOpen: () => void = () => {};
  onClose: () => void = () => {};

  constructor(private url: string) {}

  open(): void {
    this.stopped = false;
    this.connect();
  }

  private connect(): void {
    if (this.timer) clearTimeout(this.timer);
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.onOpen();
    };
    ws.onmessage = (ev) => {
      try {
        this.onMessage(JSON.parse(ev.data));
      } catch {
        /* ignore malformed frames */
      }
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.onClose();
      if (!this.stopped) {
        const delay = Math.min(10000, 500 * 2 ** this.retry++);
        this.timer = setTimeout(() => this.connect(), delay);
      }
    };
  }

  close(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.ws?.close();
    this.ws = null;
  }

  send(msg: object): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }
}

export function defaultWsUrl(): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/ws`;
}
