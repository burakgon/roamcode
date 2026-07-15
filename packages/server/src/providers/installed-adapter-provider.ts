import { spawn } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve } from "node:path";
import type { AdapterPackageManifestV1, AdapterRuntimeV1, ExtensionManager } from "../extension-manager.js";
import { defineAdapterManifest } from "./adapter-contract.js";
import {
  ProviderError,
  type ProviderAdapterV1,
  type ProviderProcessContext,
  type ProviderRuntimeSignal,
} from "./types.js";

export interface CreateInstalledAdapterProviderOptions {
  extensions: ExtensionManager;
  adapterId: string;
  env?: NodeJS.ProcessEnv;
}

function inside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function safePackagePath(value: string): boolean {
  return (
    value.length > 0 &&
    !isAbsolute(value) &&
    !value.split(/[\\/]/).some((part) => part === "" || part === "." || part === "..") &&
    !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(value)
  );
}

function safePattern(pattern: string): RegExp {
  if (
    pattern.length > 200 ||
    /\(\?[=!<:]/.test(pattern) ||
    /\\[1-9]/.test(pattern) ||
    /\([^)]*[+*][^)]*\)[+*{]/.test(pattern)
  ) {
    throw new ProviderError("PROVIDER_UNAVAILABLE", "installed adapter contains an unsafe state pattern");
  }
  try {
    return new RegExp(pattern, "u");
  } catch {
    throw new ProviderError("PROVIDER_UNAVAILABLE", "installed adapter contains an invalid state pattern");
  }
}

function processEnvironment(runtime: AdapterRuntimeV1, source: NodeJS.ProcessEnv, context?: ProviderProcessContext) {
  const env: NodeJS.ProcessEnv = {};
  for (const key of runtime.env) if (source[key] !== undefined) env[key] = source[key];
  if (context) {
    env.ROAMCODE_ADAPTER_ID = context.options.provider;
    env.ROAMCODE_SESSION_ID = context.roamSessionId;
    env.ROAMCODE_LAUNCH_INTENT = context.intent;
  }
  return env;
}

function scalar(value: unknown, label: string): string {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  throw new ProviderError("INVALID_PROVIDER_OPTIONS", `adapter template requires scalar option ${label}`);
}

function expandArgs(template: readonly string[], context: ProviderProcessContext): string[] {
  const fixed: Record<string, string | undefined> = {
    cwd: context.cwd,
    sessionId: context.roamSessionId,
    providerSessionId: context.providerSessionId,
    intent: context.intent,
  };
  const output: string[] = [];
  for (const entry of template) {
    const exactOption = /^\{option:([A-Za-z][A-Za-z0-9_.-]{0,63})\}$/.exec(entry);
    if (exactOption) {
      const value = context.options[exactOption[1]!];
      if (value === undefined) continue;
      if (Array.isArray(value)) {
        for (const item of value) output.push(scalar(item, exactOption[1]!));
      } else output.push(scalar(value, exactOption[1]!));
      continue;
    }
    const expanded = entry.replace(
      /\{(cwd|sessionId|providerSessionId|intent|option:[A-Za-z][A-Za-z0-9_.-]{0,63})\}/g,
      (_match, key: string) => {
        if (key.startsWith("option:")) return scalar(context.options[key.slice(7)], key.slice(7));
        const value = fixed[key];
        if (value === undefined) {
          throw new ProviderError("RESUME_IDENTITY_UNAVAILABLE", `adapter template requires ${key}`);
        }
        return value;
      },
    );
    if (Buffer.byteLength(expanded, "utf8") > 4096 || expanded.includes("\0")) {
      throw new ProviderError("INVALID_PROVIDER_OPTIONS", "expanded adapter argument is unsafe");
    }
    output.push(expanded);
  }
  if (output.length > 256) throw new ProviderError("INVALID_PROVIDER_OPTIONS", "adapter arguments exceed limit");
  return output;
}

async function resolvedExecutable(
  options: CreateInstalledAdapterProviderOptions,
  manifest: AdapterPackageManifestV1,
): Promise<{ executable: string; scriptArgs: string[] }> {
  if (!(await options.extensions.verify("adapter", options.adapterId))) {
    throw new ProviderError("PROVIDER_UNAVAILABLE", "installed adapter integrity verification failed");
  }
  if (!safePackagePath(manifest.runtime.executable)) {
    throw new ProviderError("PROVIDER_UNAVAILABLE", "installed adapter executable path is invalid");
  }
  const packageRoot = await realpath(options.extensions.packagePath("adapter", options.adapterId));
  const entrypoint = await realpath(resolve(packageRoot, manifest.runtime.executable)).catch(() => undefined);
  if (!entrypoint || !inside(packageRoot, entrypoint) || !(await stat(entrypoint)).isFile()) {
    throw new ProviderError("PROVIDER_UNAVAILABLE", "installed adapter executable is outside its package");
  }
  return [".js", ".mjs", ".cjs"].includes(extname(entrypoint))
    ? { executable: process.execPath, scriptArgs: [entrypoint] }
    : { executable: entrypoint, scriptArgs: [] };
}

