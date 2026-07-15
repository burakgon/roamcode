import { spawn } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve } from "node:path";
import type { ExtensionManager, PluginManifestV1 } from "./extension-manager.js";

export class PluginRuntimeError extends Error {
  constructor(
    readonly code:
      | "PLUGIN_NOT_FOUND"
      | "PLUGIN_DISABLED"
      | "PLUGIN_ACTION_NOT_FOUND"
      | "PLUGIN_PERMISSION_DENIED"
      | "PLUGIN_PATH_DENIED"
      | "PLUGIN_OUTPUT_LIMIT"
      | "PLUGIN_TIMEOUT"
      | "PLUGIN_FAILED",
    message: string,
    readonly statusCode = 400,
  ) {
    super(message);
    this.name = "PluginRuntimeError";
  }
}

export interface PluginRunInput {
  pluginId: string;
  actionId: string;
  workspacePath?: string;
  explicitCwd?: string;
  context?: Record<string, unknown>;
}

export interface PluginRunResult {
  pluginId: string;
  pluginVersion: string;
  actionId: string;
  status: "succeeded" | "failed";
  exitCode: number;
  stdout: string;
  stderr: string;
  startedAt: number;
  finishedAt: number;
  truncated: false;
}

export interface PluginAuditEvent {
  pluginId: string;
  pluginVersion: string;
  actionId: string;
  phase: "started" | "finished";
  result?: "succeeded" | "failed";
  exitCode?: number;
  durationMs?: number;
}

export interface CreatePluginRuntimeOptions {
  extensions: ExtensionManager;
  fsRoot: string;
  now?: () => number;
  audit?: (event: PluginAuditEvent) => void;
}

export interface PluginRuntime {
  run(input: PluginRunInput): Promise<PluginRunResult>;
  hooksFor(eventType: string): Array<{ pluginId: string; actionId: string }>;
}

function inside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function safeEntrypoint(value: string): boolean {
  return (
    value.length > 0 &&
    !isAbsolute(value) &&
    !value.split(/[\\/]/).some((part) => part === "" || part === "." || part === "..") &&
    !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(value)
  );
}

