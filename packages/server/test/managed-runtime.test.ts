import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  compareVersions,
  installManagedRelease,
  managedPaths,
  readActiveVersion,
  readPreviousVersion,
  renderManagedLauncher,
} from "../src/managed-runtime.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fakeNpm(root: string): string {
  const path = join(root, "fake-npm.cjs");
  writeFileSync(
    path,
    `const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const prefix = args[args.indexOf("--prefix") + 1];
if (process.env.npm_config_allow_scripts) throw new Error("inherited npx allow-scripts policy");
const policy = JSON.parse(fs.readFileSync(path.join(prefix, "package.json"), "utf8"));
if (policy.allowScripts["better-sqlite3@12.11.1"] !== true || policy.allowScripts["node-pty@1.1.0"] !== true) {
  throw new Error("missing native install-script policy");
}
const spec = args.find((arg) => /^roamcode@\\d/.test(arg));
const version = spec.slice("roamcode@".length);
const cli = path.join(prefix, "node_modules", "roamcode");
const server = path.join(prefix, "node_modules", "@roamcode.ai", "server", "dist");
fs.mkdirSync(cli, { recursive: true });
fs.mkdirSync(server, { recursive: true });
fs.writeFileSync(path.join(cli, "package.json"), JSON.stringify({ name: "roamcode", version }));
fs.writeFileSync(path.join(server, "start.js"), 'const http=require("node:http");const s=http.createServer((q,r)=>{r.statusCode=q.url==="/health"?200:404;r.end("ok")});s.listen(0,"127.0.0.1",()=>console.log("listening on http://127.0.0.1:"+s.address().port));');
`,
  );
  return path;
}

describe("managed runtime", () => {
  test("compares stable SemVer numerically", () => {
    expect(compareVersions("1.10.0", "1.9.9")).toBe(1);
    expect(compareVersions("2.0.0", "2.0.0")).toBe(0);
  });

  test("the stable launcher always follows the atomic current pointer", () => {
    const launcher = renderManagedLauncher("/home/me/.local/share/roamcode", "/usr/bin/node");
    expect(launcher).toContain('ENTRY="$ROOT/current/node_modules/roamcode/dist/index.js"');
    expect(launcher).toContain('export ROAMCODE_MANAGED_EXEC="1"');
    expect(launcher).toContain('exec "$NODE" "$ENTRY" "$@"');
    expect(launcher).not.toMatch(/git|commit|origin\/main/);
  });

  test("installs exact releases atomically and retains one rollback target", async () => {
    const root = mkdtempSync(join(tmpdir(), "roamcode-managed-test-"));
    roots.push(root);
    const installRoot = join(root, "runtime");
    const dataDir = join(root, "data");
    mkdirSync(dataDir, { recursive: true });
    const npmCommand = fakeNpm(root);

    const priorAllowScripts = process.env.npm_config_allow_scripts;
    process.env.npm_config_allow_scripts = "better-sqlite3,node-pty";
    try {
      await installManagedRelease({ version: "1.0.0", installRoot, dataDir, npmCommand, restart: false });
      expect(readActiveVersion(installRoot)).toBe("1.0.0");
      await installManagedRelease({ version: "1.1.0", installRoot, dataDir, npmCommand, restart: false });
    } finally {
      if (priorAllowScripts === undefined) delete process.env.npm_config_allow_scripts;
      else process.env.npm_config_allow_scripts = priorAllowScripts;
    }

    expect(readActiveVersion(installRoot)).toBe("1.1.0");
    expect(realpathSync(managedPaths(installRoot).current)).toContain(join("releases", "1.1.0"));
    expect(realpathSync(managedPaths(installRoot).previous)).toContain(join("releases", "1.0.0"));
    expect(readPreviousVersion(installRoot)).toBe("1.0.0");
    expect(readFileSync(join(installRoot, "releases", "1.1.0", "release.json"), "utf8")).toContain(
      '"version": "1.1.0"',
    );
  }, 30_000);
});
