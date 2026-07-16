import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { readPeerCredential, readPeerPairingUrl, runApiCommand } from "../src/api-command.js";
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

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function credentialFile(mode = 0o600): { path: string; credential: string } {
  const directory = mkdtempSync(join(tmpdir(), "roamcode-peer-cli-"));
  directories.push(directory);
  const path = join(directory, "credential");
  const credential = `rcd_${"p".repeat(43)}`;
  writeFileSync(path, `${credential}\n`, { mode });
  chmodSync(path, mode);
  return { path, credential };
}

function pairingFile(
  mode = 0o600,
  pairingUrl = `https://build.example/#pair=rcp_${"s".repeat(43)}`,
): { path: string; pairingUrl: string } {
  const directory = mkdtempSync(join(tmpdir(), "roamcode-peer-pairing-cli-"));
  directories.push(directory);
  const path = join(directory, "pairing");
  writeFileSync(path, `${pairingUrl}\n`, { mode });
  chmodSync(path, mode);
  return { path, pairingUrl };
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

  test("reads team, policy, fleet, and extension inventories without mutation headers", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    for (const [action, path] of [
      ["team", "/api/v1/team"],
      ["members", "/api/v1/team/members"],
      ["policy", "/api/v1/policy"],
      ["fleet", "/api/v1/fleet"],
      ["peers", "/api/v1/peers"],
      ["presence", "/api/v1/presence"],
      ["extensions", "/api/v1/extensions"],
      ["plugins", "/api/v1/plugins"],
    ] as const) {
      const test = harness(["api", action], fetch);
      expect(await test.run()).toBe(0);
      const [url, init] = fetch.mock.calls.at(-1)!;
      expect(String(url)).toBe(`https://code.example${path}`);
      expect(init?.method).toBe("GET");
      expect((init?.headers as Record<string, string>)["idempotency-key"]).toBeUndefined();
    }
  });

  test("registers and rotates a peer only from a private credential file", async () => {
    const secret = credentialFile();
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () => new Response(JSON.stringify({ peer: { id: "peer-1", revision: 1 } }), { status: 201 }),
    );
    const added = harness(
      [
        "api",
        "peer-add",
        "--peer-url",
        "https://build.example",
        "--peer-credential-file",
        secret.path,
        "--actions",
        "read,wait,send,start,focus",
        "--workspaces",
        "workspace-2,workspace-1",
        "--label",
        "Build host",
        "--confirm",
      ],
      fetch,
    );
    expect(await added.run()).toBe(0);
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe("https://code.example/api/v1/peers");
    expect(JSON.parse(String(init?.body))).toEqual({
      baseUrl: "https://build.example",
      credential: secret.credential,
      label: "Build host",
      actions: ["read", "wait", "send", "start", "focus"],
      allowedWorkspaceIds: ["workspace-1", "workspace-2"],
      confirm: true,
    });
    expect(added.out.join("")).not.toContain(secret.credential);

    fetch.mockResolvedValueOnce(new Response(JSON.stringify({ peer: { id: "peer-1", revision: 2 } }), { status: 200 }));
    const rotated = harness(
      [
        "api",
        "peer-rotate",
        "--peer",
        "peer-1",
        "--expected-revision",
        "1",
        "--peer-credential-file",
        secret.path,
        "--confirm",
      ],
      fetch,
    );
    expect(await rotated.run()).toBe(0);
    expect(String(fetch.mock.calls[1]?.[0])).toBe("https://code.example/api/v1/peers/peer-1/credential");
    expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toEqual({
      credential: secret.credential,
      expectedRevision: 1,
      confirm: true,
    });
    expect(rotated.out.join("")).not.toContain(secret.credential);
  });

  test("prefers a private one-use pairing file without requiring a raw peer origin or credential", async () => {
    const pairing = pairingFile();
    expect(readPeerPairingUrl(pairing.path)).toBe(pairing.pairingUrl);
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Promise.resolve(new Response(JSON.stringify({ peer: { id: "peer-1", revision: 1 } }), { status: 201 })),
    );
    const added = harness(
      ["api", "peer-add", "--peer-pairing-file", pairing.path, "--label", "Build host", "--confirm"],
      fetch,
    );
    expect(await added.run()).toBe(0);
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({
      pairingUrl: pairing.pairingUrl,
      label: "Build host",
      confirm: true,
    });
    expect(added.out.join("")).not.toContain(pairing.pairingUrl);
  });

  test("accepts bracketed IPv6 loopback for private peer pairing and registration", async () => {
    const pairing = pairingFile(0o600, `http://[::1]:4280/#pair=rcp_${"v".repeat(43)}`);
    expect(readPeerPairingUrl(pairing.path)).toBe(pairing.pairingUrl);

    const credential = credentialFile();
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () => new Response(JSON.stringify({ peer: { id: "peer-ipv6", revision: 1 } }), { status: 201 }),
    );
    const added = harness(
      [
        "api",
        "peer-add",
        "--peer-url",
        "http://[::1]:4280",
        "--peer-credential-file",
        credential.path,
        "--label",
        "IPv6 loopback",
        "--confirm",
      ],
      fetch,
    );
    expect(await added.run()).toBe(0);
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toMatchObject({ baseUrl: "http://[::1]:4280" });
  });

  test("rejects permissive and symlinked peer credential files", () => {
    const permissive = credentialFile(0o644);
    expect(() => readPeerCredential(permissive.path)).toThrow(/chmod 600/);
    const privateFile = credentialFile();
    const link = join(privateFile.path, "..", "credential-link");
    symlinkSync(privateFile.path, link);
    expect(() => readPeerCredential(link)).toThrow(/not a symlink/);
    const permissivePairing = pairingFile(0o644);
    expect(() => readPeerPairingUrl(permissivePairing.path)).toThrow(/chmod 600/);
  });

  test("routes stable agent operations through a selected peer", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(
      async (_url, init) =>
        new Response(JSON.stringify(init?.method === "POST" ? { accepted: true } : { workspaces: [] }), {
          status: init?.method === "POST" ? 202 : 200,
        }),
    );
    const discovery = harness(["api", "peer-workspaces", "--peer", "peer-1"], fetch);
    expect(await discovery.run()).toBe(0);
    expect(String(fetch.mock.calls[0]?.[0])).toBe("https://code.example/api/v1/peers/peer-1/workspaces");

    const started = harness(
      [
        "api",
        "start",
        "--peer",
        "peer-1",
        "--workspace",
        "workspace-1",
        "--provider",
        "codex",
        "--options-json",
        '{"sandbox":"workspace-write"}',
      ],
      fetch,
    );
    expect(await started.run()).toBe(0);
    expect(String(fetch.mock.calls[1]?.[0])).toBe("https://code.example/api/v1/peers/peer-1/sessions");
    expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toEqual({
      workspaceId: "workspace-1",
      provider: "codex",
      options: { sandbox: "workspace-write" },
    });

    const sent = harness(
      [
        "api",
        "send",
        "--peer",
        "peer-1",
        "--session",
        "session-1",
        "--client",
        "worker-1",
        "--lease",
        "lease-1",
        "--data",
        "continue",
        "--newline",
      ],
      fetch,
    );
    expect(await sent.run()).toBe(0);
    expect(String(fetch.mock.calls[2]?.[0])).toBe("https://code.example/api/v1/peers/peer-1/sessions/session-1/input");
    expect(JSON.parse(String(fetch.mock.calls[2]?.[1]?.body))).toMatchObject({ appendNewline: true });
  });

  test("requires confirmation and optimistic revisions for peer administration", async () => {
    const add = harness(["api", "peer-add", "--peer-url", "https://build.example"]);
    expect(await add.run()).toBe(2);
    expect(add.err.join("")).toContain("--confirm");
    expect(add.fetch).not.toHaveBeenCalled();

    const update = harness(["api", "peer-update", "--peer", "peer-1", "--peer-status", "suspended"]);
    expect(await update.run()).toBe(2);
    expect(update.err.join("")).toContain("--expected-revision");

    const remove = harness(["api", "peer-remove", "--peer", "peer-1"]);
    expect(await remove.run()).toBe(2);
    expect(remove.err.join("")).toContain("--confirm");
  });

  test("reads bounded audit pages and preserves NDJSON exports byte-for-byte", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (url) => {
      if (String(url).includes("/export")) {
        return new Response('{"type":"manifest"}\n{"type":"record"}\n', {
          status: 200,
          headers: { "content-type": "application/x-ndjson" },
        });
      }
      return new Response(JSON.stringify({ records: [], nextCursor: 4 }), { status: 200 });
    });
    const page = harness(["api", "audit", "--after", "4", "--limit", "25"], fetch);
    expect(await page.run()).toBe(0);
    expect(String(fetch.mock.calls[0]?.[0])).toBe("https://code.example/api/v1/audit?after=4&limit=25");

    const exported = harness(["api", "audit-export", "--after", "4", "--limit", "25"], fetch);
    expect(await exported.run()).toBe(0);
    expect(String(fetch.mock.calls[1]?.[0])).toBe("https://code.example/api/v1/audit/export?after=4&limit=25");
    expect((fetch.mock.calls[1]?.[1]?.headers as Record<string, string>).accept).toBe("application/x-ndjson");
    expect(exported.out.join("")).toBe('{"type":"manifest"}\n{"type":"record"}\n');

    const invalid = harness(["api", "audit", "--limit", "0"], fetch);
    expect(await invalid.run()).toBe(2);
    expect(invalid.err.join("")).toContain("--limit must be 1-1000");
    expect(fetch).toHaveBeenCalledTimes(2);
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

  test("acquires a bound lease and includes it in later terminal input", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { action?: string };
      return new Response(
        JSON.stringify(
          body.action ? { leaseId: "lease-1", lease: { revision: 1 } } : { accepted: true, focused: false },
        ),
        { status: body.action ? 201 : 202 },
      );
    });
    const lease = harness(["api", "lease", "--session", "session_1", "--client", "agent_1"], fetch);
    expect(await lease.run()).toBe(0);
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({ action: "acquire", clientId: "agent_1" });

    const send = harness(
      ["api", "send", "--session", "session_1", "--client", "agent_1", "--lease", "lease-1", "--data", "continue"],
      fetch,
    );
    expect(await send.run()).toBe(0);
    expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toEqual({
      data: "continue",
      clientId: "agent_1",
      leaseId: "lease-1",
    });
  });

  test("requires explicit confirmation for takeover and exact lease proof for release", async () => {
    const takeover = harness(["api", "lease", "--session", "s1", "--client", "a1", "--takeover"]);
    expect(await takeover.run()).toBe(2);
    expect(takeover.err.join("")).toContain("requires --confirm");
    expect(takeover.fetch).not.toHaveBeenCalled();

    const release = harness(["api", "lease", "--session", "s1", "--client", "a1", "--release"]);
    expect(await release.run()).toBe(2);
    expect(release.err.join("")).toContain("requires --lease");
    expect(release.fetch).not.toHaveBeenCalled();

    const revoke = harness(["api", "lease", "--session", "s1", "--revoke"]);
    expect(await revoke.run()).toBe(2);
    expect(revoke.err.join("")).toContain("requires --confirm");
    expect(revoke.fetch).not.toHaveBeenCalled();
  });

  test("administrator revoke requires no client identity and does not acquire ownership", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () => new Response(JSON.stringify({ lease: null, revoked: true }), { status: 200 }),
    );
    const test = harness(["api", "lease", "--session", "s1", "--revoke", "--confirm"], fetch);
    expect(await test.run()).toBe(0);
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({
      action: "revoke",
      confirm: true,
    });
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
