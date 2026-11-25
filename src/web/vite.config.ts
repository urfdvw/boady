import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The built frontend is committed to ../../dist/web and served by the backend.
export default defineConfig({
  plugins: [react()],
  resolve: {
    // vendored emulator, compiled with its own tsconfig (see vendor/rp2040js/VENDOR.md)
    alias: { "@vendor/rp2040js": decodeURIComponent(new URL("./vendor/rp2040js/boady-entry.ts", import.meta.url).pathname) },
  },
  base: "./",
  build: {
    outDir: "../../dist/web",
    emptyOutDir: true,
    chunkSizeWarningLimit: 2000,
  },
  server: {
    proxy: { "/ws": { target: "ws://127.0.0.1:8765", ws: true } },
  },
});
