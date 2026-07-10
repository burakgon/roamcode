import { mkdtemp, rm, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createServer, RateLimiter, AuthGate, TerminalManager, openSessionStore } from "../src/index.js";
import type { ServerRuntimeConfig, CreateServerResult, CreateServerDeps } from "../src/index.js";

// Covers the SECURITY HARDENING batch at the transport layer: the Origin/CSWSH guard, the global
// rate limiter (preHandler), the concurrency cap on POST /sessions, and POST /token/rotate.

const TOKEN = "test-token";

/** A fake pty spawn so terminal-session creates don't touch real tmux/node-pty. */
function fakePtySpawn(): (file: string, args: string[]) => EventEmitter {
  return () => {
    const ee = new EventEmitter() as EventEmitter & {
      write(d: string): void;
      resize(c: number, r: number): void;
      kill(): void;
      onData(cb: (d: string) => void): void;
      onExit(cb: (e: { exitCode: number }) => void): void;
    };
    ee.write = () => {};
    ee.resize = () => {};
    ee.kill = () => {};
    ee.onData = (cb) => void ee.on("data", cb);
    ee.onExit = (cb) => void ee.on("exit", cb);
    return ee;
  };
}

let dir: string;
let current: CreateServerResult | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "rc-sec-"));
});
afterEach(async () => {
  if (current) await current.app.close();
  current = undefined;
  await rm(dir, { recursive: true, force: true });
});

function configFor(over: Partial<ServerRuntimeConfig> = {}): ServerRuntimeConfig {
  return {
    port: 0,
    bindAddress: "127.0.0.1",
    accessToken: TOKEN,
    fsRoot: dir,
    maxUploadBytes: 26214400,
    dataDir: dir,
    allowedOrigins: [],
    rateLimitRpm: 600,
    rateLimitBurst: 120,
    maxSessions: 25,
    claude: { claudeBin: process.execPath },
    ...over,
  };
}

function makeServer(over: Partial<ServerRuntimeConfig> = {}, deps: CreateServerDeps = {}): CreateServerResult {
  const config = configFor(over);
  const store = deps.store ?? openSessionStore({ dbPath: ":memory:" });
  const terminalManager = new TerminalManager({
    store,
    claudeBin: config.claude.claudeBin,
    now: () => Date.now(),
    ptySpawn: fakePtySpawn() as never,
    runTmux: () => {},
  });
  return createServer(config, { store, terminalAvailable: true, terminalManager, ...deps });
}

const auth = { authorization: `Bearer ${TOKEN}` };

// ─────────────────────────────────── Origin / CSWSH guard ───────────────────────────────────

test("ORIGIN: an absent Origin is allowed (native clients / same-origin nav omit it)", async () => {
  current = makeServer();
  const res = await current.app.inject({ method: "GET", url: "/sessions", headers: auth });
  expect(res.statusCode).toBe(200);
});

test("ORIGIN: a same-origin request (Origin host == Host) is allowed", async () => {
  current = makeServer();
  const res = await current.app.inject({
    method: "GET",
    url: "/sessions",
    headers: { ...auth, host: "remotecode.example.com", origin: "https://remotecode.example.com" },
  });
  expect(res.statusCode).toBe(200);
});

test("ORIGIN: the configured public URL origin is allowed even when Host differs (behind a tunnel)", async () => {
  current = makeServer({ publicUrl: "https://remotecode.bgn.capital" });
  const res = await current.app.inject({
    method: "GET",
    url: "/sessions",
    headers: { ...auth, host: "127.0.0.1:4280", origin: "https://remotecode.bgn.capital" },
  });
  expect(res.statusCode).toBe(200);
});

test("ORIGIN: a foreign, non-allow-listed Origin is REJECTED 403 (even with a valid token)", async () => {
  current = makeServer({ publicUrl: "https://remotecode.bgn.capital" });
  const res = await current.app.inject({
    method: "GET",
    url: "/sessions",
    headers: { ...auth, host: "127.0.0.1:4280", origin: "https://evil.example" },
  });
  expect(res.statusCode).toBe(403);
});

