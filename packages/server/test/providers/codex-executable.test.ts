import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
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
  source = join(root, "Caskroom", "codex", "1.2.3", "codex-aarch64-apple-darwin");
  dataDir = join(root, "data");
  await mkdir(dirname(source), { recursive: true });
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
  it("uses a healthy Homebrew command directly and removes only the obsolete managed-copy artifacts", async () => {
    const legacyDirectory = join(dataDir, "provider-bin");
    await mkdir(legacyDirectory, { recursive: true });
    await writeFile(join(legacyDirectory, "codex-macos"), "obsolete private copy");
    await writeFile(join(legacyDirectory, "codex-macos-source.json"), "{}");
    await writeFile(join(legacyDirectory, "keep"), "unrelated provider data");
    const verify = vi.fn(async () => true);
    const resolution = await resolveCodexExecutable({
      codexBin: "codex",
      dataDir,
      deps: deps(() => ({ state: "ready", version: "1.2.3" }), { verifyOfficialSignature: verify }),
    });

    expect(resolution).toEqual({
      executable: "codex",
      sourceExecutable: source,
      provenance: "homebrew",
      recovered: false,
    });
    expect(verify).not.toHaveBeenCalled();
    await expect(lstat(join(legacyDirectory, "codex-macos"))).rejects.toThrow();
    await expect(lstat(join(legacyDirectory, "codex-macos-source.json"))).rejects.toThrow();
    expect(await readFile(join(legacyDirectory, "keep"), "utf8")).toBe("unrelated provider data");
  });

  it("does not modify a non-timeout failure or an unverified executable", async () => {
    const before = await stat(source);
    const failed = await resolveCodexExecutable({
      codexBin: "codex",
      dataDir,
      deps: deps(() => ({ state: "failed" })),
    });
    expect(failed).toMatchObject({ executable: "codex", sourceExecutable: source, recovered: false });

    const clear = vi.fn(async () => true);
    const unverified = await resolveCodexExecutable({
      codexBin: "codex",
      dataDir,
      deps: deps(() => ({ state: "timeout" }), {
        verifyOfficialSignature: vi.fn(async () => false),
        clearExtendedAttributes: clear,
      }),
    });
    expect(unverified).toMatchObject({ executable: "codex", sourceExecutable: source, recovered: false });
    expect(clear).not.toHaveBeenCalled();
    expect((await stat(source)).ino).toBe(before.ino);
  });

  it("atomically repairs a blocked official Homebrew executable in place without retaining a private copy", async () => {
    const original = await stat(source);
    const probe = vi.fn(async (executable: string): Promise<CodexExecutableProbe> => {
      if (executable === source && (await stat(source)).ino === original.ino) return { state: "timeout" };
      return { state: "ready", version: "1.2.3" };
    });
    const clearExtendedAttributes = vi.fn(async () => true);
    const resolution = await resolveCodexExecutable({
      codexBin: "codex",
      dataDir,
      deps: deps(probe, { clearExtendedAttributes }),
    });

    expect(resolution).toEqual({
      executable: "codex",
      sourceExecutable: source,
      provenance: "homebrew",
      recovered: true,
    });
    expect((await stat(source)).ino).not.toBe(original.ino);
    expect((await lstat(source)).mode & 0o777).toBe(0o755);
    expect(await readFile(source, "utf8")).toBe("official-codex-binary-v1");
    expect(clearExtendedAttributes).toHaveBeenCalledOnce();
    expect(clearExtendedAttributes).not.toHaveBeenCalledWith(source);
    expect(await readdir(dirname(source))).toEqual([basename(source)]);
    await expect(lstat(dataDir)).rejects.toThrow();
  });

  it("rolls back to the original inode when the replacement cannot run from the Homebrew path", async () => {
    const original = await stat(source);
    const resolution = await resolveCodexExecutable({
      codexBin: "codex",
      dataDir,
      deps: deps((executable) => (executable === source ? { state: "timeout" } : { state: "ready", version: "1.2.3" })),
    });

    expect(resolution.recovered).toBe(false);
    expect((await stat(source)).ino).toBe(original.ino);
    expect(await readFile(source, "utf8")).toBe("official-codex-binary-v1");
    expect(await readdir(dirname(source))).toEqual([basename(source)]);
  });

  it("does not overwrite a Homebrew update that races the repair", async () => {
    const clearExtendedAttributes = vi.fn(async () => {
      await writeFile(source, "newer-homebrew-codex-binary");
      await chmod(source, 0o755);
      return true;
    });
    const resolution = await resolveCodexExecutable({
      codexBin: "codex",
      dataDir,
      deps: deps(
        (executable) => (executable === source ? { state: "timeout" } : { state: "ready", version: "1.2.3" }),
        { clearExtendedAttributes },
      ),
    });

    expect(resolution.recovered).toBe(false);
    expect(await readFile(source, "utf8")).toBe("newer-homebrew-codex-binary");
    expect(await readdir(dirname(source))).toEqual([basename(source)]);
  });

  it("never repairs a timed-out executable from an unknown installation source", async () => {
    const standalone = join(root, "standalone-codex");
    await writeFile(standalone, "standalone-codex");
    await chmod(standalone, 0o755);
    const verify = vi.fn(async () => true);
    const resolution = await resolveCodexExecutable({
      codexBin: "codex",
      dataDir,
      deps: deps(() => ({ state: "timeout" }), {
        resolveExecutable: vi.fn(async () => standalone),
        verifyOfficialSignature: verify,
      }),
    });

    expect(resolution).toMatchObject({
      executable: "codex",
      sourceExecutable: standalone,
      provenance: "unknown",
      recovered: false,
    });
    expect(verify).not.toHaveBeenCalled();
  });

  it("does not attempt a macOS repair on other platforms", async () => {
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
