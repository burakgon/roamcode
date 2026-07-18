import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { generateRelayCredential, openRelayRouteStore, relayCredentialHash } from "../src/relay-store.js";

for (const mode of ["memory", "sqlite"] as const) {
  describe(`relay route store (${mode})`, () => {
    test("keeps the relay credential hash protocol compatible with browser enrollment", () => {
      const credential = `rrd_${"d".repeat(43)}`;
      const browserContractHash = "sha256:Hv-vzR_m3kAkti2CAuZBg7QRcd-W1masFv5t8t6Xel8";
      expect(relayCredentialHash(credential)).toBe(browserContractHash);

      const store = openRelayRouteStore({
        dbPath: ":memory:",
        generateRouteId: () => "route-browser-contract",
        ...(mode === "memory"
          ? {
              loadDatabase: () => {
                throw new Error("native unavailable");
              },
            }
          : {}),
      });
      const route = store.createRoute({
        label: "Browser contract",
        hostCredentialHash: relayCredentialHash(generateRelayCredential("rrh")),
      });
      store.putDevice({
        routeId: route.id,
        deviceId: "browser-device",
        credentialHash: browserContractHash,
        expiresAt: 10_000,
      });
      expect(store.authenticateDevice(route.id, "browser-device", credential, 9_999)).toBe(true);
      store.close();
    });

    test("stores only credential hashes and revokes devices independently", () => {
      const hostCredential = generateRelayCredential("rrh");
      const deviceCredential = generateRelayCredential("rrd");
      const store = openRelayRouteStore({
        dbPath: ":memory:",
        generateRouteId: () => "route-1",
        ...(mode === "memory"
          ? {
              loadDatabase: () => {
                throw new Error("native unavailable");
              },
            }
          : {}),
      });
      expect(store.mode).toBe(mode);
      const route = store.createRoute({
        label: "Studio",
        hostCredentialHash: relayCredentialHash(hostCredential),
      });
      expect(route.id).toBe("route-1");
      expect(JSON.stringify(route)).not.toContain(hostCredential);
      expect(store.authenticateHost(route.id, hostCredential)).toBe(true);
      expect(store.authenticateHost(route.id, generateRelayCredential("rrh"))).toBe(false);

      const device = store.putDevice({
        routeId: route.id,
        deviceId: "device-1",
        credentialHash: relayCredentialHash(deviceCredential),
      });
      expect(JSON.stringify(device)).not.toContain(deviceCredential);
      expect(store.authenticateDevice(route.id, "device-1", deviceCredential)).toBe(true);
      expect(store.listRoutes()).toEqual([expect.objectContaining({ id: route.id, label: "Studio", deviceCount: 1 })]);
      expect(store.revokeDevice(route.id, "device-1")).toBe(true);
      expect(store.authenticateDevice(route.id, "device-1", deviceCredential)).toBe(false);
      expect(store.revokeDevice(route.id, "device-1")).toBe(false);
      expect(store.deleteRoute(route.id)).toBe(true);
      expect(store.getRoute(route.id)).toBeUndefined();
      store.close();
    });

    test("rejects misleading direction controls in public route labels while allowing normal joined text", () => {
      const store = openRelayRouteStore({
        dbPath: ":memory:",
        generateRouteId: () => "route-label",
        ...(mode === "memory"
          ? {
              loadDatabase: () => {
                throw new Error("native unavailable");
              },
            }
          : {}),
      });
      const hostCredentialHash = relayCredentialHash(generateRelayCredential("rrh"));
      expect(() => store.createRoute({ label: "Studio\u202Etxt.exe", hostCredentialHash })).toThrow(
        "invalid relay route label",
      );
      expect(store.createRoute({ label: "Dev 👩‍💻", hostCredentialHash }).label).toBe("Dev 👩‍💻");
      store.close();
    });

    test("rotates a per-device capability without changing its route identity", () => {
      const store = openRelayRouteStore({
        dbPath: ":memory:",
        generateRouteId: () => "route-rotation",
        ...(mode === "memory"
          ? {
              loadDatabase: () => {
                throw new Error("native unavailable");
              },
            }
          : {}),
      });
      const hostCredential = generateRelayCredential("rrh");
      store.createRoute({ label: "Rotation", hostCredentialHash: relayCredentialHash(hostCredential) }, 1);
      const oldCredential = generateRelayCredential("rrd");
      const nextCredential = generateRelayCredential("rrd");
      store.putDevice(
        { routeId: "route-rotation", deviceId: "device-1", credentialHash: relayCredentialHash(oldCredential) },
        2,
      );
      store.putDevice(
        { routeId: "route-rotation", deviceId: "device-1", credentialHash: relayCredentialHash(nextCredential) },
        3,
      );
      expect(store.authenticateDevice("route-rotation", "device-1", oldCredential)).toBe(false);
      expect(store.authenticateDevice("route-rotation", "device-1", nextCredential)).toBe(true);
      expect(store.listRoutes()[0]?.deviceCount).toBe(1);
      store.close();
    });

    test("isolates account-owned routes and rotates the host capability", () => {
      let sequence = 0;
      const store = openRelayRouteStore({
        dbPath: ":memory:",
        generateRouteId: () => `route-owned-${++sequence}`,
        ...(mode === "memory"
          ? {
              loadDatabase: () => {
                throw new Error("native unavailable");
              },
            }
          : {}),
      });
      const firstCredential = generateRelayCredential("rrh");
      const nextCredential = generateRelayCredential("rrh");
      const first = store.createRoute({
        label: "First",
        hostCredentialHash: relayCredentialHash(firstCredential),
        ownerAccountId: "rra_account1234567890",
      });
      store.createRoute({
        label: "Second",
        hostCredentialHash: relayCredentialHash(generateRelayCredential("rrh")),
        ownerAccountId: "rra_another123456789",
      });
      expect(store.listRoutesByOwner("rra_account1234567890")).toEqual([
        expect.objectContaining({ id: first.id, label: "First" }),
      ]);
      expect(store.getRoute(first.id)?.ownerAccountId).toBe("rra_account1234567890");
      expect(store.rotateHostCredential(first.id, relayCredentialHash(nextCredential), 10)).toBe(true);
      expect(store.authenticateHost(first.id, firstCredential)).toBe(false);
      expect(store.authenticateHost(first.id, nextCredential)).toBe(true);
      expect(store.countDevices(first.id)).toBe(0);
      store.close();
    });

    test("expires bootstrap routing credentials until the host promotes them", () => {
      const store = openRelayRouteStore({
        dbPath: ":memory:",
        generateRouteId: () => "route-bootstrap",
        ...(mode === "memory"
          ? {
              loadDatabase: () => {
                throw new Error("native unavailable");
              },
            }
          : {}),
      });
      const hostCredential = generateRelayCredential("rrh");
      const deviceCredential = generateRelayCredential("rrd");
      store.createRoute({ label: "Bootstrap", hostCredentialHash: relayCredentialHash(hostCredential) }, 1);
      store.putDevice(
        {
          routeId: "route-bootstrap",
          deviceId: "pending-device",
          credentialHash: relayCredentialHash(deviceCredential),
          expiresAt: 100,
        },
        2,
      );
      expect(store.authenticateDevice("route-bootstrap", "pending-device", deviceCredential, 99)).toBe(true);
      expect(store.listRoutes(99)[0]?.deviceCount).toBe(1);
      expect(store.authenticateDevice("route-bootstrap", "pending-device", deviceCredential, 101)).toBe(false);
      expect(store.getDevice("route-bootstrap", "pending-device", 101)).toBeUndefined();
      expect(store.listRoutes(101)[0]?.deviceCount).toBe(0);

      const promoted = store.putDevice(
        {
          routeId: "route-bootstrap",
          deviceId: "pending-device",
          credentialHash: relayCredentialHash(deviceCredential),
        },
        102,
      );
      expect(promoted.createdAt).toBe(102);
      expect(store.authenticateDevice("route-bootstrap", "pending-device", deviceCredential, 1_000)).toBe(true);
      store.close();
    });

    test("rotates a bootstrap capability while retaining only an expiry-bounded retry overlap", () => {
      const store = openRelayRouteStore({
        dbPath: ":memory:",
        generateRouteId: () => "route-overlap",
        ...(mode === "memory"
          ? {
              loadDatabase: () => {
                throw new Error("native unavailable");
              },
            }
          : {}),
      });
      store.createRoute({
        label: "Overlap",
        hostCredentialHash: relayCredentialHash(generateRelayCredential("rrh")),
      });
      const bootstrapCredential = generateRelayCredential("rrd");
      const durableCredential = generateRelayCredential("rrd");
      const retriedDurableCredential = generateRelayCredential("rrd");
      store.putDevice(
        {
          routeId: "route-overlap",
          deviceId: "pairing-device",
          credentialHash: relayCredentialHash(bootstrapCredential),
          expiresAt: 100,
        },
        1,
      );

      expect(() =>
        store.putDevice(
          {
            routeId: "route-overlap",
            deviceId: "pairing-device",
            credentialHash: relayCredentialHash(bootstrapCredential),
          },
          2,
        ),
      ).toThrow("must rotate");

      const promoted = store.putDevice(
        {
          routeId: "route-overlap",
          deviceId: "pairing-device",
          credentialHash: relayCredentialHash(durableCredential),
        },
        3,
      );
      expect(promoted.expiresAt).toBeUndefined();
      expect(store.authenticateDevice("route-overlap", "pairing-device", bootstrapCredential, 99)).toBe(true);
      expect(store.authenticateDevice("route-overlap", "pairing-device", durableCredential, 99)).toBe(true);

      store.putDevice(
        {
          routeId: "route-overlap",
          deviceId: "pairing-device",
          credentialHash: relayCredentialHash(retriedDurableCredential),
        },
        4,
      );
      expect(store.authenticateDevice("route-overlap", "pairing-device", bootstrapCredential, 99)).toBe(true);
      expect(store.authenticateDevice("route-overlap", "pairing-device", durableCredential, 99)).toBe(false);
      expect(store.authenticateDevice("route-overlap", "pairing-device", retriedDurableCredential, 99)).toBe(true);
      expect(store.authenticateDevice("route-overlap", "pairing-device", bootstrapCredential, 101)).toBe(false);
      expect(store.authenticateDevice("route-overlap", "pairing-device", retriedDurableCredential, 101)).toBe(true);
      expect(store.countDevices("route-overlap", 101)).toBe(1);
      store.close();
    });
  });
}

