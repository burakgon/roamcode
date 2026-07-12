import { EventEmitter } from "node:events";
import { z } from "zod";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CODEX_METADATA_ERROR_CODE,
  CodexAppServerClient,
  type CodexAppServerTransport,
  type SpawnCodexAppServerTransport,
} from "../../src/providers/codex-app-server-client.js";

class FakeReadable extends EventEmitter {
  data(value: string | Buffer): void {
    this.emit("data", typeof value === "string" ? Buffer.from(value) : value);
  }
}

class FakeWritable extends EventEmitter {
  readonly writes: string[] = [];
  returnValue = true;
  throwOnWrite?: Error;
  callbackError?: Error;
  deferCallbacks = false;
  readonly pendingCallbacks: Array<(error?: Error | null) => void> = [];
  ended = false;

  write(value: string | Uint8Array, callback?: (error?: Error | null) => void): boolean {
    if (this.throwOnWrite) throw this.throwOnWrite;
    this.writes.push(value.toString());
    if (callback) {
      if (this.deferCallbacks) this.pendingCallbacks.push(callback);
      else callback(this.callbackError);
    }
    return this.returnValue;
  }

  completeNext(error: Error | null | undefined = this.callbackError): void {
    const callback = this.pendingCallbacks.shift();
    if (!callback) throw new Error("No pending write callback");
    callback(error);
  }

  end(): void {
    this.ended = true;
  }
}

class FakeTransport extends EventEmitter implements CodexAppServerTransport {
  readonly stdout = new FakeReadable();
  readonly stderr = new FakeReadable();
  readonly stdin = new FakeWritable();
  readonly kills: Array<NodeJS.Signals | undefined> = [];

  kill(signal?: NodeJS.Signals): boolean {
    this.kills.push(signal);
    return true;
  }

