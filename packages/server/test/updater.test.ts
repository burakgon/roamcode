import { describe, expect, test, vi } from "vitest";
import {
  Updater,
  parseChangelog,
  parseConventionalSubject,
  groupForPrefix,
  versionLabel,
  renderRestartCommand,
  renderUpdaterScript,
  computeBuildDrift,
  RUNNING_BUILD,
  EXPECTED_REMOTE_SUBSTRING,
  isExpectedRemote,
  CHECK_CACHE_MS,
} from "../src/updater.js";
import type { RunGit, RunGitResult, UpdaterFs } from "../src/updater.js";

test("isExpectedRemote matches ONLY the official repo, exactly (not a substring)", () => {
  for (const ok of [
    "https://github.com/burakgon/roamcode",
    "https://github.com/burakgon/roamcode.git",
    "git@github.com:burakgon/roamcode.git",
    "ssh://git@github.com/burakgon/roamcode",
    // Pre-rename repo name: still official (GitHub permanently redirects) — pre-rename installs
    // keep this as their configured origin and MUST retain OTA.
    "https://github.com/burakgon/remote-coder",
    "https://github.com/burakgon/remote-coder.git",
    "git@github.com:burakgon/remote-coder.git",
    "ssh://git@github.com/burakgon/remote-coder",
  ])
    expect(isExpectedRemote(ok)).toBe(true);
  for (const bad of [
    "https://github.com/burakgon/roamcode-attacker.git", // suffix — the old substring guard accepted this
    "https://evil.com/github.com/burakgon/roamcode", // prefix
    "https://github.com/someoneelse/roamcode",
    "https://gitlab.com/burakgon/roamcode",
    "https://github.com/burakgon/remote-coder-attacker.git", // legacy-name suffix attack
    "https://github.com/someoneelse/remote-coder",
  ])
    expect(isExpectedRemote(bad)).toBe(false);
});

// The ASCII unit separator the updater's git --format uses (must match updater.ts's LOG_SEP).
const US = "\x1f";
const NOW = Date.parse("2026-06-25T12:00:00Z");

/** A FIXTURE git runner: matches on the joined args and returns canned stdout. Records calls so a test
 * can assert ordering / which commands ran. NEVER runs real git. */
function fixtureRunGit(table: Array<{ match: (args: string[]) => boolean; result: Partial<RunGitResult> }>): {
  runGit: RunGit;
  calls: string[][];
} {
  const calls: string[][] = [];
  const runGit: RunGit = async (args) => {
    calls.push(args);
    for (const row of table) {
      if (row.match(args)) {
        return { stdout: row.result.stdout ?? "", stderr: row.result.stderr ?? "", code: row.result.code ?? 0 };
      }
    }
    return { stdout: "", stderr: "no fixture", code: 1 };
  };
  return { runGit, calls };
}

/** An in-memory fs double. */
function memFs(seed: Record<string, string> = {}): UpdaterFs & { files: Record<string, string> } {
  const files: Record<string, string> = { ...seed };
  return {
    files,
    existsSync: (p) => p in files,
    readFileSync: (p) => {
      if (!(p in files)) throw new Error(`ENOENT: ${p}`);
      return files[p]!;
    },
    writeFileSync: (p, data) => {
      files[p] = data;
    },
    mkdirSync: () => {},
    chmodSync: () => {},
  };
}

const has = (sub: string) => (args: string[]) => args.join(" ").includes(sub);

function logLine(sha: string, iso: string, subject: string): string {
  return `${sha}${US}${iso}${US}${subject}`;
}

describe("parseConventionalSubject", () => {
  test("strips a feat(scope): prefix", () => {
    expect(parseConventionalSubject("feat(server): add OTA self-update")).toEqual({
      prefix: "feat",
      subject: "add OTA self-update",
    });
  });
  test("strips a bare fix: prefix", () => {
    expect(parseConventionalSubject("fix: handle offline fetch")).toEqual({
      prefix: "fix",
      subject: "handle offline fetch",
    });
  });
  test("handles a breaking-change ! marker", () => {
    expect(parseConventionalSubject("feat(api)!: drop legacy route")).toEqual({
      prefix: "feat",
      subject: "drop legacy route",
    });
  });
  test("a non-conventional subject is returned verbatim with no prefix", () => {
    expect(parseConventionalSubject("Merge branch main")).toEqual({ subject: "Merge branch main" });
  });
});

