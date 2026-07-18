import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, test } from "vitest";
import { openDeviceStore, PAIRING_TTL_MS } from "../src/device-store.js";
import { generateRelayIdentity } from "../src/relay-crypto.js";

const SECRET = `rcp_${"s".repeat(43)}`;
const TOKEN = `rcd_${"t".repeat(43)}`;
const CONTROL_PLANE_DEVICE_ID = "22222222-2222-4222-8222-222222222222";

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
  test("persists a crash-safe cloud enrollment saga without storing browser or relay credentials", () => {
    const dbPath = databasePath();
    const identity = generateRelayIdentity();
    const enrollment = {
      enrollmentId: "11111111-1111-4111-8111-111111111111",
      deviceId: "cloud-browser-1",
      challenge: `rce_${"c".repeat(43)}`,
      name: "  Work browser  ",
      token: `rcd_${"b".repeat(43)}`,
      relayIdentityPublicKey: identity.publicKey,
      durableRelayCredentialHash: `sha256:${"d".repeat(43)}`,
    };
    const temporaryHash = `sha256:${"t".repeat(43)}`;

    const first = openDeviceStore({ dbPath });
    expect(first.beginCloudDeviceEnrollment(enrollment, 1_000)).toMatchObject({
      enrollmentId: enrollment.enrollmentId,
      deviceId: enrollment.deviceId,
      state: "prepared",
    });
    expect(() =>
      first.beginCloudDeviceEnrollment({ ...enrollment, challenge: `rce_${"x".repeat(43)}` }, 1_001),
    ).toThrow("conflicts with existing local state");
    expect(first.authenticate(enrollment.token, 1_002, "relay")).toBeUndefined();
    first.close();

    const resumed = openDeviceStore({ dbPath });
    expect(resumed.beginCloudDeviceEnrollment(enrollment, 2_000).state).toBe("prepared");
    expect(
      resumed.finalizeCloudDeviceEnrollment(enrollment.enrollmentId, temporaryHash, CONTROL_PLANE_DEVICE_ID, 2_001),
    ).toMatchObject({
      state: "local-finalized",
      temporaryRelayCredentialHash: temporaryHash,
      controlPlaneDeviceId: CONTROL_PLANE_DEVICE_ID,
      device: {
        id: enrollment.deviceId,
        name: "Work browser",
        scopes: ["relay"],
        relayIdentityFingerprint: identity.fingerprint,
      },
    });
    expect(resumed.authenticate(enrollment.token, 2_002, "relay")).toBeUndefined();
    expect(resumed.cloudDeviceEnrollmentPending(enrollment.deviceId)).toBe(true);
    resumed.close();

    const recovered = openDeviceStore({ dbPath });
    expect(recovered.pendingCloudDevicePromotions(3_000)).toEqual([
      {
        enrollmentId: enrollment.enrollmentId,
        deviceId: enrollment.deviceId,
        expectedCredentialHash: temporaryHash,
        credentialHash: enrollment.durableRelayCredentialHash,
        controlPlaneDeviceId: CONTROL_PLANE_DEVICE_ID,
        brokerPromoted: false,
      },
    ]);
    expect(
      recovered.finalizeCloudDeviceEnrollment(enrollment.enrollmentId, temporaryHash, CONTROL_PLANE_DEVICE_ID, 3_001)
        .state,
    ).toBe("local-finalized");
    expect(
      recovered.markCloudDeviceEnrollmentPromoted(
        enrollment.enrollmentId,
        temporaryHash,
        enrollment.durableRelayCredentialHash,
        3_002,
      ).state,
    ).toBe("cloud-report-pending");
    expect(
      recovered.completeCloudDeviceEnrollment(
        enrollment.enrollmentId,
        temporaryHash,
        enrollment.durableRelayCredentialHash,
        3_003,
      ).state,
    ).toBe("complete");
    expect(recovered.authenticate(enrollment.token, 3_004, "relay")?.id).toBe(enrollment.deviceId);
    expect(recovered.cloudDeviceEnrollmentPending(enrollment.deviceId)).toBe(false);
    expect(
      recovered.completeCloudDeviceEnrollment(
        enrollment.enrollmentId,
        temporaryHash,
        enrollment.durableRelayCredentialHash,
        3_003,
      ).state,
    ).toBe("complete");
    expect(recovered.pendingCloudDevicePromotions(3_004)).toEqual([]);
    recovered.close();

    const bytes = readFileSync(dbPath).toString("latin1");
    expect(bytes).not.toContain(enrollment.challenge);
    expect(bytes).not.toContain(enrollment.token);
    expect(bytes).not.toContain(identity.privateKey);
  });

  test.each(["sqlite", "memory-fallback"] as const)(
    "bounds cloud recovery reads and moves attempted failures behind newer pending work (%s)",
    (mode) => {
      const store = openDeviceStore({
        dbPath: databasePath(),
        ...(mode === "memory-fallback"
          ? {
              loadDatabase: () => {
                throw new Error("native unavailable");
              },
            }
          : {}),
      });
      expect(store.mode).toBe(mode);
      const identity = generateRelayIdentity();
      const pending = Array.from({ length: 26 }, (_, index) => {
        const sequence = index + 1;
        const marker = sequence.toString(36).padStart(43, "0");
        const enrollmentId = `00000000-0000-4000-8000-${sequence.toString().padStart(12, "0")}`;
        const temporaryHash = `sha256:${`t${marker.slice(1)}`}`;
        const durableHash = `sha256:${`d${marker.slice(1)}`}`;
        store.beginCloudDeviceEnrollment(
          {
            enrollmentId,
            deviceId: `cloud-browser-${sequence}`,
            challenge: `rce_${marker}`,
            name: `Browser ${sequence}`,
            token: `rcd_${marker}`,
            relayIdentityPublicKey: identity.publicKey,
            durableRelayCredentialHash: durableHash,
          },
          sequence,
        );
        store.finalizeCloudDeviceEnrollment(enrollmentId, temporaryHash, enrollmentId, 100 + sequence);
        return { enrollmentId, temporaryHash, durableHash, deviceId: `cloud-browser-${sequence}` };
      });

      const firstPage = store.pendingCloudDevicePromotions(1_000, 25);
      expect(firstPage).toHaveLength(25);
      expect(firstPage[0]?.deviceId).toBe("cloud-browser-1");
      expect(firstPage.at(-1)?.deviceId).toBe("cloud-browser-25");
      for (const promotion of firstPage) {
        expect(
          store.deferCloudDevicePromotion(
            promotion.enrollmentId,
            promotion.expectedCredentialHash,
            promotion.credentialHash,
            50,
          ),
        ).toBe(true);
      }

      const nextPage = store.pendingCloudDevicePromotions(3_000, 25);
      expect(nextPage).toHaveLength(25);
      expect(nextPage[0]?.deviceId).toBe(pending[25]?.deviceId);
      expect(nextPage.some((promotion) => promotion.deviceId === "cloud-browser-1")).toBe(true);
      store.close();
    },
  );

  test.each(["sqlite", "memory-fallback"] as const)(
    "keeps a locally revoked managed browser tombstoned across recovery (%s)",
    (mode) => {
      const store = openDeviceStore({
        dbPath: databasePath(),
        ...(mode === "memory-fallback"
          ? {
              loadDatabase: () => {
                throw new Error("native unavailable");
              },
            }
          : {}),
      });
      const identity = generateRelayIdentity();
      const enrollment = {
        enrollmentId: "30000000-0000-4000-8000-000000000001",
        deviceId: "revoked-cloud-browser",
        challenge: `rce_${"c".repeat(43)}`,
        name: "Revoked browser",
        token: `rcd_${"b".repeat(43)}`,
        relayIdentityPublicKey: identity.publicKey,
        durableRelayCredentialHash: `sha256:${"d".repeat(43)}`,
      };
      const temporaryHash = `sha256:${"t".repeat(43)}`;
      store.beginCloudDeviceEnrollment(enrollment, 1);
      store.finalizeCloudDeviceEnrollment(enrollment.enrollmentId, temporaryHash, CONTROL_PLANE_DEVICE_ID, 2);
      store.markCloudDeviceEnrollmentPromoted(
        enrollment.enrollmentId,
        temporaryHash,
        enrollment.durableRelayCredentialHash,
        3,
      );

      expect(store.revoke(enrollment.deviceId)).toBe(true);
      expect(store.cloudDeviceEnrollmentPending(enrollment.deviceId)).toBe(false);
      expect(store.pendingCloudDevicePromotions(4)).toEqual([]);
      expect(store.authenticate(enrollment.token, 4, "relay")).toBeUndefined();
      expect(store.beginCloudDeviceEnrollment(enrollment, 5).state).toBe("revoked");
      store.close();
    },
  );

  test.each(["sqlite", "memory-fallback"] as const)(
    "prunes abandoned prepared cloud enrollments after the browser recovery window (%s)",
    (mode) => {
      const store = openDeviceStore({
        dbPath: databasePath(),
        ...(mode === "memory-fallback"
          ? {
              loadDatabase: () => {
                throw new Error("native unavailable");
              },
            }
          : {}),
      });
      const identity = generateRelayIdentity();
      const material = {
        deviceId: "abandoned-browser",
        challenge: `rce_${"a".repeat(43)}`,
        name: "Abandoned browser",
        token: `rcd_${"b".repeat(43)}`,
        relayIdentityPublicKey: identity.publicKey,
        durableRelayCredentialHash: `sha256:${"d".repeat(43)}`,
      };
      store.beginCloudDeviceEnrollment({ enrollmentId: "10000000-0000-4000-8000-000000000001", ...material }, 1);

      expect(
        store.beginCloudDeviceEnrollment(
          { enrollmentId: "10000000-0000-4000-8000-000000000002", ...material },
          1 + 30 * 60 * 1_000 + 1,
        ),
      ).toMatchObject({ state: "prepared", deviceId: material.deviceId });
      store.close();
    },
  );

  test("covers the SQLite recovery order with an index instead of a temporary full-queue sort", () => {
    const dbPath = databasePath();
    const store = openDeviceStore({ dbPath });
    store.close();
    const db = new Database(dbPath);
    const plan = db
      .prepare(
        `EXPLAIN QUERY PLAN SELECT * FROM cloud_device_enrollments
         WHERE state = 'local-finalized' AND temporary_credential_hash IS NOT NULL
         ORDER BY recovery_order ASC, created_at ASC, enrollment_id ASC LIMIT ?`,
      )
      .all(25) as Array<{ detail: string }>;
    expect(plan.some((step) => step.detail.includes("cloud_device_enrollment_recovery_idx"))).toBe(true);
    expect(plan.some((step) => step.detail.includes("USE TEMP B-TREE"))).toBe(false);
    db.close();
  });

  test("retires a legacy cloud enrollment that lacks a verifiable control-plane device binding", () => {
    const dbPath = databasePath();
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE cloud_device_enrollments (
        enrollment_id TEXT PRIMARY KEY,
        device_id TEXT NOT NULL UNIQUE,
        challenge_hash TEXT NOT NULL UNIQUE,
        token_hash TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        relay_public_key TEXT NOT NULL,
        relay_fingerprint TEXT NOT NULL,
        temporary_credential_hash TEXT,
        durable_credential_hash TEXT NOT NULL UNIQUE,
        state TEXT NOT NULL CHECK (state IN ('prepared', 'local-finalized', 'complete')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    legacy
      .prepare(
        `INSERT INTO cloud_device_enrollments
         (enrollment_id, device_id, challenge_hash, token_hash, name, relay_public_key, relay_fingerprint,
          temporary_credential_hash, durable_credential_hash, state, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'local-finalized', ?, ?)`,
      )
      .run(
        "20000000-0000-4000-8000-000000000001",
        "migrated-browser",
        "challenge-hash",
        "token-hash",
        "Migrated browser",
        "public-key",
        `sha256:${"i".repeat(43)}`,
        `sha256:${"t".repeat(43)}`,
        `sha256:${"d".repeat(43)}`,
        1,
        1,
      );
    legacy.close();

    const store = openDeviceStore({ dbPath });
    expect(store.pendingCloudDevicePromotions(2, 25)).toEqual([]);
    expect(
      store.deferCloudDevicePromotion(
        "20000000-0000-4000-8000-000000000001",
        `sha256:${"t".repeat(43)}`,
        `sha256:${"d".repeat(43)}`,
        0,
      ),
    ).toBe(false);
    store.close();

    const migrated = new Database(dbPath);
    const columns = migrated.prepare("PRAGMA table_info(cloud_device_enrollments)").all() as Array<{ name: string }>;
    expect(columns.some((column) => column.name === "recovery_order")).toBe(true);
    expect(columns.some((column) => column.name === "control_plane_device_id")).toBe(true);
    expect(columns.some((column) => column.name === "broker_promoted_at")).toBe(true);
    expect(columns.some((column) => column.name === "revoked_at")).toBe(true);
    expect(
      migrated
        .prepare("SELECT revoked_at FROM cloud_device_enrollments WHERE enrollment_id = ?")
        .get("20000000-0000-4000-8000-000000000001"),
    ).toEqual({ revoked_at: 1 });
    migrated.close();
  });

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

  test("rejects misleading direction controls in device names while preserving normal joined Unicode", () => {
    const store = openDeviceStore({
      dbPath: ":memory:",
      generateSecret: () => SECRET,
      generateToken: () => TOKEN,
      generateId: () => "unicode-device",
    });
    store.issuePairing(1);
    expect(store.claimPairing(SECRET, "Phone\u202Etxt.exe", 2)).toBeUndefined();
    expect(store.cancelPairing(SECRET)).toBe(true);
    store.issuePairing(3);
    expect(store.claimPairing(SECRET, "Family 👩‍💻 laptop", 4)?.device.name).toBe("Family 👩‍💻 laptop");
    store.close();
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
    expect(store.cancelRelayPairing("not-the-device")).toBe(false);
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

  test("cancels an unadvertised relay pairing without creating a device", () => {
    const store = openDeviceStore({
      dbPath: ":memory:",
      generateSecret: () => SECRET,
      generateToken: () => TOKEN,
      generateId: () => "relay-cancelled",
    });
    store.issueRelayPairing(100);
    expect(store.cancelRelayPairing("relay-cancelled")).toBe(true);
    expect(store.pendingRelayPairing("relay-cancelled", 101)).toBe(false);
    expect(store.cancelRelayPairing("relay-cancelled")).toBe(false);
    store.close();
  });

  test("atomically reserves relay cancellation across database connections and releases a failed attempt", () => {
    const dbPath = databasePath();
    const identity = generateRelayIdentity();
    const issuer = openDeviceStore({
      dbPath,
      generateSecret: () => SECRET,
      generateToken: () => TOKEN,
      generateId: () => "relay-cancel-race",
    });
    const claimant = openDeviceStore({ dbPath });
    issuer.issueRelayPairing(100);

    const started = issuer.beginRelayPairingCancellation("relay-cancel-race", 101);
    expect(started.status).toBe("reserved");
    expect(issuer.beginRelayPairingCancellation("relay-cancel-race", 101)).toEqual({ status: "busy" });
    expect(claimant.claimRelayPairing(SECRET, TOKEN, "Phone", identity.publicKey, 102)).toBeUndefined();

    if (started.status !== "reserved") throw new Error("relay cancellation was not reserved");
    expect(issuer.releaseRelayPairingCancellation(started.reservation)).toBe(true);
    expect(claimant.claimRelayPairing(SECRET, TOKEN, "Phone", identity.publicKey, 103)?.device.id).toBe(
      "relay-cancel-race",
    );
    claimant.close();
    issuer.close();
  });

  test("finishes a reserved relay cancellation without leaving a claimable local bootstrap", () => {
    const identity = generateRelayIdentity();
    const store = openDeviceStore({
      dbPath: ":memory:",
      generateSecret: () => SECRET,
      generateToken: () => TOKEN,
      generateId: () => "relay-cancel-finished",
    });
    store.issueRelayPairing(100);
    const started = store.beginRelayPairingCancellation("relay-cancel-finished", 101);
    if (started.status !== "reserved") throw new Error("relay cancellation was not reserved");
    expect(store.finishRelayPairingCancellation(started.reservation)).toBe(true);
    expect(store.pendingRelayPairing("relay-cancel-finished", 102)).toBe(false);
    expect(store.claimRelayPairing(SECRET, TOKEN, "Phone", identity.publicKey, 102)).toBeUndefined();
    store.close();
  });

  test("retries relay bootstrap device and token collisions instead of creating ambiguous cancellation ids", () => {
    const secrets = [
      `rcp_${"1".repeat(43)}`,
      `rcp_${"2".repeat(43)}`,
      `rcp_${"3".repeat(43)}`,
      `rcp_${"4".repeat(43)}`,
    ];
    const tokens = [`rcd_${"1".repeat(43)}`, `rcd_${"1".repeat(43)}`, `rcd_${"3".repeat(43)}`, `rcd_${"4".repeat(43)}`];
    const ids = ["relay-one", "relay-two", "relay-one", "relay-four"];
    const store = openDeviceStore({
      dbPath: ":memory:",
      generateSecret: () => secrets.shift()!,
      generateToken: () => tokens.shift()!,
      generateId: () => ids.shift()!,
    });

    expect(store.issueRelayPairing(100)).toMatchObject({ deviceId: "relay-one", token: `rcd_${"1".repeat(43)}` });
    expect(store.issueRelayPairing(101)).toMatchObject({ deviceId: "relay-four", token: `rcd_${"4".repeat(43)}` });
    expect(store.cancelRelayPairing("relay-one")).toBe(true);
    expect(store.pendingRelayPairing("relay-four", 102)).toBe(true);
    store.close();
  });

  test("cancels a direct one-use pairing by its capability", () => {
    const store = openDeviceStore({
      dbPath: ":memory:",
      generateSecret: () => SECRET,
      generateToken: () => TOKEN,
      generateId: () => "direct-cancelled",
    });
    store.issuePairing(100);
    expect(store.cancelPairing(SECRET)).toBe(true);
    expect(store.cancelPairing(SECRET)).toBe(false);
    expect(store.claimPairing(SECRET, "Too late", 101)).toBeUndefined();
    expect(store.list()).toEqual([]);
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
