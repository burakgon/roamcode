import { describe, expect, test } from "vitest";
import {
  CLOUD_IMAGE_PLATFORMS,
  createCloudImageManifest,
  validateCloudImageIndex,
  validateCloudImageManifest,
} from "../../../scripts/cloud-image-manifest-lib.mjs";

const VERSION = "1.2.3";
const REVISION = "a".repeat(40);
const DIGEST = `sha256:${"b".repeat(64)}`;

function validManifest() {
  return createCloudImageManifest({
    version: VERSION,
    revision: REVISION,
    relay: { image: "ghcr.io/example/roamcode-relay", digest: DIGEST },
    edge: { image: "ghcr.io/example/roamcode-edge", digest: DIGEST },
  });
}

describe("cloud image release manifest", () => {
  test("records only exact digests for the two supported platforms", () => {
    const manifest = validManifest();
    expect(manifest).toEqual({
      schemaVersion: 1,
      version: VERSION,
      revision: REVISION,
      containers: {
        relay: {
          image: "ghcr.io/example/roamcode-relay",
          digest: DIGEST,
          platforms: CLOUD_IMAGE_PLATFORMS,
        },
        edge: {
          image: "ghcr.io/example/roamcode-edge",
          digest: DIGEST,
          platforms: CLOUD_IMAGE_PLATFORMS,
        },
      },
    });
  });

  test.each([
    ["tagged image", { image: "ghcr.io/example/roamcode-relay:latest" }, "untagged"],
    ["uppercase image", { image: "ghcr.io/Example/roamcode-relay" }, "lowercase"],
    ["non-GHCR image", { image: "registry.example/roamcode-relay" }, "ghcr.io"],
    ["short digest", { digest: "sha256:abcd" }, "sha256"],
  ])("rejects a %s", (_label, relayPatch, message) => {
    const base = validManifest();
    expect(() =>
      validateCloudImageManifest(
        {
          ...base,
          containers: { ...base.containers, relay: { ...base.containers.relay, ...relayPatch } },
        },
        VERSION,
      ),
    ).toThrow(message);
  });

  test("rejects a manifest for another stable release", () => {
    expect(() => validateCloudImageManifest(validManifest(), "1.2.4")).toThrow("does not match");
  });

  test("rejects missing or reordered platform coverage", () => {
    const base = validManifest();
    expect(() =>
      validateCloudImageManifest(
        {
          ...base,
          containers: {
            ...base.containers,
            relay: { ...base.containers.relay, platforms: ["linux/arm64", "linux/amd64"] },
          },
        },
        VERSION,
      ),
    ).toThrow("linux/amd64 followed by linux/arm64");
  });
});

describe("published cloud image index", () => {
  function validIndex() {
    return {
      schemaVersion: 2,
      mediaType: "application/vnd.oci.image.index.v1+json",
      annotations: {
        "org.opencontainers.image.version": VERSION,
        "org.opencontainers.image.revision": REVISION,
        "org.opencontainers.image.source": "https://github.com/example/roamcode",
      },
      manifests: [
        { platform: { os: "linux", architecture: "amd64" } },
        { platform: { os: "linux", architecture: "arm64" } },
        {
          platform: { os: "unknown", architecture: "unknown" },
          annotations: { "vnd.docker.reference.type": "attestation-manifest" },
        },
      ],
    };
  }

  const expected = {
    version: VERSION,
    revision: REVISION,
    source: "https://github.com/example/roamcode",
  };

  test("accepts exactly two runtime platforms plus BuildKit attestations", () => {
    expect(validateCloudImageIndex(validIndex(), expected)).toBe(true);
  });

  test("rejects mismatched release annotations", () => {
    expect(() =>
      validateCloudImageIndex(
        {
          ...validIndex(),
          annotations: { ...validIndex().annotations, "org.opencontainers.image.version": "9.9.9" },
        },
        expected,
      ),
    ).toThrow("annotations");
  });

  test("rejects an unexpected runtime platform", () => {
    const index = validIndex();
    index.manifests.push({ platform: { os: "linux", architecture: "arm" } });
    expect(() => validateCloudImageIndex(index, expected)).toThrow("exactly");
  });

  test("rejects an unclassified unknown-platform descriptor", () => {
    const index = validIndex();
    index.manifests[2] = { platform: { os: "unknown", architecture: "unknown" } };
    expect(() => validateCloudImageIndex(index, expected)).toThrow("attestation");
  });
});
