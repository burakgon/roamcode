import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { validateCloudImageManifest } from "./cloud-image-manifest-lib.mjs";

const version = (process.argv[2] ?? "").replace(/^v/, "");
const output = process.argv[3] ?? "roamcode-release.json";
const cloudImagesPath = process.argv[4];
if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) throw new Error("stable SemVer required");

const packageNames = ["roamcode", "@roamcode.ai/server", "@roamcode.ai/web"];
const packages = {};
for (const name of packageNames) {
  const raw = execFileSync(
    "npm",
    ["view", `${name}@${version}`, "version", "dist.integrity", "dist.tarball", "--json"],
    {
      encoding: "utf8",
    },
  );
  const parsed = JSON.parse(raw);
  const metadata = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!metadata || typeof metadata !== "object") {
    throw new Error(`${name}@${version} returned invalid npm metadata`);
  }
  const integrity = metadata["dist.integrity"] ?? metadata.dist?.integrity;
  const tarball = metadata["dist.tarball"] ?? metadata.dist?.tarball;
  if (metadata.version !== version || typeof integrity !== "string" || typeof tarball !== "string") {
    throw new Error(`${name}@${version} is not fully available on npm`);
  }
  packages[name === "roamcode" ? "roamcode" : name] = {
    version: metadata.version,
    integrity,
    tarball,
  };
}

const cloudImages = cloudImagesPath
  ? validateCloudImageManifest(JSON.parse(readFileSync(cloudImagesPath, "utf8")), version)
  : undefined;

writeFileSync(
  output,
  `${JSON.stringify(
    {
      schemaVersion: 1,
      channel: "stable",
      version,
      packages,
      ...(cloudImages ? { revision: cloudImages.revision, containers: cloudImages.containers } : {}),
    },
    null,
    2,
  )}\n`,
);
console.log(output);
