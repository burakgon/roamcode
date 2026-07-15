import { createHash, createPublicKey, verify as verifySignature } from "node:crypto";
import { createRequire } from "node:module";
import { access, mkdir, open, opendir, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";
import { validateAdapterManifest, type AdapterManifestV1 } from "./providers/adapter-contract.js";

const require = createRequire(import.meta.url);
const MAX_PACKAGE_FILES = 512;
const MAX_PACKAGE_BYTES = 20 * 1024 * 1024;

export type ExtensionKind = "adapter" | "plugin";
export type ExtensionTrust = "signed" | "integrity";

export class ExtensionError extends Error {
  constructor(
    readonly code:
      | "EXTENSION_INVALID"
      | "EXTENSION_OUTSIDE_ROOT"
      | "EXTENSION_INTEGRITY_MISMATCH"
      | "EXTENSION_SIGNATURE_INVALID"
      | "EXTENSION_NOT_FOUND"
      | "EXTENSION_VERSION_NOT_FOUND"
      | "EXTENSION_ROLLBACK_UNAVAILABLE"
      | "EXTENSION_IN_USE"
      | "EXTENSION_PERMISSION_DENIED",
    message: string,
    readonly statusCode = 400,
  ) {
    super(message);
    this.name = "ExtensionError";
  }
}

const pluginPermissionSchema = z.enum([
  "notifications:write",
  "worktrees:write",
  "ci:read",
  "releases:read",
  "events:read",
  "events:write",
]);

const pluginActionSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
    title: z.string().trim().min(1).max(80),
    description: z.string().trim().max(240).optional(),
    entrypoint: z.string().min(1).max(240),
    args: z.array(z.string().max(1024)).max(64).default([]),
    cwd: z.enum(["host", "workspace", "explicit"]).default("workspace"),
    timeoutMs: z.number().int().min(100).max(30_000).default(10_000),
    maxOutputBytes: z
      .number()
      .int()
      .min(1024)
      .max(256 * 1024)
      .default(64 * 1024),
    permissions: z.array(pluginPermissionSchema).max(16).default([]),
  })
  .strict();

const pluginManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("plugin"),
    id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
    version: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/),
    displayName: z.string().trim().min(1).max(80),
    description: z.string().trim().min(1).max(500),
    platforms: z
      .array(z.enum(["darwin", "linux"]))
      .min(1)
      .max(2),
    minimumRoamCodeVersion: z
      .string()
      .regex(/^\d+\.\d+\.\d+$/)
      .optional(),
    permissions: z.array(pluginPermissionSchema).max(16),
    actions: z.array(pluginActionSchema).max(32),
    eventHooks: z
      .array(
        z
          .object({ event: z.string().regex(/^[a-z][a-z0-9_.-]{0,127}$/), actionId: z.string().min(1).max(64) })
          .strict(),
      )
      .max(32)
      .default([]),
    settingsSchema: z.record(z.string(), z.unknown()).default({ type: "object" }),
    ui: z
      .object({ label: z.string().trim().min(1).max(40), route: z.string().regex(/^\/[a-z0-9/_-]*$/) })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((manifest, context) => {
    const permissions = new Set(manifest.permissions);
    const actionIds = new Set<string>();
    for (const [index, action] of manifest.actions.entries()) {
      if (actionIds.has(action.id)) {
        context.addIssue({ code: "custom", path: ["actions", index, "id"], message: "action id must be unique" });
      }
      actionIds.add(action.id);
      for (const permission of action.permissions) {
        if (!permissions.has(permission)) {
          context.addIssue({
            code: "custom",
            path: ["actions", index, "permissions"],
            message: "action permission must be declared by the plugin",
          });
        }
      }
    }
    for (const [index, hook] of manifest.eventHooks.entries()) {
      if (!actionIds.has(hook.actionId)) {
        context.addIssue({ code: "custom", path: ["eventHooks", index], message: "hook action does not exist" });
      }
    }
  });