async function probeProcess(executable: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number) {
  return new Promise<boolean>((resolveProbe) => {
    const child = spawn(executable, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let bytes = 0;
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!ok) child.kill("SIGKILL");
      resolveProbe(ok);
    };
    const onData = (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 64 * 1024) finish(false);
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.once("error", () => finish(false));
    child.once("close", (code) => finish(code === 0));
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref?.();
  });
}

export function createInstalledAdapterProvider(options: CreateInstalledAdapterProviderOptions): ProviderAdapterV1 {
  const installed = options.extensions.get("adapter", options.adapterId);
  if (!installed || installed.current.manifest.kind !== "adapter") {
    throw new ProviderError("PROVIDER_UNAVAILABLE", "installed adapter package was not found");
  }
  const packageManifest = installed.current.manifest;
  const manifest = defineAdapterManifest(packageManifest.adapter);
  const runtime = packageManifest.runtime;
  const working = runtime.workingPatterns.map(safePattern);
  const blocked = runtime.blockedPatterns.map(safePattern);
  const idle = runtime.idlePatterns.map(safePattern);
  const identity = runtime.identityPattern ? safePattern(runtime.identityPattern) : undefined;
  const signalsFor = (value: string): ProviderRuntimeSignal[] => {
    const signals: ProviderRuntimeSignal[] = [];
    const identityMatch = manifest.capabilities.identity ? identity?.exec(value) : undefined;
    if (identityMatch?.[1]) signals.push({ type: "provider-session-id", id: identityMatch[1].slice(0, 2048) });
    if (manifest.capabilities.state) {
      if (blocked.some((pattern) => pattern.test(value))) signals.push({ type: "blocked" });
      else if (working.some((pattern) => pattern.test(value))) signals.push({ type: "working" });
      else if (idle.some((pattern) => pattern.test(value))) signals.push({ type: "idle" });
    }
    return signals;
  };
  return {
    manifest,
    id: manifest.id,
    displayName: manifest.displayName,
    resumeIdentity: manifest.resumeIdentity,
    async probe() {
      try {
        if (
          !manifest.capabilities.probe ||
          !options.extensions.get("adapter", options.adapterId)?.enabled ||
          !manifest.platforms.includes(process.platform as "darwin" | "linux")
        ) {
          return { terminalAvailable: false, metadataAvailable: false, detail: "adapter disabled or incompatible" };
        }
        const resolved = await resolvedExecutable(options, packageManifest);
        const available = await probeProcess(
          resolved.executable,
          [...resolved.scriptArgs, ...runtime.probeArgs],
          processEnvironment(runtime, options.env ?? process.env),
          runtime.probeTimeoutMs,
        );
        return { terminalAvailable: available, metadataAvailable: false, version: manifest.version };
      } catch {
        return { terminalAvailable: false, metadataAvailable: false };
      }
    },
    async buildProcess(context) {
      if (!manifest.capabilities.launch) {
        throw new ProviderError("PROVIDER_UNAVAILABLE", "installed adapter does not declare launch capability");
      }
      if (context.options.provider !== manifest.id) {
        throw new ProviderError("INVALID_PROVIDER_OPTIONS", "installed adapter received another provider's options");
      }
      if (context.intent === "resume" && (!manifest.capabilities.resume || manifest.resumeIdentity === "unsupported")) {
        throw new ProviderError("RESUME_IDENTITY_UNAVAILABLE", "installed adapter does not support resume");
      }
      const template = context.intent === "resume" ? runtime.resumeArgs : runtime.launchArgs;
      if (!template) throw new ProviderError("RESUME_IDENTITY_UNAVAILABLE", "adapter has no resume argument contract");
      const resolved = await resolvedExecutable(options, packageManifest);
      return {
        executable: resolved.executable,
        args: [...resolved.scriptArgs, ...expandArgs(template, context)],
        env: processEnvironment(runtime, options.env ?? process.env, context),
        cleanupPaths: [],
        integration: {
          attachments: "degraded",
          activity: manifest.capabilities.state ? "ready" : "degraded",
          ...(!manifest.capabilities.attachments
            ? { detail: "adapter does not provide RoamCode attachment bridging" }
            : {}),
        },
      };
    },
    createRuntimeSignalParser() {
      let buffer = "";
      let lastState: ProviderRuntimeSignal["type"] | undefined;
      let lastIdentity: string | undefined;
      return {
        push(chunk) {
          buffer = `${buffer}${chunk}`.slice(-4096);
          return signalsFor(buffer).filter((signal) => {
            if (signal.type === "provider-session-id") {
              if (signal.id === lastIdentity) return false;
              lastIdentity = signal.id;
              return true;
            }
            if (signal.type === lastState) return false;
            lastState = signal.type;
            return true;
          });
        },
      };
    },
    runtimeSignals: signalsFor,
    classifyPane(pane) {
      if (!manifest.capabilities.state) return "idle";
      if (blocked.some((pattern) => pattern.test(pane))) return "blocked";
      if (working.some((pattern) => pattern.test(pane))) return "working";
      return "idle";
    },
    cleanup() {},
  };
}