describe("groupForPrefix", () => {
  test("maps prefixes to the right buckets", () => {
    expect(groupForPrefix("feat")).toBe("new");
    expect(groupForPrefix("fix")).toBe("fixes");
    expect(groupForPrefix("perf")).toBe("improvements");
    expect(groupForPrefix("refactor")).toBe("improvements");
    expect(groupForPrefix("chore")).toBe("other");
    expect(groupForPrefix("docs")).toBe("other");
    expect(groupForPrefix("test")).toBe("other");
    expect(groupForPrefix("ci")).toBe("other");
    expect(groupForPrefix(undefined)).toBe("improvements");
  });
});

describe("parseChangelog (FIXTURE git log output)", () => {
  const fixture = [
    logLine("a1b2c3d", "2026-06-25T10:00:00Z", "feat(web): update banner + changelog panel"),
    logLine("b2c3d4e", "2026-06-24T10:00:00Z", "fix(server): guard offline fetch in /version"),
    logLine("c3d4e5f", "2026-06-23T10:00:00Z", "chore: bump deps"),
    logLine("d4e5f60", "2026-06-22T10:00:00Z", "perf(store): memoize reducer"),
    logLine("e5f6071", "2026-06-21T10:00:00Z", "docs: update README"),
  ].join("\n");

  test("groups feat/fix/perf and HIDES chore/docs (folded into Other)", () => {
    const entries = parseChangelog(fixture, NOW);
    // chore + docs are excluded → 3 visible entries.
    expect(entries).toHaveLength(3);
    expect(entries.map((e) => e.group)).toEqual(["new", "fixes", "improvements"]);
    expect(entries[0]!.subject).toBe("update banner + changelog panel");
    expect(entries[1]!.subject).toBe("guard offline fetch in /version");
    expect(entries[2]!.subject).toBe("memoize reducer");
  });

  test("each entry carries a short sha + a relative-time label", () => {
    const entries = parseChangelog(fixture, NOW);
    expect(entries[0]!.sha).toBe("a1b2c3d");
    expect(entries[0]!.when).toBe("2h"); // 10:00 vs 12:00 same day
    expect(entries[1]!.when).toBe("1d");
  });

  test("ignores malformed lines (missing separators)", () => {
    const entries = parseChangelog("garbage line with no separators\n", NOW);
    expect(entries).toEqual([]);
  });
});

describe("versionLabel", () => {
  test("formats v<YYYY.MM.DD> · <sha>", () => {
    expect(versionLabel("2026-06-25T10:00:00Z", "a1b2c3d")).toBe("v2026.06.25 · a1b2c3d");
  });
});

describe("renderRestartCommand", () => {
  test("launchd → launchctl kickstart -k gui/$(id -u)/<label>", () => {
    expect(renderRestartCommand("launchd", "com.bgn.remotecoder")).toBe(
      'launchctl kickstart -k "gui/$(id -u)/com.bgn.remotecoder"',
    );
  });
  test("systemd → systemctl --user restart <label>", () => {
    expect(renderRestartCommand("systemd", "roamcode")).toBe('systemctl --user restart "roamcode"');
  });
  test("unknown manager → empty (the script's SIGTERM fallback covers it)", () => {
    expect(renderRestartCommand("weird", "x")).toBe("");
  });
});

