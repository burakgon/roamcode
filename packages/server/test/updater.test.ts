import { describe, expect, test, vi } from "vitest";
import { CHECK_CACHE_MS, Updater, normalizeRelease, parseReleaseNotes, stableReleases } from "../src/updater.js";
import type { GitHubRelease, ReleaseRecord, UpdaterFs } from "../src/updater.js";

const NOW = Date.parse("2026-07-13T12:00:00Z");

function release(version: string, over: Partial<GitHubRelease> = {}): GitHubRelease {
  return {
    tag_name: `v${version}`,
    name: `v${version}`,
    body: "## Added\n- A feature\n## Fixed\n- A bug",
    published_at: "2026-07-12T12:00:00Z",
    draft: false,
    prerelease: false,
    assets: [{ name: "roamcode-release.json", browser_download_url: `https://example.test/${version}.json` }],
    ...over,
  };
}

function memFs(seed: Record<string, string> = {}): UpdaterFs & { files: Record<string, string> } {
  const files = { ...seed };
  return {
    files,
    existsSync: (path) => path in files,
    readFileSync: (path) => {
      if (!(path in files)) throw new Error(`ENOENT: ${path}`);
      return files[path]!;
    },
    writeFileSync: (path, data) => void (files[path] = data),
    mkdirSync: () => {},
    chmodSync: () => {},
    renameSync: (from, to) => {
      files[to] = files[from]!;
      delete files[from];
    },
  };
}

describe("stable GitHub Release feed", () => {
  test("accepts stable SemVer tags and ignores drafts, prereleases and non-SemVer tags", () => {
    expect(normalizeRelease(release("1.2.3"))?.version).toBe("1.2.3");
    expect(normalizeRelease(release("1.2.4", { draft: true }))).toBeUndefined();
    expect(normalizeRelease(release("1.3.0", { prerelease: true }))).toBeUndefined();
    expect(normalizeRelease(release("main", { tag_name: "main" }))).toBeUndefined();
  });

  test("sorts numerically by SemVer, not lexically", () => {
    expect(stableReleases([release("1.9.0"), release("1.10.0"), release("2.0.0")]).map((item) => item.version)).toEqual(
      ["2.0.0", "1.10.0", "1.9.0"],
    );
  });

  test("turns release-note headings into grouped changelog items without commit identity", () => {
    const record = normalizeRelease(release("1.1.0")) as ReleaseRecord;
    const entries = parseReleaseNotes(record, NOW);
    expect(entries).toEqual([
      expect.objectContaining({ id: "1.1.0:0", version: "1.1.0", group: "new", subject: "A feature" }),
      expect.objectContaining({ id: "1.1.0:1", version: "1.1.0", group: "fixes", subject: "A bug" }),
    ]);
  });
});

describe("Updater", () => {
  function build(
    opts: {
      releases?: GitHubRelease[];
      repoInstalled?: boolean;
      fetchError?: Error;
      manifest?: unknown;
    } = {},
  ) {
    const fs = memFs(
      opts.repoInstalled === false
        ? {}
        : { "/repo/.git": "", "/data/service.json": '{"manager":"systemd","label":"roamcode"}' },
    );
    const child = { on: vi.fn(), unref: vi.fn() };
    const spawn = vi.fn(() => child) as never;
    const fetchReleases = vi.fn(async () => {
      if (opts.fetchError) throw opts.fetchError;
      return { releases: opts.releases ?? [release("1.2.0"), release("1.1.0"), release("1.0.0")], etag: '"x"' };
    });
    const fetchManifest = vi.fn(
      async () =>
        opts.manifest ?? {
          version: "1.2.0",
          packages: {
            roamcode: { integrity: "sha512-cli" },
            "@roamcode.ai/server": { integrity: "sha512-server" },
            "@roamcode.ai/web": { integrity: "sha512-web" },
          },
        },
    );
    const updater = new Updater({
      fs,
      spawn,
      now: () => NOW,
      dataDir: "/data",
      repoRoot: "/repo",
      helperPath: "/release/managed-update-helper.js",
      env: { ROAMCODE_INSTALL_ROOT: "/definitely-not-a-managed-install" },
      runningVersion: "1.0.0",
      fetchReleases,
      fetchManifest,
    });
    return { updater, fs, spawn, fetchReleases, fetchManifest, child };
  }

  test("reports release distance and a migration/update action from stable versions", async () => {
    const { updater } = build();
    const info = await updater.getVersion();
    expect(info).toMatchObject({
      current: "v1.0.0",
      latest: "v1.2.0",
      behind: 2,
      releaseCount: 2,
      installation: "legacy-git",
      updateAction: "update",
      updatable: true,
      updateAvailable: true,
      runningVersion: "1.0.0",
    });
    expect(info.changelog.every((entry) => entry.version !== "1.0.0")).toBe(true);
  });

  test("an unmanaged foreground process directs the user to the persistent installer", async () => {
    const { updater } = build({ repoInstalled: false });
    const info = await updater.getVersion();
    expect(info.installation).toBe("unmanaged");
    expect(info.updatable).toBe(false);
    await expect(updater.startUpdate()).resolves.toMatchObject({
      started: false,
      reason: expect.stringContaining("roamcode install"),
    });
  });

  test("uses the cached release feed inside the TTL", async () => {
    const { updater, fetchReleases } = build();
    await updater.getVersion();
    await updater.getVersion();
    expect(fetchReleases).toHaveBeenCalledTimes(1);
    expect(CHECK_CACHE_MS).toBeGreaterThan(0);
  });

  test("verifies the release manifest before spawning the detached exact-version helper", async () => {
    const { updater, fs, spawn, fetchManifest, child } = build();
    const result = await updater.startUpdate({ targetVersion: "v1.2.0" });
    expect(result).toMatchObject({ started: true, target: "1.2.0" });
    expect(fetchManifest).toHaveBeenCalledWith("https://example.test/1.2.0.json");
    expect(spawn).toHaveBeenCalledWith(
      process.execPath,
      ["/release/managed-update-helper.js", expect.stringMatching(/^\/data\/update-/)],
      expect.objectContaining({ detached: true, stdio: "ignore" }),
    );
    expect(child.unref).toHaveBeenCalled();
    const configPath = Object.keys(fs.files).find((path) => /^\/data\/update-[0-9a-f-]+\.json$/.test(path));
    expect(configPath).toBeDefined();
    expect(JSON.parse(fs.files[configPath!]!)).toMatchObject({
      version: "1.2.0",
      expectedIntegrities: {
        roamcode: "sha512-cli",
        "@roamcode.ai/server": "sha512-server",
        "@roamcode.ai/web": "sha512-web",
      },
      restart: true,
    });
  });

  test("refuses a release whose manifest does not match its tag", async () => {
    const { updater, spawn } = build({
      manifest: { version: "9.9.9", packages: { roamcode: { integrity: "sha512-x" } } },
    });
    await expect(updater.startUpdate()).resolves.toMatchObject({
      started: false,
      reason: expect.stringContaining("tag"),
    });
    expect(spawn).not.toHaveBeenCalled();
  });
});
