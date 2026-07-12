import { EventEmitter } from "node:events";
import { z } from "zod";
import { describe, expect, it, vi } from "vitest";
import type {
  CodexAppServerTransport,
  SpawnCodexAppServerTransport,
} from "../../src/providers/codex-app-server-client.js";
import { createCodexProfileClientLifecycle } from "../../src/providers/codex-profile-client.js";

class Writable extends EventEmitter {
  readonly writes: string[] = [];
  write(value: string | Uint8Array, callback?: (error?: Error | null) => void): boolean {
    this.writes.push(value.toString());
    callback?.();
    return true;
  }
  end(): void {}
}

class Transport extends EventEmitter implements CodexAppServerTransport {
  readonly stdin = new Writable();
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly kill = vi.fn(() => true);

  frames(): Array<Record<string, unknown>> {
    return this.stdin.writes.map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  respond(method: string, result: unknown): void {
    const frame = this.frames().find((candidate) => candidate.method === method && typeof candidate.id === "number");
    if (!frame) throw new Error(`No ${method} request`);
    this.stdout.emit("data", Buffer.from(`${JSON.stringify({ id: frame.id, result })}\n`));
  }
}

describe("Codex selected-profile client lifecycle", () => {
  it("owns exact profile argv, canonical CODEX_HOME, config params, and stop", async () => {
    const transports: Transport[] = [];
    const spawns: Array<{ command: string; args: readonly string[]; env?: NodeJS.ProcessEnv }> = [];
    const spawnTransport: SpawnCodexAppServerTransport = (command, args, options) => {
      spawns.push({ command, args, env: options?.env });
      const transport = new Transport();
      transports.push(transport);
      return transport;
    };
    const lifecycle = createCodexProfileClientLifecycle({
      codexBin: "/configured/codex",
      env: { PATH: "/safe/bin", CODEX_HOME: "/must-not-win" },
      spawnTransport,
      timeoutMs: 100,
    });
    const reading = lifecycle.readConfig(
      "openai-work",
      "/canonical/codex-home",
      "/exact/project",
      z.object({ config: z.object({ model_provider: z.string() }), origins: z.record(z.string(), z.unknown()) }),
    );
    expect(spawns).toEqual([
      {
        command: "/configured/codex",
        args: ["--profile", "openai-work", "app-server", "--stdio"],
        env: { PATH: "/safe/bin", CODEX_HOME: "/canonical/codex-home" },
      },
    ]);
    transports[0]!.respond("initialize", {});
    await vi.waitFor(() => expect(transports[0]!.frames().some((frame) => frame.method === "config/read")).toBe(true));
    expect(transports[0]!.frames().find((frame) => frame.method === "config/read")).toMatchObject({
      params: { cwd: "/exact/project", includeLayers: false },
    });
    transports[0]!.respond("config/read", { config: { model_provider: "openai" }, origins: {} });
    await expect(reading).resolves.toMatchObject({ config: { model_provider: "openai" } });
    expect(transports[0]!.kill).toHaveBeenCalledOnce();
  });

  it.each(["initialize", "config"] as const)("stops the Task 6 client after %s failure", async (phase) => {
    const transport = new Transport();
    const lifecycle = createCodexProfileClientLifecycle({
      codexBin: "codex",
      env: {},
      spawnTransport: () => transport,
      timeoutMs: 100,
    });
    const reading = lifecycle.readConfig(
      "work",
      "/canonical/home",
      "/cwd",
      z.object({
        config: z.object({ model_provider: z.literal("openai") }),
        origins: z.record(z.string(), z.unknown()),
      }),
    );
    if (phase === "initialize") {
      const id = transport.frames()[0]!.id;
      transport.stdout.emit(
        "data",
        Buffer.from(`${JSON.stringify({ id, error: { code: -1, message: "raw-secret" } })}\n`),
      );
    } else {
      transport.respond("initialize", {});
      await vi.waitFor(() => expect(transport.frames().some((frame) => frame.method === "config/read")).toBe(true));
      transport.respond("config/read", { config: { model_provider: "ollama" }, origins: {} });
    }
    await expect(reading).rejects.toMatchObject({
      code: "OSS_PROVIDER_DEFERRED",
      message: "Codex profile capability proof is unavailable",
    });
    await expect(reading).rejects.not.toThrow(/raw-secret/);
    expect(transport.kill).toHaveBeenCalledOnce();
  });
});
