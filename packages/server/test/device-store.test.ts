import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, test } from "vitest";
import { openDeviceStore, PAIRING_TTL_MS } from "../src/device-store.js";
import { generateRelayIdentity } from "../src/relay-crypto.js";

const SECRET = `rcp_${"s".repeat(43)}`;
const TOKEN = `rcd_${"t".repeat(43)}`;

let dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

function databasePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "roamcode-devices-"));
  dirs.push(dir);
  return join(dir, "devices.db");
}

describe("device credential store", () => {
  test("claims a pairing once, authenticates the device, persists it, and revokes it", () => {
    const dbPath = databasePath();
    const store = openDeviceStore({
      dbPath,
      generateSecret: () => SECRET,
      generateToken: () => TOKEN,
      generateId: () => "device-1",
    });
    const pairing = store.issuePairing(1_000);
    expect(pairing).toEqual({ secret: SECRET, expiresAt: 1_000 + PAIRING_TTL_MS, scopes: ["direct"] });

    const claimed = store.claimPairing(SECRET, "  Burak's iPhone  ", 2_000);
    expect(claimed).toEqual({
      token: TOKEN,
      device: { id: "device-1", name: "Burak's iPhone", createdAt: 2_000, lastSeenAt: 2_000, scopes: ["direct"] },
    });
    expect(store.claimPairing(SECRET, "Second claimant", 2_001)).toBeUndefined();
    expect(store.authenticate(TOKEN, 2_001)?.id).toBe("device-1");
    store.close();

    const reopened = openDeviceStore({ dbPath });
    expect(reopened.authenticate(TOKEN, 70_000)).toMatchObject({ id: "device-1", lastSeenAt: 70_000 });
    expect(reopened.rename("device-1", "Travel phone")?.name).toBe("Travel phone");
    expect(reopened.revoke("device-1")).toBe(true);
    expect(reopened.authenticate(TOKEN)).toBeUndefined();
    reopened.close();
  });

  test("enforces direct versus relay credential scope and supports a full recovery revocation", () => {
    const identity = generateRelayIdentity();
    const store = openDeviceStore({
      dbPath: ":memory:",
      generateSecret: () => SECRET,
      generateToken: () => TOKEN,
      generateId: () => "relay-device",
    });
    store.issuePairing(1, ["relay"]);
    expect(() => store.claimPairing(SECRET, "Relay client", 2)).toThrow("requires a device E2E identity");
    expect(() => store.claimPairing(SECRET, "Relay client", 2, "not-a-key")).toThrow(
      "relay identity must be a P-256 public key",
    );
    const claimed = store.claimPairing(SECRET, "Relay client", 2, identity.publicKey);
    expect(claimed?.device).toMatchObject({ scopes: ["relay"], relayIdentityFingerprint: identity.fingerprint });
    expect(store.relayIdentity("relay-device")).toEqual({
      publicKey: identity.publicKey,
      fingerprint: identity.fingerprint,
    });
    expect(store.authenticate(TOKEN, 3)).toBeUndefined();
    expect(store.authenticate(TOKEN, 3, "relay")?.id).toBe("relay-device");
    expect(store.revokeAll()).toBe(1);
    expect(store.authenticate(TOKEN, 4, "relay")).toBeUndefined();
    store.close();
  });

  test("pre-allocates a recoverable relay identity and consumes it only with both capabilities", () => {
    const identity = generateRelayIdentity();
    const store = openDeviceStore({
      dbPath: ":memory:",
      generateSecret: () => SECRET,
      generateToken: () => TOKEN,
      generateId: () => "relay-bootstrap",
    });
    const pairing = store.issueRelayPairing(100);
    expect(pairing).toEqual({
      secret: SECRET,
      token: TOKEN,
      deviceId: "relay-bootstrap",
      expiresAt: 100 + PAIRING_TTL_MS,
      scopes: ["relay"],
    });
    expect(store.pendingRelayPairing("relay-bootstrap", 101)).toBe(true);
    expect(store.claimPairing(SECRET, "wrong claim path", 102, identity.publicKey)).toBeUndefined();
    expect(store.claimRelayPairing(SECRET, `rcd_${"x".repeat(43)}`, "Phone", identity.publicKey, 103)).toBeUndefined();

    const claimed = store.claimRelayPairing(SECRET, TOKEN, "  Travel phone ", identity.publicKey, 104);
    expect(claimed).toEqual({
      token: TOKEN,
      device: {
        id: "relay-bootstrap",
        name: "Travel phone",
        createdAt: 104,
        lastSeenAt: 104,
        scopes: ["relay"],
        relayIdentityFingerprint: identity.fingerprint,
      },
    });
    expect(store.pendingRelayPairing("relay-bootstrap", 105)).toBe(false);
    expect(store.claimRelayPairing(SECRET, TOKEN, "Replay", identity.publicKey, 106)).toBeUndefined();
    expect(store.authenticate(TOKEN, 107, "relay")?.id).toBe("relay-bootstrap");
    store.close();
  });

  test("persists a relay public identity while never storing its private key", () => {
    const dbPath = databasePath();
    const identity = generateRelayIdentity();
    const store = openDeviceStore({
      dbPath,
      generateSecret: () => SECRET,
      generateToken: () => TOKEN,
      generateId: () => "relay-persisted",
    });
    store.issuePairing(1, ["direct", "relay"]);
    store.claimPairing(SECRET, "Roaming browser", 2, identity.publicKey);
    store.close();

    const bytes = readFileSync(dbPath).toString("latin1");
    expect(bytes).toContain(identity.publicKey);
    expect(bytes).not.toContain(identity.privateKey);
    const reopened = openDeviceStore({ dbPath });
    expect(reopened.relayIdentity("relay-persisted")?.fingerprint).toBe(identity.fingerprint);
    reopened.close();
  });

  test("expired pairings cannot mint a device key", () => {
    const store = openDeviceStore({
      dbPath: ":memory:",
      generateSecret: () => SECRET,
      generateToken: () => TOKEN,
      generateId: () => "device-1",
    });
    store.issuePairing(10);
    expect(store.claimPairing(SECRET, "Phone", 10 + PAIRING_TTL_MS + 1)).toBeUndefined();
    expect(store.list()).toEqual([]);
    store.close();
  });

  test("persists only credential digests, never the pairing secret or device token", () => {
    const dbPath = databasePath();
    const store = openDeviceStore({
      dbPath,
      generateSecret: () => SECRET,
      generateToken: () => TOKEN,
      generateId: () => "device-1",
    });
    store.issuePairing(1);
    store.claimPairing(SECRET, "Phone", 2);
    store.close();

    const bytes = readFileSync(dbPath).toString("latin1");
    expect(bytes).not.toContain(SECRET);
    expect(bytes).not.toContain(TOKEN);
  });

  test("shares a CLI-issued ticket with an already-open server connection", () => {
    const dbPath = databasePath();
    const serverStore = openDeviceStore({ dbPath });
    const cliStore = openDeviceStore({
      dbPath,
      generateSecret: () => SECRET,
    });

    const pairing = cliStore.issuePairing(1_000);
    const claimed = serverStore.claimPairing(pairing.secret, "Phone", 2_000);

    expect(claimed?.device.name).toBe("Phone");
    expect(serverStore.claimPairing(pairing.secret, "Second phone", 2_001)).toBeUndefined();
    cliStore.close();
    serverStore.close();
  });

  test("migrates pre-scope databases without invalidating existing device credentials", () => {
    const dbPath = databasePath();
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE devices (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL
      );
      CREATE TABLE pairing_sessions (
        secret_hash TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
    `);
    legacy.close();

    const store = openDeviceStore({
      dbPath,
      generateSecret: () => SECRET,
      generateToken: () => TOKEN,
      generateId: () => "migrated-device",
    });
    store.issuePairing(100);
    expect(store.claimPairing(SECRET, "Migrated phone", 101)?.device.scopes).toEqual(["direct"]);
    expect(store.authenticate(TOKEN, 102, "direct")?.id).toBe("migrated-device");
    expect(store.authenticate(TOKEN, 102, "relay")).toBeUndefined();
    store.close();
  });
});
