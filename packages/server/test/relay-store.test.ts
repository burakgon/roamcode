import { describe, expect, test } from "vitest";
import { generateRelayCredential, openRelayRouteStore, relayCredentialHash } from "../src/relay-store.js";

for (const mode of ["memory", "sqlite"] as const) {
  describe(`relay route store (${mode})`, () => {
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

      store.putDevice(
        {
          routeId: "route-bootstrap",
          deviceId: "pending-device",
          credentialHash: relayCredentialHash(deviceCredential),
        },
        102,
      );
      expect(store.authenticateDevice("route-bootstrap", "pending-device", deviceCredential, 1_000)).toBe(true);
      store.close();
    });
  });
}
