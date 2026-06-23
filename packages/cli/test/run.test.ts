import { describe, expect, test, vi } from "vitest";
import { run } from "../src/index.js";
import type { RunDeps } from "../src/index.js";

/**
 * Build a fake startServer that records the env it was called with and never binds a real port.
 * The real `app.close()` is stubbed so no live Fastify instance is required.
 */
function fakeDeps(
  overrides: Partial<RunDeps> = {},
): { deps: RunDeps; out: string[]; err: string[]; calls: NodeJS.ProcessEnv[] } {
  const out: string[] = [];
  const err: string[] = [];
  const calls: NodeJS.ProcessEnv[] = [];
  const startServer: RunDeps["startServer"] = vi.fn(async (env: NodeJS.ProcessEnv) => {
    calls.push(env);
    return {
      app: { close: vi.fn(async () => {}) },
      url: "http://127.0.0.1:4280",
      token: "tok_abc123",
      tokenGenerated: true,
    } as unknown as Awaited<ReturnType<RunDeps["startServer"]>>;
  });
  const deps: RunDeps = {
    startServer,
    stdout: (s) => out.push(s),
    stderr: (s) => err.push(s),
    env: {},
    onReady: () => {},
    ...overrides,
  };
  return { deps, out, err, calls };
}

describe("run — --help / --version", () => {
  test("--help prints usage incl. the env vars and does NOT start the server", async () => {
    const { deps, out } = fakeDeps();
    const code = await run(["--help"], deps);
    expect(code).toBe(0);
    expect(deps.startServer).not.toHaveBeenCalled();
    const text = out.join("");
    expect(text).toContain("remote-coder");
    expect(text).toContain("--port");
    expect(text).toContain("BIND_ADDRESS");
  });

  test("--version prints the version and does NOT start the server", async () => {
    const { deps, out } = fakeDeps();
    const code = await run(["--version"], deps);
    expect(code).toBe(0);
    expect(deps.startServer).not.toHaveBeenCalled();
    expect(out.join("")).toMatch(/\d+\.\d+\.\d+/);
  });

  test("an unknown flag prints a clear error and exits non-zero without starting", async () => {
    const { deps, err } = fakeDeps();
    const code = await run(["--bogus"], deps);
    expect(code).not.toBe(0);
    expect(deps.startServer).not.toHaveBeenCalled();
    expect(err.join("").toLowerCase()).toContain("unknown option");
  });
});

describe("run — boot path (mocked startServer, no real listen)", () => {
  test("maps flags onto the env vars startServer reads", async () => {
    const { deps, calls } = fakeDeps();
    await run(["--port", "8080", "--bind", "0.0.0.0", "--no-token"], deps);
    expect(deps.startServer).toHaveBeenCalledTimes(1);
    const env = calls[0]!;
    expect(env.PORT).toBe("8080");
    expect(env.BIND_ADDRESS).toBe("0.0.0.0");
    expect(env.NO_TOKEN).toBe("1");
  });

  test("prints connect info including the URL and the generated token once", async () => {
    const { deps, out } = fakeDeps();
    await run([], deps);
    const text = out.join("");
    expect(text).toContain("http://127.0.0.1:4280");
    // The token is printed exactly once (generated path).
    expect(text.split("tok_abc123").length - 1).toBe(1);
    expect(text.toLowerCase()).toContain("tunnel");
  });

  test("does not re-print an existing (non-generated) token", async () => {
    const { deps, out } = fakeDeps({
      startServer: vi.fn(async () => ({
        app: { close: vi.fn(async () => {}) },
        url: "http://127.0.0.1:4280",
        token: "tok_existing",
        tokenGenerated: false,
      })) as unknown as RunDeps["startServer"],
    });
    await run([], deps);
    const text = out.join("");
    expect(text).not.toContain("tok_existing");
    expect(text).toContain("http://127.0.0.1:4280");
  });

  test("NO_TOKEN mode (no token) notes the tokenless mode", async () => {
    const { deps, out } = fakeDeps({
      startServer: vi.fn(async () => ({
        app: { close: vi.fn(async () => {}) },
        url: "http://127.0.0.1:4280",
        token: undefined,
        tokenGenerated: false,
      })) as unknown as RunDeps["startServer"],
    });
    await run(["--no-token"], deps);
    expect(out.join("").toLowerCase()).toContain("no access token");
  });

  test("a startServer failure surfaces a clear error and exits non-zero", async () => {
    const { deps, err } = fakeDeps({
      startServer: vi.fn(async () => {
        throw new Error("port in use");
      }) as unknown as RunDeps["startServer"],
    });
    const code = await run([], deps);
    expect(code).not.toBe(0);
    expect(err.join("")).toContain("port in use");
  });
});
