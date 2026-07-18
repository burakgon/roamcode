import { describe, expect, test } from "vitest";
import { generateBrowserRelayIdentity } from "./crypto";
import {
  installBrowserRelayIdentity,
  loadBrowserRelayIdentity,
  type BrowserRelayIdentityRepository,
} from "./identity-store";

function memoryRepository(): BrowserRelayIdentityRepository {
  const records = new Map<
    string,
    {
      key: string;
      createdAt: number;
      version: 1;
      publicKey: string;
      privateKey: CryptoKey;
      fingerprint: string;
    }
  >();
  return {
    get: async (key) => records.get(key),
    add: async (record) => {
      if (records.has(record.key)) return false;
      records.set(record.key, record);
      return true;
    },
    delete: async (key) => {
      records.delete(key);
    },
    listMetadata: async () => [...records.values()].map(({ key, createdAt }) => ({ key, createdAt })),
  };
}

describe("relay identity installation", () => {
  test("distinguishes a missing saved identity from one that can be safely reused", async () => {
    const repository = memoryRepository();
    expect(await loadBrowserRelayIdentity("relay:host:route:device", repository)).toBeUndefined();

    const identity = await generateBrowserRelayIdentity();
    await installBrowserRelayIdentity("relay:host:route:device", identity, { repository, now: () => 123 });

    const saved = await loadBrowserRelayIdentity("relay:host:route:device", repository);
    expect(saved).toMatchObject({ createdAt: 123, generated: false });
    expect(saved?.identity.fingerprint).toBe(identity.fingerprint);
  });

  test("copies a non-exportable provisional identity idempotently to its route-bound key", async () => {
    const repository = memoryRepository();
    const identity = await generateBrowserRelayIdentity();
    const options = { repository, now: () => 123 };

    const installed = await installBrowserRelayIdentity("relay:host:route:device", identity, options);
    const replay = await installBrowserRelayIdentity("relay:host:route:device", identity, options);

    expect(installed.identity.privateKey.extractable).toBe(false);
    expect(installed.identity.fingerprint).toBe(identity.fingerprint);
    expect(replay).toMatchObject({ createdAt: 123, generated: false });
  });

  test("never overwrites a different identity already bound to the same Node device", async () => {
    const repository = memoryRepository();
    const first = await generateBrowserRelayIdentity();
    const second = await generateBrowserRelayIdentity();
    await installBrowserRelayIdentity("relay:host:route:device", first, { repository, now: () => 123 });

    await expect(
      installBrowserRelayIdentity("relay:host:route:device", second, { repository, now: () => 124 }),
    ).rejects.toThrow(/different relay identity/i);
  });
});