export function createPluginRuntime(options: CreatePluginRuntimeOptions): PluginRuntime {
  const now = options.now ?? Date.now;
  let rootPromise: Promise<string> | undefined;
  const root = () => (rootPromise ??= realpath(resolve(options.fsRoot)));

  return {
    hooksFor(eventType) {
      return options.extensions
        .list("plugin")
        .filter((extension) => extension.enabled && extension.current.manifest.kind === "plugin")
        .flatMap((extension) => {
          const manifest = extension.current.manifest as PluginManifestV1;
          return manifest.eventHooks
            .filter((hook) => hook.event === eventType)
            .map((hook) => ({ pluginId: extension.id, actionId: hook.actionId }));
        })
        .sort((a, b) => a.pluginId.localeCompare(b.pluginId) || a.actionId.localeCompare(b.actionId));
    },
    async run(input) {
      const extension = options.extensions.get("plugin", input.pluginId);
      if (!extension || extension.current.manifest.kind !== "plugin") {
        throw new PluginRuntimeError("PLUGIN_NOT_FOUND", "plugin not found", 404);
      }
      if (!extension.enabled) throw new PluginRuntimeError("PLUGIN_DISABLED", "plugin is disabled", 409);
      if (!(await options.extensions.verify("plugin", extension.id, extension.currentVersion))) {
        throw new PluginRuntimeError("PLUGIN_PATH_DENIED", "plugin package integrity verification failed", 409);
      }
      const manifest = extension.current.manifest;
      const action = manifest.actions.find((candidate) => candidate.id === input.actionId);
      if (!action) throw new PluginRuntimeError("PLUGIN_ACTION_NOT_FOUND", "plugin action not found", 404);
      const missing = action.permissions.filter((permission) => !extension.approvedPermissions.includes(permission));
      if (missing.length > 0) {
        throw new PluginRuntimeError("PLUGIN_PERMISSION_DENIED", "plugin action permission was not approved", 403);
      }
      if (!safeEntrypoint(action.entrypoint)) {
        throw new PluginRuntimeError("PLUGIN_PATH_DENIED", "plugin entrypoint is invalid", 403);
      }
      const packageRoot = await realpath(options.extensions.packagePath("plugin", extension.id));
      const entrypoint = await realpath(resolve(packageRoot, action.entrypoint)).catch(() => undefined);
      if (!entrypoint || !inside(packageRoot, entrypoint) || !(await stat(entrypoint)).isFile()) {
        throw new PluginRuntimeError("PLUGIN_PATH_DENIED", "plugin entrypoint is outside its package", 403);
      }
      let cwd: string;
      if (action.cwd === "host") cwd = await root();
      else if (action.cwd === "workspace") {
        if (!input.workspacePath) throw new PluginRuntimeError("PLUGIN_PATH_DENIED", "workspace path is required");
        cwd = await realpath(resolve(input.workspacePath)).catch(() => "");
      } else {
        if (!input.explicitCwd) throw new PluginRuntimeError("PLUGIN_PATH_DENIED", "explicit cwd is required");
        cwd = await realpath(resolve(input.explicitCwd)).catch(() => "");
      }
      if (!cwd || !inside(await root(), cwd) || !(await stat(cwd)).isDirectory()) {
        throw new PluginRuntimeError("PLUGIN_PATH_DENIED", "plugin cwd is outside FS_ROOT", 403);
      }
      const context = JSON.stringify(input.context ?? {});
      if (Buffer.byteLength(context, "utf8") > 16 * 1024) {
        throw new PluginRuntimeError("PLUGIN_FAILED", "plugin context exceeds 16 KiB");
      }
      const executable = [".js", ".mjs", ".cjs"].includes(extname(entrypoint)) ? process.execPath : entrypoint;
      const args = executable === process.execPath ? [entrypoint, ...action.args] : [...action.args];
      const env: NodeJS.ProcessEnv = {
        ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
        LANG: "C",
        LC_ALL: "C",
        ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
        ROAMCODE_PLUGIN_ID: extension.id,
        ROAMCODE_PLUGIN_VERSION: extension.currentVersion,
        ROAMCODE_PLUGIN_ACTION: action.id,
      };
      const startedAt = now();
      options.audit?.({
        pluginId: extension.id,
        pluginVersion: extension.currentVersion,
        actionId: action.id,
        phase: "started",
      });
      return new Promise<PluginRunResult>((resolveRun, reject) => {
        const child = spawn(executable, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
        let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
        let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
        let settled = false;
        const finishAudit = (result: "succeeded" | "failed", exitCode?: number) => {
          options.audit?.({
            pluginId: extension.id,
            pluginVersion: extension.currentVersion,
            actionId: action.id,
            phase: "finished",
            result,
            ...(exitCode === undefined ? {} : { exitCode }),
            durationMs: Math.max(0, now() - startedAt),
          });
        };
        const fail = (error: PluginRuntimeError) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          child.kill("SIGKILL");
          finishAudit("failed");
          reject(error);
        };
        const timer = setTimeout(
          () => fail(new PluginRuntimeError("PLUGIN_TIMEOUT", "plugin action timed out", 504)),
          action.timeoutMs,
        );
        timer.unref?.();
        const append = (current: Buffer<ArrayBufferLike>, chunk: Buffer<ArrayBufferLike>) => {
          if (current.length + chunk.length > action.maxOutputBytes) {
            fail(new PluginRuntimeError("PLUGIN_OUTPUT_LIMIT", "plugin output exceeded its declared limit", 413));
            return current;
          }
          return Buffer.concat([current, chunk]);
        };
        child.stdout.on("data", (chunk: Buffer) => {
          stdout = append(stdout, chunk);
        });
        child.stderr.on("data", (chunk: Buffer) => {
          stderr = append(stderr, chunk);
        });
        child.once("error", () => fail(new PluginRuntimeError("PLUGIN_FAILED", "plugin process could not start")));
        child.once("close", (code) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          const exitCode = code ?? -1;
          const finishedAt = now();
          const status = exitCode === 0 ? "succeeded" : "failed";
          finishAudit(status, exitCode);
          resolveRun({
            pluginId: extension.id,
            pluginVersion: extension.currentVersion,
            actionId: action.id,
            status,
            exitCode,
            stdout: stdout.toString("utf8"),
            stderr: stderr.toString("utf8"),
            startedAt,
            finishedAt,
            truncated: false,
          });
        });
        child.stdin.end(context);
      });
    },
  };
}
