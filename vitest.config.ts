import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";

// Standalone Vitest config (does not load vite.config.ts, so the Cloudflare
// Worker plugin does not interfere with the jsdom component test environment).
export default defineConfig({
  plugins: [react()],
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "./src") } },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}", "worker/**/*.test.ts"],
    css: false,
    restoreMocks: true,
    // Parallel jsdom workers starve interaction deadlines on small CI runners.
    // Keep file isolation and assertion timeouts; bound CI contention instead.
    maxWorkers: process.env.CI ? 1 : 4,
  },
});
