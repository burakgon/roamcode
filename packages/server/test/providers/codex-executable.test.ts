import { chmod, lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resolveCodexExecutable,
  type CodexExecutableDeps,
  type CodexExecutableProbe,
} from "../../src/providers/codex-executable.js";

let root: string;
let source: string;
let dataDir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "roamcode-codex-executable-"));
  source = join(root, "source-codex");
  dataDir = join(root, "data");
  await writeFile(source, "official-codex-binary-v1");
  await chmod(source, 0o755);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function deps(
  probe: (executable: string) => CodexExecutableProbe | Promise<CodexExecutableProbe>,
  overrides: Partial<CodexExecutableDeps> = {},
): Partial<CodexExecutableDeps> {
  return {
    platform: "darwin",
    resolveExecutable: vi.fn(async () => source),
    probe: vi.fn(async (executable) => probe(executable)),
    verifyOfficialSignature: vi.fn(async () => true),
    clearExtendedAttributes: vi.fn(async () => true),
    ...overrides,
  };
}

describe("resolveCodexExecutable", () => {
  it("leaves a healthy Codex executable untouched", async () => {
    const verify = vi.fn(async () => true);
    const resolution = await resolveCodexExecutable({
      codexBin: "codex",
      dataDir,
      deps: deps(() => ({ state: "ready", version: "1.2.3" }), { verifyOfficialSignature: verify }),
    });

    expect(resolution).toMatchObject({ executable: source, sourceExecutable: source, recovered: false });
    expect(verify).not.toHaveBeenCalled();
  });

  it("does not bypass a non-timeout failure or an unverified executable", async () => {
    const failed = await resolveCodexExecutable({
      codexBin: "codex",
      dataDir,
      deps: deps(() => ({ state: "failed" })),
    });
    expect(failed).toMatchObject({ executable: source, recovered: false });

    const clear = vi.fn(async () => true);
    const unverified = await resolveCodexExecutable({
      codexBin: "codex",
      dataDir,
      deps: deps(() => ({ state: "timeout" }), {
        verifyOfficialSignature: vi.fn(async () => false),
        clearExtendedAttributes: clear,
      }),
    });
    expect(unverified).toMatchObject({ executable: source, recovered: false });
    expect(clear).not.toHaveBeenCalled();
  });

  it("uses a private verified copy after a macOS launch timeout and reuses its source-bound cache", async () => {
    const firstProbe = vi.fn(async (executable: string): Promise<CodexExecutableProbe> =>
      executable === source ? { state: "timeout" } : { state: "ready", version: "1.2.3" },
    );
    const first = await resolveCodexExecutable({
      codexBin: "codex",
      dataDir,
      deps: deps(firstProbe),
    });

    expect(first.recovered).toBe(true);
    expect(first.executable).not.toBe(source);
    expect(await readFile(first.executable, "utf8")).toBe("official-codex-binary-v1");
    expect((await lstat(first.executable)).mode & 0o777).toBe(0o700);
    expect((await lstat(join(dataDir, "provider-bin", "codex-macos-source.json"))).mode & 0o777).toBe(0o600);
    expect(firstProbe).toHaveBeenCalledWith(source);

    const cachedProbe = vi.fn(async (executable: string): Promise<CodexExecutableProbe> => {
      expect(executable).toBe(first.executable);
      return { state: "ready", version: "1.2.3" };
    });
    const cached = await resolveCodexExecutable({
      codexBin: "codex",
      dataDir,
      deps: deps(cachedProbe),
    });

    expect(cached).toEqual(first);
    expect(cachedProbe).toHaveBeenCalledOnce();
  });

  it("invalidates the managed copy when the source executable changes", async () => {
    const recoveringDeps = deps((executable) =>
      executable === source ? { state: "timeout" } : { state: "ready", version: "1.2.3" },
    );
    const first = await resolveCodexExecutable({ codexBin: "codex", dataDir, deps: recoveringDeps });
    expect(first.recovered).toBe(true);

    await writeFile(source, "official-codex-binary-version-two");
    await chmod(source, 0o755);
    const sourceProbe = vi.fn(async (executable: string): Promise<CodexExecutableProbe> =>
      executable === source ? { state: "timeout" } : { state: "ready", version: "2.0.0" },
    );
    const second = await resolveCodexExecutable({ codexBin: "codex", dataDir, deps: deps(sourceProbe) });

    expect(second.recovered).toBe(true);
    expect(await readFile(second.executable, "utf8")).toBe("official-codex-binary-version-two");
    expect(sourceProbe).toHaveBeenCalledWith(source);
  });

  it("never trusts a symlink substituted for the managed executable", async () => {
    const recoveringDeps = deps((executable) =>
      executable === source ? { state: "timeout" } : { state: "ready", version: "1.2.3" },
    );
    const first = await resolveCodexExecutable({ codexBin: "codex", dataDir, deps: recoveringDeps });
    const replacement = join(root, "replacement");
    await writeFile(replacement, "not-codex");
    await rm(first.executable);
    await symlink(replacement, first.executable);

    const second = await resolveCodexExecutable({ codexBin: "codex", dataDir, deps: recoveringDeps });
    expect(second.recovered).toBe(true);
    expect((await lstat(second.executable)).isSymbolicLink()).toBe(false);
    expect(await readFile(second.executable, "utf8")).toBe("official-codex-binary-v1");
  });

  it("does not create a managed executable outside macOS", async () => {
    const resolveExecutable = vi.fn(async () => source);
    const resolution = await resolveCodexExecutable({
      codexBin: "codex",
      dataDir,
      deps: deps(() => ({ state: "timeout" }), { platform: "linux", resolveExecutable }),
    });

    expect(resolution).toEqual({
      executable: "codex",
      sourceExecutable: "codex",
      provenance: "unknown",
      recovered: false,
    });
    expect(resolveExecutable).not.toHaveBeenCalled();
  });
});
