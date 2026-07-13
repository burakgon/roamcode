import { describe, expect, test, vi } from "vitest";
import { runStatus } from "../src/status.js";
import type { StatusDeps } from "../src/status.js";

/**
 * Build fully-faked deps: an in-memory "filesystem" (path → contents; missing paths throw like
 * readFileSync) and a fetch faked per-route. No real network, ports, or data dir anywhere.
 */
function fakeDeps(opts: {
  files?: Record<string, string>;
  env?: NodeJS.ProcessEnv;
  health?: boolean | "throw";
  version?: { status: number; body?: unknown };
}): { deps: StatusDeps; out: string[]; fetched: string[]; headers: Record<string, string>[] } {
  const out: string[] = [];
  const fetched: string[] = [];
  const headers: Record<string, string>[] = [];
  const files = opts.files ?? {};
  const readFile = (p: string): string => {
    // Normalize separators so the same fake files work on Windows (join uses "\") and POSIX.
    const key = p.replaceAll("\\", "/");
    if (key in files) return files[key] as string;
    throw new Error(`ENOENT: ${p}`);
  };
  const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    fetched.push(url);
    headers.push((init?.headers as Record<string, string>) ?? {});
    if (url.endsWith("/health")) {
      if (opts.health === "throw") throw new Error("ECONNREFUSED");
      return { ok: opts.health === true, json: async () => ({ ok: true }) } as Response;
    }
    if (url.endsWith("/version")) {
      const v = opts.version ?? { status: 401 };
      return { ok: v.status === 200, status: v.status, json: async () => v.body } as Response;
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as unknown as typeof fetch;
  const deps: StatusDeps = {
    dataDir: "/data",
    env: opts.env ?? {},
    stdout: (s) => out.push(s),
    fetchFn,
    readFile,
  };
  return { deps, out, fetched, headers };
}

/** The /version payload carries the presentation label plus the unprefixed running SemVer. */
const REAL_VERSION_BODY = { current: "v1.2.3", runningVersion: "1.2.3" };

describe("roamcode status", () => {
  test("no service installed + nothing listening → says so and exits 1", async () => {
    const { deps, out } = fakeDeps({ health: "throw" });
    const code = await runStatus(deps);
    expect(code).toBe(1);
    const text = out.join("");
    expect(text).toContain("none installed");
    expect(text).toContain("roamcode install");
    expect(text).toContain("not reachable at http://127.0.0.1:4280");
  });

  test("service + server up + explicit ACCESS_TOKEN → one accurate release label", async () => {
    const { deps, out } = fakeDeps({
      files: { "/data/service.json": JSON.stringify({ manager: "systemd", label: "roamcode" }) },
      env: { ACCESS_TOKEN: "tok_env" },
      health: true,
      version: { status: 200, body: REAL_VERSION_BODY },
    });
    const code = await runStatus(deps);
    expect(code).toBe(0);
    const text = out.join("");
    expect(text).toContain("Service: systemd · roamcode");
    expect(text).toContain("running at http://127.0.0.1:4280 (v1.2.3)\n");
  });

  test("explicit ACCESS_TOKEN is sent as the Authorization bearer on /version", async () => {
    const { deps, fetched, headers } = fakeDeps({
      env: { ACCESS_TOKEN: "tok_env" },
      health: true,
      version: { status: 200, body: REAL_VERSION_BODY },
    });
    await runStatus(deps);
    const versionIdx = fetched.findIndex((u) => u.endsWith("/version"));
    expect(versionIdx).toBeGreaterThan(-1);
    expect(headers[versionIdx]).toMatchObject({ authorization: "Bearer tok_env" });
  });

  test("SECURITY: a persisted token file is never transmitted — no ACCESS_TOKEN, no /version call", async () => {
    const { deps, out, fetched } = fakeDeps({
      files: { "/data/token": "tok_persisted\n" },
      health: true,
    });
    const code = await runStatus(deps);
    expect(code).toBe(0);
    // Reachability is still reported, but nothing was sent to the (possibly foreign) listener.
    expect(out.join("")).toContain("running at http://127.0.0.1:4280\n");
    expect(fetched.some((u) => u.endsWith("/version"))).toBe(false);
  });

  test("the server's current release label remains authoritative during install drift", async () => {
    const { deps, out } = fakeDeps({
      env: { ACCESS_TOKEN: "tok_env" },
      health: true,
      version: { status: 200, body: { current: "v1.2.3", runningVersion: "1.2.2" } },
    });
    await runStatus(deps);
    expect(out.join("")).toContain("(v1.2.3)");
  });

  test("release-feed fallback reports the running package version", async () => {
    const { deps, out } = fakeDeps({
      env: { ACCESS_TOKEN: "tok_env" },
      health: true,
      version: { status: 200, body: { current: "—", runningVersion: "1.2.3" } },
    });
    await runStatus(deps);
    expect(out.join("")).toContain("(v1.2.3)");
  });

  test("a rejected /version (rotated token → 401) degrades to plain 'running', not an error", async () => {
    const { deps, out } = fakeDeps({
      env: { ACCESS_TOKEN: "tok_stale" },
      health: true,
      version: { status: 401 },
    });
    const code = await runStatus(deps);
    expect(code).toBe(0);
    // The newline right after the URL proves no "(v… · sha)" detail was appended.
    expect(out.join("")).toContain("running at http://127.0.0.1:4280\n");
  });

  test("PORT env picks the probe target", async () => {
    const { deps, out, fetched } = fakeDeps({
      env: { PORT: "5310" },
      health: true,
    });
    const code = await runStatus(deps);
    expect(code).toBe(0);
    expect(out.join("")).toContain("running at http://127.0.0.1:5310");
    expect(fetched.every((u) => u.includes(":5310/"))).toBe(true);
  });

  test("PORT=0 (serve-time 'pick a free port') falls back to probing the default 4280", async () => {
    const { deps, fetched } = fakeDeps({ env: { PORT: "0" }, health: true });
    await runStatus(deps);
    expect(fetched[0]).toContain(":4280/");
  });

  test("PORT outside 1..65535 follows the server config contract: default, not a bogus probe", async () => {
    const { deps, fetched } = fakeDeps({ env: { PORT: "70000" }, health: true });
    await runStatus(deps);
    expect(fetched[0]).toContain(":4280/");
  });

  test("PORT=65535 (the top of the range) is honored", async () => {
    const { deps, fetched } = fakeDeps({ env: { PORT: "65535" }, health: true });
    await runStatus(deps);
    expect(fetched[0]).toContain(":65535/");
  });

  test("corrupt service.json reads as 'none installed' (never throws)", async () => {
    const { deps, out } = fakeDeps({
      files: { "/data/service.json": "{not json" },
      health: true,
    });
    const code = await runStatus(deps);
    expect(code).toBe(0);
    expect(out.join("")).toContain("none installed");
  });
});
