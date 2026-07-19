import Database from "better-sqlite3";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { normalizeDeviceName, normalizeDeviceScopes, openDeviceStore, PAIRING_TTL_MS } from "../src/device-store.js";

const SECRET = `rcp_${"s".repeat(43)}`;
const TOKEN = `rcd_${"t".repeat(43)}`;
const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function sqlitePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "rc-devices-"));
  tempDirectories.push(directory);
  return join(directory, "devices.db");
}

function createStore(kind: "sqlite" | "memory") {
  return openDeviceStore({
    dbPath: kind === "sqlite" ? sqlitePath() : ":memory:",
    generateSecret: () => SECRET,
    generateToken: () => TOKEN,
    generateId: () => "device-1",
    ...(kind === "memory"
      ? {
          loadDatabase: () => {
            throw new Error("native SQLite unavailable");
          },
        }
      : {}),
  });
}

describe.each(["sqlite", "memory"] as const)("%s direct device store", (kind) => {
  test("issues a five-minute one-use direct pairing credential", () => {
    const store = createStore(kind);
    const pairing = store.issuePairing(1_000);
    expect(pairing).toEqual({ secret: SECRET, expiresAt: 1_000 + PAIRING_TTL_MS, scopes: ["direct"] });

    const enrolled = store.claimPairing(SECRET, "  Work   phone  ", 2_000);
    expect(enrolled).toEqual({
      token: TOKEN,
      device: {
        id: "device-1",
        name: "Work phone",
        createdAt: 2_000,
        lastSeenAt: 2_000,
        scopes: ["direct"],
      },
    });
    expect(store.claimPairing(SECRET, "Second claim", 2_001)).toBeUndefined();
    expect(store.authenticate(TOKEN, 2_002, "direct")?.id).toBe("device-1");
    store.close();
  });

  test("expires and cancels pairing capabilities", () => {
    const store = createStore(kind);
    store.issuePairing(10);
    expect(store.claimPairing(SECRET, "Expired", 10 + PAIRING_TTL_MS + 1)).toBeUndefined();
    store.close();

    const cancelled = createStore(kind);
    cancelled.issuePairing(10);
    expect(cancelled.cancelPairing(SECRET)).toBe(true);
    expect(cancelled.cancelPairing(SECRET)).toBe(false);
    expect(cancelled.claimPairing(SECRET, "Cancelled", 11)).toBeUndefined();
    cancelled.close();
  });

  test("renames and revokes an independently authenticated device", () => {
    const store = createStore(kind);
    store.issuePairing(1);
    store.claimPairing(SECRET, "Phone", 2);
    expect(store.rename("device-1", "  Main phone ")?.name).toBe("Main phone");
    expect(store.list()).toHaveLength(1);
    expect(store.revoke("device-1")).toBe(true);
    expect(store.authenticate(TOKEN, 3)).toBeUndefined();
    expect(store.list()).toEqual([]);
    store.close();
  });
});

test("validates direct-only scope and safe display labels", () => {
  expect(normalizeDeviceScopes(["direct"])).toEqual(["direct"]);
  expect(normalizeDeviceScopes([])).toBeUndefined();
  expect(normalizeDeviceScopes(["relay"])).toBeUndefined();
  expect(normalizeDeviceName("  Build   tablet ")).toBe("Build tablet");
  expect(normalizeDeviceName("bad\u0000name")).toBeUndefined();
  expect(normalizeDeviceName("x".repeat(81))).toBeUndefined();
});

test("does not persist plaintext pairing or device credentials", () => {
  const dbPath = sqlitePath();
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

test("leaves obsolete non-direct devices inert and removes obsolete pending pairings", () => {
  const dbPath = sqlitePath();
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE devices (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      scopes_json TEXT NOT NULL
    );
    CREATE TABLE pairing_sessions (
      secret_hash TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      scopes_json TEXT NOT NULL
    );
    INSERT INTO devices VALUES ('obsolete-device', 'Obsolete', 'hash', 1, 1, '["relay"]');
    INSERT INTO pairing_sessions VALUES ('obsolete-pairing', 1, 9999999999999, '["relay"]');
  `);
  db.close();

  const store = openDeviceStore({ dbPath });
  expect(store.list()).toEqual([]);
  store.close();

  const reopened = new Database(dbPath, { readonly: true });
  expect(reopened.prepare("SELECT COUNT(*) AS count FROM pairing_sessions").get()).toEqual({ count: 0 });
  reopened.close();
});