const adapterRuntimeSchema = z
  .object({
    executable: z.string().min(1).max(240),
    probeArgs: z.array(z.string().max(1024)).max(32).default(["--version"]),
    probeTimeoutMs: z.number().int().min(100).max(10_000).default(2_000),
    launchArgs: z.array(z.string().max(1024)).max(128),
    resumeArgs: z.array(z.string().max(1024)).max(128).optional(),
    env: z
      .array(z.enum(["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "SHELL"]))
      .max(6)
      .default(["PATH", "HOME"]),
    workingPatterns: z.array(z.string().max(200)).max(32).default([]),
    blockedPatterns: z.array(z.string().max(200)).max(32).default([]),
    idlePatterns: z.array(z.string().max(200)).max(32).default([]),
    identityPattern: z.string().max(200).optional(),
  })
  .strict();

const adapterPackageSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("adapter"),
    adapter: z.unknown(),
    runtime: adapterRuntimeSchema,
  })
  .strict();

export type PluginPermission = z.infer<typeof pluginPermissionSchema>;
export type PluginManifestV1 = z.infer<typeof pluginManifestSchema>;
export type AdapterRuntimeV1 = z.infer<typeof adapterRuntimeSchema>;
export interface AdapterPackageManifestV1 {
  schemaVersion: 1;
  kind: "adapter";
  adapter: AdapterManifestV1;
  runtime: AdapterRuntimeV1;
}
export type ExtensionManifestV1 = PluginManifestV1 | AdapterPackageManifestV1;

export interface ExtensionVersionRecord {
  kind: ExtensionKind;
  id: string;
  version: string;
  manifest: ExtensionManifestV1;
  integrity: string;
  trust: ExtensionTrust;
  signerFingerprint?: string;
  source: string;
  installedAt: number;
}

export interface InstalledExtension {
  kind: ExtensionKind;
  id: string;
  enabled: boolean;
  currentVersion: string;
  previousVersion?: string;
  updatedAt: number;
  approvedPermissions: string[];
  current: ExtensionVersionRecord;
  versions: ExtensionVersionRecord[];
}

export interface InstallExtensionInput {
  sourceDirectory: string;
  expectedIntegrity: string;
  signature?: string;
  publicKey?: string;
  source?: string;
  allowUnsigned?: boolean;
}

export interface ExtensionManager {
  readonly mode: "sqlite" | "memory-fallback";
  list(kind?: ExtensionKind): InstalledExtension[];
  get(kind: ExtensionKind, id: string): InstalledExtension | undefined;
  packagePath(kind: ExtensionKind, id: string, version?: string): string;
  verify(kind: ExtensionKind, id: string, version?: string): Promise<boolean>;
  install(input: InstallExtensionInput): Promise<InstalledExtension>;
  setEnabled(kind: ExtensionKind, id: string, enabled: boolean, approvedPermissions?: string[]): InstalledExtension;
  rollback(kind: ExtensionKind, id: string): InstalledExtension;
  uninstall(kind: ExtensionKind, id: string, options?: { purgeState?: boolean }): Promise<boolean>;
  close(): void;
}

export interface OpenExtensionManagerOptions {
  dbPath: string;
  packagesDir: string;
  fsRoot: string;
  now?: () => number;
  loadDatabase?: () => typeof import("better-sqlite3");
}

interface PackageSnapshot {
  manifest: ExtensionManifestV1;
  files: Array<{ path: string; bytes: Buffer; mode: number }>;
  integrity: string;
}

function inside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function safeRelativePath(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 512 &&
    !isAbsolute(value) &&
    !value.split(/[\\/]/).some((part) => part === "" || part === "." || part === "..") &&
    !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(value)
  );
}

