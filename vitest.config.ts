import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts"],
    environment: "node",
    // The WS/integration tests spawn a `node` mock subprocess per session. Running the test
    // FILES in parallel (the default) makes those handshakes/round-trips compete for the same
    // spawn/IO budget, so under full-suite load a WS turn intermittently never delivers its
    // `result` frame ("no result over ws"). Serialising the files in a single fork removes
    // that contention and makes the suite reliably green (verified across repeated full runs);
    // tests WITHIN a file still run as written. The suite is small, so the serial cost is minor.
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
    // Headroom over the longest in-test reject budget (10s) so the harness never kills a
    // subprocess-driven WS turn before its own deadline fires.
    testTimeout: 15000,
    hookTimeout: 15000,
  },
  resolve: {
    alias: {
      "@remote-coder/protocol": fileURLToPath(
        new URL("./packages/protocol/src/index.ts", import.meta.url),
      ),
    },
  },
});
