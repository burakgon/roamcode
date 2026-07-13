import { defineConfig } from "vitest/config";

// Per-package server config so `pnpm -C packages/server exec vitest run` works standalone.
// Mirrors the relevant bits of the repo-root `vitest.config.ts`: node env, the server test glob,
// and the serial/file-timeout settings the WS suite needs (running the subprocess-driven WS test
// FILES in parallel makes their spawn/IO handshakes contend, so a turn intermittently never delivers
// its output — serialising removes that).
// The repo-root `vitest.workspace.ts` lists this file, so root `pnpm test` keeps running everything.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    setupFiles: ["test/setup.ts"],
    environment: "node",
    fileParallelism: false,
    testTimeout: 15000,
    hookTimeout: 15000,
  },
});
