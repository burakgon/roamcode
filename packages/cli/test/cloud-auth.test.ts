import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { parseArgs } from "../src/args.js";
import {
  CLOUD_AUTH_PATHS,
  createBrowserOpener,
  createCloudCredentialStore,
  normalizeControlPlaneOrigin,
  redactCloudAuthSecrets,
  runCloudAuthCommand,
  type CloudCredentialStore,
  type ProcessInvocation,
  type ProcessResult,
  type StoredCloudSession,
} from "../src/cloud-auth.js";
import { runCloudCommand } from "../src/cloud.js";

const DEVICE_TOKEN = `device_${"d".repeat(32)}`;
const ACCESS_TOKEN = `access_${"a".repeat(32)}`;
const NEXT_ACCESS_TOKEN = `access_${"n".repeat(32)}`;
const REFRESH_TOKEN = `refresh_${"r".repeat(32)}`;
const NEXT_REFRESH_TOKEN = `refresh_${"n".repeat(32)}`;
const NOW = 1_750_000_000_000;
const directories: string[] = [];

afterEach(() => {
  while (directories.length > 0) rmSync(directories.pop()!, { recursive: true, force: true });
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "roamcode-cloud-auth-"));
  directories.push(directory);
  return directory;
}

function jsonResponse(body: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(body === undefined ? undefined : JSON.stringify(body), {
    status,
    headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
  });
}

function deviceAuthorization(overrides: Record<string, unknown> = {}) {
  return {
    device_code: DEVICE_TOKEN,
    user_code: "ABCD-EFGH",
    verification_uri: "https://cloud.example.test/activate",
    verification_uri_complete: "https://cloud.example.test/activate?user_code=ABCD-EFGH",
    expires_in: 120,
    interval: 2,
    ...overrides,
  };
}

function tokenResponse(overrides: Record<string, unknown> = {}) {
  return {
    access_token: ACCESS_TOKEN,
    refresh_token: REFRESH_TOKEN,
    token_type: "Bearer",
    expires_in: 3_600,
    refresh_token_expires_in: 2_592_000,
    scope: "identity profile email offline_access organizations hosts hosts:write",
    ...overrides,
  };
}

function storedSession(overrides: Partial<StoredCloudSession> = {}): StoredCloudSession {
  return {
    version: 1,
    controlPlaneOrigin: "https://cloud.example.test",
    accessToken: ACCESS_TOKEN,
    refreshToken: REFRESH_TOKEN,
    tokenType: "Bearer",
    accessTokenExpiresAt: NOW + 3_600_000,
    refreshTokenExpiresAt: NOW + 2_592_000_000,
    issuedAt: NOW,
    scope: "identity profile email offline_access organizations hosts hosts:write",
    ...overrides,
  };
}

function memoryStore(initial?: StoredCloudSession) {
  let session = initial;
  const store: CloudCredentialStore = {
    read: vi.fn(async () => session),
    write: vi.fn(async (next) => {
      session = next;
    }),
    remove: vi.fn(async () => {
      const existed = session !== undefined;
      session = undefined;
      return existed;
    }),
  };
  return { store, current: () => session };
}

function outputs() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, stdout: (value: string) => out.push(value), stderr: (value: string) => err.push(value) };
}

