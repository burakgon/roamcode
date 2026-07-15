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
    // Standalone blind relay. It routes authenticated opaque envelopes and has no access to session plaintext.
    entry: ["src/relay-start.ts"],
    format: ["esm"],
    dts: true,
    clean: false,
    tsconfig: "tsconfig.build.json",
    banner: { js: "#!/usr/bin/env node" },
    define: buildDefine,
  },
  {
    // Minimal OCI image entry. The internal image package installs only the relay's four runtime dependencies,
    // keeping PTY/provider code and credentials out of the cloud container.
    entry: { relay: "src/relay-container.ts" },
    outDir: "dist/container",
    format: ["esm"],
    dts: false,
    clean: false,
    splitting: false,
    tsconfig: "tsconfig.build.json",
    define: { ...buildDefine, __RELAY_CONTAINER_BUILD__: "true" },
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
