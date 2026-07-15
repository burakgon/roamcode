import { describe, expect, test, vi } from "vitest";
import { buildPairingUrl, pairingBaseUrl, runPairCommand } from "../src/pair.js";
import type { DeviceStore } from "@roamcode.ai/server";

const SECRET = `rcp_${"a".repeat(43)}`;

function fakeStore(): DeviceStore {
  return {
    mode: "sqlite",
    issuePairing: vi.fn(() => ({ secret: SECRET, expiresAt: Date.now() + 300_000 })),
    claimPairing: vi.fn(),
    authenticate: vi.fn(),
    list: vi.fn(() => []),
    revoke: vi.fn(() => false),
    close: vi.fn(),
  };
}

describe("pairing URL", () => {
  test("prefers the explicit origin, then configured public URL, then loopback", () => {
    expect(pairingBaseUrl("https://pair.example", { ROAMCODE_PUBLIC_URL: "https://env.example" })).toBe(
      "https://pair.example",
    );
    expect(pairingBaseUrl(undefined, { ROAMCODE_PUBLIC_URL: "https://env.example" })).toBe("https://env.example");
    expect(pairingBaseUrl(undefined, { PORT: "5310" })).toBe("http://127.0.0.1:5310");
  });

  test("rejects credentials and non-origin URL components", () => {
    expect(() => pairingBaseUrl("https://user:pass@example.com", {})).toThrow(/without embedded credentials/i);
    expect(() => pairingBaseUrl("https://example.com/path", {})).toThrow(/origin only/i);
  });

  test("puts only the one-time pairing capability in the URL", () => {
    const url = buildPairingUrl("https://pair.example", SECRET);
    expect(url).toBe(`https://pair.example/#pair=${SECRET}`);
    expect(url).not.toContain("token=");
  });
});

describe("roamcode pair", () => {
  test("issues one pairing, prints a terminal QR/link, and closes the store", async () => {
    const store = fakeStore();
    const out: string[] = [];
    const code = await runPairCommand({
      dataDir: "/data",
      env: {},
      publicUrl: "https://pair.example",
      stdout: (value) => out.push(value),
      stderr: vi.fn(),
      openStore: (path) => {
        expect(path.replaceAll("\\", "/")).toBe("/data/devices.db");
        return store;
      },
    });

    expect(code).toBe(0);
    expect(store.issuePairing).toHaveBeenCalledOnce();
    expect(store.close).toHaveBeenCalledOnce();
    const output = out.join("");
    expect(output).toContain(`https://pair.example/#pair=${SECRET}`);
    expect(output).toContain("Expires in 5 minutes");
    expect(output).toContain("host access token is not included");
  });

  test("invalid public URL fails without opening the credential store", async () => {
    const openStore = vi.fn();
    const err: string[] = [];
    const code = await runPairCommand({
      dataDir: "/data",
      env: {},
      publicUrl: "file:///tmp/app",
      stdout: vi.fn(),
      stderr: (value) => err.push(value),
      openStore,
    });
    expect(code).toBe(2);
    expect(openStore).not.toHaveBeenCalled();
    expect(err.join("")).toMatch(/http\(s\) origin/i);
  });
});
