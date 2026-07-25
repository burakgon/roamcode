import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageRoot = join(root, "packages", "ghostty-web");
const manifestPath = join(packageRoot, "ghostty-upstream.json");
const wasmPath = join(packageRoot, "src", "ghostty-vt.wasm");
const upstreamSourcePath = join(packageRoot, "src", "upstream.ts");
const buildOptions = ["-Demit-lib-vt", "-Dtarget=wasm32-freestanding", "-Doptimize=ReleaseSmall"];

function command(name, args, options = {}) {
  const result = spawnSync(name, args, {
    cwd: options.cwd ?? root,
    encoding: options.capture ? "utf8" : undefined,
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (result.status !== 0) {
    const stderr = typeof result.stderr === "string" ? result.stderr.trim() : "";
    throw new Error(`${name} ${args.join(" ")} failed${stderr ? `: ${stderr}` : ""}`);
  }
  return typeof result.stdout === "string" ? result.stdout.trim() : "";
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function readManifest() {
  return JSON.parse(readFileSync(manifestPath, "utf8"));
}

function renderUpstreamSource(manifest) {
  return `export const GHOSTTY_UPSTREAM = {
  repository: ${JSON.stringify(manifest.repository)},
  commit: ${JSON.stringify(manifest.commit)},
  committedAt: ${JSON.stringify(manifest.committedAt)},
  zigVersion: ${JSON.stringify(manifest.zigVersion)},
  wasmSha256: ${JSON.stringify(manifest.wasmSha256)},
} as const;
`;
}

function cloneCommit(repository, commit, destination) {
  command("git", ["init", "--quiet", destination]);
  command("git", ["remote", "add", "origin", repository], { cwd: destination });
  command("git", ["fetch", "--quiet", "--depth=1", "origin", commit], { cwd: destination });
  command("git", ["checkout", "--quiet", "--detach", "FETCH_HEAD"], { cwd: destination });
  const actual = command("git", ["rev-parse", "HEAD"], { cwd: destination, capture: true });
  if (actual !== commit) throw new Error(`Ghostty checkout mismatch: expected ${commit}, got ${actual}`);
}

function requiredZigVersion(sourceRoot) {
  const zon = readFileSync(join(sourceRoot, "build.zig.zon"), "utf8");
  const match = zon.match(/\.minimum_zig_version\s*=\s*"([^"]+)"/);
  if (!match) throw new Error("Ghostty build.zig.zon does not declare minimum_zig_version");
  return match[1];
}

function buildGhostty(sourceRoot, expectedZigVersion) {
  const actualZigVersion = command("zig", ["version"], { capture: true });
  if (actualZigVersion !== expectedZigVersion) {
    throw new Error(`Ghostty requires Zig ${expectedZigVersion}; found ${actualZigVersion}`);
  }
  command("zig", ["build", ...buildOptions], { cwd: sourceRoot });
  return join(sourceRoot, "zig-out", "bin", "ghostty-vt.wasm");
}

function verifyGeneratedMetadata(manifest) {
  const expectedSource = renderUpstreamSource(manifest);
  const actualSource = readFileSync(upstreamSourcePath, "utf8");
  if (actualSource !== expectedSource) {
    throw new Error("src/upstream.ts does not match ghostty-upstream.json");
  }
  const committedHash = sha256(wasmPath);
  if (committedHash !== manifest.wasmSha256) {
    throw new Error(`Committed Ghostty WASM hash mismatch: expected ${manifest.wasmSha256}, got ${committedHash}`);
  }
}

function resolveMain(repository) {
  const output = command("git", ["ls-remote", repository, "refs/heads/main"], { capture: true });
  const commit = output.split(/\s+/)[0];
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error("Could not resolve Ghostty main");
  return commit;
}

function main() {
  const mode = process.argv[2] ?? "verify";
  if (mode !== "verify" && mode !== "update") {
    throw new Error("Usage: node scripts/ghostty-wasm.mjs <verify|update>");
  }

  const current = readManifest();
  if (mode === "verify") verifyGeneratedMetadata(current);
  const commit = mode === "update" ? resolveMain(current.repository) : current.commit;
  const temporaryRoot = mkdtempSync(join(tmpdir(), "roamcode-ghostty-"));
  const sourceRoot = join(temporaryRoot, "ghostty");
  try {
    cloneCommit(current.repository, commit, sourceRoot);
    const zigVersion = requiredZigVersion(sourceRoot);
    const builtWasm = buildGhostty(sourceRoot, zigVersion);
    const wasmSha256 = sha256(builtWasm);

    if (mode === "verify") {
      if (zigVersion !== current.zigVersion) {
        throw new Error(`Pinned Zig version mismatch: expected ${current.zigVersion}, got ${zigVersion}`);
      }
      if (wasmSha256 !== current.wasmSha256) {
        throw new Error(`Rebuilt Ghostty WASM hash mismatch: expected ${current.wasmSha256}, got ${wasmSha256}`);
      }
      console.log(`Verified Ghostty ${commit} with Zig ${zigVersion} (${wasmSha256})`);
      return;
    }

    const committedAt = command("git", ["show", "-s", "--format=%cI", "HEAD"], {
      cwd: sourceRoot,
      capture: true,
    });
    const next = {
      schemaVersion: 1,
      repository: current.repository,
      commit,
      committedAt,
      zigVersion,
      buildOptions,
      wasmSha256,
    };
    cpSync(builtWasm, wasmPath);
    writeFileSync(manifestPath, `${JSON.stringify(next, null, 2)}\n`);
    writeFileSync(upstreamSourcePath, renderUpstreamSource(next));
    console.log(`Updated Ghostty to ${commit} with Zig ${zigVersion} (${wasmSha256})`);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

main();
