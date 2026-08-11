import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

describe("stable release workflow", () => {
  it("publishes only exact successful-CI package candidates without rebuilding them", async () => {
    const [ci, release] = await Promise.all([
      readFile(resolve(repositoryRoot, ".github/workflows/ci.yml"), "utf8"),
      readFile(resolve(repositoryRoot, ".github/workflows/release.yml"), "utf8"),
    ]);

    expect(ci).toContain("stable-candidate-${{ github.sha }}");
    expect(ci).toContain("Attest exact stable package candidate");
    expect(ci).toContain('shard: ["1/2", "2/2"]');
    expect(ci).toContain("Build linked server package");
    expect(ci).toContain("pnpm exec vitest run --shard=${{ matrix.shard }}");
    expect(ci).not.toContain("stable-image-candidate");
    expect(ci).not.toContain("packaging/relay");

    expect(release).toContain("actions/workflows/ci.yml/runs?branch=main");
    expect(release).toContain("candidate.head_sha === process.env.SOURCE_REVISION");
    expect(release).toContain("Wait for exact successful CI candidate");
    expect(release).toContain('gh run watch "$run_id" --exit-status');
    expect(release).toContain("stopped being the main head while CI ran");
    expect(release).toContain("fetch-depth: 1");
    expect(release).toContain('git ls-remote --exit-code --tags origin "refs/tags/v${VERSION}"');
    expect(release).not.toContain("fetch-depth: 0");
    expect(release).toContain("stable-candidate-${{ github.sha }}");
    expect(release).toContain('gh attestation verify "$tarball"');
    expect(release).toContain('npm publish "$PWD/$tarball" --access public --provenance');
    expect(release).toContain('node scripts/verify-npm-artifact.mjs "$package" "$VERSION" "$PWD/$tarball"');
    expect(release).not.toContain("npm access set status=public");
    expect(release).toContain("Build verified release metadata from npm");
    expect(release).not.toMatch(/cloud image|roamcode-cloud-images|ghcr\.io/i);
    expect(release).not.toContain("docker/build-push-action@");
    expect(release).not.toContain("pnpm install --frozen-lockfile");
    expect(release).not.toContain("setup-qemu-action@");
  });

  it("keeps expensive release gates in independent parallel CI jobs", async () => {
    const ci = await readFile(resolve(repositoryRoot, ".github/workflows/ci.yml"), "utf8");
    const tests = ci.indexOf("\n  test:");
    const quality = ci.indexOf("\n  quality:");
    const mobile = ci.indexOf("\n  mobile:");
    const candidate = ci.indexOf("\n  stable-candidate:");
    const site = ci.indexOf("\n  site:");

    expect(tests).toBeGreaterThan(0);
    expect(quality).toBeGreaterThan(tests);
    expect(mobile).toBeGreaterThan(quality);
    expect(candidate).toBeGreaterThan(mobile);
    expect(site).toBeGreaterThan(candidate);
    expect(ci.slice(quality, mobile)).not.toContain("Mobile browser contracts");
    expect(ci.slice(mobile, candidate)).toContain("Mobile browser contracts");
    expect(ci.slice(tests, quality)).not.toContain("Exercise packed standalone runtime");
    expect(ci.slice(candidate, site)).toContain("Exercise packed standalone runtime");
    expect(ci.slice(candidate, site)).not.toContain("- name: Install tmux");
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

  it("keeps release visibility checks responsive without weakening their timeout", async () => {
    const [release, verification, fakeClaude] = await Promise.all([
      readFile(resolve(repositoryRoot, ".github/workflows/release.yml"), "utf8"),
      readFile(resolve(repositoryRoot, "scripts/verify-npm-artifact.mjs"), "utf8"),
      readFile(resolve(repositoryRoot, "packages/server/test/fixtures/fake-claude.mjs"), "utf8"),
    ]);

    expect(release).toContain('verify_package "dist-pack/roamcode.ai-web-${VERSION}.tgz" "@roamcode.ai/web" &');
    expect(release).toContain('for verify_pid in "${verify_pids[@]}"');
    expect(verification).toContain("const MAX_ATTEMPTS = 240;");
    expect(verification).toContain("const RETRY_DELAY_MS = 500;");
    expect(verification).toContain('accept: "application/json"');
    expect(verification).not.toContain("execFileSync");
    expect(fakeClaude).toContain('argv[0] === "auth" && argv[1] === "status"');
  });
});
