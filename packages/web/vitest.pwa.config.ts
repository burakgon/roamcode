import react from "@vitejs/plugin-react";
import { configDefaults, defineConfig } from "vitest/config";

/** Dedicated Node/Vite build gate for the emitted PWA artifacts excluded from the fast jsdom suite. */
export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify("dev") },
  plugins: [react()],
  test: {
    name: "web-pwa-build",
    globals: true,
    environment: "node",
    include: ["src/pwa/build-artifacts.test.ts"],
    exclude: [...configDefaults.exclude],
    hookTimeout: 120_000,
    testTimeout: 120_000,
  },
});
