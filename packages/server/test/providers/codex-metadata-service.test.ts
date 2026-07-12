import { EventEmitter } from "node:events";
import { mkdir, realpath, rename, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ZodType } from "zod";
import {
  CODEX_MODEL_CATALOG_ERROR_CODE,
  OSS_PROVIDER_DEFERRED,
  CodexMetadataService,
  type CodexMetadataRpc,
} from "../../src/providers/codex-metadata-service.js";
import { createCodexProfileClientLifecycleForTests } from "../../src/providers/codex-profile-client.js";

class FakeRpc implements CodexMetadataRpc {
  readonly requests: Array<{ method: string; params: unknown }> = [];
  readonly pending: Array<{
    method: string;
    schema: ZodType<unknown>;
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }> = [];
  private readonly notifications = new EventEmitter();

  request<T>(method: string, params: unknown, schema: ZodType<T>): Promise<T> {
    this.requests.push({ method, params });
    return new Promise<T>((resolve, reject) => {
      this.pending.push({
        method,
        schema: schema as ZodType<unknown>,
        resolve: resolve as (value: unknown) => void,
        reject,
      });
    });
  }

  onNotification(listener: (notification: { method: string; params?: unknown }) => void): () => void {
    this.notifications.on("notification", listener);
    return () => this.notifications.off("notification", listener);
  }

  reply(method: string, value: unknown): void {
    const index = this.pending.findIndex((entry) => entry.method === method);
    if (index < 0) throw new Error(`No pending ${method}`);
    const [entry] = this.pending.splice(index, 1);
    const parsed = entry!.schema.safeParse(value);
    if (parsed.success) entry!.resolve(parsed.data);
    else entry!.reject(new Error("Codex metadata is unavailable"));
  }

  fail(method: string): void {
    const index = this.pending.findIndex((entry) => entry.method === method);
    if (index < 0) throw new Error(`No pending ${method}`);
    this.pending.splice(index, 1)[0]!.reject(new Error("Bearer raw-secret"));
  }

  notify(method: string, params: unknown): void {
    this.notifications.emit("notification", { method, params });
  }

  get notificationListenerCount(): number {
    return this.notifications.listenerCount("notification");
  }
}

function model(
  value: string,
  options: Partial<{
    hidden: boolean;
    isDefault: boolean;
    efforts: Array<{ reasoningEffort: string; description: string }>;
    defaultEffort: string;
  }> = {},
) {
  return {
    id: `id-${value}`,
    model: value,
    displayName: value.toUpperCase(),
    description: `${value} description`,
    hidden: options.hidden ?? false,
    isDefault: options.isDefault ?? false,
    supportedReasoningEfforts: options.efforts ?? [
      { reasoningEffort: "low", description: "Low" },
      { reasoningEffort: "high", description: "High" },
    ],
    defaultReasoningEffort: options.defaultEffort ?? "low",
  };
}

function profileClientFrom(
  factory: (profile: string, proof: { readonly codexHome: string }) => CodexMetadataRpc | Promise<CodexMetadataRpc>,
) {
  return createCodexProfileClientLifecycleForTests(
    async <T>(profile: string, codexHome: string, cwd: string, schema: ZodType<T>) => {
      const rpc = await factory(profile, { codexHome });
      if (typeof rpc.start !== "function" || typeof rpc.stop !== "function") throw new Error("invalid lifecycle");
      try {
        await rpc.start();
        return await rpc.request("config/read", { cwd, includeLayers: false }, schema);
      } finally {
        await rpc.stop();
      }
    },
  );
}

afterEach(() => vi.useRealTimers());

