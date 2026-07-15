import { writeFileSync } from "node:fs";
import { createCloudImageManifest } from "./cloud-image-manifest-lib.mjs";

const [version, revision, relayImage, relayDigest, edgeImage, edgeDigest, output = "roamcode-cloud-images.json"] =
  process.argv.slice(2);

const manifest = createCloudImageManifest({
  version: version?.replace(/^v/, "") ?? "",
  revision: revision ?? "",
  relay: { image: relayImage, digest: relayDigest },
  edge: { image: edgeImage, digest: edgeDigest },
});

writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });
console.log(output);
