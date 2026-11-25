import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { DeviceManager } from "./hw/device";
import { WebSocketConnection, defaultWsUrl } from "./adapters/websocket";
import { Backend, loadToken, saveToken } from "./backend";
import "./styles.css";

// A pairing link (#token=...) printed by run.py stores the token and is then removed from the URL.
const m = location.hash.match(/token=([^&]+)/);
if (m) {
  saveToken(decodeURIComponent(m[1]));
  history.replaceState(null, "", location.pathname + location.search);
}

// DeviceManager also runs without Web Serial: then only the testing-only emulator is available.
const hw = new DeviceManager();
const backend = new Backend(new WebSocketConnection(defaultWsUrl()), hw, loadToken());
backend.start();
hw.init().catch((e) => console.warn("hardware init failed", e));

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App backend={backend} hw={hw} />
  </StrictMode>,
);
