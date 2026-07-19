import { readFileSync } from "node:fs";
import { defineConfig } from "tsup";

const packageVersion = (
  JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string }
).version;
// Release identity is package/SemVer based. The workflow may override it, but it must never be a commit SHA.
const buildDefine = { __SERVER_VERSION__: JSON.stringify(process.env.ROAMCODE_BUILD_VERSION || packageVersion) };

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
    // Separate liveness supervisor for managed installs. It must keep running when Fastify's event loop wedges.
    // Keep the executable wrapper separate from the imported watchdog implementation: bundlers rewrite
    // import.meta.url to the parent entry URL, so an in-module direct-execution guard can stop start.js itself.
    entry: { "health-watchdog": "src/health-watchdog-entry.ts" },
    format: ["esm"],
    dts: false,
    clean: false,
    tsconfig: "tsconfig.build.json",
    define: buildDefine,
  },
  {
    // Runnable stdio MCP server: spawned by Claude (via --mcp-config) or Codex (via provider config) so
    // either terminal can send files/images to the app. Emits dist/mcp-send.js as a standalone node script.
    entry: ["src/mcp-send.ts"],
    format: ["esm"],
    dts: false, // not imported as a library; the test imports the source directly
    clean: false,
    tsconfig: "tsconfig.build.json",
    banner: { js: "#!/usr/bin/env node" },
    define: buildDefine,
  },
  {
    // Detached, version-independent managed-runtime installer. The running server copies only a small
    // config file into the data dir and launches this helper; it survives service restart because the
    // current release is retained as the rollback target.
    entry: ["src/managed-update-helper.ts"],
    format: ["esm"],
    dts: false,
    clean: false,
    tsconfig: "tsconfig.build.json",
    // The source already carries a shebang. Adding another banner produces two consecutive shebangs;
    // Node accepts only the first one and the detached helper then exits before it can report status.
    define: buildDefine,
  },
]);
