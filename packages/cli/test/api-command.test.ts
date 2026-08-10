import { describe, expect, test, vi } from "vitest";
import { runApiCommand } from "../src/api-command.js";
import { parseArgs } from "../src/args.js";

function harness(argv: string[], fetch = vi.fn<typeof globalThis.fetch>()) {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    fetch,
    run: () =>
      runApiCommand({
        options: parseArgs(argv),
        env: { ROAMCODE_API_URL: "https://code.example", ROAMCODE_API_TOKEN: "device-secret" },
        stdout: (message) => out.push(message),
        stderr: (message) => err.push(message),
        fetch,
        generateIdempotencyKey: () => "generated-key",
      }),
  };
}

describe("roamcode api", () => {
  test("reads capabilities with a header credential and never places it in the URL", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response(JSON.stringify({ apiVersion: "v1" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const test = harness(["api", "capabilities"], fetch);
    expect(await test.run()).toBe(0);
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe("https://code.example/api/v1/capabilities");
    expect(String(url)).not.toContain("device-secret");
    expect((init?.headers as Record<string, string>).authorization).toBe("Bearer device-secret");
    expect(test.out.join("")).toContain('"apiVersion": "v1"');
  });

  test("reads current inventories without mutation headers", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    for (const [action, path] of [
      ["sessions", "/api/v1/sessions"],
      ["agents", "/api/v1/agents"],
      ["workspaces", "/api/v1/workspaces"],
      ["devices", "/api/v1/devices"],
      ["presence", "/api/v1/presence"],
      ["adapters", "/api/v1/adapters"],
      ["events", "/api/v1/events?after=0"],
      ["openapi", "/api/v1/openapi.json"],
    ] as const) {
      const test = harness(["api", action], fetch);
      expect(await test.run()).toBe(0);
      const [url, init] = fetch.mock.calls.at(-1)!;
      expect(String(url)).toBe(`https://code.example${path}`);
      expect(init?.method).toBe("GET");
      expect((init?.headers as Record<string, string>)["idempotency-key"]).toBeUndefined();
    }
  });

  test("sends terminal input with idempotency and preserves non-stealing focus semantics", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () => new Response(JSON.stringify({ accepted: true, focused: false }), { status: 202 }),
    );
    const test = harness(["api", "send", "--session", "session_1", "--data", "continue"], fetch);
    expect(await test.run()).toBe(0);
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toContain("/api/v1/sessions/session_1/input");
    expect((init?.headers as Record<string, string>)["idempotency-key"]).toBe("generated-key");
    expect(JSON.parse(String(init?.body))).toEqual({ data: "continue" });
    expect(test.out.join("")).toContain('"focused": false');
  });

  test("wait is a bounded long-poll and focus defaults to a request", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(
      async (_url, init) =>
        new Response(JSON.stringify(init?.method === "POST" ? { mode: "request" } : { timedOut: true }), {
          status: 200,
        }),
    );
    const wait = harness(["api", "wait", "--agent", "agent_1", "--after", "10", "--timeout-ms", "25"], fetch);
    expect(await wait.run()).toBe(0);
    expect(String(fetch.mock.calls[0]?.[0])).toContain("after=10&timeoutMs=25");

    const focus = harness(["api", "focus", "--agent", "agent_1"], fetch);
    expect(await focus.run()).toBe(0);
    expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toEqual({ mode: "request" });
  });

  test("fails closed without a token and never echoes an arbitrary proxy response", async () => {
    const out: string[] = [];
    const err: string[] = [];
    expect(
      await runApiCommand({
        options: parseArgs(["api", "sessions"]),
        env: {},
        stdout: (message) => out.push(message),
        stderr: (message) => err.push(message),
      }),
    ).toBe(2);
    expect(err.join("")).toContain("ROAMCODE_API_TOKEN");

    const fetch = vi.fn<typeof globalThis.fetch>(
      async () => new Response("<html>private proxy page</html>", { status: 502 }),
    );
    const failed = harness(["api", "sessions"], fetch);
    expect(await failed.run()).toBe(1);
    expect(failed.err.join("")).not.toContain("private proxy page");
  });
});
