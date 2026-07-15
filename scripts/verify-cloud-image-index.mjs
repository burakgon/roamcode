import { readFileSync } from "node:fs";
import { validateCloudImageIndex } from "./cloud-image-manifest-lib.mjs";

const [version, revision, source] = process.argv.slice(2);
const raw = readFileSync(0, "utf8");
validateCloudImageIndex(JSON.parse(raw), {
  version: version?.replace(/^v/, "") ?? "",
  revision: revision ?? "",
  source: source ?? "",
});
