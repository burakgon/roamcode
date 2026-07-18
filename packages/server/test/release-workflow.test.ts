import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

describe("stable release workflow", () => {
  it("promotes only exact successful-CI candidates without rebuilding them", async () => {
    const [ci, release] = await Promise.all([
      readFile(resolve(repositoryRoot, ".github/workflows/ci.yml"), "utf8"),
      readFile(resolve(repositoryRoot, ".github/workflows/release.yml"), "utf8"),
    ]);

    expect(ci).toContain("stable-candidate-${{ github.sha }}");
    expect(ci).toContain("Attest exact stable package candidate");
    expect(ci).toContain("Build exact multi-platform candidate");
    expect(ci).toContain("provenance: mode=max");
    expect(ci).toContain("sbom: true");

    expect(release).toContain("actions/workflows/ci.yml/runs?branch=main");
    expect(release).toContain("candidate.head_sha === process.env.SOURCE_REVISION");
    expect(release).toContain("stable-candidate-${{ github.sha }}");
    expect(release).toContain('gh attestation verify "$tarball"');
    expect(release).toContain("Require exact CI-approved cloud image candidates");
    expect(release).not.toContain("docker/build-push-action@");
    expect(release).not.toContain("pnpm install --frozen-lockfile");
    expect(release).not.toContain("setup-qemu-action@");
  });

  it("keeps stable discovery last", async () => {
    const release = await readFile(resolve(repositoryRoot, ".github/workflows/release.yml"), "utf8");
    const npm = release.indexOf("Publish npm packages with trusted publishing");
    const homebrew = release.indexOf("Update permanent Homebrew tap");
    const githubRelease = release.indexOf("Publish stable GitHub Release last");

    expect(npm).toBeGreaterThan(0);
    expect(homebrew).toBeGreaterThan(npm);
    expect(githubRelease).toBeGreaterThan(homebrew);
  });
});
