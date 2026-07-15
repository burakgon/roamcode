import { describe, expect, test, vi } from "vitest";
import type { PushStore } from "@roamcode.ai/server";
import { runAccessReset, type ResetDeviceStore } from "../src/access-reset.js";

function stores() {
  const deviceStore = {
    mode: "sqlite",
    revokeAll: vi.fn(() => 2),
    issuePairing: vi.fn(() => ({
      secret: `rcp_${"p".repeat(43)}`,
      expiresAt: Date.now() + 300_000,
      scopes: ["direct"],
    })),
    close: vi.fn(),
  } as unknown as ResetDeviceStore;
  const pushStore = {
    list: vi.fn(() => [{ endpoint: "https://push.example/a", p256dh: "p", auth: "a", createdAt: 1 }]),
    remove: vi.fn(),
    close: vi.fn(),
  } as unknown as PushStore;
  return { deviceStore, pushStore };
}

describe("offline access reset", () => {
  test("refuses to race a running service", async () => {
    const openDevices = vi.fn();
    const errors: string[] = [];
    const code = await runAccessReset({
      dataDir: "/isolated/data",
      env: {},
      stdout: vi.fn(),
      stderr: (message) => errors.push(message),
      isServerRunning: async () => true,
      openDevices,
    });
    expect(code).toBe(1);
    expect(openDevices).not.toHaveBeenCalled();
    expect(errors.join("")).toMatch(/still running/i);
  });

  test("revokes durable devices and push, persists a new host key, and prints only a one-use link", async () => {
    const { deviceStore, pushStore } = stores();
    const output: string[] = [];
    const persistToken = vi.fn();
    const code = await runAccessReset({
      dataDir: "/isolated/data",
      env: {},
      publicUrl: "https://code.example",
      stdout: (message) => output.push(message),
      stderr: vi.fn(),
      isServerRunning: async () => false,
      openDevices: () => deviceStore,
      openPush: () => pushStore,
      generateToken: () => "new-private-host-token",
      persistToken,
    });
    expect(code).toBe(0);
    expect(deviceStore.revokeAll).toHaveBeenCalledTimes(1);
    expect(pushStore.remove).toHaveBeenCalledWith("https://push.example/a");
    expect(persistToken).toHaveBeenCalledWith("/isolated/data", "new-private-host-token");
    expect(output.join("")).toContain("https://code.example/#pair=rcp_");
    expect(output.join("")).not.toContain("new-private-host-token");
    expect(deviceStore.close).toHaveBeenCalledTimes(1);
    expect(pushStore.close).toHaveBeenCalledTimes(1);
  });
});