describe("Updater.getVersion (FIXTURE git, no real git mutation)", () => {
  function buildUpdater(opts: {
    behind: number;
    log: string;
    remote?: string;
    fetchCode?: number;
    fs?: UpdaterFs;
    now?: () => number;
  }) {
    const { runGit, calls } = fixtureRunGit([
      { match: has("rev-parse --show-toplevel"), result: { stdout: "/repo\n" } },
      {
        match: has("config --get remote.origin.url"),
        result: { stdout: (opts.remote ?? `https://${EXPECTED_REMOTE_SUBSTRING}.git`) + "\n" },
      },
      { match: has("rev-parse --short HEAD"), result: { stdout: "headsha\n" } },
      { match: (a) => a.join(" ") === "log -1 --format=%cI", result: { stdout: "2026-06-20T08:00:00Z\n" } },
      { match: has("fetch origin main"), result: { code: opts.fetchCode ?? 0 } },
      { match: has("rev-list --count"), result: { stdout: `${opts.behind}\n` } },
      { match: (a) => a.join(" ").startsWith("log HEAD..origin/main"), result: { stdout: opts.log } },
      {
        match: (a) => a.join(" ").startsWith("log -1 origin/main"),
        result: { stdout: `${US}2026-06-25T10:00:00Z${US}newsha` },
      },
    ]);
    const updater = new Updater({
      runGit,
      fs: opts.fs ?? memFs(),
      spawn: vi.fn() as never,
      now: opts.now ?? (() => NOW),
      dataDir: "/data",
      repoRoot: "/cwd",
      env: {},
      platform: "linux",
    });
    return { updater, calls };
  }

  test("reports behind + grouped changelog when origin/main is ahead", async () => {
    const log = [
      logLine("a1b2c3d", "2026-06-25T10:00:00Z", "feat: new thing"),
      logLine("b2c3d4e", "2026-06-24T10:00:00Z", "fix: a bug"),
    ].join("\n");
    const { updater } = buildUpdater({ behind: 2, log });
    const info = await updater.getVersion();
    expect(info.updatable).toBe(true);
    expect(info.updateAvailable).toBe(true);
    expect(info.behind).toBe(2);
    expect(info.current).toBe("v2026.06.20 · headsha");
    expect(info.latest).toBe("v2026.06.25 · newsha");
    expect(info.changelog).toHaveLength(2);
    expect(info.changelog[0]!.group).toBe("new");
    // The running build sha is reported; in test (no build-time define) it is "dev", so drift can't be
    // decided → false (never false-alarms on an unstamped build).
    expect(info.runningBuild).toBe(RUNNING_BUILD);
    expect(RUNNING_BUILD).toBe("dev");
    expect(info.buildDrift).toBe(false);
  });

  test("up to date → behind 0, no changelog, latest == current", async () => {
    const { updater } = buildUpdater({ behind: 0, log: "" });
    const info = await updater.getVersion();
    expect(info.behind).toBe(0);
    expect(info.updateAvailable).toBe(false);
    expect(info.updatable).toBe(true);
    expect(info.latest).toBe(info.current);
    expect(info.changelog).toEqual([]);
  });

  test("offline (fetch fails) is non-fatal → updatable, not behind", async () => {
    const { updater } = buildUpdater({ behind: 5, log: "", fetchCode: 1 });
    const info = await updater.getVersion();
    expect(info.updatable).toBe(true);
    expect(info.updateAvailable).toBe(false);
    expect(info.behind).toBe(0);
  });

  test("a wrong remote disables the feature (updatable:false)", async () => {
    const { updater } = buildUpdater({ behind: 1, log: "", remote: "https://github.com/someone/fork.git" });
    const info = await updater.getVersion();
    expect(info.updatable).toBe(false);
    expect(info.updateAvailable).toBe(false);
  });

  test("not a git checkout → updatable:false", async () => {
    const { runGit } = fixtureRunGit([
      { match: has("rev-parse --show-toplevel"), result: { code: 128 } }, // git: not a repository
    ]);
    const updater = new Updater({
      runGit,
      fs: memFs(),
      spawn: vi.fn() as never,
      now: () => NOW,
      dataDir: "/data",
      repoRoot: "/cwd",
      env: {},
      platform: "linux",
    });
    const info = await updater.getVersion();
    expect(info.updatable).toBe(false);
  });

  test("caches the check within CHECK_CACHE_MS (no second fetch)", async () => {
    let clock = NOW;
    const { updater, calls } = buildUpdater({ behind: 0, log: "", now: () => clock });
    await updater.getVersion();
    const firstFetches = calls.filter((c) => c.join(" ").includes("fetch origin main")).length;
    expect(firstFetches).toBe(1);
    // Inside the window → reuse.
    clock = NOW + CHECK_CACHE_MS - 1;
    await updater.getVersion();
    expect(calls.filter((c) => c.join(" ").includes("fetch origin main")).length).toBe(1);
    // Past the window → re-fetch.
    clock = NOW + CHECK_CACHE_MS + 1;
    await updater.getVersion();
    expect(calls.filter((c) => c.join(" ").includes("fetch origin main")).length).toBe(2);
  });
});