test("migrates the released relay-device schema before creating a retry overlap", () => {
  const directory = mkdtempSync(join(tmpdir(), "roamcode-relay-store-migration-"));
  const dbPath = join(directory, "routes.db");
  const bootstrapCredential = generateRelayCredential("rrd");
  const durableCredential = generateRelayCredential("rrd");
  try {
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE relay_routes (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        host_credential_hash TEXT NOT NULL,
        owner_account_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE relay_route_devices (
        route_id TEXT NOT NULL REFERENCES relay_routes(id) ON DELETE CASCADE,
        device_id TEXT NOT NULL,
        credential_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        expires_at INTEGER,
        PRIMARY KEY(route_id, device_id)
      );
    `);
    legacy
      .prepare("INSERT INTO relay_routes VALUES (?, ?, ?, NULL, ?, ?)")
      .run("route-migrated", "Migrated", relayCredentialHash(generateRelayCredential("rrh")), 1, 1);
    legacy
      .prepare("INSERT INTO relay_route_devices VALUES (?, ?, ?, ?, ?, ?)")
      .run("route-migrated", "device-migrated", relayCredentialHash(bootstrapCredential), 1, 1, 100);
    legacy.close();

    const store = openRelayRouteStore({ dbPath });
    expect(store.mode).toBe("sqlite");
    store.putDevice(
      {
        routeId: "route-migrated",
        deviceId: "device-migrated",
        credentialHash: relayCredentialHash(durableCredential),
      },
      2,
    );
    expect(store.authenticateDevice("route-migrated", "device-migrated", bootstrapCredential, 99)).toBe(true);
    expect(store.authenticateDevice("route-migrated", "device-migrated", bootstrapCredential, 101)).toBe(false);
    expect(store.authenticateDevice("route-migrated", "device-migrated", durableCredential, 101)).toBe(true);
    store.close();

    const migrated = new Database(dbPath, { readonly: true });
    const columns = migrated.prepare("PRAGMA table_info(relay_route_devices)").all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toEqual(
      expect.arrayContaining(["previous_credential_hash", "previous_credential_expires_at"]),
    );
    migrated.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
