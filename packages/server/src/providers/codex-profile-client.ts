import type { ZodType } from "zod";
import {
  CodexAppServerClient,
  type CodexAppServerClientOptions,
  type SpawnCodexAppServerTransport,
} from "./codex-app-server-client.js";
import { ProviderError } from "./types.js";

const lifecycles = new WeakSet<object>();

export interface CodexProfileClientLifecycle {
  readConfig<T>(profile: string, codexHome: string, cwd: string, schema: ZodType<T>): Promise<T>;
}

export interface CreateCodexProfileClientLifecycleOptions {
  readonly codexBin: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly spawnTransport?: SpawnCodexAppServerTransport;
  readonly timeoutMs?: number;
}

function unavailable(): ProviderError {
  return new ProviderError("OSS_PROVIDER_DEFERRED", "Codex profile capability proof is unavailable");
}

function brand(lifecycle: CodexProfileClientLifecycle): CodexProfileClientLifecycle {
  lifecycles.add(lifecycle);
  return lifecycle;
}

/** Required selected-profile lifecycle. It owns Task 6 client construction, canonical env, start, and stop. */
export function createCodexProfileClientLifecycle(
  options: CreateCodexProfileClientLifecycleOptions,
): CodexProfileClientLifecycle {
  return brand({
    async readConfig<T>(profile: string, codexHome: string, cwd: string, schema: ZodType<T>): Promise<T> {
      const clientOptions: CodexAppServerClientOptions = {
        codexBin: options.codexBin,
        profile,
        env: { ...(options.env ?? process.env), CODEX_HOME: codexHome },
        ...(options.spawnTransport ? { spawnTransport: options.spawnTransport } : {}),
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      };
      const client = new CodexAppServerClient(clientOptions);
      let result: T | undefined;
      let failed = false;
      try {
        await client.start();
        result = await client.request("config/read", { cwd, includeLayers: false }, schema);
      } catch {
        failed = true;
      }
      try {
        await client.stop();
      } catch {
        failed = true;
      }
      if (failed || result === undefined) throw unavailable();
      return result;
    },
  });
}

/** Isolated protocol seam for service tests; unavailable outside the test process. */
export function createCodexProfileClientLifecycleForTests(
  readConfig: CodexProfileClientLifecycle["readConfig"],
): CodexProfileClientLifecycle {
  if (process.env.NODE_ENV !== "test") throw unavailable();
  return brand({ readConfig });
}

export function isCodexProfileClientLifecycle(value: unknown): value is CodexProfileClientLifecycle {
  return typeof value === "object" && value !== null && lifecycles.has(value);
}
