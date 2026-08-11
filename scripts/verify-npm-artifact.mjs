import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const [name, version, tarball] = process.argv.slice(2);
if (!name || !version || !tarball) {
  throw new Error("usage: verify-npm-artifact.mjs <package> <version> <local.tgz>");
}
const MAX_ATTEMPTS = 60;
const RETRY_DELAY_MS = 2_000;
let expected;
let lastError;
for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
  try {
    expected = execFileSync("npm", ["view", `${name}@${version}`, "dist.integrity", "--prefer-online"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    break;
  } catch (error) {
    lastError = error;
    if (attempt < MAX_ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
  }
}
if (!expected) throw lastError ?? new Error(`${name}@${version} is not visible on npm`);
const actual = `sha512-${createHash("sha512").update(readFileSync(tarball)).digest("base64")}`;
if (actual !== expected) throw new Error(`${name}@${version} exists on npm with different package bytes`);
console.log(`${name}@${version} matches ${tarball}`);