describe("cloud device authorization", () => {
  test("polls the RFC 8628 grant, opens the trusted verification URL, and stores only rotating tokens", async () => {
    const auth = memoryStore();
    const io = outputs();
    let clock = NOW;
    const sleep = vi.fn(async (milliseconds: number) => {
      clock += milliseconds;
    });
    const openBrowser = vi.fn(async () => true);
    const fetch = vi
      .fn()
      .mockImplementationOnce(async (url: URL, init: RequestInit) => {
        expect(String(url)).toBe(`https://cloud.example.test${CLOUD_AUTH_PATHS.authorize}`);
        expect(init.method).toBe("POST");
        expect(init.redirect).toBe("error");
        expect(init.signal).toBeInstanceOf(AbortSignal);
        const form = new URLSearchParams(String(init.body));
        expect(form.get("client_id")).toBe("roamcode-cli");
        expect(form.get("scope")).toBe("identity profile email offline_access organizations hosts hosts:write");
        expect(form.get("scope")).not.toContain("openid");
        return jsonResponse(deviceAuthorization());
      })
      .mockResolvedValueOnce(jsonResponse({ error: "authorization_pending" }, 400))
      .mockResolvedValueOnce(jsonResponse({ error: "slow_down" }, 400))
      .mockImplementationOnce(async (_url: URL, init: RequestInit) => {
        const form = new URLSearchParams(String(init.body));
        expect(form.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:device_code");
        expect(form.get("device_code")).toBe(DEVICE_TOKEN);
        return jsonResponse(tokenResponse());
      }) as unknown as typeof globalThis.fetch;

    const code = await runCloudCommand({
      options: parseArgs(["cloud", "login", "--control-plane-url", "https://cloud.example.test"]),
      env: {},
      dataDir: "/isolated/data",
      fetch,
      authCredentialStore: auth.store,
      openBrowser,
      sleep,
      now: () => clock,
      stdout: io.stdout,
      stderr: io.stderr,
    });

    expect(code, io.err.join("")).toBe(0);
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(openBrowser).toHaveBeenCalledWith("https://cloud.example.test/activate?user_code=ABCD-EFGH");
    expect(sleep.mock.calls.map(([milliseconds]) => milliseconds)).toEqual([2_000, 2_000, 7_000]);
    expect(auth.current()).toMatchObject({
      accessToken: ACCESS_TOKEN,
      refreshToken: REFRESH_TOKEN,
      controlPlaneOrigin: "https://cloud.example.test",
      accessTokenExpiresAt: clock + 3_600_000,
    });
    const transcript = `${io.out.join("")} ${io.err.join("")}`;
    expect(transcript).toContain("ABCD-EFGH");
    expect(transcript).toContain("Signed in to RoamCode Cloud");
    expect(transcript).not.toContain(DEVICE_TOKEN);
    expect(transcript).not.toContain(ACCESS_TOKEN);
    expect(transcript).not.toContain(REFRESH_TOKEN);
  });

  test("does not start another authorization while a session exists", async () => {
    const auth = memoryStore(storedSession());
    const io = outputs();
    const fetch = vi.fn();
    const openBrowser = vi.fn();

    const code = await runCloudCommand({
      options: parseArgs(["cloud", "login"]),
      env: {},
      dataDir: "/isolated/data",
      fetch: fetch as unknown as typeof globalThis.fetch,
      authCredentialStore: auth.store,
      openBrowser,
      stdout: io.stdout,
      stderr: io.stderr,
    });

    expect(code).toBe(2);
    expect(fetch).not.toHaveBeenCalled();
    expect(openBrowser).not.toHaveBeenCalled();
    expect(io.err.join("")).toContain("already signed in");
  });

  test("rejects an off-origin verification URL before opening a browser or polling", async () => {
    const auth = memoryStore();
    const io = outputs();
    const openBrowser = vi.fn();
    const fetch = vi.fn(async () =>
      jsonResponse(deviceAuthorization({ verification_uri: "https://phishing.example/activate" })),
    ) as unknown as typeof globalThis.fetch;

    const code = await runCloudCommand({
      options: parseArgs(["cloud", "login", "--control-plane-url", "https://cloud.example.test"]),
      env: {},
      dataDir: "/isolated/data",
      fetch,
      authCredentialStore: auth.store,
      openBrowser,
      sleep: vi.fn(),
      now: () => NOW,
      stdout: io.stdout,
      stderr: io.stderr,
    });

    expect(code).toBe(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(openBrowser).not.toHaveBeenCalled();
    expect(auth.store.write).not.toHaveBeenCalled();
    expect(io.err.join("")).toContain("untrusted verification URL");
  });

  test("rejects a verification link that exposes the private device credential", async () => {
    const auth = memoryStore();
    const io = outputs();
    const openBrowser = vi.fn();
    const fetch = vi.fn(async () =>
      jsonResponse(
        deviceAuthorization({
          verification_uri_complete: `https://cloud.example.test/activate?device_code=${DEVICE_TOKEN}`,
        }),
      ),
    ) as unknown as typeof globalThis.fetch;

    const code = await runCloudCommand({
      options: parseArgs(["cloud", "login", "--control-plane-url", "https://cloud.example.test"]),
      env: {},
      dataDir: "/isolated/data",
      fetch,
      authCredentialStore: auth.store,
      openBrowser,
      stdout: io.stdout,
      stderr: io.stderr,
    });

    expect(code).toBe(1);
    expect(openBrowser).not.toHaveBeenCalled();
    expect(io.err.join("")).toContain("device credential");
    expect(io.err.join("")).not.toContain(DEVICE_TOKEN);
  });

  test("expires predictably without making a token request after the deadline", async () => {
    const auth = memoryStore();
    const io = outputs();
    let clock = NOW;
    const fetch = vi.fn(async () =>
      jsonResponse(deviceAuthorization({ expires_in: 30, interval: 30 })),
    ) as unknown as typeof globalThis.fetch;

    const code = await runCloudCommand({
      options: parseArgs(["cloud", "login", "--control-plane-url", "https://cloud.example.test"]),
      env: {},
      dataDir: "/isolated/data",
      fetch,
      authCredentialStore: auth.store,
      openBrowser: vi.fn(async () => false),
      sleep: async (milliseconds) => {
        clock += milliseconds;
      },
      now: () => clock,
      stdout: io.stdout,
      stderr: io.stderr,
    });

    expect(code).toBe(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(auth.store.write).not.toHaveBeenCalled();
    expect(io.err.join("")).toContain("expired before approval");
  });

  test("rejects oversized authorization responses without reflecting their contents", async () => {
    const auth = memoryStore();
    const io = outputs();
    const fetch = vi.fn(async () =>
      jsonResponse({ error: ACCESS_TOKEN }, 500, { "content-length": "70000" }),
    ) as unknown as typeof globalThis.fetch;

    const code = await runCloudCommand({
      options: parseArgs(["cloud", "login", "--control-plane-url", "https://cloud.example.test"]),
      env: {},
      dataDir: "/isolated/data",
      fetch,
      authCredentialStore: auth.store,
      openBrowser: vi.fn(),
      stdout: io.stdout,
      stderr: io.stderr,
    });

    expect(code).toBe(1);
    expect(io.err.join("")).toContain("oversized response");
    expect(io.err.join("")).not.toContain(ACCESS_TOKEN);
  });
});

describe("cloud session lifecycle", () => {
  test("uses one operation-lock namespace for the global macOS Keychain across data directories", async () => {
    const lockDirectory = temporaryDirectory();
    const firstDataDir = temporaryDirectory();
    const secondDataDir = temporaryDirectory();
    const firstIo = outputs();
    let markAuthorizationStarted!: () => void;
    const authorizationStarted = new Promise<void>((resolve) => {
      markAuthorizationStarted = resolve;
    });
    let finishAuthorization!: () => void;
    const authorizationGate = new Promise<void>((resolve) => {
      finishAuthorization = resolve;
    });
    const firstFetch = vi.fn(async () => {
      markAuthorizationStarted();
      await authorizationGate;
      return jsonResponse({ error: "temporarily_unavailable" }, 503);
    }) as unknown as typeof globalThis.fetch;
    const missingKeychain = vi.fn(async (): Promise<ProcessResult> => ({
      exitCode: 44,
      stdout: "",
      stderr: "not found",
    }));

    const first = runCloudAuthCommand({
      options: parseArgs(["cloud", "login", "--control-plane-url", "https://cloud.example.test"]),
      env: {},
      dataDir: firstDataDir,
      fetch: firstFetch,
      platform: "darwin",
      processRunner: missingKeychain,
      operationLockDirectory: lockDirectory,
      openBrowser: vi.fn(),
      stdout: firstIo.stdout,
      stderr: firstIo.stderr,
    });
    await authorizationStarted;

    const secondIo = outputs();
    const secondProcessRunner = vi.fn();
    const secondFetch = vi.fn();
    const second = await runCloudAuthCommand({
      options: parseArgs(["cloud", "login", "--control-plane-url", "https://cloud.example.test"]),
      env: {},
      dataDir: secondDataDir,
      fetch: secondFetch as unknown as typeof globalThis.fetch,
      platform: "darwin",
      processRunner: secondProcessRunner,
      operationLockDirectory: lockDirectory,
      openBrowser: vi.fn(),
      stdout: secondIo.stdout,
      stderr: secondIo.stderr,
    });

    expect(second).toBe(1);
    expect(secondProcessRunner).not.toHaveBeenCalled();
    expect(secondFetch).not.toHaveBeenCalled();
    expect(secondIo.err.join("")).toContain("another cloud authentication command is already running");

    finishAuthorization();
    expect(await first).toBe(1);
  });

  test("serializes refresh rotation across CLI processes so a losing refresh cannot erase the new session", async () => {
    const dataDir = temporaryDirectory();
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
    const store = createCloudCredentialStore({
      dataDir,
      platform: "linux",
      processRunner: vi.fn(),
      uid,
      pid: process.pid,
    });
    await store.write(storedSession({ accessTokenExpiresAt: NOW }));

    let markRefreshStarted!: () => void;
    const refreshStarted = new Promise<void>((resolve) => {
      markRefreshStarted = resolve;
    });
    let allowRefresh!: () => void;
    const refreshGate = new Promise<void>((resolve) => {
      allowRefresh = resolve;
    });
    const firstIo = outputs();
    const firstFetch = vi.fn(async (url: URL) => {
      if (url.pathname === CLOUD_AUTH_PATHS.token) {
        markRefreshStarted();
        await refreshGate;
        return jsonResponse(tokenResponse({ access_token: NEXT_ACCESS_TOKEN, refresh_token: NEXT_REFRESH_TOKEN }));
      }
      return jsonResponse({ user: { email: "ada@example.test" }, organization: null });
    }) as unknown as typeof globalThis.fetch;

    const first = runCloudAuthCommand({
      options: parseArgs(["cloud", "whoami"]),
      env: {},
      dataDir,
      fetch: firstFetch,
      now: () => NOW,
      platform: "linux",
      uid,
      stdout: firstIo.stdout,
      stderr: firstIo.stderr,
    });
    await refreshStarted;

    const secondIo = outputs();
    const secondFetch = vi.fn();
    const second = await runCloudAuthCommand({
      options: parseArgs(["cloud", "whoami"]),
      env: {},
      dataDir,
      fetch: secondFetch as unknown as typeof globalThis.fetch,
      now: () => NOW,
      platform: "linux",
      uid,
      stdout: secondIo.stdout,
      stderr: secondIo.stderr,
    });

    expect(second).toBe(1);
    expect(secondFetch).not.toHaveBeenCalled();
    expect(secondIo.err.join("")).toContain("another cloud authentication command is already running");

    allowRefresh();
    expect(await first, firstIo.err.join("")).toBe(0);
    expect(await store.read()).toMatchObject({
      accessToken: NEXT_ACCESS_TOKEN,
      refreshToken: NEXT_REFRESH_TOKEN,
    });
    expect(existsSync(join(dataDir, "cloud-auth-operation.lock"))).toBe(false);
  });

  test("recovers an operation lock left by a process that is no longer running", async () => {
    const dataDir = temporaryDirectory();
    const lockPath = join(dataDir, "cloud-auth-operation.lock");
    writeFileSync(
      lockPath,
      `${JSON.stringify({ pid: 2_147_483_647, createdAt: Date.now(), nonce: "a".repeat(24) })}\n`,
      { mode: 0o600 },
    );
    const io = outputs();
    const fetch = vi.fn();

    const code = await runCloudAuthCommand({
      options: parseArgs(["cloud", "logout"]),
      env: {},
      dataDir,
      fetch: fetch as unknown as typeof globalThis.fetch,
      platform: "linux",
      uid: typeof process.getuid === "function" ? process.getuid() : undefined,
      stdout: io.stdout,
      stderr: io.stderr,
    });

    expect(code, io.err.join("")).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
    expect(io.out.join("")).toContain("Not signed in");
    expect(existsSync(lockPath)).toBe(false);
  });

  test("whoami refreshes an expiring session, requires refresh rotation, and prints safe identity", async () => {
    const auth = memoryStore(storedSession({ accessTokenExpiresAt: NOW + 1_000 }));
    const io = outputs();
    const fetch = vi
      .fn()
      .mockImplementationOnce(async (url: URL, init: RequestInit) => {
        expect(String(url)).toBe(`https://cloud.example.test${CLOUD_AUTH_PATHS.token}`);
        const form = new URLSearchParams(String(init.body));
        expect(form.get("grant_type")).toBe("refresh_token");
        expect(form.get("refresh_token")).toBe(REFRESH_TOKEN);
        expect(String(url)).not.toContain(REFRESH_TOKEN);
        return jsonResponse(tokenResponse({ access_token: NEXT_ACCESS_TOKEN, refresh_token: NEXT_REFRESH_TOKEN }));
      })
      .mockImplementationOnce(async (url: URL, init: RequestInit) => {
        expect(String(url)).toBe(`https://cloud.example.test${CLOUD_AUTH_PATHS.me}`);
        expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${NEXT_ACCESS_TOKEN}`);
        return jsonResponse({
          user: { id: "usr_1", email: "ada@example.test", name: "Ada Lovelace" },
          organization: { id: "org_1", name: "Analytical Engines" },
        });
      }) as unknown as typeof globalThis.fetch;

    const code = await runCloudCommand({
      options: parseArgs(["cloud", "whoami"]),
      env: {},
      dataDir: "/isolated/data",
      fetch,
      authCredentialStore: auth.store,
      now: () => NOW,
      stdout: io.stdout,
      stderr: io.stderr,
    });

    expect(code, io.err.join("")).toBe(0);
    expect(auth.current()).toMatchObject({ accessToken: NEXT_ACCESS_TOKEN, refreshToken: NEXT_REFRESH_TOKEN });
    expect(io.out.join("")).toContain("Ada Lovelace <ada@example.test>");
    expect(io.out.join("")).toContain("Organization: Analytical Engines");
    const transcript = `${io.out.join("")} ${io.err.join("")}`;
    expect(transcript).not.toContain(ACCESS_TOKEN);
    expect(transcript).not.toContain(NEXT_ACCESS_TOKEN);
    expect(transcript).not.toContain(REFRESH_TOKEN);
    expect(transcript).not.toContain(NEXT_REFRESH_TOKEN);
  });

  test("whoami retries one 401 after rotating the session", async () => {
    const auth = memoryStore(storedSession());
    const io = outputs();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: "invalid_token" }, 401))
      .mockResolvedValueOnce(
        jsonResponse(tokenResponse({ access_token: NEXT_ACCESS_TOKEN, refresh_token: NEXT_REFRESH_TOKEN })),
      )
      .mockResolvedValueOnce(
        jsonResponse({ user: { email: "grace@example.test" }, organization: null }),
      ) as unknown as typeof globalThis.fetch;

    const code = await runCloudCommand({
      options: parseArgs(["cloud", "whoami"]),
      env: {},
      dataDir: "/isolated/data",
      fetch,
      authCredentialStore: auth.store,
      now: () => NOW,
      stdout: io.stdout,
      stderr: io.stderr,
    });

    expect(code, io.err.join("")).toBe(0);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(io.out.join("")).toContain("grace@example.test");
    expect(io.out.join("")).toContain("Organization: Not selected");
  });

  test("rejects a non-rotating refresh response without overwriting the stored session", async () => {
    const original = storedSession({ accessTokenExpiresAt: NOW });
    const auth = memoryStore(original);
    const io = outputs();
    const fetch = vi.fn(async () =>
      jsonResponse(tokenResponse({ access_token: NEXT_ACCESS_TOKEN, refresh_token: REFRESH_TOKEN })),
    ) as unknown as typeof globalThis.fetch;

    const code = await runCloudCommand({
      options: parseArgs(["cloud", "whoami"]),
      env: {},
      dataDir: "/isolated/data",
      fetch,
      authCredentialStore: auth.store,
      now: () => NOW,
      stdout: io.stdout,
      stderr: io.stderr,
    });

    expect(code).toBe(1);
    expect(auth.current()).toEqual(original);
    expect(auth.store.write).not.toHaveBeenCalled();
    expect(io.err.join("")).toContain("did not rotate");
    expect(io.err.join("")).not.toContain(REFRESH_TOKEN);
  });

  test("clears an expired session when refresh is rejected", async () => {
    const auth = memoryStore(storedSession({ accessTokenExpiresAt: NOW }));
    const io = outputs();
    const fetch = vi.fn(async () =>
      jsonResponse({ error: "invalid_grant" }, 400),
    ) as unknown as typeof globalThis.fetch;

    const code = await runCloudCommand({
      options: parseArgs(["cloud", "whoami"]),
      env: {},
      dataDir: "/isolated/data",
      fetch,
      authCredentialStore: auth.store,
      now: () => NOW,
      stdout: io.stdout,
      stderr: io.stderr,
    });

    expect(code).toBe(1);
    expect(auth.current()).toBeUndefined();
    expect(auth.store.remove).toHaveBeenCalledOnce();
    expect(io.err.join("")).toContain("session expired");
  });

  test("logout always removes local credentials and reports an unconfirmed remote revocation", async () => {
    const auth = memoryStore(storedSession());
    const io = outputs();
    const fetch = vi.fn(async () => {
      throw new Error(`network error ${REFRESH_TOKEN}`);
    }) as unknown as typeof globalThis.fetch;

    const code = await runCloudCommand({
      options: parseArgs(["cloud", "logout"]),
      env: {},
      dataDir: "/isolated/data",
      fetch,
      authCredentialStore: auth.store,
      stdout: io.stdout,
      stderr: io.stderr,
    });

    expect(code).toBe(1);
    expect(auth.current()).toBeUndefined();
    expect(io.err.join("")).toContain("Signed out locally");
    expect(io.err.join("")).not.toContain(REFRESH_TOKEN);
  });

  test("logout revokes the refresh credential before removing local state", async () => {
    const auth = memoryStore(storedSession());
    const io = outputs();
    const fetch = vi.fn(async (url: URL, init: RequestInit) => {
      expect(String(url)).toBe(`https://cloud.example.test${CLOUD_AUTH_PATHS.revoke}`);
      expect(init.redirect).toBe("error");
      const form = new URLSearchParams(String(init.body));
      expect(form.get("token")).toBe(REFRESH_TOKEN);
      expect(form.get("token_type_hint")).toBe("refresh_token");
      expect(String(url)).not.toContain(REFRESH_TOKEN);
      return new Response(undefined, { status: 204 });
    }) as unknown as typeof globalThis.fetch;

    const code = await runCloudCommand({
      options: parseArgs(["cloud", "logout"]),
      env: {},
      dataDir: "/isolated/data",
      fetch,
      authCredentialStore: auth.store,
      stdout: io.stdout,
      stderr: io.stderr,
    });

    expect(code, io.err.join("")).toBe(0);
    expect(auth.current()).toBeUndefined();
    expect(io.out.join("")).toContain("Signed out of RoamCode Cloud");
    expect(`${io.out.join("")} ${io.err.join("")}`).not.toContain(REFRESH_TOKEN);
  });

  test("logout is idempotent when there is no local session", async () => {
    const auth = memoryStore();
    const io = outputs();
    const fetch = vi.fn();
    const code = await runCloudCommand({
      options: parseArgs(["cloud", "logout"]),
      env: {},
      dataDir: "/isolated/data",
      fetch: fetch as unknown as typeof globalThis.fetch,
      authCredentialStore: auth.store,
      stdout: io.stdout,
      stderr: io.stderr,
    });
    expect(code).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
    expect(io.out.join("")).toContain("Not signed in");
  });

  test("logout can recover by removing a malformed local session", async () => {
    const io = outputs();
    const store: CloudCredentialStore = {
      read: vi.fn(async () => {
        throw new Error("malformed credential payload");
      }),
      write: vi.fn(),
      remove: vi.fn(async () => true),
    };
    const fetch = vi.fn();
    const code = await runCloudCommand({
      options: parseArgs(["cloud", "logout"]),
      env: {},
      dataDir: "/isolated/data",
      fetch: fetch as unknown as typeof globalThis.fetch,
      authCredentialStore: store,
      stdout: io.stdout,
      stderr: io.stderr,
    });
    expect(code).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
    expect(store.remove).toHaveBeenCalledOnce();
    expect(io.out.join("")).toContain("Removed an invalid local");
  });
});

describe("cloud credential persistence", () => {
  test("uses an atomic mode-0600 JSON fallback away from macOS", async () => {
    const dataDir = temporaryDirectory();
    const runProcess = vi.fn();
    const store = createCloudCredentialStore({
      dataDir,
      platform: "linux",
      processRunner: runProcess,
      uid: typeof process.getuid === "function" ? process.getuid() : undefined,
      pid: 42,
      randomId: () => "fixed",
    });

    await store.write(storedSession());
    const path = join(dataDir, "cloud-session.json");
    expect(existsSync(path)).toBe(true);
    expect(lstatSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, "utf8")).not.toContain("fixed.tmp");
    expect(await store.read()).toEqual(storedSession());
    expect(runProcess).not.toHaveBeenCalled();
    expect(await store.remove()).toBe(true);
    expect(existsSync(path)).toBe(false);
  });

  test("refuses a symlink at the fallback credential path", async () => {
    const dataDir = temporaryDirectory();
    const target = join(dataDir, "target");
    const path = join(dataDir, "cloud-session.json");
    symlinkSync(target, path);
    const store = createCloudCredentialStore({
      dataDir,
      platform: "linux",
      processRunner: vi.fn(),
      uid: typeof process.getuid === "function" ? process.getuid() : undefined,
      pid: 42,
    });
    await expect(store.write(storedSession())).rejects.toThrow(/regular file|symlink/);
    expect(existsSync(target)).toBe(false);
  });

  test("uses macOS Keychain with the secret on stdin, never in process arguments", async () => {
    const dataDir = temporaryDirectory();
    let keychainValue: string | undefined;
    const invocations: ProcessInvocation[] = [];
    const runProcess = vi.fn(async (invocation: ProcessInvocation): Promise<ProcessResult> => {
      invocations.push(invocation);
      if (invocation.args[0] === "add-generic-password") {
        keychainValue = invocation.stdin?.trim();
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (invocation.args[0] === "find-generic-password") {
        return keychainValue
          ? { exitCode: 0, stdout: `${keychainValue}\n`, stderr: "" }
          : { exitCode: 44, stdout: "", stderr: "not found" };
      }
      keychainValue = undefined;
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    const store = createCloudCredentialStore({
      dataDir,
      platform: "darwin",
      processRunner: runProcess,
      uid: typeof process.getuid === "function" ? process.getuid() : undefined,
      pid: 42,
    });

    await store.write(storedSession());
    expect(await store.read()).toEqual(storedSession());
    expect(await store.remove()).toBe(true);
    expect(invocations.map((item) => item.args[0])).toEqual([
      "add-generic-password",
      "find-generic-password",
      "delete-generic-password",
    ]);
    const write = invocations[0]!;
    expect(write.args.at(-1)).toBe("-w");
    expect(write.stdin).toContain(REFRESH_TOKEN);
    expect(write.args.join(" ")).not.toContain(ACCESS_TOKEN);
    expect(write.args.join(" ")).not.toContain(REFRESH_TOKEN);
    expect(existsSync(join(dataDir, "cloud-session.json"))).toBe(false);
  });

  test("falls back to the private file if the security executable is unavailable", async () => {
    const dataDir = temporaryDirectory();
    const runProcess = vi.fn(async (): Promise<ProcessResult> => ({
      exitCode: null,
      stdout: "",
      stderr: "",
      errorCode: "ENOENT",
    }));
    const store = createCloudCredentialStore({
      dataDir,
      platform: "darwin",
      processRunner: runProcess,
      uid: typeof process.getuid === "function" ? process.getuid() : undefined,
      pid: 42,
    });
    await store.write(storedSession());
    expect(await store.read()).toEqual(storedSession());
    expect(lstatSync(join(dataDir, "cloud-session.json")).mode & 0o777).toBe(0o600);
  });

  test("refuses a group-readable fallback file", async () => {
    const dataDir = temporaryDirectory();
    const store = createCloudCredentialStore({
      dataDir,
      platform: "linux",
      processRunner: vi.fn(),
      uid: typeof process.getuid === "function" ? process.getuid() : undefined,
      pid: 42,
    });
    await store.write(storedSession());
    chmodSync(join(dataDir, "cloud-session.json"), 0o640);
    await expect(store.read()).rejects.toThrow(/chmod 600/);
  });
});

describe("browser and origin safety", () => {
  test("opens browsers without a shell on each supported platform", async () => {
    const cases: Array<[NodeJS.Platform, string, string[]]> = [
      ["darwin", "open", ["https://cloud.example.test/activate?user_code=ABCD"]],
      ["linux", "xdg-open", ["https://cloud.example.test/activate?user_code=ABCD"]],
      ["win32", "rundll32.exe", ["url.dll,FileProtocolHandler", "https://cloud.example.test/activate?user_code=ABCD"]],
    ];
    for (const [platform, executable, args] of cases) {
      const detachedProcessRunner = vi.fn(async () => undefined);
      const open = createBrowserOpener({ platform, detachedProcessRunner });
      expect(await open("https://cloud.example.test/activate?user_code=ABCD")).toBe(true);
      expect(detachedProcessRunner).toHaveBeenCalledWith(executable, args);
    }
  });

  test("does not open public HTTP, credential-bearing, or fragment URLs", async () => {
    const detachedProcessRunner = vi.fn();
    const open = createBrowserOpener({ platform: "linux", detachedProcessRunner });
    expect(await open("http://cloud.example.test/activate")).toBe(false);
    expect(await open("https://user:pass@cloud.example.test/activate")).toBe(false);
    expect(await open("https://cloud.example.test/activate#secret")).toBe(false);
    expect(detachedProcessRunner).not.toHaveBeenCalled();
  });

  test("accepts HTTPS and loopback HTTP control-plane origins only", () => {
    expect(normalizeControlPlaneOrigin("https://cloud.example.test/")).toBe("https://cloud.example.test");
    expect(normalizeControlPlaneOrigin("http://127.0.0.1:3000")).toBe("http://127.0.0.1:3000");
    expect(() => normalizeControlPlaneOrigin("http://cloud.example.test")).toThrow(/HTTPS origin/);
    expect(() => normalizeControlPlaneOrigin("https://cloud.example.test/api")).toThrow(/without credentials/);
  });

  test("redacts explicit and field-shaped secrets", () => {
    expect(
      redactCloudAuthSecrets(`refresh_token=${REFRESH_TOKEN}; device_token=${DEVICE_TOKEN}; opaque=${ACCESS_TOKEN}`, [
        ACCESS_TOKEN,
      ]),
    ).not.toMatch(new RegExp([REFRESH_TOKEN, DEVICE_TOKEN, ACCESS_TOKEN].join("|")));
  });
});