describe("Updater.resolveServiceRestart", () => {
  function make(opts: { fs?: UpdaterFs; env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform }) {
    return new Updater({
      runGit: (async () => ({ stdout: "", stderr: "", code: 0 })) as RunGit,
      fs: opts.fs ?? memFs(),
      spawn: vi.fn() as never,
      now: () => NOW,
      dataDir: "/data",
      env: opts.env ?? {},
      platform: opts.platform ?? "linux",
    });
  }

  test("prefers service.json", () => {
    const fs = memFs({ "/data/service.json": JSON.stringify({ manager: "launchd", label: "com.bgn.remotecoder" }) });
    const r = make({ fs, platform: "darwin" }).resolveServiceRestart();
    expect(r.manager).toBe("launchd");
    expect(r.label).toBe("com.bgn.remotecoder");
    expect(r.command).toContain("com.bgn.remotecoder");
  });

  test("falls back to env ROAMCODE_SERVICE_LABEL/_MANAGER", () => {
    const r = make({
      env: { ROAMCODE_SERVICE_MANAGER: "systemd", ROAMCODE_SERVICE_LABEL: "rc-custom" },
    }).resolveServiceRestart();
    expect(r.manager).toBe("systemd");
    expect(r.label).toBe("rc-custom");
    expect(r.command).toBe('systemctl --user restart "rc-custom"');
  });

  test("legacy REMOTE_CODER_SERVICE_* env still works; ROAMCODE_* wins when both are set", () => {
    const legacy = make({
      env: { REMOTE_CODER_SERVICE_MANAGER: "systemd", REMOTE_CODER_SERVICE_LABEL: "old-label" },
    }).resolveServiceRestart();
    expect(legacy.manager).toBe("systemd");
    expect(legacy.label).toBe("old-label");
    const both = make({
      env: { ROAMCODE_SERVICE_LABEL: "new-label", REMOTE_CODER_SERVICE_LABEL: "old-label" },
    }).resolveServiceRestart();
    expect(both.label).toBe("new-label");
  });

  test("platform default on macOS is launchd/com.roamcode", () => {
    const r = make({ platform: "darwin" }).resolveServiceRestart();
    expect(r.manager).toBe("launchd");
    expect(r.label).toBe("com.roamcode");
  });

  test("platform default on linux is systemd/roamcode", () => {
    const r = make({ platform: "linux" }).resolveServiceRestart();
    expect(r.manager).toBe("systemd");
    expect(r.label).toBe("roamcode");
  });
});

describe("Updater.readStatus", () => {
  test("idle when no status file exists", () => {
    const u = new Updater({
      runGit: (async () => ({ stdout: "", stderr: "", code: 0 })) as RunGit,
      fs: memFs(),
      spawn: vi.fn() as never,
      now: () => NOW,
      dataDir: "/data",
    });
    expect(u.readStatus()).toEqual({ state: "idle" });
  });

  test("reads a persisted status", () => {
    const fs = memFs({ "/data/update-status.json": JSON.stringify({ state: "building", phase: "building" }) });
    const u = new Updater({
      runGit: (async () => ({ stdout: "", stderr: "", code: 0 })) as RunGit,
      fs,
      spawn: vi.fn() as never,
      now: () => NOW,
      dataDir: "/data",
    });
    expect(u.readStatus().state).toBe("building");
  });

  test("a corrupt status file is treated as idle (never throws)", () => {
    const fs = memFs({ "/data/update-status.json": "{not json" });
    const u = new Updater({
      runGit: (async () => ({ stdout: "", stderr: "", code: 0 })) as RunGit,
      fs,
      spawn: vi.fn() as never,
      now: () => NOW,
      dataDir: "/data",
    });
    expect(u.readStatus()).toEqual({ state: "idle" });
  });
});

