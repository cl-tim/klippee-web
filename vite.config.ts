import path from "path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import { viteNoncePlaceholder } from "./worker/viteNonce.ts";

export default defineConfig(({ command }) => ({
  html: command === "serve" ? { cspNonce: viteNoncePlaceholder } : undefined,
  build: {
    chunkSizeWarningLimit: 1000,
  },
  plugins: [react(), tailwindcss(), cloudflare()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
}));