function safeRuntimePattern(value: string): boolean {
  if (
    value.length > 200 ||
    /\(\?[=!<:]/.test(value) ||
    /\\[1-9]/.test(value) ||
    /\([^)]*[+*][^)]*\)[+*{]/.test(value)
  ) {
    return false;
  }
  try {
    void new RegExp(value, "u");
    return true;
  } catch {
    return false;
  }
}

function validateRuntimeArgs(args: readonly string[], resume: boolean): void {
  for (const arg of args) {
    if (arg.includes("\0")) throw new Error("runtime arguments must not contain null bytes");
    const placeholders = arg.match(/\{[^{}]*\}/g) ?? [];
    for (const placeholder of placeholders) {
      if (!/^\{(?:cwd|sessionId|intent|option:[A-Za-z][A-Za-z0-9_.-]{0,63})\}$/.test(placeholder)) {
        if (resume && placeholder === "{providerSessionId}") continue;
        throw new Error(`unsupported runtime argument placeholder: ${placeholder}`);
      }
    }
  }
}

function validateAdapterRuntime(adapter: AdapterManifestV1, runtime: AdapterRuntimeV1): void {
  if (!safeRelativePath(runtime.executable)) throw new Error("adapter executable must be a package-relative path");
  if (!adapter.capabilities.launch) throw new Error("installed adapters must declare launch capability");
  for (const capability of ["metadata", "usage", "login", "attachments"] as const) {
    if (adapter.capabilities[capability]) {
      throw new Error(`installed adapter runtime v1 does not implement ${capability} capability`);
    }
  }
  if (adapter.stateAuthority.includes("native-events")) {
    throw new Error("installed adapter runtime v1 does not implement native event authority");
  }
  validateRuntimeArgs(runtime.probeArgs, false);
  validateRuntimeArgs(runtime.launchArgs, false);
  if (runtime.resumeArgs) validateRuntimeArgs(runtime.resumeArgs, true);
  if (adapter.capabilities.resume !== Boolean(runtime.resumeArgs)) {
    throw new Error("resume capability and resumeArgs must agree");
  }
  if (adapter.capabilities.resume && !adapter.capabilities.identity) {
    throw new Error("resumable adapters must declare identity capability");
  }
  if (adapter.capabilities.resume && !runtime.resumeArgs?.some((arg) => arg.includes("{providerSessionId}"))) {
    throw new Error("resumeArgs must consume the exact provider session id");
  }
  const statePatterns = [...runtime.workingPatterns, ...runtime.blockedPatterns, ...runtime.idlePatterns];
  if (statePatterns.some((pattern) => !safeRuntimePattern(pattern))) {
    throw new Error("adapter state patterns must be bounded safe regular expressions");
  }
  if (adapter.capabilities.state !== statePatterns.length > 0) {
    throw new Error("state capability and state patterns must agree");
  }
  if (
    adapter.capabilities.state &&
    !adapter.stateAuthority.some((value) => value === "runtime-signals" || value === "pane-heuristics")
  ) {
    throw new Error("state-capable adapters require runtime signal or pane authority");
  }
  if (runtime.identityPattern !== undefined) {
    if (!safeRuntimePattern(runtime.identityPattern) || !/\((?!\?)/.test(runtime.identityPattern)) {
      throw new Error("identityPattern must be a bounded expression with one capture group");
    }
  }
  if (adapter.capabilities.identity !== Boolean(runtime.identityPattern)) {
    throw new Error("identity capability and identityPattern must agree");
  }
}

function parseManifest(value: unknown): ExtensionManifestV1 {
  const kind = typeof value === "object" && value !== null ? (value as { kind?: unknown }).kind : undefined;
  if (kind === "plugin") {
    const parsed = pluginManifestSchema.safeParse(value);
    if (!parsed.success)
      throw new ExtensionError("EXTENSION_INVALID", `invalid plugin manifest: ${parsed.error.message}`);
    return parsed.data;
  }
  if (kind === "adapter") {
    const parsed = adapterPackageSchema.safeParse(value);
    if (!parsed.success)
      throw new ExtensionError("EXTENSION_INVALID", `invalid adapter package: ${parsed.error.message}`);
    try {
      const adapter = validateAdapterManifest(parsed.data.adapter);
      validateAdapterRuntime(adapter, parsed.data.runtime);
      return { ...parsed.data, adapter };
    } catch (error) {
      throw new ExtensionError(
        "EXTENSION_INVALID",
        `invalid adapter package: ${error instanceof Error ? error.message : "runtime contract rejected"}`,
      );
    }
  }
  throw new ExtensionError("EXTENSION_INVALID", "extension kind must be adapter or plugin");
}

async function snapshotPackage(sourceDirectory: string, fsRoot: string): Promise<PackageSnapshot> {
  const root = await realpath(fsRoot);
  const source = await realpath(resolve(sourceDirectory)).catch(() => undefined);
  if (!source || !inside(root, source)) {
    throw new ExtensionError("EXTENSION_OUTSIDE_ROOT", "extension source is outside FS_ROOT", 403);
  }
  const rootStat = await stat(source);
  if (!rootStat.isDirectory()) throw new ExtensionError("EXTENSION_INVALID", "extension source must be a directory");
  const files: PackageSnapshot["files"] = [];
  let totalBytes = 0;
  const walk = async (directory: string, prefix = ""): Promise<void> => {
    const handle = await opendir(directory);
    try {
      for await (const entry of handle) {
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (!safeRelativePath(rel) || entry.isSymbolicLink()) {
          throw new ExtensionError("EXTENSION_INVALID", "extension paths must be safe regular files");
        }
        const absolute = join(directory, entry.name);
        if (entry.isDirectory()) {
          await walk(absolute, rel);
          continue;
        }
        if (!entry.isFile()) throw new ExtensionError("EXTENSION_INVALID", "extension contains a special file");
        const info = await stat(absolute);
        totalBytes += info.size;
        if (files.length >= MAX_PACKAGE_FILES || totalBytes > MAX_PACKAGE_BYTES) {
          throw new ExtensionError("EXTENSION_INVALID", "extension package exceeds file or byte limits");
        }
        files.push({ path: rel, bytes: await readFile(absolute), mode: info.mode & 0o111 ? 0o700 : 0o600 });
      }
    } finally {
      await handle.close().catch(() => undefined);
    }
  };
  await walk(source);
  files.sort((a, b) => a.path.localeCompare(b.path));
  const manifestFile = files.find((file) => file.path === "roamcode-extension.json");
  if (!manifestFile) throw new ExtensionError("EXTENSION_INVALID", "roamcode-extension.json is required");
  let rawManifest: unknown;
  try {
    rawManifest = JSON.parse(manifestFile.bytes.toString("utf8")) as unknown;
  } catch {
    throw new ExtensionError("EXTENSION_INVALID", "extension manifest is not valid JSON");
  }
  const manifest = parseManifest(rawManifest);
  const digest = createHash("sha256");
  for (const file of files) {
    digest.update(file.path, "utf8");
    digest.update("\0");
    digest.update(String(file.bytes.length), "utf8");
    digest.update("\0");
    digest.update(file.bytes);
  }
  return { manifest, files, integrity: `sha256-${digest.digest("base64")}` };
}

export async function inspectExtensionPackage(sourceDirectory: string, fsRoot: string) {
  const snapshot = await snapshotPackage(sourceDirectory, fsRoot);
  return { manifest: snapshot.manifest, integrity: snapshot.integrity };
}

function identity(manifest: ExtensionManifestV1): { kind: ExtensionKind; id: string; version: string } {
  return manifest.kind === "plugin"
    ? { kind: "plugin", id: manifest.id, version: manifest.version }
    : { kind: "adapter", id: manifest.adapter.id, version: manifest.adapter.version };
}

function signerFor(
  integrity: string,
  signature: string | undefined,
  publicKey: string | undefined,
): string | undefined {
  if (signature === undefined && publicKey === undefined) return undefined;
  if (!signature || !publicKey) {
    throw new ExtensionError("EXTENSION_SIGNATURE_INVALID", "signature and public key must be supplied together");
  }
  try {
    const key = createPublicKey(publicKey);
    const valid = verifySignature(null, Buffer.from(integrity, "utf8"), key, Buffer.from(signature, "base64"));
    if (!valid) throw new Error("invalid");
    return createHash("sha256")
      .update(key.export({ type: "spki", format: "der" }))
      .digest("hex");
  } catch {
    throw new ExtensionError("EXTENSION_SIGNATURE_INVALID", "extension signature is invalid", 403);
  }
}

async function materialize(snapshot: PackageSnapshot, target: string): Promise<void> {
  const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
  await rm(temporary, { recursive: true, force: true });
  try {
    for (const file of snapshot.files) {
      const output = join(temporary, ...file.path.split("/"));
      await mkdir(dirname(output), { recursive: true, mode: 0o700 });
      const handle = await open(output, "wx", file.mode);
      try {
        await handle.writeFile(file.bytes);
      } finally {
        await handle.close();
      }
    }
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await rename(temporary, target).catch(async (error: unknown) => {
      if ((error as { code?: string }).code !== "EEXIST" && (error as { code?: string }).code !== "ENOTEMPTY")
        throw error;
    });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

type StateRow = {
  kind: ExtensionKind;
  id: string;
  current_version: string;
  previous_version: string | null;
  enabled: number;
  permissions_json: string;
  updated_at: number;
};
type VersionRow = {
  kind: ExtensionKind;
  id: string;
  version: string;
  manifest_json: string;
  integrity: string;
  trust: ExtensionTrust;
  signer_fingerprint: string | null;
  source: string;
  installed_at: number;
};

function versionFromRow(row: VersionRow): ExtensionVersionRecord {
  return {
    kind: row.kind,
    id: row.id,
    version: row.version,
    manifest: parseManifest(JSON.parse(row.manifest_json) as unknown),
    integrity: row.integrity,
    trust: row.trust,
    ...(row.signer_fingerprint ? { signerFingerprint: row.signer_fingerprint } : {}),
    source: row.source,
    installedAt: row.installed_at,
  };
}

export function openExtensionManager(options: OpenExtensionManagerOptions): ExtensionManager {
  const now = options.now ?? Date.now;
  let Database: typeof import("better-sqlite3");
  let mode: ExtensionManager["mode"] = "sqlite";
  try {
    if (options.loadDatabase) Database = options.loadDatabase();
    else {
      const loaded = require("better-sqlite3") as { default?: typeof import("better-sqlite3") };
      Database = (loaded.default ?? loaded) as typeof import("better-sqlite3");
    }
  } catch {
    mode = "memory-fallback";
    const loaded = require("better-sqlite3") as { default?: typeof import("better-sqlite3") };
    Database = (loaded.default ?? loaded) as typeof import("better-sqlite3");
  }
  const db = new Database(mode === "sqlite" ? options.dbPath : ":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS extensions (
      kind TEXT NOT NULL, id TEXT NOT NULL, current_version TEXT NOT NULL, previous_version TEXT,
      enabled INTEGER NOT NULL, permissions_json TEXT NOT NULL DEFAULT '[]', updated_at INTEGER NOT NULL,
      PRIMARY KEY(kind, id)
    );
    CREATE TABLE IF NOT EXISTS extension_versions (
      kind TEXT NOT NULL, id TEXT NOT NULL, version TEXT NOT NULL, manifest_json TEXT NOT NULL,
      integrity TEXT NOT NULL, trust TEXT NOT NULL, signer_fingerprint TEXT, source TEXT NOT NULL,
      installed_at INTEGER NOT NULL, PRIMARY KEY(kind, id, version)
    );
  `);
  const stateList = db.prepare("SELECT * FROM extensions ORDER BY kind, id");
  const stateGet = db.prepare("SELECT * FROM extensions WHERE kind = ? AND id = ?");
  const versionList = db.prepare(
    "SELECT * FROM extension_versions WHERE kind = ? AND id = ? ORDER BY installed_at DESC, version DESC",
  );
  const versionGet = db.prepare("SELECT * FROM extension_versions WHERE kind = ? AND id = ? AND version = ?");
  const versionInsert = db.prepare(`
    INSERT INTO extension_versions
      (kind,id,version,manifest_json,integrity,trust,signer_fingerprint,source,installed_at)
    VALUES (@kind,@id,@version,@manifest_json,@integrity,@trust,@signer_fingerprint,@source,@installed_at)
    ON CONFLICT(kind,id,version) DO UPDATE SET
      manifest_json=excluded.manifest_json, integrity=excluded.integrity, trust=excluded.trust,
      signer_fingerprint=excluded.signer_fingerprint, source=excluded.source
  `);
  const stateInsert = db.prepare(`
    INSERT INTO extensions (kind,id,current_version,previous_version,enabled,permissions_json,updated_at)
    VALUES (@kind,@id,@current_version,@previous_version,@enabled,@permissions_json,@updated_at)
    ON CONFLICT(kind,id) DO UPDATE SET previous_version=extensions.current_version,
      current_version=excluded.current_version, enabled=excluded.enabled, updated_at=excluded.updated_at
  `);
  const stateEnable = db.prepare(
    "UPDATE extensions SET enabled = ?, permissions_json = ?, updated_at = ? WHERE kind = ? AND id = ?",
  );
  const stateSwitch = db.prepare(
    "UPDATE extensions SET current_version = ?, previous_version = ?, updated_at = ? WHERE kind = ? AND id = ?",
  );
  const stateDelete = db.prepare("DELETE FROM extensions WHERE kind = ? AND id = ?");
  const versionDelete = db.prepare("DELETE FROM extension_versions WHERE kind = ? AND id = ?");

  const manager: ExtensionManager = {
    mode,
    list(kind) {
      return (stateList.all() as StateRow[])
        .filter((row) => kind === undefined || row.kind === kind)
        .map((row) => manager.get(row.kind, row.id)!)
        .filter(Boolean);
    },
    get(kind, id) {
      const state = stateGet.get(kind, id) as StateRow | undefined;
      if (!state) return undefined;
      const versions = (versionList.all(kind, id) as VersionRow[]).map(versionFromRow);
      const current = versions.find((version) => version.version === state.current_version);
      if (!current) return undefined;
      return {
        kind,
        id,
        enabled: state.enabled === 1,
        currentVersion: state.current_version,
        ...(state.previous_version ? { previousVersion: state.previous_version } : {}),
        updatedAt: state.updated_at,
        approvedPermissions: (() => {
          try {
            const parsed = JSON.parse(state.permissions_json) as unknown;
            return Array.isArray(parsed) && parsed.every((permission) => typeof permission === "string") ? parsed : [];
          } catch {
            return [];
          }
        })(),
        current,
        versions,
      };
    },
    packagePath(kind, id, version) {
      const selected = version ?? manager.get(kind, id)?.currentVersion;
      if (!selected || !versionGet.get(kind, id, selected)) {
        throw new ExtensionError("EXTENSION_VERSION_NOT_FOUND", "extension version not found", 404);
      }
      return join(options.packagesDir, kind, id, selected);
    },
    async verify(kind, id, version) {
      const selected = version ?? manager.get(kind, id)?.currentVersion;
      if (!selected) return false;
      const record = versionGet.get(kind, id, selected) as VersionRow | undefined;
      if (!record) return false;
      try {
        const snapshot = await snapshotPackage(join(options.packagesDir, kind, id, selected), options.packagesDir);
        const packageIdentity = identity(snapshot.manifest);
        return (
          snapshot.integrity === record.integrity &&
          packageIdentity.kind === kind &&
          packageIdentity.id === id &&
          packageIdentity.version === selected
        );
      } catch {
        return false;
      }
    },
    async install(input) {
      if (!/^sha256-[A-Za-z0-9+/]{43}=$/.test(input.expectedIntegrity)) {
        throw new ExtensionError("EXTENSION_INVALID", "expectedIntegrity must be a sha256 SRI value");
      }
      const snapshot = await snapshotPackage(input.sourceDirectory, options.fsRoot);
      if (snapshot.integrity !== input.expectedIntegrity) {
        throw new ExtensionError("EXTENSION_INTEGRITY_MISMATCH", "extension package integrity does not match", 409);
      }
      const signerFingerprint = signerFor(snapshot.integrity, input.signature, input.publicKey);
      const { kind, id, version } = identity(snapshot.manifest);
      if (kind === "adapter" && (id === "claude" || id === "codex")) {
        throw new ExtensionError("EXTENSION_INVALID", "built-in adapter ids cannot be replaced", 409);
      }
      if (!signerFingerprint && input.allowUnsigned !== true) {
        throw new ExtensionError(
          "EXTENSION_SIGNATURE_INVALID",
          "a verified signature or explicit allowUnsigned is required",
          403,
        );
      }
      const target = join(options.packagesDir, kind, id, version);
      const existing = versionGet.get(kind, id, version) as VersionRow | undefined;
      if (existing && existing.integrity !== snapshot.integrity) {
        throw new ExtensionError("EXTENSION_INTEGRITY_MISMATCH", "published version bytes cannot be replaced", 409);
      }
      const targetExists = await access(target)
        .then(() => true)
        .catch(() => false);
      if (targetExists) {
        if (!existing || !(await manager.verify(kind, id, version))) {
          throw new ExtensionError(
            "EXTENSION_INTEGRITY_MISMATCH",
            "installed extension bytes do not match the verified version",
            409,
          );
        }
      } else {
        await materialize(snapshot, target);
      }
      const at = now();
      const source = (input.source ?? "local").trim().slice(0, 500) || "local";
      const installTx = db.transaction(() => {
        versionInsert.run({
          kind,
          id,
          version,
          manifest_json: JSON.stringify(snapshot.manifest),
          integrity: snapshot.integrity,
          trust: signerFingerprint ? "signed" : "integrity",
          signer_fingerprint: signerFingerprint ?? null,
          source,
          installed_at: at,
        });
        const current = stateGet.get(kind, id) as StateRow | undefined;
        stateInsert.run({
          kind,
          id,
          current_version: version,
          previous_version: current?.current_version ?? null,
          enabled: current?.enabled ?? 0,
          permissions_json: current?.permissions_json ?? "[]",
          updated_at: at,
        });
      });
      installTx();
      return manager.get(kind, id)!;
    },
    setEnabled(kind, id, enabled, approvedPermissions) {
      const current = manager.get(kind, id);
      if (!current) throw new ExtensionError("EXTENSION_NOT_FOUND", "extension not found", 404);
      const approved = [...new Set(approvedPermissions ?? current.approvedPermissions)].sort();
      if (enabled && current.current.manifest.kind === "plugin") {
        const missing = current.current.manifest.permissions.filter((permission) => !approved.includes(permission));
        if (missing.length > 0) {
          throw new ExtensionError(
            "EXTENSION_PERMISSION_DENIED",
            `explicit approval is required for: ${missing.join(", ")}`,
            403,
          );
        }
      }
      stateEnable.run(enabled ? 1 : 0, JSON.stringify(approved), now(), kind, id);
      return manager.get(kind, id)!;
    },
    rollback(kind, id) {
      const current = manager.get(kind, id);
      if (!current) throw new ExtensionError("EXTENSION_NOT_FOUND", "extension not found", 404);
      if (!current.previousVersion || !versionGet.get(kind, id, current.previousVersion)) {
        throw new ExtensionError("EXTENSION_ROLLBACK_UNAVAILABLE", "no verified previous version is available", 409);
      }
      stateSwitch.run(current.previousVersion, current.currentVersion, now(), kind, id);
      return manager.get(kind, id)!;
    },
    async uninstall(kind, id, uninstallOptions = {}) {
      const current = manager.get(kind, id);
      if (!current) return false;
      if (current.enabled)
        throw new ExtensionError("EXTENSION_IN_USE", "disable the extension before uninstalling", 409);
      const removeTx = db.transaction(() => {
        stateDelete.run(kind, id);
        versionDelete.run(kind, id);
      });
      removeTx();
      await rm(join(options.packagesDir, kind, id), { recursive: true, force: true });
      if (uninstallOptions.purgeState)
        await rm(join(options.packagesDir, "state", kind, id), { recursive: true, force: true });
      return true;
    },
    close() {
      db.close();
    },
  };
  return manager;
}

export interface MarketplaceEntry {
  kind: ExtensionKind;
  id: string;
  version: string;
  displayName: string;
  description: string;
  trust: "verified" | "community" | "local";
  compatibility: { platforms: Array<"darwin" | "linux">; minimumRoamCodeVersion?: string };
  changelog?: string;
  source: string;
  integrity: string;
  signerFingerprint?: string;
  reportUrl?: string;
}

const marketplaceEntrySchema = z
  .object({
    kind: z.enum(["adapter", "plugin"]),
    id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
    version: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/),
    displayName: z.string().trim().min(1).max(80),
    description: z.string().trim().min(1).max(500),
    trust: z.enum(["verified", "community", "local"]),
    compatibility: z
      .object({
        platforms: z
          .array(z.enum(["darwin", "linux"]))
          .min(1)
          .max(2),
        minimumRoamCodeVersion: z
          .string()
          .regex(/^\d+\.\d+\.\d+$/)
          .optional(),
      })
      .strict(),
    changelog: z.string().max(4000).optional(),
    source: z.string().min(1).max(500),
    integrity: z.string().regex(/^sha256-[A-Za-z0-9+/]{43}=$/),
    signerFingerprint: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    reportUrl: z.string().url().optional(),
  })
  .strict();

export function parseMarketplaceIndex(value: unknown): MarketplaceEntry[] {
  const parsed = z.array(marketplaceEntrySchema).max(10_000).safeParse(value);
  if (!parsed.success)
    throw new ExtensionError("EXTENSION_INVALID", `invalid marketplace index: ${parsed.error.message}`);
  const seen = new Set<string>();
  return parsed.data
    .filter((entry) => {
      const key = `${entry.kind}:${entry.id}:${entry.version}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.displayName.localeCompare(b.displayName) || b.version.localeCompare(a.version));
}

export function searchMarketplace(entries: MarketplaceEntry[], query: string, platform = process.platform) {
  const needle = query.trim().toLocaleLowerCase("en-US");
  return entries
    .filter((entry) => entry.compatibility.platforms.includes(platform as "darwin" | "linux"))
    .map((entry) => {
      const name = entry.displayName.toLocaleLowerCase("en-US");
      const id = entry.id.toLocaleLowerCase("en-US");
      const description = entry.description.toLocaleLowerCase("en-US");
      const score = !needle
        ? 1
        : name === needle
          ? 300
          : name.startsWith(needle)
            ? 220
            : id.includes(needle)
              ? 160
              : description.includes(needle)
                ? 100
                : 0;
      return { entry, score };
    })
    .filter((result) => result.score > 0)
    .sort((a, b) => b.score - a.score || a.entry.displayName.localeCompare(b.entry.displayName))
    .map((result) => result.entry);
}
