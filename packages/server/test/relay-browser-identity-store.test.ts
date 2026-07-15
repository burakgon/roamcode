import { describe, expect, test, vi } from "vitest";
import { generateBrowserRelayIdentity } from "../../web/src/relay/crypto.js";
import {
  deleteBrowserRelayIdentity,
  loadOrCreateBrowserRelayIdentity,
  type BrowserRelayIdentityRepository,
} from "../../web/src/relay/identity-store.js";

function memoryRepository(): BrowserRelayIdentityRepository & { size(): number } {
  type Record = Awaited<ReturnType<BrowserRelayIdentityRepository["get"]>>;
  const records = new Map<string, NonNullable<Record>>();
  return {
    get: async (key) => records.get(key),
    add: async (record) => {
      if (records.has(record.key)) return false;
      records.set(record.key, record);
      return true;
    },
    delete: async (key) => void records.delete(key),
    size: () => records.size,
  };
}

describe("browser relay identity persistence", () => {
  test("creates once and reloads the same non-extractable identity", async () => {
    const repository = memoryRepository();
    const generate = vi.fn(generateBrowserRelayIdentity);
    const first = await loadOrCreateBrowserRelayIdentity("relay.example/route/device", {
      repository,
      generate,
      now: () => 42,
    });
    const second = await loadOrCreateBrowserRelayIdentity("relay.example/route/device", {
      repository,
      generate,
      now: () => 99,
    });
    expect(first).toMatchObject({ createdAt: 42, generated: true });
    expect(second).toMatchObject({ createdAt: 42, generated: false });
    expect(second.identity.fingerprint).toBe(first.identity.fingerprint);
    expect(second.identity.privateKey).toBe(first.identity.privateKey);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(repository.size()).toBe(1);
  });

  test("resolves a concurrent creation race to one durable winner", async () => {
    const repository = memoryRepository();
    const [first, second] = await Promise.all([
      loadOrCreateBrowserRelayIdentity("shared-key", { repository, now: () => 1 }),
      loadOrCreateBrowserRelayIdentity("shared-key", { repository, now: () => 2 }),
    ]);
    expect(first.identity.fingerprint).toBe(second.identity.fingerprint);
    expect([first.generated, second.generated].sort()).toEqual([false, true]);
    expect(repository.size()).toBe(1);
  });

  test("fails closed on mismatched stored material and only deletes on an explicit unpair", async () => {
    const repository = memoryRepository();
    const first = await generateBrowserRelayIdentity();
    const unrelated = await generateBrowserRelayIdentity();
    await repository.add({
      key: "corrupt-key",
      version: 1,
      createdAt: 1,
      ...first,
      privateKey: unrelated.privateKey,
    });
    await expect(loadOrCreateBrowserRelayIdentity("corrupt-key", { repository })).rejects.toThrow(
      "stored relay identity is invalid",
    );
    expect(repository.size()).toBe(1);
    await deleteBrowserRelayIdentity("corrupt-key", repository);
    expect(repository.size()).toBe(0);
  });
});
