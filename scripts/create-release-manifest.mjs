import { writeFileSync } from "node:fs";

const version = (process.argv[2] ?? "").replace(/^v/, "");
const output = process.argv[3] ?? "roamcode-release.json";
if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) throw new Error("stable SemVer required");

const packageNames = ["roamcode", "@roamcode.ai/server", "@roamcode.ai/web"];
const registry = new URL(process.env.npm_config_registry ?? "https://registry.npmjs.org/");
const packages = {};
const metadataEntries = await Promise.all(
  packageNames.map(async (name) => {
    const metadataUrl = new URL(`${encodeURIComponent(name)}/${encodeURIComponent(version)}`, registry);
    const response = await fetch(metadataUrl, {
      headers: {
        accept: "application/json",
        "cache-control": "no-cache",
      },
    });
    if (!response.ok) throw new Error(`${name}@${version} returned HTTP ${response.status}`);
    return [name, await response.json()];
  }),
);
for (const [name, metadata] of metadataEntries) {
  if (!metadata || typeof metadata !== "object") {
    throw new Error(`${name}@${version} returned invalid npm metadata`);
  }
  const integrity = metadata.dist?.integrity;
  const tarball = metadata.dist?.tarball;
  if (metadata.version !== version || typeof integrity !== "string" || typeof tarball !== "string") {
    throw new Error(`${name}@${version} is not fully available on npm`);
  }
  packages[name === "roamcode" ? "roamcode" : name] = {
    version: metadata.version,
    integrity,
    tarball,
  };
}

writeFileSync(
  output,
  `${JSON.stringify(
    {
      schemaVersion: 1,
      channel: "stable",
      version,
      packages,
    },
    null,
    2,
  )}\n`,
);
console.log(output);
