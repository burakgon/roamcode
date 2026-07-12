import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ClaudeMetadataService,
  createClaudeMetadataRunner,
  type ClaudeMetadataRunner,
} from "../../src/providers/claude-metadata-service.js";

const model = {
  value: "sonnet",
  displayName: "Sonnet",
  description: "Balanced model",
  supportedEffortLevels: ["low", "medium", "high"],
  isDefault: true,
};

const envelope = {
  response: {
    response: {
      models: [model],
    },
  },
};

function runnerReturning(...responses: unknown[]): ClaudeMetadataRunner & { run: ReturnType<typeof vi.fn> } {
  const run = vi.fn();
  for (const response of responses) run.mockResolvedValueOnce(response);
  return { run };
}

function withModels(models: unknown): unknown {
  return { response: { response: { models } } };
}

class FakeChild extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly stdin = { end: vi.fn() };
  readonly kill = vi.fn(() => true);
}

function createRunnerHarness(overrides: { timeoutMs?: number; maxOutputBytes?: number } = {}) {
  const child = new FakeChild();
  const spawnProcess = vi.fn(() => child);
  const sourceEnv = { PATH: "/bin", ANTHROPIC_API_KEY: "must-not-leak", SAFE: "yes" };
  const runner = createClaudeMetadataRunner({
    claudeBin: "/opt/claude",
    cwd: "/tmp/project",
    env: sourceEnv,
    spawnProcess,
    ...overrides,
  });
  return { child, runner, sourceEnv, spawnProcess };
}

