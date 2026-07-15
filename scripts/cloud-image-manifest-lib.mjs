const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const GIT_REVISION = /^[0-9a-f]{40}$/;
const OCI_DIGEST = /^sha256:[0-9a-f]{64}$/;
const GHCR_IMAGE = /^ghcr\.io\/[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+$/;

export const CLOUD_IMAGE_PLATFORMS = Object.freeze(["linux/amd64", "linux/arm64"]);
const INDEX_MEDIA_TYPES = new Set([
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
]);

function requiredString(value, field) {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${field} is required`);
  return value;
}

function validateContainer(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  const image = requiredString(value.image, `${field}.image`);
  const digest = requiredString(value.digest, `${field}.digest`);
  if (!GHCR_IMAGE.test(image)) {
    throw new Error(`${field}.image must be a lowercase, untagged ghcr.io image name`);
  }
  if (!OCI_DIGEST.test(digest)) throw new Error(`${field}.digest must be a sha256 OCI digest`);
  if (
    !Array.isArray(value.platforms) ||
    value.platforms.length !== CLOUD_IMAGE_PLATFORMS.length ||
    !CLOUD_IMAGE_PLATFORMS.every((platform, index) => value.platforms[index] === platform)
  ) {
    throw new Error(`${field}.platforms must be linux/amd64 followed by linux/arm64`);
  }
  return { image, digest, platforms: [...CLOUD_IMAGE_PLATFORMS] };
}

export function createCloudImageManifest({ version, revision, relay, edge }) {
  if (!STABLE_VERSION.test(version)) throw new Error("stable SemVer required");
  if (!GIT_REVISION.test(revision)) throw new Error("a full lowercase Git revision is required");
  return {
    schemaVersion: 1,
    version,
    revision,
    containers: {
      relay: validateContainer({ ...relay, platforms: CLOUD_IMAGE_PLATFORMS }, "containers.relay"),
      edge: validateContainer({ ...edge, platforms: CLOUD_IMAGE_PLATFORMS }, "containers.edge"),
    },
  };
}

export function validateCloudImageManifest(value, expectedVersion) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("cloud image manifest must be an object");
  }
  if (value.schemaVersion !== 1) throw new Error("cloud image manifest schemaVersion must be 1");
  if (value.version !== expectedVersion) throw new Error("cloud image manifest version does not match the release");
  if (!GIT_REVISION.test(value.revision)) throw new Error("cloud image manifest has an invalid revision");
  if (!value.containers || typeof value.containers !== "object" || Array.isArray(value.containers)) {
    throw new Error("cloud image manifest has no containers");
  }
  return {
    schemaVersion: 1,
    version: value.version,
    revision: value.revision,
    containers: {
      relay: validateContainer(value.containers.relay, "containers.relay"),
      edge: validateContainer(value.containers.edge, "containers.edge"),
    },
  };
}

export function validateCloudImageIndex(value, { version, revision, source }) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("cloud image index must be an object");
  }
  if (value.schemaVersion !== 2 || !INDEX_MEDIA_TYPES.has(value.mediaType)) {
    throw new Error("cloud image must be an OCI or Docker multi-platform index");
  }
  if (
    value.annotations?.["org.opencontainers.image.version"] !== version ||
    value.annotations?.["org.opencontainers.image.revision"] !== revision ||
    value.annotations?.["org.opencontainers.image.source"] !== source
  ) {
    throw new Error("cloud image index release annotations do not match");
  }
  if (!Array.isArray(value.manifests)) throw new Error("cloud image index has no manifests");

  const runtimePlatforms = [];
  for (const descriptor of value.manifests) {
    const os = descriptor?.platform?.os;
    const architecture = descriptor?.platform?.architecture;
    if (os === "unknown" && architecture === "unknown") {
      if (descriptor?.annotations?.["vnd.docker.reference.type"] !== "attestation-manifest") {
        throw new Error("unknown-platform descriptor is not a BuildKit attestation");
      }
      continue;
    }
    runtimePlatforms.push(`${os}/${architecture}`);
  }
  runtimePlatforms.sort();
  if (
    runtimePlatforms.length !== CLOUD_IMAGE_PLATFORMS.length ||
    !CLOUD_IMAGE_PLATFORMS.every((platform, index) => runtimePlatforms[index] === platform)
  ) {
    throw new Error("cloud image index must contain exactly linux/amd64 and linux/arm64 runtimes");
  }
  return true;
}