test("ORIGIN: ROAMCODE_ALLOWED_ORIGINS extends the allow-list", async () => {
  current = makeServer({ allowedOrigins: ["https://my-frontend.example"] });
  const ok = await current.app.inject({
    method: "GET",
    url: "/sessions",
    headers: { ...auth, host: "127.0.0.1:4280", origin: "https://my-frontend.example" },
  });
  expect(ok.statusCode).toBe(200);
  const nope = await current.app.inject({
    method: "GET",
    url: "/sessions",
    headers: { ...auth, host: "127.0.0.1:4280", origin: "https://unknown.example" },
  });
  expect(nope.statusCode).toBe(403);
});

// ─────────────────────────────────── Global rate limiter ───────────────────────────────────

test("RATE LIMIT: under-limit requests pass; a burst over the limit gets 429 + Retry-After", async () => {
  const t = 0;
  // A tiny injected limiter: burst 3, slow refill — the 4th immediate request is denied.
  const rateLimiter = new RateLimiter({ capacity: 60, windowMs: 60_000, burst: 3, now: () => t });
  current = makeServer({}, { rateLimiter });
  for (let i = 0; i < 3; i++) {
    const ok = await current.app.inject({ method: "GET", url: "/sessions", headers: auth });
    expect(ok.statusCode).toBe(200);
  }
  const limited = await current.app.inject({ method: "GET", url: "/sessions", headers: auth });
  expect(limited.statusCode).toBe(429);
  expect(Number(limited.headers["retry-after"])).toBeGreaterThanOrEqual(1);
});

test("RATE LIMIT: /health is never throttled (liveness probe stays up under a flood)", async () => {
  const t = 0;
  const rateLimiter = new RateLimiter({ capacity: 60, windowMs: 60_000, burst: 1, now: () => t });
  current = makeServer({}, { rateLimiter });
  // Exhaust the bucket on an API route...
  await current.app.inject({ method: "GET", url: "/sessions", headers: auth });
  // ...then hammer /health: it bypasses the gate + limiter entirely.
  for (let i = 0; i < 10; i++) {
    const h = await current.app.inject({ method: "GET", url: "/health" });
    expect(h.statusCode).toBe(200);
    expect(h.json()).toEqual({ ok: true });
  }
});

test("RATE LIMIT: rpm=0 disables the limiter (no 429 under a sustained burst)", async () => {
  current = makeServer({ rateLimitRpm: 0 });
  for (let i = 0; i < 50; i++) {
    const res = await current.app.inject({ method: "GET", url: "/sessions", headers: auth });
    expect(res.statusCode).toBe(200);
  }
});

test("RATE LIMIT: the /images exemption does NOT bypass auth — a tokenless image GET still 401s", async () => {
  current = makeServer();
  const noTok = await current.app.inject({ method: "GET", url: "/images/whatever.png" });
  expect(noTok.statusCode).toBe(401);
});

test("RATE LIMIT: the /images exemption does NOT bypass the origin guard — a foreign-origin image GET is 403", async () => {
  current = makeServer({ publicUrl: "https://remotecode.bgn.capital" });
  const res = await current.app.inject({
    method: "GET",
    url: "/images/whatever.png?token=" + TOKEN,
    headers: { host: "127.0.0.1:4280", origin: "https://evil.example" },
  });
  expect(res.statusCode).toBe(403);
});

// ─────────────────────────────────── Concurrency cap ───────────────────────────────────

test("CONCURRENCY: at the live cap a new POST /sessions is refused 429; under the cap it succeeds", async () => {
  current = makeServer({ maxSessions: 2 });
  const create = () =>
    current!.app.inject({ method: "POST", url: "/sessions", headers: auth, payload: { cwd: process.cwd() } });

  const a = await create();
  expect(a.statusCode).toBe(201);
  const b = await create();
  expect(b.statusCode).toBe(201);
  // Third create is at the cap → refused.
  const c = await create();
  expect(c.statusCode).toBe(429);
  expect(c.json().error).toMatch(/cap/i);

  // Closing one frees a slot → the next create succeeds again (existing sessions unaffected).
  const delRes = await current.app.inject({ method: "DELETE", url: `/sessions/${a.json().session.id}`, headers: auth });
  expect(delRes.statusCode).toBe(204);
  const d = await create();
  expect(d.statusCode).toBe(201);
});

