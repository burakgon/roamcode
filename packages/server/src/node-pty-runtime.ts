import { chmodSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

const require = createRequire(import.meta.url);

/**
 * node-pty's macOS prebuild ships spawn-helper without an executable bit. npm
 * install scripts do not repair that prebuilt path, so enforce it immediately
 * before the first PTY spawn. This is idempotent and deliberately best-effort.
 */
export function ensureNodePtySpawnHelperExecutable(
  resolveNodePty: () => string = () => require.resolve("node-pty"),
  platform = process.platform,
  arch = process.arch,
): void {
  if (platform !== "darwin") return;
  try {
    const packageRoot = resolve(dirname(resolveNodePty()), "..");
    const helper = join(packageRoot, "prebuilds", `${platform}-${arch}`, "spawn-helper");
    if (existsSync(helper)) chmodSync(helper, 0o755);
  } catch {
    // A missing node-pty already degrades through the existing terminal preflight.
  }
}
