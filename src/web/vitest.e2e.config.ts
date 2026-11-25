// Config for the end-to-end helpers in scripts/ (not part of `npm test`).
import { defineConfig, mergeConfig } from "vite";
import base from "./vite.config";

export default mergeConfig(base, defineConfig({ test: { include: ["scripts/*.e2e.ts"], testTimeout: 1200000 } } as object));