describe("Updater.startUpdate (spawns the detached script; NO real git/build)", () => {
  function buildOkUpdater(spawnImpl: ReturnType<typeof vi.fn>, fs = memFs()) {
    const { runGit } = fixtureRunGit([
      { match: has("rev-parse --show-toplevel"), result: { stdout: "/repo\n" } },
      {
        match: has("config --get remote.origin.url"),
        result: { stdout: `https://${EXPECTED_REMOTE_SUBSTRING}.git\n` },
      },
    ]);
    return new Updater({
      runGit,
      fs,
      spawn: spawnImpl as never,
      now: () => NOW,
      dataDir: "/data",
      repoRoot: "/cwd",
      env: {},
      platform: "linux",
    });
  }

  test("writes starting status, writes the .sh, and spawns it detached + unref", async () => {
    const unref = vi.fn();
    const spawnImpl = vi.fn(() => ({ unref, on: vi.fn() }));
    const fs = memFs();
    const u = buildOkUpdater(spawnImpl, fs);
    const res = await u.startUpdate();
    expect(res.started).toBe(true);
    // status went to "starting"
    expect(JSON.parse(fs.files["/data/update-status.json"]!).state).toBe("starting");
    // wrote the updater script
    expect(fs.files["/data/rc-update.sh"]).toContain("#!/bin/sh");
    expect(fs.files["/data/rc-update.sh"]).toContain("git merge --ff-only origin/main");
    // spawned /bin/sh <script> detached, and unref'd so it survives the restart
    expect(spawnImpl).toHaveBeenCalledTimes(1);
    const [cmd, args, spawnOpts] = spawnImpl.mock.calls[0]!;
    expect(cmd).toBe("/bin/sh");
    expect(args).toEqual(["/data/rc-update.sh"]);
    expect(spawnOpts).toMatchObject({ detached: true, stdio: "ignore" });
    expect(unref).toHaveBeenCalled();
  });

  test("self-heals a wedged in-flight flag: a prior build FAILURE never blocks future updates", async () => {
    const spawnImpl = vi.fn(() => ({ unref: vi.fn(), on: vi.fn() }));
    const fs = memFs();
    const u = buildOkUpdater(spawnImpl, fs);

    // 1. First update launches (sets the in-memory in-flight flag + writes "starting" + spawns the script).
    const first = await u.startUpdate();
    expect(first.started).toBe(true);
    expect(spawnImpl).toHaveBeenCalledTimes(1);

    // 2. The DETACHED script fails at build → it writes {state:"failed"} to the status file. It's a separate
    //    process, so it CANNOT reset our in-memory flag — the bug was that this wedged every future update.
    fs.files["/data/update-status.json"] = JSON.stringify({
      state: "failed",
      error: "pnpm -r build failed",
      updatedAt: NOW,
    });

    // 3. A retry must be ALLOWED (re-derived from the terminal status), not refused "already in progress".
    const second = await u.startUpdate();
    expect(second.started).toBe(true);
    expect(second.reason).toBeUndefined();
    expect(spawnImpl).toHaveBeenCalledTimes(2);
  });

  test("self-heals a STALE in-progress status (the detached script was killed before writing a terminal state)", async () => {
    const spawnImpl = vi.fn(() => ({ unref: vi.fn(), on: vi.fn() }));
    const fs = memFs();
    const u = buildOkUpdater(spawnImpl, fs);
    expect((await u.startUpdate()).started).toBe(true);
    // A non-terminal status whose timestamp is far in the past → the updater died without finishing.
    fs.files["/data/update-status.json"] = JSON.stringify({ state: "building", updatedAt: NOW - 11 * 60_000 });
    const second = await u.startUpdate();
    expect(second.started).toBe(true);
    expect(spawnImpl).toHaveBeenCalledTimes(2);
  });

  test("STILL refuses a concurrent update while one is GENUINELY running (fresh non-terminal status)", async () => {
    const spawnImpl = vi.fn(() => ({ unref: vi.fn(), on: vi.fn() }));
    const fs = memFs();
    const u = buildOkUpdater(spawnImpl, fs);
    expect((await u.startUpdate()).started).toBe(true);
    // Mid-build, status freshly written → a second tap must be refused (we didn't weaken the real guard).
    fs.files["/data/update-status.json"] = JSON.stringify({ state: "building", updatedAt: NOW });
    const second = await u.startUpdate();
    expect(second.started).toBe(false);
    expect(second.reason).toMatch(/already in progress/);
    expect(spawnImpl).toHaveBeenCalledTimes(1);
  });

  test("refuses when the remote is not the official repo (no spawn)", async () => {
    const spawnImpl = vi.fn(() => ({ unref: vi.fn(), on: vi.fn() }));
    const { runGit } = fixtureRunGit([
      { match: has("rev-parse --show-toplevel"), result: { stdout: "/repo\n" } },
      { match: has("config --get remote.origin.url"), result: { stdout: "https://github.com/x/fork.git\n" } },
    ]);
    const u = new Updater({
      runGit,
      fs: memFs(),
      spawn: spawnImpl as never,
      now: () => NOW,
      dataDir: "/data",
      repoRoot: "/cwd",
      env: {},
      platform: "linux",
    });
    const res = await u.startUpdate();
    expect(res.started).toBe(false);
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  /** Like buildOkUpdater, but the fixture also answers `rev-parse --short HEAD` so the rollback anchor
   *  (last-good-sha) can be recorded. */
  function buildAnchoredUpdater(spawnImpl: ReturnType<typeof vi.fn>, fs = memFs()) {
    const { runGit } = fixtureRunGit([
      { match: has("rev-parse --show-toplevel"), result: { stdout: "/repo\n" } },
      {
        match: has("config --get remote.origin.url"),
        result: { stdout: `https://${EXPECTED_REMOTE_SUBSTRING}.git\n` },
      },
      { match: has("rev-parse --short HEAD"), result: { stdout: "0abc123\n" } },
    ]);
    return new Updater({
      runGit,
      fs,
      spawn: spawnImpl as never,
      now: () => NOW,
      dataDir: "/data",
      repoRoot: "/cwd",
      env: {},
      platform: "linux",
    });
  }

  test("records the pre-update HEAD to <dataDir>/last-good-sha (the rollback anchor) before moving off it", async () => {
    const spawnImpl = vi.fn(() => ({ unref: vi.fn(), on: vi.fn() }));
    const fs = memFs();
    const u = buildAnchoredUpdater(spawnImpl, fs);
    expect(u.readLastGoodSha()).toBeUndefined(); // nothing recorded until an update runs
    expect((await u.startUpdate()).started).toBe(true);
    expect(fs.files["/data/last-good-sha"]).toBe("0abc123\n");
    expect(u.readLastGoodSha()).toBe("0abc123");
  });

  test("startUpdate({targetSha}) renders the ROLLBACK script mode (reset to the sha, not an ff-merge)", async () => {
    const spawnImpl = vi.fn(() => ({ unref: vi.fn(), on: vi.fn() }));
    const fs = memFs();
    const u = buildAnchoredUpdater(spawnImpl, fs);
    const res = await u.startUpdate({ targetSha: "abc1234" });
    expect(res.started).toBe(true);
    const script = fs.files["/data/rc-update.sh"]!;
    expect(script).toContain("ROLLBACK_SHA='abc1234'");
    expect(script).toContain('git reset --hard "$ROLLBACK_SHA"');
  });

  test("startUpdate refuses a malformed targetSha (it's interpolated into the script) — no spawn", async () => {
    const spawnImpl = vi.fn(() => ({ unref: vi.fn(), on: vi.fn() }));
    const u = buildAnchoredUpdater(spawnImpl);
    const res = await u.startUpdate({ targetSha: "not a sha; rm -rf /" });
    expect(res.started).toBe(false);
    expect(res.reason).toMatch(/invalid target sha/);
    expect(spawnImpl).not.toHaveBeenCalled();
  });
});

describe("Updater.readLastGoodSha", () => {
  function make(fs: UpdaterFs) {
    return new Updater({
      runGit: (async () => ({ stdout: "", stderr: "", code: 0 })) as RunGit,
      fs,
      spawn: vi.fn() as never,
      now: () => NOW,
      dataDir: "/data",
    });
  }

  test("returns the recorded sha (trimmed)", () => {
    expect(make(memFs({ "/data/last-good-sha": "abc1234\n" })).readLastGoodSha()).toBe("abc1234");
  });

  test("undefined when no file exists", () => {
    expect(make(memFs()).readLastGoodSha()).toBeUndefined();
  });

  test("undefined for a garbage file (never trusted into a git command)", () => {
    expect(make(memFs({ "/data/last-good-sha": "$(rm -rf /)" })).readLastGoodSha()).toBeUndefined();
  });
});

describe("renderUpdaterScript", () => {
  const script = renderUpdaterScript({
    repoRoot: "/repo",
    statusPath: "/data/update-status.json",
    logPath: "/data/update.log",
    expectedRemote: EXPECTED_REMOTE_SUBSTRING,
    restartCommand: 'systemctl --user restart "roamcode"',
    parentPid: 4242,
    nodeBinDir: "/opt/node/bin",
  });

  test("guards the remote, pulls ff-only, installs, builds, boot-smokes, then restarts", () => {
    expect(script).toContain("#!/bin/sh");
    expect(script).toContain(EXPECTED_REMOTE_SUBSTRING);
    expect(script).toContain("git merge --ff-only origin/main");
    // Install/build go through the $PNPM shim (corepack fallback), not a bare `pnpm`.
    expect(script).toContain("$PNPM install --frozen-lockfile");
    expect(script).toContain("$PNPM -r build");
    expect(script).toContain('systemctl --user restart "roamcode"');
  });

  test("exports a robust PATH that prepends the node bin dir + homebrew + pnpm globals", () => {
    // The injected node bin dir is single-quoted into NODE_BIN_DIR and prepended to PATH.
    expect(script).toContain("NODE_BIN_DIR='/opt/node/bin'");
    expect(script).toContain('export PATH="${NODE_BIN_DIR}:/opt/homebrew/bin:/usr/local/bin:');
    expect(script).toContain("${HOME}/.local/share/pnpm");
    expect(script).toContain("${HOME}/Library/pnpm");
    // corepack pnpm fallback when a real pnpm isn't found.
    expect(script).toContain('PNPM="corepack pnpm"');
  });

  test("PREFLIGHTS git/node/pnpm and fails (preparing) BEFORE mutating anything", () => {
    expect(script).toContain("command -v git");
    expect(script).toContain("command -v node");
    expect(script).toContain("$PNPM --version");
    // Each missing-tool branch fails in the "preparing" phase (before any pull/install).
    expect(script).toMatch(/git not found[\s\S]*"preparing"/);
    expect(script).toMatch(/pnpm not found[\s\S]*"preparing"/);
    // Preflight must come BEFORE the first destructive git op.
    const preflightIdx = script.indexOf("command -v git");
    const pullIdx = script.indexOf("git merge --ff-only");
    expect(preflightIdx).toBeGreaterThan(-1);
    expect(preflightIdx).toBeLessThan(pullIdx);
  });

  test("DIRTY-TREE GUARD refuses on TRACKED changes only (untracked can't be harmed) and never reset --hard origin/main", () => {
    // -uno: a stray untracked dir (scratch folder, a parallel agent's workspace) must NOT block updates —
    // ff-only pulls can't harm untracked files, and a real path collision fails the pull itself.
    expect(script).toContain("git status --porcelain --untracked-files=no");
    expect(script).toContain("local changes to tracked files present");
    // The old destructive, edit-eating fallback must be GONE — the only reset is the rollback to PREV_SHA.
    expect(script).not.toContain("git reset --hard origin/main");
    // The dirty-tree guard runs before the pull.
    const guardIdx = script.indexOf("git status --porcelain");
    const pullIdx = script.indexOf("git merge --ff-only");
    expect(guardIdx).toBeLessThan(pullIdx);
  });

  test("captures PREV_SHA before the pull and rolls back to it on a failed boot-smoke", () => {
    expect(script).toContain("PREV_SHA=");
    expect(script).toContain("git rev-parse HEAD");
    // PREV_SHA is captured before the pull.
    const prevIdx = script.indexOf("PREV_SHA=");
    const pullIdx = script.indexOf("git merge --ff-only");
    expect(prevIdx).toBeLessThan(pullIdx);
    // Rollback resets to the captured PREV_SHA (NOT origin/main) and rebuilds.
    expect(script).toContain('git reset --hard "$PREV_SHA"');
    expect(script).toContain("new build failed to boot");
    expect(script).toContain("rolled back to $PREV_SHA");
  });

  test("BOOT-SMOKE boots the new build on loopback + temp dir, polls /health, BEFORE restarting", () => {
    expect(script).toContain("packages/server/dist/start.js");
    expect(script).toContain("BIND_ADDRESS=127.0.0.1");
    expect(script).toContain("PORT=0"); // OS-chosen ephemeral port → no collision with the live server
    expect(script).toContain("mktemp -d"); // throwaway data dir
    // The probe MUST run on an isolated tmux socket. On the default socket its empty-store rehydrate would
    // reap every live terminal session as an orphan → the user's terminals close on every update.
    expect(script).toContain('RC_TMUX_SOCKET="rc-smoke-$$"');
    expect(script).toContain("/health");
    // The probe child is always reaped (cleanup on every exit path).
    expect(script).toContain("cleanup_smoke");
    expect(script).toContain('kill "$SMOKE_PID"');
    // ORDER: build → boot-smoke → restart. The smoke section comes after the build and before the restart.
    const buildIdx = script.indexOf("$PNPM -r build");
    const smokeIdx = script.indexOf("boot-smoke:");
    const restartIdx = script.indexOf('if [ -n "$RESTART_CMD" ]');
    expect(buildIdx).toBeLessThan(smokeIdx);
    expect(smokeIdx).toBeLessThan(restartIdx);
  });

  test("health_get falls back to node when neither curl nor wget exist (slim host can still update)", () => {
    // Without this, a host lacking curl AND wget would false-fail the boot-smoke and roll back EVERY good
    // build → permanently stuck. node is guaranteed by the preflight, so it's the always-available fallback.
    expect(script).toContain("command -v curl");
    expect(script).toContain("command -v wget");
    expect(script).toContain('node -e \'var h=require("http")');
    expect(script).not.toContain("return 127"); // the old dead-end fallback is gone
  });

  test("traps cleanup so the probe child + temp dir are reaped even if the script is killed mid-smoke", () => {
    expect(script).toContain("trap cleanup_smoke EXIT INT TERM");
    // cleanup_smoke nulls its vars so the EXIT trap can't double-kill a reused pid.
    expect(script).toContain('SMOKE_PID=""');
    expect(script).toContain('SMOKE_DIR=""');
  });

  test("on failure it records failed and does NOT restart", () => {
    // The fail() helper writes a "failed" status; restart only happens after a successful build + smoke.
    expect(script).toContain('write_status "failed"');
    // The SIGTERM fallback targets the parent pid for the supervisor to recover.
    expect(script).toContain("4242");
    expect(script).toContain("kill -TERM");
  });

  test("default mode: ROLLBACK_SHA is empty, so the ff-only path (not the reset) runs", () => {
    expect(script).toContain("ROLLBACK_SHA=''");
    expect(script).toContain("git merge --ff-only origin/main");
  });

  test("targetSha mode: the sha is single-quoted in and the pulling step resets to it AFTER the dirty-tree guard", () => {
    const rb = renderUpdaterScript({
      repoRoot: "/repo",
      statusPath: "/data/update-status.json",
      logPath: "/data/update.log",
      expectedRemote: EXPECTED_REMOTE_SUBSTRING,
      restartCommand: 'systemctl --user restart "roamcode"',
      parentPid: 4242,
      nodeBinDir: "/opt/node/bin",
      targetSha: "abc1234",
    });
    expect(rb).toContain("ROLLBACK_SHA='abc1234'");
    expect(rb).toContain('git reset --hard "$ROLLBACK_SHA"');
    // The reset only ever runs after the clean-tree guard, so a rollback can't eat local edits either.
    expect(rb.indexOf("git status --porcelain")).toBeLessThan(rb.indexOf('git reset --hard "$ROLLBACK_SHA"'));
    // The full pipeline (install → build → boot-smoke → restart) is unchanged in rollback mode.
    expect(rb).toContain("$PNPM install --frozen-lockfile");
    expect(rb).toContain("boot-smoke:");
  });

  test("single-quotes interpolated values so a path can't break out of the shell", () => {
    const evil = renderUpdaterScript({
      repoRoot: "/re'po",
      statusPath: "/data/s.json",
      logPath: "/data/l.log",
      expectedRemote: "x",
      restartCommand: "",
      parentPid: 1,
      nodeBinDir: "/no'de",
    });
    // The embedded single-quote is escaped via the '\'' idiom, not left raw.
    expect(evil).toContain("'/re'\\''po'");
    expect(evil).toContain("'/no'\\''de'");
  });
});

describe("computeBuildDrift", () => {
  test("true when build and HEAD are different commits", () => {
    expect(computeBuildDrift("aaaaaaa", "bbbbbbb")).toBe(true);
  });
  test("false when build is a prefix of HEAD (or vice versa) — same commit, different abbrev", () => {
    expect(computeBuildDrift("abc1234", "abc12345678")).toBe(false);
    expect(computeBuildDrift("abc12345678", "abc1234")).toBe(false);
  });
  test("false (can't decide) when either sha is unknown/dev", () => {
    expect(computeBuildDrift("dev", "abc1234")).toBe(false);
    expect(computeBuildDrift("abc1234", "unknown")).toBe(false);
    expect(computeBuildDrift("", "abc1234")).toBe(false);
  });
});
