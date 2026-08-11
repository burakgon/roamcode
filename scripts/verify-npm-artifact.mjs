import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const [name, version, tarball] = process.argv.slice(2);
if (!name || !version || !tarball) {
  throw new Error("usage: verify-npm-artifact.mjs <package> <version> <local.tgz>");
}
const MAX_ATTEMPTS = 240;
const RETRY_DELAY_MS = 500;
const registry = new URL(process.env.npm_config_registry ?? "https://registry.npmjs.org/");
const metadataUrl = new URL(`${encodeURIComponent(name)}/${encodeURIComponent(version)}`, registry);
let expected;
let lastError;
for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
  try {
    const response = await fetch(metadataUrl, {
      headers: {
        accept: "application/json",
        "cache-control": "no-cache",
      },
    });
    if (!response.ok) throw new Error(`${name}@${version} returned HTTP ${response.status}`);
    const metadata = await response.json();
    if (metadata?.version !== version || typeof metadata?.dist?.integrity !== "string") {
      throw new Error(`${name}@${version} returned incomplete npm metadata`);
    }
    expected = metadata.dist.integrity;
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
