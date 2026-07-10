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
}): { deps: StatusDeps; out: string[]; fetched: string[] } {
  const out: string[] = [];
  const fetched: string[] = [];
  const files = opts.files ?? {};
  const readFile = (p: string): string => {
    // Normalize separators so the same fake files work on Windows (join uses "\") and POSIX.
    const key = p.replaceAll("\\", "/");
    if (key in files) return files[key] as string;
    throw new Error(`ENOENT: ${p}`);
  };
  const fetchFn = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    fetched.push(url);
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
  return { deps, out, fetched };
}

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

  test("service installed + server up + token → prints manager/label and version · build, exits 0", async () => {
    const { deps, out } = fakeDeps({
      files: {
        "/data/service.json": JSON.stringify({ manager: "systemd", label: "roamcode" }),
        "/data/token": "tok_secret\n",
      },
      health: true,
      version: { status: 200, body: { current: "0.4.2", runningBuild: "abc1234" } },
    });
    const code = await runStatus(deps);
    expect(code).toBe(0);
    const text = out.join("");
    expect(text).toContain("Service: systemd · roamcode");
    expect(text).toContain("running at http://127.0.0.1:4280 (v0.4.2 · abc1234)");
  });

  test("reachable but no token anywhere → still 'running' (no /version call), exits 0", async () => {
    const { deps, out, fetched } = fakeDeps({ health: true });
    const code = await runStatus(deps);
    expect(code).toBe(0);
    expect(out.join("")).toContain("running at http://127.0.0.1:4280");
    expect(fetched.some((u) => u.endsWith("/version"))).toBe(false);
  });

  test("a rejected /version (rotated token → 401) degrades to plain 'running', not an error", async () => {
    const { deps, out } = fakeDeps({
      files: { "/data/token": "tok_stale" },
      health: true,
      version: { status: 401 },
    });
    const code = await runStatus(deps);
    expect(code).toBe(0);
    // The newline right after the URL proves no "(v… · sha)" detail was appended.
    expect(out.join("")).toContain("running at http://127.0.0.1:4280\n");
  });

  test("PORT env picks the probe target; ACCESS_TOKEN beats the token file", async () => {
    const { deps, out, fetched } = fakeDeps({
      files: { "/data/token": "tok_file" },
      env: { PORT: "5310", ACCESS_TOKEN: "tok_env" },
      health: true,
      version: { status: 200, body: { current: "1.0.0", runningBuild: "deadbee" } },
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