function writtenRequest(child: FakeChild): Record<string, unknown> {
  const written = child.stdin.end.mock.calls[0]?.[0];
  if (typeof written !== "string") throw new Error("expected an initialize request");
  return JSON.parse(written.trim()) as Record<string, unknown>;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("ClaudeMetadataService", () => {
  it("coalesces concurrent catalog requests and clones every public result", async () => {
    let resolve!: (value: unknown) => void;
    const runner = {
      run: vi.fn(() => new Promise<unknown>((settle) => (resolve = settle))),
    };
    const service = new ClaudeMetadataService(runner);

    const firstRequest = service.getModels();
    const secondRequest = service.getModels();
    expect(runner.run).toHaveBeenCalledTimes(1);
    resolve(envelope);

    const [first, second] = await Promise.all([firstRequest, secondRequest]);
    expect(first).toEqual([model]);
    expect(second).toEqual([model]);
    expect(first).not.toBe(second);
    expect(first[0]).not.toBe(second[0]);
    expect(first[0]?.supportedEffortLevels).not.toBe(second[0]?.supportedEffortLevels);
  });

  it("caches successful catalogs until the TTL expires", async () => {
    let now = 1_000;
    const runner = runnerReturning(envelope, envelope);
    const service = new ClaudeMetadataService(runner, { now: () => now, ttlMs: 50 });

    await service.getModels();
    now += 49;
    const cached = await service.getModels();
    cached[0]!.supportedEffortLevels.push("mutated");
    expect(runner.run).toHaveBeenCalledTimes(1);

    now += 1;
    await service.getModels();
    expect(runner.run).toHaveBeenCalledTimes(2);
  });

  it("force-refreshes a successful cached catalog", async () => {
    const refreshed = withModels([{ ...model, value: "opus", displayName: "Opus" }]);
    const runner = runnerReturning(envelope, refreshed);
    const service = new ClaudeMetadataService(runner);

    await expect(service.getModels()).resolves.toEqual([model]);
    await expect(service.getModels(true)).resolves.toEqual([
      expect.objectContaining({ value: "opus", displayName: "Opus" }),
    ]);
    expect(runner.run).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["a missing models array", {}],
    ["an empty models array", withModels([])],
    ["more than 64 models", withModels(Array.from({ length: 65 }, (_, index) => ({ ...model, value: `m-${index}` })))],
    ["duplicate model values", withModels([model, { ...model }])],
    ["an invalid model token", withModels([{ ...model, value: "bad value" }])],
    ["a model token longer than 128 characters", withModels([{ ...model, value: `m${"x".repeat(128)}` }])],
    ["a display name longer than 512 characters", withModels([{ ...model, displayName: "x".repeat(513) }])],
    ["a description longer than 4096 characters", withModels([{ ...model, description: "x".repeat(4_097) }])],
    [
      "more than 32 effort values",
      withModels([{ ...model, supportedEffortLevels: Array.from({ length: 33 }, (_, index) => `e-${index}`) }]),
    ],
    ["duplicate effort values", withModels([{ ...model, supportedEffortLevels: ["low", "low"] }])],
    ["an invalid effort token", withModels([{ ...model, supportedEffortLevels: ["not safe"] }])],
  ])("rejects %s with the generic metadata error", async (_label, response) => {
    const service = new ClaudeMetadataService(runnerReturning(response));

    await expect(service.getModels()).rejects.toThrow("Claude model metadata is unavailable");
  });

  it("does not cache a failed catalog load", async () => {
    const runner = runnerReturning({}, envelope);
    const service = new ClaudeMetadataService(runner);

    await expect(service.getModels()).rejects.toThrow("Claude model metadata is unavailable");
    await expect(service.getModels()).resolves.toEqual([model]);
    expect(runner.run).toHaveBeenCalledTimes(2);
  });

  it("rejects an unsupported effort for a known model", async () => {
    const service = new ClaudeMetadataService(runnerReturning(envelope));

    await expect(service.validateModelSelection("sonnet", "max")).rejects.toMatchObject({
      name: "ProviderError",
      code: "INVALID_PROVIDER_OPTIONS",
    });
  });

  it("allows a bounded custom model because the CLI is authoritative", async () => {
    const service = new ClaudeMetadataService(runnerReturning(envelope));

    await expect(service.validateModelSelection("future-model/v2", "max")).resolves.toBeUndefined();
  });

  it("disposes the owned runner", async () => {
    const dispose = vi.fn();
    const service = new ClaudeMetadataService({ run: vi.fn(), dispose });

    await service.dispose();

    expect(dispose).toHaveBeenCalledTimes(1);
  });
});

describe("createClaudeMetadataRunner", () => {
  it("spawns fixed arguments with sanitized environment and writes one initialize request", async () => {
    const { child, runner, sourceEnv, spawnProcess } = createRunnerHarness();

    const result = runner.run();
    expect(spawnProcess).toHaveBeenCalledWith(
      "/opt/claude",
      [
        "--print",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
        "--no-session-persistence",
        "--permission-mode",
        "plan",
      ],
      expect.objectContaining({
        cwd: "/tmp/project",
        env: { PATH: "/bin", SAFE: "yes" },
        stdio: ["pipe", "pipe", "pipe"],
      }),
    );
    expect(sourceEnv.ANTHROPIC_API_KEY).toBe("must-not-leak");
    expect(child.stdin.end).toHaveBeenCalledTimes(1);
    const request = writtenRequest(child);
    expect(request).toEqual({
      type: "control_request",
      request_id: expect.stringMatching(/^roamcode-models-[0-9a-f-]+$/),
      request: {
        subtype: "initialize",
        hooks: { PreToolUse: [{ matcher: "", hookCallbackIds: ["roamcode-metadata"] }] },
      },
    });

    const requestId = request.request_id;
    const matching = { type: "control_response", response: { request_id: requestId, response: { models: [] } } };
    child.stdout.emit(
      "data",
      Buffer.from(
        `${JSON.stringify({ type: "control_response", response: { request_id: "some-other-request" } })}\n${JSON.stringify(matching)}\n`,
      ),
    );
    await expect(result).resolves.toEqual(matching);
  });

  it("matches a response split across stdout chunks", async () => {
    const { child, runner } = createRunnerHarness();
    const result = runner.run();
    const requestId = writtenRequest(child).request_id;
    const line = `${JSON.stringify({ type: "control_response", response: { request_id: requestId, response: { models: [] } } })}\n`;

    child.stdout.emit("data", Buffer.from(line.slice(0, 20)));
    child.stdout.emit("data", Buffer.from(line.slice(20)));

    await expect(result).resolves.toMatchObject({ response: { request_id: requestId } });
  });

  it("rejects output beyond the combined stdout and stderr byte limit", async () => {
    const { child, runner } = createRunnerHarness({ maxOutputBytes: 10 });
    const result = runner.run();
    const rejected = expect(result).rejects.toThrow("Claude model metadata is unavailable");

    child.stdout.emit("data", Buffer.from("123456"));
    child.stderr.emit("data", Buffer.from("12345"));

    await rejected;
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it("times out and cleans up the child", async () => {
    vi.useFakeTimers();
    const { child, runner } = createRunnerHarness({ timeoutMs: 25 });
    const result = runner.run();
    const rejected = expect(result).rejects.toThrow("Claude model metadata is unavailable");
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(25);

    await rejected;
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects an early child exit", async () => {
    const { child, runner } = createRunnerHarness();
    const result = runner.run();
    const rejected = expect(result).rejects.toThrow("Claude model metadata is unavailable");

    child.emit("exit", 1, null);

    await rejected;
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it("cleans timers and listeners exactly once after a matching response", async () => {
    vi.useFakeTimers();
    const { child, runner } = createRunnerHarness({ timeoutMs: 25 });
    const result = runner.run();
    const requestId = writtenRequest(child).request_id;
    child.stdout.emit(
      "data",
      Buffer.from(`${JSON.stringify({ type: "control_response", response: { request_id: requestId } })}\n`),
    );

    await expect(result).resolves.toMatchObject({ response: { request_id: requestId } });
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(child.stdout.listenerCount("data")).toBe(0);
    expect(child.stderr.listenerCount("data")).toBe(0);
    expect(child.listenerCount("error")).toBe(0);
    expect(child.listenerCount("exit")).toBe(0);

    child.emit("exit", 0, null);
    await vi.advanceTimersByTimeAsync(50);
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it("dispose terminates an active run", async () => {
    const { child, runner } = createRunnerHarness();
    const result = runner.run();
    const rejected = expect(result).rejects.toThrow("Claude model metadata is unavailable");

    await runner.dispose?.();

    await rejected;
    expect(child.kill).toHaveBeenCalledTimes(1);
  });
});