  frames(): Array<Record<string, unknown>> {
    return this.stdin.writes.map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  receive(value: unknown, ending = "\n"): void {
    this.stdout.data(`${JSON.stringify(value)}${ending}`);
  }

  receiveRaw(value: string | Buffer): void {
    this.stdout.data(value);
  }

  responseId(method: string): number {
    const frame = this.frames().find((candidate) => candidate.method === method && "id" in candidate);
    if (!frame || typeof frame.id !== "number") throw new Error(`No request for ${method}`);
    return frame.id;
  }

  respondTo(method: string, result: unknown): void {
    this.receive({ id: this.responseId(method), result });
  }
}

function harness(
  options: {
    timeoutMs?: number;
    maxStdoutLineBytes?: number;
    maxStdoutBufferBytes?: number;
    profile?: string;
    env?: NodeJS.ProcessEnv;
  } = {},
) {
  const transports: FakeTransport[] = [];
  const spawns: Array<{ command: string; args: readonly string[]; env?: NodeJS.ProcessEnv }> = [];
  const spawnTransport: SpawnCodexAppServerTransport = (command, args, spawnOptions) => {
    spawns.push({ command, args, env: spawnOptions?.env });
    const transport = new FakeTransport();
    transports.push(transport);
    return transport;
  };
  const client = new CodexAppServerClient({
    codexBin: "/configured/codex",
    spawnTransport,
    timeoutMs: options.timeoutMs ?? 100,
    maxStdoutLineBytes: options.maxStdoutLineBytes,
    maxStdoutBufferBytes: options.maxStdoutBufferBytes,
    profile: options.profile,
    env: options.env,
  });
  return { client, spawns, transports };
}

async function start(client: CodexAppServerClient, transports: FakeTransport[]): Promise<void> {
  const started = client.start();
  const transport = transports[0]!;
  expect(transport.frames()[0]).toMatchObject({ id: 1, method: "initialize" });
  transport.receive({ id: 1, result: { userAgent: "fake" } });
  await started;
  expect(transport.frames()[1]).toEqual({ method: "initialized", params: {} });
}

function expectUnavailable(promise: Promise<unknown>): Promise<void> {
  return expect(promise).rejects.toMatchObject({
    code: CODEX_METADATA_ERROR_CODE,
    message: "Codex metadata is unavailable",
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("CodexAppServerClient", () => {
  it("can launch app-server with one validated selected profile for effective config reads", async () => {
    const { client, spawns, transports } = harness({
      profile: "openai-work",
      env: { PATH: "/bin", CODEX_HOME: "/canonical/codex-home" },
    });
    const started = client.start();
    expect(spawns).toEqual([
      {
        command: "/configured/codex",
        args: ["--profile", "openai-work", "app-server", "--stdio"],
        env: { PATH: "/bin", CODEX_HOME: "/canonical/codex-home" },
      },
    ]);
    transports[0]!.receive({ id: 1, result: {} });
    await started;

    expect(
      () =>
        new CodexAppServerClient({
          profile: "../unsafe",
          spawnTransport: () => {
            throw new Error("must not spawn");
          },
        }),
    ).toThrowError(expect.objectContaining({ code: CODEX_METADATA_ERROR_CODE }));
  });

  it("spawns the exact configured app-server command and performs initialize then initialized", async () => {
    const { client, spawns, transports } = harness();
    const started = client.start();

    expect(spawns).toEqual([{ command: "/configured/codex", args: ["app-server", "--stdio"], env: undefined }]);
    expect(transports[0]!.frames()).toEqual([
      {
        id: 1,
        method: "initialize",
        params: {
          clientInfo: { name: "roamcode", title: "RoamCode", version: "0.0.0" },
          capabilities: {},
        },
      },
    ]);

    transports[0]!.receive({ jsonrpc: "2.0", id: 1, result: { userAgent: "fake" } });
    await started;
    expect(transports[0]!.frames()[1]).toEqual({ method: "initialized", params: {} });
  });

  it("shares a concurrent start and rejects requests before initialization", async () => {
    const { client, transports } = harness();
    await expectUnavailable(client.request("account/read", {}, z.object({ account: z.null() })));

    const first = client.start();
    const second = client.start();
    expect(second).toBe(first);
    await expectUnavailable(client.request("account/read", {}, z.object({ account: z.null() })));

    transports[0]!.receive({ id: 1, result: {} });
    await Promise.all([first, second]);
    await client.start();
    expect(transports).toHaveLength(1);
  });

  it("correlates out-of-order responses with monotonic ids and validates caller schemas", async () => {
    const { client, transports } = harness();
    const starting = client.start();
    const transport = transports[0]!;
    transport.receive({ id: 1, result: {} });
    await starting;

    const accountSchema = z.object({ account: z.null(), requiresOpenaiAuth: z.boolean() });
    const modelsSchema = z.object({ data: z.array(z.unknown()), nextCursor: z.string().nullable() });
    const account = client.request("account/read", {}, accountSchema);
    const models = client.request("model/list", {}, modelsSchema);

    expect(transport.responseId("account/read")).toBe(2);
    expect(transport.responseId("model/list")).toBe(3);
    transport.respondTo("model/list", { data: [], nextCursor: null });
    transport.respondTo("account/read", { account: null, requiresOpenaiAuth: true });
    await expect(Promise.all([account, models])).resolves.toEqual([
      { account: null, requiresOpenaiAuth: true },
      { data: [], nextCursor: null },
    ]);

    const invalid = client.request("account/read", {}, accountSchema);
    transport.respondTo("account/read", { account: "raw-secret-account", requiresOpenaiAuth: true });
    await expectUnavailable(invalid);
  });

  it("ignores unknown envelope and result fields without exposing them", async () => {
    const { client, transports } = harness();
    await start(client, transports);
    const response = client.request("future/method", {}, z.object({ value: z.number() }));
    transports[0]!.receive({
      id: transports[0]!.responseId("future/method"),
      result: { value: 7, futureSecretField: "not returned" },
      futureEnvelopeField: { token: "not returned" },
    });

    await expect(response).resolves.toEqual({ value: 7 });
  });

  it("contains a caller schema that throws and redacts its error", async () => {
    const { client, transports } = harness();
    await start(client, transports);
    const throwingSchema = z.unknown().transform(() => {
      throw new Error("schema-secret");
    });
    const response = client.request("throwing/schema", {}, throwingSchema);

    expect(() => transports[0]!.respondTo("throwing/schema", { token: "payload-secret" })).not.toThrow();
    await expectUnavailable(response);
    await expect(response).rejects.not.toThrow(/schema-secret|payload-secret/);
  });

  it("redacts initialization errors, request JSON-RPC errors, and timeouts", async () => {
    vi.useFakeTimers();
    const { client, transports } = harness({ timeoutMs: 20 });
    const initializing = client.start();
    transports[0]!.receive({
      id: 1,
      error: { code: -32000, message: "Bearer raw-credential", data: { token: "raw-token" } },
    });
    await expectUnavailable(initializing);
    await expect(initializing).rejects.not.toThrow(/credential|raw-token/i);

    const restarted = client.start();
    transports[1]!.receive({ id: 2, result: {} });
    await restarted;
    const errored = client.request("account/read", { password: "request-secret" }, z.object({ ok: z.literal(true) }));
    transports[1]!.receive({ id: 3, error: { code: 42, message: "response-secret" } });
    await expectUnavailable(errored);
    await expect(errored).rejects.not.toThrow(/request-secret|response-secret/i);

    const timedOut = client.request("model/list", {}, z.object({ ok: z.literal(true) }));
    const timeoutExpectation = expectUnavailable(timedOut);
    await vi.advanceTimersByTimeAsync(21);
    await timeoutExpectation;
  });

  it("accepts CRLF, split lines, and multiple lines in one chunk while containing unknown ids", async () => {
    const { client, transports } = harness();
    const started = client.start();
    transports[0]!.receiveRaw('{"id":1,"result":');
    transports[0]!.receiveRaw("{}}\r\n");
    await started;

    const first = client.request("one", {}, z.object({ value: z.number() }));
    const second = client.request("two", {}, z.object({ value: z.number() }));
    transports[0]!.receiveRaw(
      `${JSON.stringify({ id: 999_999, result: { value: "ignored" } })}\n${JSON.stringify({ id: 3, result: { value: 2 } })}\r\n${JSON.stringify({ id: 2, result: { value: 1 } })}\n`,
    );
    await expect(Promise.all([first, second])).resolves.toEqual([{ value: 1 }, { value: 2 }]);
  });

  it("validates and publishes notifications while containing unknown messages", async () => {
    const { client, transports } = harness();
    await start(client, transports);
    const notifications: unknown[] = [];
    const unsubscribe = client.onNotification((notification) => notifications.push(notification));

    transports[0]!.receive({ method: "account/login/completed", params: { success: true } });
    transports[0]!.receive({ method: 7, params: { secret: "ignored" } });
    transports[0]!.receive({ id: "not-a-number", result: {} });
    expect(notifications).toEqual([{ method: "account/login/completed", params: { success: true } }]);

    unsubscribe();
    transports[0]!.receive({ method: "another/notification" });
    expect(notifications).toHaveLength(1);
  });

  it("contains envelopes with conflicting response and notification fields", async () => {
    const { client, transports } = harness();
    await start(client, transports);
    const notifications: unknown[] = [];
    client.onNotification((notification) => notifications.push(notification));
    const response = client.request("one", {}, z.object({ value: z.string() }));
    const id = transports[0]!.responseId("one");

    transports[0]!.receive({
      id,
      result: { value: "invalid" },
      error: { code: 1, message: "conflicting-secret" },
    });
    transports[0]!.receive({ id: 40, method: "server/request", params: {} });
    transports[0]!.receive({ id, result: { value: "valid" } });

    await expect(response).resolves.toEqual({ value: "valid" });
    expect(notifications).toEqual([]);
  });

  it("contains malformed JSON to metadata and rejects pending work without echoing it", async () => {
    const { client, transports } = harness();
    await start(client, transports);
    const pending = client.request("account/read", {}, z.object({ ok: z.boolean() }));
    transports[0]!.receiveRaw("Bearer malformed-secret{\n");

    await expectUnavailable(pending);
    await expect(pending).rejects.not.toThrow(/Bearer|malformed-secret/);
    expect(transports[0]!.kills).toHaveLength(1);
    expect(client.diagnostics.lastIssue).toBe("malformed_json");
  });

  it("bounds oversized unterminated stdout and rejects all pending without echoing it", async () => {
    const { client, transports } = harness({ maxStdoutLineBytes: 64, maxStdoutBufferBytes: 72 });
    await start(client, transports);
    const pending = client.request("account/read", {}, z.object({ ok: z.boolean() }));
    transports[0]!.receiveRaw(`Bearer ${"stdout-secret".repeat(10)}`);

    await expectUnavailable(pending);
    await expect(pending).rejects.not.toThrow(/stdout-secret|Bearer/);
    expect(transports[0]!.kills).toHaveLength(1);
    expect(client.diagnostics.lastIssue).toBe("stdout_limit");
  });

  it("enforces the aggregate stdout buffer cap independently of the line cap", async () => {
    const { client, transports } = harness({ maxStdoutLineBytes: 128, maxStdoutBufferBytes: 64 });
    await start(client, transports);
    const pending = client.request("account/read", {}, z.object({ ok: z.boolean() }));
    transports[0]!.receiveRaw("x".repeat(65));

    await expectUnavailable(pending);
    expect(transports[0]!.kills).toHaveLength(1);
    expect(client.limits.maxStdoutBufferBytes).toBe(64);
    expect(client.diagnostics.lastIssue).toBe("stdout_limit");
  });

  it("caps stderr diagnostics by bytes and never exposes stderr content", async () => {
    const { client, transports } = harness();
    const started = client.start();
    transports[0]!.stderr.data(`Bearer ${"stderr-secret".repeat(10_000)}`);
    transports[0]!.emit("exit", 1, null);

    await expectUnavailable(started);
    expect(client.diagnostics.stderrBytes).toBe(client.limits.maxStderrBytes);
    expect(client.diagnostics.stderrTruncated).toBe(true);
    expect(JSON.stringify(client.diagnostics)).not.toMatch(/stderr-secret|Bearer/);
  });

  it("rejects pending work on exit, restarts cleanly, and isolates stale generations", async () => {
    const { client, transports } = harness();
    await start(client, transports);
    const oldRequest = client.request("old", {}, z.object({ value: z.string() }));
    const oldId = transports[0]!.responseId("old");
    transports[0]!.emit("exit", 1, null);
    await expectUnavailable(oldRequest);

    const restarted = client.start();
    expect(transports[1]!.responseId("initialize")).toBeGreaterThan(oldId);
    transports[0]!.receive({ id: oldId, result: { value: "stale" } });
    transports[1]!.receive({ id: transports[1]!.responseId("initialize"), result: {} });
    await restarted;
    const fresh = client.request("fresh", {}, z.object({ value: z.string() }));
    transports[0]!.receive({ id: transports[1]!.responseId("fresh"), result: { value: "wrong generation" } });
    transports[1]!.respondTo("fresh", { value: "fresh" });
    await expect(fresh).resolves.toEqual({ value: "fresh" });
  });

  it("makes concurrent stop idempotent and cleans timers and listeners", async () => {
    vi.useFakeTimers();
    const { client, transports } = harness({ timeoutMs: 20 });
    await start(client, transports);
    const pending = client.request("waiting", {}, z.object({ ok: z.boolean() }));
    const firstStop = client.stop();
    const secondStop = client.stop();

    expect(secondStop).toBe(firstStop);
    await Promise.all([firstStop, secondStop]);
    await expectUnavailable(pending);
    expect(transports[0]!.kills).toHaveLength(1);
    expect(transports[0]!.stdin.ended).toBe(true);
    expect(transports[0]!.listenerCount("exit")).toBe(0);
    expect(transports[0]!.stdout.listenerCount("data")).toBe(0);
    expect(transports[0]!.stderr.listenerCount("data")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    await client.stop();
    expect(transports[0]!.kills).toHaveLength(1);
  });

  it("serializes a stop during start with a concurrent restart", async () => {
    const { client, transports } = harness();
    const firstStart = client.start();
    const firstStartExpectation = expectUnavailable(firstStart);
    const firstStop = client.stop();
    const secondStop = client.stop();
    const restarted = client.start();

    expect(secondStop).toBe(firstStop);
    await firstStartExpectation;
    await firstStop;
    await vi.waitFor(() => expect(transports).toHaveLength(2));
    transports[1]!.respondTo("initialize", {});
    await restarted;
    expect(transports[0]!.kills).toHaveLength(1);
    expect(transports[1]!.frames()[1]).toMatchObject({ method: "initialized" });
  });

  it("rejects every pending request on one timeout and permits an immediate restart after exit", async () => {
    vi.useFakeTimers();
    const { client, transports } = harness({ timeoutMs: 20 });
    await start(client, transports);
    const first = client.request("first", {}, z.object({ ok: z.boolean() }));
    const second = client.request("second", {}, z.object({ ok: z.boolean() }));
    const expectations = [expectUnavailable(first), expectUnavailable(second)];
    await vi.advanceTimersByTimeAsync(21);
    await Promise.all(expectations);
    expect(transports[0]!.kills).toHaveLength(1);

    vi.useRealTimers();
    const restarting = client.start();
    transports[1]!.respondTo("initialize", {});
    await restarting;
    transports[1]!.emit("exit", 1, null);
    const immediateRestart = client.start();
    expect(transports).toHaveLength(3);
    transports[2]!.respondTo("initialize", {});
    await immediateRestart;
  });

  it("queues writes behind backpressure and contains write failures", async () => {
    const { client, transports } = harness();
    await start(client, transports);
    const transport = transports[0]!;
    transport.stdin.returnValue = false;
    const backpressured = client.request("backpressured", {}, z.object({ ok: z.boolean() }));
    const queued = client.request("after-backpressure", {}, z.object({ ok: z.boolean() }));
    expect(transport.frames()).toHaveLength(3);
    transport.stdin.returnValue = true;
    transport.stdin.emit("drain");
    expect(transport.frames()[3]).toMatchObject({ method: "after-backpressure" });
    transport.respondTo("backpressured", { ok: true });
    transport.respondTo("after-backpressure", { ok: true });
    await expect(Promise.all([backpressured, queued])).resolves.toEqual([{ ok: true }, { ok: true }]);

    transport.stdin.callbackError = new Error("write secret");
    const failed = client.request("write-error", { secret: "payload secret" }, z.object({ ok: z.boolean() }));
    await expectUnavailable(failed);
    await expect(failed).rejects.not.toThrow(/write secret|payload secret/i);
  });

  it("keeps a safe error sink after a failed write callback", async () => {
    const { client, transports } = harness();
    await start(client, transports);
    const transport = transports[0]!;
    const writeError = new Error("write secret");
    transport.stdin.callbackError = writeError;

    const failed = client.request("write-error-followed-by-event", {}, z.object({ ok: z.boolean() }));
    await expectUnavailable(failed);
    expect(() => transport.stdin.emit("error", writeError)).not.toThrow();
  });

  it.each(["callback-first", "drain-first"] as const)(
    "waits for write callback success and drain before start resolves ($0)",
    async (order) => {
      const { client, transports } = harness();
      const started = client.start();
      const transport = transports[0]!;
      transport.stdin.deferCallbacks = true;
      transport.stdin.returnValue = false;
      transport.receive({ id: 1, result: {} });
      await vi.waitFor(() => expect(transport.frames()).toHaveLength(2));

      let settled = false;
      void started.finally(() => {
        settled = true;
      });
      if (order === "callback-first") transport.stdin.completeNext();
      else transport.stdin.emit("drain");
      await Promise.resolve();
      expect(settled).toBe(false);

      if (order === "callback-first") transport.stdin.emit("drain");
      else transport.stdin.completeNext();
      await started;
      expect(settled).toBe(true);
    },
  );

  it("rejects start when the initialized notification write callback fails", async () => {
    const { client, transports } = harness();
    const started = client.start();
    const transport = transports[0]!;
    transport.stdin.deferCallbacks = true;
    transport.receive({ id: 1, result: {} });
    await vi.waitFor(() => expect(transport.frames()).toHaveLength(2));
    transport.stdin.completeNext(new Error("initialized write secret"));

    await expectUnavailable(started);
    await expect(started).rejects.not.toThrow(/initialized write secret/i);
    await expectUnavailable(client.request("must-not-run", {}, z.unknown()));
  });

  it("times out when the initialized notification write callback never arrives", async () => {
    vi.useFakeTimers();
    const { client, transports } = harness({ timeoutMs: 20 });
    const started = client.start();
    const transport = transports[0]!;
    transport.stdin.deferCallbacks = true;
    transport.receive({ id: 1, result: {} });
    await vi.waitFor(() => expect(transport.frames()).toHaveLength(2));
    const rejection = expectUnavailable(started);

    await vi.advanceTimersByTimeAsync(21);
    await rejection;
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["callback", "drain"] as const)(
    "times out after a response when the request write $0 never completes",
    async (missing) => {
      vi.useFakeTimers();
      const { client, transports } = harness({ timeoutMs: 20 });
      await start(client, transports);
      const transport = transports[0]!;
      if (missing === "callback") transport.stdin.deferCallbacks = true;
      else transport.stdin.returnValue = false;
      const request = client.request("response-before-write-complete", {}, z.object({ ok: z.boolean() }));
      transport.respondTo("response-before-write-complete", { ok: true });
      const rejection = expectUnavailable(request);

      await vi.advanceTimersByTimeAsync(21);
      await rejection;
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each(["stop", "exit"] as const)(
    "rejects active and queued writes when the transport reaches $0",
    async (event) => {
      const { client, transports } = harness();
      await start(client, transports);
      const transport = transports[0]!;
      transport.stdin.returnValue = false;
      const active = client.request("active-write", {}, z.unknown());
      const queued = client.request("queued-write", {}, z.unknown());
      const rejections = [expectUnavailable(active), expectUnavailable(queued)];
      expect(transport.frames()).toHaveLength(3);

      if (event === "stop") await client.stop();
      else transport.emit("exit", 1, null);
      await Promise.all(rejections);
      expect(transport.stdin.listenerCount("drain")).toBe(0);
      transport.stdin.returnValue = true;
      expect(() => transport.stdin.emit("drain")).not.toThrow();
      expect(transport.frames()).toHaveLength(3);
    },
  );

  it("contains a failed callback while backpressured and ignores a later drain", async () => {
    const { client, transports } = harness();
    await start(client, transports);
    const transport = transports[0]!;
    transport.stdin.returnValue = false;
    transport.stdin.deferCallbacks = true;
    const failed = client.request("backpressured-error", {}, z.unknown());
    const rejection = expectUnavailable(failed);
    transport.stdin.completeNext(new Error("write secret"));

    await rejection;
    expect(transport.stdin.listenerCount("drain")).toBe(0);
    expect(() => transport.stdin.emit("drain")).not.toThrow();
  });

  it("rejects initialization timeout and a synchronous spawn failure with the stable error", async () => {
    vi.useFakeTimers();
    const { client } = harness({ timeoutMs: 10 });
    const starting = client.start();
    await vi.advanceTimersByTimeAsync(11);
    await expectUnavailable(starting);

    const failedSpawn = new CodexAppServerClient({
      spawnTransport: () => {
        throw new Error("spawn secret path");
      },
    });
    const failed = failedSpawn.start();
    await expectUnavailable(failed);
    await expect(failed).rejects.not.toThrow(/secret path/i);
  });
});
