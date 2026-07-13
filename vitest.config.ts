import { defineConfig } from "vitest/config";

// Vitest 4 dropped `vitest.workspace.ts` support in favour of `test.projects`. Without this the root
// `pnpm test` (and CI's Test step) silently ran ONLY the node suite (server/cli/protocol) and skipped
// EVERY web test — a client regression shipped green. `projects` restores the single-command run of BOTH
// suites, each with its own environment/plugins; `pnpm -C packages/web test` still works standalone.
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "node",
          include: ["packages/*/test/**/*.test.ts"],
          setupFiles: ["packages/server/test/setup.ts"],
          environment: "node",
          // The WS/integration tests spawn a `node` mock subprocess per session. Running the test FILES in
          // parallel makes those handshakes compete for the same spawn/IO budget, so under full-suite load a
          // WS turn intermittently never delivers ("no result over ws"). Serialising the files removes that
          // contention (tests WITHIN a file still run as written); the suite is small, so the cost is minor.
          fileParallelism: false,
          testTimeout: 15000,
          hookTimeout: 15000,
        },
      },
      // The web suite keeps its own jsdom env + React plugin + release-version stub.
      "./packages/web/vitest.config.ts",
    ],
  },
});