test("CONCURRENCY: maxSessions=0 disables the cap (unbounded creates)", async () => {
  current = makeServer({ maxSessions: 0 });
  for (let i = 0; i < 5; i++) {
    const res = await current.app.inject({
      method: "POST",
      url: "/sessions",
      headers: auth,
      payload: { cwd: process.cwd() },
    });
    expect(res.statusCode).toBe(201);
  }
});

// ─────────────────────────────────── Token rotation ───────────────────────────────────

test("ROTATE: returns a NEW token; with no grace the old token is rejected and the new one works", async () => {
  let n = 0;
  const generateToken = () => `rotated-token-${++n}`;
  // graceMs:0 → no dual-token window, so the old token dies the instant rotation completes.
  const authGate = new AuthGate({ token: TOKEN, graceMs: 0 });
  current = makeServer({}, { generateToken, authGate });

  const rotated = await current.app.inject({ method: "POST", url: "/token/rotate", headers: auth });
  expect(rotated.statusCode).toBe(200);
  const next = rotated.json().token as string;
  expect(next).toBe("rotated-token-1");

  // The OLD token is now invalid (no grace).
  const oldTok = await current.app.inject({ method: "GET", url: "/sessions", headers: auth });
  expect(oldTok.statusCode).toBe(401);
  // The NEW token works.
  const newTok = await current.app.inject({
    method: "GET",
    url: "/sessions",
    headers: { authorization: `Bearer ${next}` },
  });
  expect(newTok.statusCode).toBe(200);

  // It was persisted to the 0600 token file.
  const persisted = (await readFile(join(dir, "token"), "utf8")).trim();
  expect(persisted).toBe(next);
  expect((await stat(join(dir, "token"))).mode & 0o777).toBe(0o600);
});

test("ROTATE: grace window keeps the OLD token working (in-flight mcp-send callbacks survive rotation)", async () => {
  let t = 1000;
  let n = 0;
  const generateToken = () => `rotated-token-${++n}`;
  // A real grace window with a controllable clock: the old token survives for graceMs after rotation.
  const authGate = new AuthGate({ token: TOKEN, graceMs: 60_000, now: () => t });
  current = makeServer({}, { generateToken, authGate });

  const rotated = await current.app.inject({ method: "POST", url: "/token/rotate", headers: auth });
  const next = rotated.json().token as string;

  // Within the grace window the OLD token (an in-flight subprocess holds it) still authenticates.
  const oldInGrace = await current.app.inject({ method: "GET", url: "/sessions", headers: auth });
  expect(oldInGrace.statusCode).toBe(200);
  // The NEW token works too.
  const newTok = await current.app.inject({
    method: "GET",
    url: "/sessions",
    headers: { authorization: `Bearer ${next}` },
  });
  expect(newTok.statusCode).toBe(200);

  // Past the grace window the OLD token is dead.
  t += 61_000;
  const oldAfter = await current.app.inject({ method: "GET", url: "/sessions", headers: auth });
  expect(oldAfter.statusCode).toBe(401);
});

test("ROTATE: unauthed rotate is 401 (and does NOT change the token)", async () => {
  current = makeServer();
  const res = await current.app.inject({ method: "POST", url: "/token/rotate" });
  expect(res.statusCode).toBe(401);
  // The original token still works (rotation never ran).
  const stillOk = await current.app.inject({ method: "GET", url: "/sessions", headers: auth });
  expect(stillOk.statusCode).toBe(200);
});

test("ROTATE: the default CSPRNG generator produces a fresh strong token when none is injected", async () => {
  current = makeServer();
  const rotated = await current.app.inject({ method: "POST", url: "/token/rotate", headers: auth });
  expect(rotated.statusCode).toBe(200);
  const next = rotated.json().token as string;
  expect(next).toMatch(/^[A-Za-z0-9_-]{43,}$/); // 32-byte base64url
  expect(next).not.toBe(TOKEN);
});