describe("CodexMetadataService account and device login", () => {
  it("reports the exact login lifecycle independently of global account state", async () => {
    vi.useFakeTimers();
    let now = 1_000;
    const rpc = new FakeRpc();
    const service = new CodexMetadataService(rpc, { now: () => now, loginTtlMs: 100 });

    const start = async (loginId: string) => {
      const pending = service.startDeviceLogin();
      rpc.reply("account/login/start", {
        type: "chatgptDeviceCode",
        loginId,
        userCode: "CODE",
        verificationUrl: "https://auth.openai.test/device",
      });
      return await pending;
    };

    await start("completed");
    expect(service.getLoginStatus("completed")).toEqual({ status: "pending" });
    rpc.notify("account/login/completed", { loginId: "completed", success: true });
    expect(service.getLoginStatus("completed")).toEqual({ status: "completed" });

    await start("failed");
    rpc.notify("account/login/completed", { loginId: "failed", success: false });
    expect(service.getLoginStatus("failed")).toEqual({ status: "failed" });

    await start("canceled");
    const canceled = service.cancelLogin("canceled");
    rpc.reply("account/login/cancel", { status: "canceled" });
    await canceled;
    expect(service.getLoginStatus("canceled")).toEqual({ status: "canceled" });

    await start("expired");
    now += 101;
    await vi.advanceTimersByTimeAsync(101);
    expect(service.getLoginStatus("expired")).toEqual({ status: "expired" });
    rpc.reply("account/login/cancel", { status: "canceled" });

    expect(service.getLoginStatus("unknown")).toEqual({ status: "notFound" });
    now += 101;
    expect(service.getLoginStatus("completed")).toEqual({ status: "notFound" });
  });

  it("bounds retained login outcomes", async () => {
    const rpc = new FakeRpc();
    const service = new CodexMetadataService(rpc, { now: () => 1_000, loginTtlMs: 60_000 });
    for (let index = 0; index < 65; index += 1) {
      const loginId = `outcome-${index}`;
      const started = service.startDeviceLogin();
      rpc.reply("account/login/start", {
        type: "chatgptDeviceCode",
        loginId,
        userCode: "CODE",
        verificationUrl: "https://auth.openai.test/device",
      });
      await started;
      rpc.notify("account/login/completed", { loginId, success: true });
    }
    expect(service.getLoginStatus("outcome-0")).toEqual({ status: "notFound" });
    expect(service.getLoginStatus("outcome-64")).toEqual({ status: "completed" });
  });

  it.each([
    [
      { account: null, requiresOpenaiAuth: true },
      { authenticated: false, authMethod: "none" },
    ],
    [
      { account: { type: "apiKey", apiKey: "must-be-stripped" }, requiresOpenaiAuth: false },
      { authenticated: true, authMethod: "apiKey" },
    ],
    [
      {
        account: { type: "chatgpt", email: "person@example.test", planType: "pro", accessToken: "strip" },
        requiresOpenaiAuth: false,
      },
      { authenticated: true, authMethod: "chatgpt", plan: "pro" },
    ],
  ])("normalizes account state without exposing credentials", async (payload, expected) => {
    const rpc = new FakeRpc();
    const service = new CodexMetadataService(rpc);
    const result = service.getAccount();
    expect(rpc.requests).toEqual([{ method: "account/read", params: { refreshToken: false } }]);
    rpc.reply("account/read", payload);
    await expect(result).resolves.toEqual(expected);
    expect(JSON.stringify(await result)).not.toMatch(/must-be-stripped|accessToken|person@example/i);
  });

  it("starts exact device auth, buffers a racing exact completion, and never exposes tokens", async () => {
    const rpc = new FakeRpc();
    const service = new CodexMetadataService(rpc, { now: () => 1_000, loginTtlMs: 60_000 });
    const started = service.startDeviceLogin();
    expect(rpc.requests).toEqual([{ method: "account/login/start", params: { type: "chatgptDeviceCode" } }]);
    rpc.notify("account/login/completed", { loginId: "l1", success: true, accessToken: "strip-me" });
    rpc.reply("account/login/start", {
      type: "chatgptDeviceCode",
      loginId: "l1",
      userCode: "ABCD-EFGH",
      verificationUrl: "https://auth.openai.test/device",
      accessToken: "strip-me",
    });
    const login = await started;
    expect(login).toMatchObject({
      loginId: "l1",
      userCode: "ABCD-EFGH",
      verificationUrl: "https://auth.openai.test/device",
      expiresAt: 61_000,
    });
    await expect(login.completion).resolves.toEqual({ status: "completed" });
    expect(JSON.stringify(login)).not.toContain("strip-me");
  });

  it("ignores wrong login ids, rejects non-HTTPS URLs, expires, and cancels idempotently", async () => {
    vi.useFakeTimers();
    let now = 10_000;
    const rpc = new FakeRpc();
    const service = new CodexMetadataService(rpc, { now: () => now, loginTtlMs: 50 });
    const started = service.startDeviceLogin();
    rpc.reply("account/login/start", {
      type: "chatgptDeviceCode",
      loginId: "l1",
      userCode: "SAFE-CODE",
      verificationUrl: "https://auth.openai.test/device",
    });
    const login = await started;
    rpc.notify("account/login/completed", { loginId: "other", success: true });

    const firstCancel = service.cancelLogin("l1");
    const secondCancel = service.cancelLogin("l1");
    expect(secondCancel).toBe(firstCancel);
    expect(rpc.requests.at(-1)).toEqual({ method: "account/login/cancel", params: { loginId: "l1" } });
    expect(rpc.requests.filter((request) => request.method === "account/login/cancel")).toHaveLength(1);
    rpc.reply("account/login/cancel", { status: "canceled" });
    await expect(Promise.all([firstCancel, secondCancel])).resolves.toEqual([
      { status: "canceled" },
      { status: "canceled" },
    ]);
    await expect(login.completion).resolves.toEqual({ status: "canceled" });
    await expect(service.cancelLogin("l1")).resolves.toEqual({ status: "notFound" });

    const invalid = service.startDeviceLogin();
    rpc.reply("account/login/start", {
      type: "chatgptDeviceCode",
      loginId: "l2",
      userCode: "SAFE-CODE",
      verificationUrl: "http://not-secure.test/device",
    });
    await expect(invalid).rejects.toMatchObject({ code: "CODEX_METADATA_UNAVAILABLE" });

    const expiring = service.startDeviceLogin();
    rpc.reply("account/login/start", {
      type: "chatgptDeviceCode",
      loginId: "l3",
      userCode: "SAFE-CODE",
      verificationUrl: "https://auth.openai.test/device",
    });
    const expiringLogin = await expiring;
    now += 51;
    await vi.advanceTimersByTimeAsync(51);
    await expect(expiringLogin.completion).resolves.toEqual({ status: "expired" });
    expect(rpc.requests.at(-1)).toEqual({ method: "account/login/cancel", params: { loginId: "l3" } });
    rpc.reply("account/login/cancel", { status: "canceled" });
  });

  it("buffers completions only for the in-flight start generation and never reuses a retired login id", async () => {
    const rpc = new FakeRpc();
    const service = new CodexMetadataService(rpc, { loginTtlMs: 60_000 });
    rpc.notify("account/login/completed", { loginId: "outside", success: true });

    const outside = service.startDeviceLogin();
    rpc.reply("account/login/start", {
      type: "chatgptDeviceCode",
      loginId: "outside",
      userCode: "OUT-SIDE",
      verificationUrl: "https://auth.openai.test/device",
    });
    const outsideLogin = await outside;
    let outsideSettled = false;
    void outsideLogin.completion.then(() => {
      outsideSettled = true;
    });
    await Promise.resolve();
    expect(outsideSettled).toBe(false);
    const cancelOutside = service.cancelLogin("outside");
    rpc.reply("account/login/cancel", { status: "canceled" });
    await cancelOutside;

    const failedStart = service.startDeviceLogin();
    rpc.notify("account/login/completed", { loginId: "retired", success: true });
    rpc.fail("account/login/start");
    await expect(failedStart).rejects.toMatchObject({ code: "CODEX_METADATA_UNAVAILABLE" });

    const reused = service.startDeviceLogin();
    rpc.reply("account/login/start", {
      type: "chatgptDeviceCode",
      loginId: "retired",
      userCode: "RETI-RED",
      verificationUrl: "https://auth.openai.test/device",
    });
    await expect(reused).rejects.toMatchObject({ code: "CODEX_METADATA_UNAVAILABLE" });
  });

  it("clears a rejected cancel request so retry works and removes the login timer", async () => {
    vi.useFakeTimers();
    const rpc = new FakeRpc();
    const service = new CodexMetadataService(rpc, { loginTtlMs: 60_000 });
    const started = service.startDeviceLogin();
    rpc.reply("account/login/start", {
      type: "chatgptDeviceCode",
      loginId: "retry-cancel",
      userCode: "RETR-YCAN",
      verificationUrl: "https://auth.openai.test/device",
    });
    const login = await started;
    expect(vi.getTimerCount()).toBe(1);

    const first = service.cancelLogin("retry-cancel");
    rpc.fail("account/login/cancel");
    await expect(first).rejects.toMatchObject({ code: "CODEX_METADATA_UNAVAILABLE" });
    const retry = service.cancelLogin("retry-cancel");
    expect(rpc.requests.filter((request) => request.method === "account/login/cancel")).toHaveLength(2);
    rpc.reply("account/login/cancel", { status: "canceled" });
    await expect(retry).resolves.toEqual({ status: "canceled" });
    await expect(login.completion).resolves.toEqual({ status: "canceled" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retires an active login when protocol cancel reports notFound and permits an explicit new start", async () => {
    const rpc = new FakeRpc();
    const service = new CodexMetadataService(rpc, { loginTtlMs: 60_000 });
    const firstStart = service.startDeviceLogin();
    rpc.reply("account/login/start", {
      type: "chatgptDeviceCode",
      loginId: "locally-active",
      userCode: "LOCA-CTIV",
      verificationUrl: "https://auth.openai.test/device",
    });
    const first = await firstStart;
    const cancel = service.cancelLogin(first.loginId);
    rpc.reply("account/login/cancel", { status: "notFound" });
    await expect(cancel).resolves.toEqual({ status: "notFound" });
    await expect(first.completion).resolves.toEqual({ status: "canceled" });

    const second = service.startDeviceLogin();
    expect(rpc.requests.at(-1)).toEqual({ method: "account/login/start", params: { type: "chatgptDeviceCode" } });
    rpc.reply("account/login/start", {
      type: "chatgptDeviceCode",
      loginId: "explicit-new",
      userCode: "EXPL-NEW1",
      verificationUrl: "https://auth.openai.test/device",
    });
    await expect(second).resolves.toMatchObject({ loginId: "explicit-new" });
  });

  it("dispose unregisters notifications, settles active logins, and clears their timers", async () => {
    vi.useFakeTimers();
    const rpc = new FakeRpc();
    const service = new CodexMetadataService(rpc, { loginTtlMs: 60_000 });
    expect(rpc.notificationListenerCount).toBe(1);
    const started = service.startDeviceLogin();
    rpc.reply("account/login/start", {
      type: "chatgptDeviceCode",
      loginId: "dispose-me",
      userCode: "DISP-OSEM",
      verificationUrl: "https://auth.openai.test/device",
    });
    const login = await started;
    expect(vi.getTimerCount()).toBe(1);

    service.dispose();

    expect(rpc.notificationListenerCount).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    await expect(login.completion).resolves.toEqual({ status: "canceled" });
    expect(service.getLoginStatus("dispose-me")).toEqual({ status: "canceled" });
    rpc.notify("account/login/completed", { loginId: "dispose-me", success: true });
    expect(rpc.requests.filter((request) => request.method === "account/login/cancel")).toHaveLength(1);
  });

  it("ignores late completion for an expired generation while the next start is in flight", async () => {
    vi.useFakeTimers();
    const rpc = new FakeRpc();
    const service = new CodexMetadataService(rpc, { loginTtlMs: 20 });
    const firstStart = service.startDeviceLogin();
    rpc.reply("account/login/start", {
      type: "chatgptDeviceCode",
      loginId: "expired-id",
      userCode: "EXPI-RED1",
      verificationUrl: "https://auth.openai.test/device",
    });
    const first = await firstStart;
    await vi.advanceTimersByTimeAsync(21);
    await expect(first.completion).resolves.toEqual({ status: "expired" });

    const secondStart = service.startDeviceLogin();
    rpc.notify("account/login/completed", { loginId: "expired-id", success: true });
    rpc.reply("account/login/start", {
      type: "chatgptDeviceCode",
      loginId: "next-id",
      userCode: "NEXT-ID22",
      verificationUrl: "https://auth.openai.test/device",
    });
    const second = await secondStart;
    let settled = false;
    void second.completion.then(() => {
      settled = true;
    });
    rpc.notify("account/login/completed", { loginId: "expired-id", success: true });
    await Promise.resolve();
    expect(settled).toBe(false);
    rpc.notify("account/login/completed", { loginId: "next-id", success: true });
    await expect(second.completion).resolves.toEqual({ status: "completed" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ages out and retires early completions while a start request remains in flight", async () => {
    let now = 1_000;
    const rpc = new FakeRpc();
    const service = new CodexMetadataService(rpc, { now: () => now, loginTtlMs: 20 });
    const started = service.startDeviceLogin();
    rpc.notify("account/login/completed", { loginId: "stale-early", success: true });
    now += 21;
    rpc.notify("account/login/completed", { loginId: "fresh-early", success: true });
    rpc.reply("account/login/start", {
      type: "chatgptDeviceCode",
      loginId: "stale-early",
      userCode: "STAL-EARL",
      verificationUrl: "https://auth.openai.test/device",
    });
    await expect(started).rejects.toMatchObject({ code: "CODEX_METADATA_UNAVAILABLE" });
  });
});

describe("CodexMetadataService models, usage, and profiles", () => {
  it("probes and caches every stable metadata method family used by the server", async () => {
    let now = 1_000;
    const rpc = new FakeRpc();
    const threadInventory = vi.fn(async () => []);
    const service = new CodexMetadataService(rpc, {
      now: () => now,
      capabilityCacheTtlMs: 100,
    });

    const first = service.probeCapabilities("/work", threadInventory);
    expect(rpc.requests).toEqual(
      expect.arrayContaining([
        { method: "account/read", params: { refreshToken: false } },
        { method: "model/list", params: { cursor: null, includeHidden: false, limit: 100 } },
        { method: "account/rateLimits/read", params: {} },
        { method: "config/read", params: { cwd: "/work", includeLayers: false } },
      ]),
    );
    rpc.reply("account/read", { account: null, requiresOpenaiAuth: true });
    rpc.reply("model/list", { data: [], nextCursor: null });
    rpc.reply("account/rateLimits/read", { rateLimits: {} });
    rpc.reply("config/read", { config: {}, origins: {} });
    await expect(first).resolves.toBe(true);
    expect(threadInventory).toHaveBeenCalledTimes(1);

    const requestCount = rpc.requests.length;
    now += 99;
    await expect(service.probeCapabilities("/work", threadInventory)).resolves.toBe(true);
    expect(rpc.requests).toHaveLength(requestCount);
    expect(threadInventory).toHaveBeenCalledTimes(1);
  });

  it("reports a redacted unavailable aggregate when any required metadata schema drifts", async () => {
    const rpc = new FakeRpc();
    const service = new CodexMetadataService(rpc);
    const result = service.probeCapabilities("/work", async () => []);
    rpc.reply("account/read", { account: null, requiresOpenaiAuth: true });
    rpc.reply("model/list", { data: [{ raw: "Bearer secret model frame" }], nextCursor: null });
    rpc.reply("account/rateLimits/read", { rateLimits: {} });
    rpc.reply("config/read", { config: {}, origins: {} });

    await expect(result).resolves.toBe(false);
    expect(service.diagnostics.capabilities).toEqual({
      code: "CODEX_METADATA_UNAVAILABLE",
      message: "Codex metadata capabilities are unavailable",
    });
    expect(JSON.stringify(service.diagnostics)).not.toMatch(/Bearer|secret|frame/i);
  });

  it("bounds a hung aggregate capability probe with one shared deadline", async () => {
    vi.useFakeTimers();
    const rpc = new FakeRpc();
    const service = new CodexMetadataService(rpc, { capabilityTimeoutMs: 20 });
    const result = service.probeCapabilities("/work", () => new Promise(() => {}));

    await vi.advanceTimersByTimeAsync(21);

    await expect(result).resolves.toBe(false);
    expect(service.diagnostics.capabilities).toEqual({
      code: "CODEX_METADATA_UNAVAILABLE",
      message: "Codex metadata capabilities are unavailable",
    });
  });

  it("paginates, deduplicates, excludes hidden models, and returns immutable copies", async () => {
    let now = 1_000;
    const rpc = new FakeRpc();
    const service = new CodexMetadataService(rpc, { now: () => now, modelCacheTtlMs: 100 });
    const first = service.getModels();
    const concurrent = service.getModels();
    expect(rpc.requests).toEqual([
      { method: "model/list", params: { cursor: null, includeHidden: false, limit: 100 } },
    ]);
    rpc.reply("model/list", { data: [model("gpt-5.6"), model("hidden", { hidden: true })], nextCursor: "page-2" });
    await Promise.resolve();
    expect(rpc.requests.at(-1)).toEqual({
      method: "model/list",
      params: { cursor: "page-2", includeHidden: false, limit: 100 },
    });
    rpc.reply("model/list", {
      data: [model("gpt-5.6"), model("gpt-5.7", { isDefault: true, defaultEffort: "high" })],
      nextCursor: null,
    });
    const [models, sameModels] = await Promise.all([first, concurrent]);
    expect(models).toEqual([
      expect.objectContaining({
        value: "gpt-5.6",
        supportedReasoningEfforts: ["low", "high"],
        defaultReasoningEffort: "low",
      }),
      expect.objectContaining({ value: "gpt-5.7", isDefault: true, defaultReasoningEffort: "high" }),
    ]);
    expect(sameModels).toEqual(models);
    expect(sameModels).not.toBe(models);
    models[0]!.supportedReasoningEfforts.push("mutated");
    const cached = await service.getModels();
    expect(cached[0]!.supportedReasoningEfforts).toEqual(["low", "high"]);
    expect(rpc.requests.filter((request) => request.method === "model/list")).toHaveLength(2);
    now += 101;
    const refreshed = service.getModels();
    rpc.reply("model/list", { data: [model("gpt-5.8")], nextCursor: null });
    await expect(refreshed).resolves.toEqual([expect.objectContaining({ value: "gpt-5.8" })]);
  });

  it("preserves effort descriptions and bounded future effort tokens during model normalization", async () => {
    const rpc = new FakeRpc();
    const service = new CodexMetadataService(rpc);
    const models = service.getModels();
    rpc.reply("model/list", {
      data: [
        model("gpt-future", {
          efforts: [
            { reasoningEffort: "medium", description: "Balanced reasoning" },
            { reasoningEffort: "future-depth", description: "Provider-defined deep reasoning" },
          ],
          defaultEffort: "future-depth",
        }),
      ],
      nextCursor: null,
    });

    await expect(models).resolves.toEqual([
      expect.objectContaining({
        value: "gpt-future",
        reasoningOptions: [
          { value: "medium", description: "Balanced reasoning", isDefault: false },
          { value: "future-depth", description: "Provider-defined deep reasoning", isDefault: true },
        ],
        supportedReasoningEfforts: ["medium", "future-depth"],
        defaultReasoningEffort: "future-depth",
      }),
    ]);
  });

  it("rejects malformed catalogs and known unsupported reasoning while preserving bounded custom models", async () => {
    const rpc = new FakeRpc();
    const service = new CodexMetadataService(rpc, { maxModelPages: 2, maxModelItems: 2 });
    const cycling = service.getModels();
    rpc.reply("model/list", { data: [model("a")], nextCursor: "repeat" });
    await Promise.resolve();
    rpc.reply("model/list", { data: [model("b")], nextCursor: "repeat" });
    await expect(cycling).rejects.toMatchObject({ code: CODEX_MODEL_CATALOG_ERROR_CODE });

    const cappedRpc = new FakeRpc();
    const cappedService = new CodexMetadataService(cappedRpc, { maxModelPages: 3, maxModelItems: 2 });
    const capped = cappedService.getModels();
    cappedRpc.reply("model/list", { data: [model("duplicate")], nextCursor: "two" });
    await Promise.resolve();
    cappedRpc.reply("model/list", { data: [model("duplicate")], nextCursor: "three" });
    await Promise.resolve();
    cappedRpc.reply("model/list", { data: [model("duplicate")], nextCursor: null });
    await expect(capped).rejects.toMatchObject({ code: CODEX_MODEL_CATALOG_ERROR_CODE });

    const malformedRpc = new FakeRpc();
    const malformedService = new CodexMetadataService(malformedRpc);
    const malformed = malformedService.getModels();
    malformedRpc.reply("model/list", {
      data: [model("bad", { defaultEffort: "medium" })],
      nextCursor: null,
    });
    await expect(malformed).rejects.toMatchObject({ code: CODEX_MODEL_CATALOG_ERROR_CODE });

    const validRpc = new FakeRpc();
    const validService = new CodexMetadataService(validRpc);
    const loaded = validService.getModels();
    validRpc.reply("model/list", { data: [model("gpt")], nextCursor: null });
    await loaded;
    await expect(validService.validateModelSelection("safe-custom-model", "low")).resolves.toBeUndefined();
    await expect(validService.validateModelSelection("gpt", "high")).resolves.toBeUndefined();
    await expect(validService.validateModelSelection("gpt", "medium")).rejects.toMatchObject({
      code: "INVALID_PROVIDER_OPTIONS",
    });
  });

  it("normalizes primary, secondary, other buckets, timestamps, clamped percents, and credits", async () => {
    const rpc = new FakeRpc();
    const service = new CodexMetadataService(rpc, { now: () => 77 });
    const usage = service.getUsage();
    rpc.reply("account/rateLimits/read", {
      rateLimits: {
        limitId: "codex",
        primary: { usedPercent: 142, resetsAt: 1_783_800_000, windowDurationMins: 300 },
        secondary: { usedPercent: -2, resetsAt: null, windowDurationMins: null },
        credits: { hasCredits: true, unlimited: false, balance: "12.50" },
      },
      rateLimitsByLimitId: {
        codex: { limitId: "codex", primary: { usedPercent: 42, resetsAt: 1_783_800_000 } },
        review: { limitId: "review", limitName: "Code Review", primary: { usedPercent: 25, resetsAt: 1_783_900_000 } },
      },
      rateLimitResetCredits: { availableCount: 2, credits: null },
    });
    await expect(usage).resolves.toEqual({
      bars: [
        {
          id: "codex:primary",
          label: "Codex Primary",
          percent: 100,
          resetsAt: 1_783_800_000_000,
          windowDurationMs: 18_000_000,
        },
        { id: "codex:secondary", label: "Codex Secondary", percent: 0 },
        { id: "review:primary", label: "Code Review", percent: 25, resetsAt: 1_783_900_000_000 },
      ],
      credits: { hasCredits: true, unlimited: false, balance: "12.50", resetCreditsAvailable: 2 },
      fetchedAt: 77,
    });
    expect(JSON.stringify(await usage)).not.toMatch(/Claude|Sonnet/i);
  });

  it("returns null plus a redacted diagnostic when usage fails", async () => {
    const rpc = new FakeRpc();
    const service = new CodexMetadataService(rpc);
    const usage = service.getUsage();
    rpc.fail("account/rateLimits/read");
    await expect(usage).resolves.toBeNull();
    expect(service.diagnostics.usage).toEqual({
      code: "CODEX_METADATA_UNAVAILABLE",
      message: "Codex usage is unavailable",
    });
    expect(JSON.stringify(service.diagnostics)).not.toMatch(/Bearer|raw-secret/i);
  });

  it("lists only bounded regular profile filenames directly under CODEX_HOME", async () => {
    const home = await mkdtemp(join(await realpath(tmpdir()), "codex-home-"));
    await writeFile(join(home, "work.config.toml"), "model_provider='openai'");
    await writeFile(join(home, "a.b.config.toml"), "secret='never-read'");
    await writeFile(join(home, "config.toml"), "base=true");
    await mkdir(join(home, "nested.config.toml"));
    await symlink(join(home, "work.config.toml"), join(home, "linked.config.toml"));
    await writeFile(join(home, `${"x".repeat(129)}.config.toml`), "x=1");
    const service = new CodexMetadataService(new FakeRpc(), { codexHome: home });
    await expect(service.listProfiles()).resolves.toEqual(["a.b", "work"]);
  });

  it("capability-checks the selected profile at the exact cwd and fails closed", async () => {
    const home = await mkdtemp(join(await realpath(tmpdir()), "codex-home-"));
    await writeFile(join(home, "work.config.toml"), "contents-must-not-be-read");
    const profileRpc = new FakeRpc();
    const startProfileRpc = vi.fn(async () => {});
    const stopProfileRpc = vi.fn(async () => {});
    Object.assign(profileRpc, { start: startProfileRpc, stop: stopProfileRpc });
    const service = new CodexMetadataService(new FakeRpc(), {
      codexHome: home,
      profileClient: profileClientFrom(async (profile, proof) => {
        expect(profile).toBe("work");
        expect(proof.codexHome).toBe(await realpath(home));
        return profileRpc;
      }),
    });
    const valid = service.validateProfile("work", "/exact/cwd");
    await vi.waitFor(() =>
      expect(profileRpc.requests).toEqual([
        { method: "config/read", params: { cwd: "/exact/cwd", includeLayers: false } },
      ]),
    );
    profileRpc.reply("config/read", {
      config: { model_provider: "openai", developer_instructions: "strip" },
      origins: {},
    });
    await expect(valid).resolves.toMatchObject({ codexHome: await realpath(home), profile: "work" });
    expect(startProfileRpc).toHaveBeenCalledOnce();
    expect(stopProfileRpc).toHaveBeenCalledOnce();

    const local = service.validateProfile("work", "/exact/cwd");
    await vi.waitFor(() => expect(profileRpc.pending.some((entry) => entry.method === "config/read")).toBe(true));
    profileRpc.reply("config/read", { config: { model_provider: "ollama" }, origins: {} });
    await expect(local).rejects.toMatchObject({ code: OSS_PROVIDER_DEFERRED });

    const noProof = new CodexMetadataService(new FakeRpc(), { codexHome: home });
    await expect(noProof.validateProfile("work", "/exact/cwd")).rejects.toMatchObject({ code: OSS_PROVIDER_DEFERRED });
    await expect(service.validateProfile("../work", "/exact/cwd")).rejects.toMatchObject({
      code: "INVALID_PROVIDER_OPTIONS",
    });
  });

  it("rejects symlinked CODEX_HOME ancestors, homes, and profile files", async () => {
    const root = await mkdtemp(join(await realpath(tmpdir()), "codex-root-"));
    const realParent = join(root, "real-parent");
    const realHome = join(realParent, "home");
    await mkdir(realHome, { recursive: true });
    await writeFile(join(realHome, "work.config.toml"), "model_provider='openai'");
    const linkedParent = join(root, "linked-parent");
    await symlink(realParent, linkedParent);
    const linkedHome = join(root, "linked-home");
    await symlink(realHome, linkedHome);
    await symlink(join(realHome, "work.config.toml"), join(realHome, "linked.config.toml"));

    await expect(
      new CodexMetadataService(new FakeRpc(), { codexHome: join(linkedParent, "home") }).listProfiles(),
    ).resolves.toEqual([]);
    await expect(new CodexMetadataService(new FakeRpc(), { codexHome: linkedHome }).listProfiles()).resolves.toEqual(
      [],
    );
    await expect(new CodexMetadataService(new FakeRpc(), { codexHome: realHome }).listProfiles()).resolves.toEqual([
      "work",
    ]);
  });

  it("detects a selected profile replacement during config/read and stops the validator client", async () => {
    const home = await mkdtemp(join(await realpath(tmpdir()), "codex-home-"));
    const profilePath = join(home, "work.config.toml");
    await writeFile(profilePath, "model_provider='openai'");
    const profileRpc = new FakeRpc();
    const stop = vi.fn(async () => {});
    Object.assign(profileRpc, { start: vi.fn(async () => {}), stop });
    const service = new CodexMetadataService(new FakeRpc(), {
      codexHome: home,
      profileClient: profileClientFrom(() => profileRpc),
    });

    const validating = service.validateProfile("work", "/exact/cwd");
    await vi.waitFor(() => expect(profileRpc.pending.some((entry) => entry.method === "config/read")).toBe(true));
    await rename(profilePath, `${profilePath}.old`);
    await writeFile(profilePath, "model_provider='ollama'; replacement=true");
    profileRpc.reply("config/read", { config: { model_provider: "openai" }, origins: {} });
    await expect(validating).rejects.toMatchObject({ code: OSS_PROVIDER_DEFERRED });
    expect(stop).toHaveBeenCalledOnce();
  });

  it("rechecks the profile at final spawn and stops the validator after request and stop failures", async () => {
    const home = await mkdtemp(join(await realpath(tmpdir()), "codex-home-"));
    const profilePath = join(home, "work.config.toml");
    await writeFile(profilePath, "model_provider='openai'");
    const rpc = new FakeRpc();
    const stop = vi.fn(async () => {});
    Object.assign(rpc, { start: vi.fn(async () => {}), stop });
    const service = new CodexMetadataService(new FakeRpc(), {
      codexHome: home,
      profileClient: profileClientFrom(() => rpc),
    });

    const validating = service.validateProfile("work", "/exact/cwd");
    await vi.waitFor(() => expect(rpc.pending.some((entry) => entry.method === "config/read")).toBe(true));
    rpc.reply("config/read", { config: { model_provider: "openai" }, origins: {} });
    const proof = await validating;
    expect(stop).toHaveBeenCalledOnce();
    await rename(profilePath, `${profilePath}.old`);
    await writeFile(profilePath, "model_provider='openai'; replacement=true");
    const changed = proof.assertUnchanged();
    await vi.waitFor(() => expect(rpc.pending.some((entry) => entry.method === "config/read")).toBe(true));
    rpc.reply("config/read", { config: { model_provider: "openai" }, origins: {} });
    await expect(changed).rejects.toMatchObject({ code: OSS_PROVIDER_DEFERRED });

    const failingRpc = new FakeRpc();
    const failingStop = vi.fn(async () => {});
    Object.assign(failingRpc, { start: vi.fn(async () => {}), stop: failingStop });
    const failingService = new CodexMetadataService(new FakeRpc(), {
      codexHome: home,
      profileClient: profileClientFrom(() => failingRpc),
    });
    const failing = failingService.validateProfile("work", "/exact/cwd");
    await vi.waitFor(() => expect(failingRpc.pending.some((entry) => entry.method === "config/read")).toBe(true));
    failingRpc.fail("config/read");
    await expect(failing).rejects.toMatchObject({ code: OSS_PROVIDER_DEFERRED });
    expect(failingStop).toHaveBeenCalledOnce();

    const stopFailingRpc = new FakeRpc();
    Object.assign(stopFailingRpc, {
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {
        throw new Error("stop-secret");
      }),
    });
    const stopFailingService = new CodexMetadataService(new FakeRpc(), {
      codexHome: home,
      profileClient: profileClientFrom(() => stopFailingRpc),
    });
    const stopFailing = stopFailingService.validateProfile("work", "/exact/cwd");
    await vi.waitFor(() => expect(stopFailingRpc.pending.some((entry) => entry.method === "config/read")).toBe(true));
    stopFailingRpc.reply("config/read", { config: { model_provider: "openai" }, origins: {} });
    await expect(stopFailing).rejects.toMatchObject({ code: OSS_PROVIDER_DEFERRED });
    await expect(stopFailing).rejects.not.toThrow(/stop-secret/);
  });

  it("reruns exact selected-profile effective config at the exact cwd immediately before spawn", async () => {
    const home = await mkdtemp(join(await realpath(tmpdir()), "codex-home-"));
    await writeFile(join(home, "work.config.toml"), "model_provider='openai'");
    const rpc = new FakeRpc();
    const start = vi.fn(async () => {});
    const stop = vi.fn(async () => {});
    Object.assign(rpc, { start, stop });
    const service = new CodexMetadataService(new FakeRpc(), {
      codexHome: home,
      profileClient: profileClientFrom(() => rpc),
    });
    const validating = service.validateProfile("work", "/exact/cwd");
    await vi.waitFor(() => expect(rpc.pending.some((entry) => entry.method === "config/read")).toBe(true));
    rpc.reply("config/read", { config: { model_provider: "openai" }, origins: {} });
    const proof = await validating;

    const finalCheck = proof.assertUnchanged();
    await vi.waitFor(() => expect(rpc.pending.some((entry) => entry.method === "config/read")).toBe(true));
    expect(rpc.requests.at(-1)).toEqual({ method: "config/read", params: { cwd: "/exact/cwd", includeLayers: false } });
    rpc.reply("config/read", { config: { model_provider: "openai" }, origins: {} });
    await expect(finalCheck).resolves.toBeUndefined();
    expect(start).toHaveBeenCalledTimes(2);
    expect(stop).toHaveBeenCalledTimes(2);
  });

  it("detects same-size base config mutations even when mtime is restored", async () => {
    const home = await mkdtemp(join(await realpath(tmpdir()), "codex-home-"));
    const basePath = join(home, "config.toml");
    await writeFile(basePath, "model_provider='openai'\n");
    await writeFile(join(home, "work.config.toml"), "model_provider='openai'");
    const original = await stat(basePath);
    const rpc = new FakeRpc();
    Object.assign(rpc, { start: vi.fn(async () => {}), stop: vi.fn(async () => {}) });
    const service = new CodexMetadataService(new FakeRpc(), {
      codexHome: home,
      profileClient: profileClientFrom(() => rpc),
    });
    const validating = service.validateProfile("work", "/exact/cwd");
    await vi.waitFor(() => expect(rpc.pending.some((entry) => entry.method === "config/read")).toBe(true));
    rpc.reply("config/read", { config: { model_provider: "openai" }, origins: {} });
    const proof = await validating;

    await writeFile(basePath, "model_provider='ollama'\n");
    await utimes(basePath, original.atime, original.mtime);
    const finalCheck = proof.assertUnchanged();
    await vi.waitFor(() => expect(rpc.pending.some((entry) => entry.method === "config/read")).toBe(true));
    rpc.reply("config/read", { config: { model_provider: "openai" }, origins: {} });
    await expect(finalCheck).rejects.toMatchObject({ code: OSS_PROVIDER_DEFERRED });
  });

  it("rejects an effective project-layer provider flip during the final config read", async () => {
    const home = await mkdtemp(join(await realpath(tmpdir()), "codex-home-"));
    await writeFile(join(home, "work.config.toml"), "model_provider='openai'");
    const rpc = new FakeRpc();
    Object.assign(rpc, { start: vi.fn(async () => {}), stop: vi.fn(async () => {}) });
    const service = new CodexMetadataService(new FakeRpc(), {
      codexHome: home,
      profileClient: profileClientFrom(() => rpc),
    });
    const validating = service.validateProfile("work", "/project/with-layer");
    await vi.waitFor(() => expect(rpc.pending.some((entry) => entry.method === "config/read")).toBe(true));
    rpc.reply("config/read", { config: { model_provider: "openai" }, origins: {} });
    const proof = await validating;

    const finalCheck = proof.assertUnchanged();
    await vi.waitFor(() => expect(rpc.pending.some((entry) => entry.method === "config/read")).toBe(true));
    expect(rpc.requests.at(-1)).toEqual({
      method: "config/read",
      params: { cwd: "/project/with-layer", includeLayers: false },
    });
    rpc.reply("config/read", { config: { model_provider: "local-project" }, origins: {} });
    await expect(finalCheck).rejects.toMatchObject({ code: OSS_PROVIDER_DEFERRED });
  });
});
