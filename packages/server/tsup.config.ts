import { execSync } from "node:child_process";
import { defineConfig } from "tsup";

/**
 * The git short sha being built. Baked into the server bundle as `__SERVER_BUILD_SHA__` (mirroring the web
 * bundle's `__BUILD_SHA__` in vite.config.ts) so the RUNNING process knows the commit it was actually built
 * from — distinct from git HEAD, which can move ahead of the build (a pull without a rebuild/restart). The
 * /version route surfaces both so build-vs-checkout DRIFT is detectable. The OTA build runs `pnpm -r build`
 * AFTER `git pull`, so HEAD here is the freshly-pulled commit. "unknown" when git is unavailable (still
 * safe — drift detection treats a non-real sha as "can't decide").
 */
function gitShortSha(): string {
  try {
    return execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim() || "unknown";
  } catch {
    return "unknown";
  }
}

// One `define` shared by every bundle below — esbuild substitutes the literal at build time. Done once at
// config load so a single `git` call stamps all entries with the same sha.
const buildDefine = { __SERVER_BUILD_SHA__: JSON.stringify(gitShortSha()) };

export default defineConfig([
  {
    // Library entry — imported by other packages; no shebang.
    entry: ["src/index.ts"],
    format: ["esm"],
    dts: true,
    clean: true,
    tsconfig: "tsconfig.build.json",
    define: buildDefine,
  },
  {
    // Executable entry for the `roamcode-server` bin.
    entry: ["src/start.ts"],
    format: ["esm"],
    dts: true,
    clean: false, // don't wipe the index.* output from the first config
    tsconfig: "tsconfig.build.json",
    banner: { js: "#!/usr/bin/env node" },
    define: buildDefine,
  },
  {
    // Runnable stdio MCP server: spawned as claude's MCP subprocess (via --mcp-config) so claude can
    // send files/images to the chat. Emits dist/mcp-send.js as a standalone node script.
    entry: ["src/mcp-send.ts"],
    format: ["esm"],
    dts: false, // not imported as a library; the test imports the source directly
    clean: false,
    tsconfig: "tsconfig.build.json",
    banner: { js: "#!/usr/bin/env node" },
    define: buildDefine,
  },
]);
