import { afterEach, describe, expect, test } from "vitest";
import {
  generateRelayAccountCredential,
  openRelayAccountStore,
  relayAccountCredentialHash,
  relayAccountCredentialLookup,
} from "../src/relay-account-store.js";
import { createBlindRelayServer } from "../src/relay-broker.js";
import { generateRelayCredential, openRelayRouteStore, relayCredentialHash } from "../src/relay-store.js";

const opened: Array<{ app: { close(): Promise<unknown> } }> = [];

afterEach(async () => {
  while (opened.length > 0) await opened.pop()!.app.close();
});

describe("private relay management API", () => {
  test("owns temporary device credentials, promotes with compare-and-swap, and makes cleanup replay-safe", async () => {
    let clock = 1_800_000_000_000;
    const rootToken = generateRelayCredential("rrp");
    const accountStore = openRelayAccountStore({
      dbPath: ":memory:",
      loadDatabase: () => {
        throw new Error("memory fixture");
      },
    });
    const store = openRelayRouteStore({
      dbPath: ":memory:",
      loadDatabase: () => {
        throw new Error("memory fixture");
      },
    });
    const accountId = "rra_deviceaccount0001";
    const routeId = "rrt-device-lifecycle";
    const deviceId = "device-browser-1";
    const accountCredential = generateRelayAccountCredential();
    accountStore.createAccount({
      id: accountId,
      label: "Device lifecycle",
      plan: "free",
      maxRoutes: 1,
      maxDevicesPerRoute: 1,
      credentialHash: relayAccountCredentialHash(accountCredential),
      credentialLookup: relayAccountCredentialLookup(accountCredential),
    });
    store.createRoute({
      id: routeId,
      label: "Lifecycle host",
      hostCredentialHash: relayCredentialHash(generateRelayCredential("rrh")),
      ownerAccountId: accountId,
    });
    const relay = createBlindRelayServer({ rootToken, accountStore, store, now: () => clock });
    opened.push(relay);
    const headers = { authorization: `Bearer ${rootToken}` };
    const path = `/internal/v1/accounts/${accountId}/routes/${routeId}/devices/${deviceId}`;
    const temporaryCredential = generateRelayCredential("rrd");
    const temporaryHash = relayCredentialHash(temporaryCredential);
    const durableCredential = generateRelayCredential("rrd");
    const durableHash = relayCredentialHash(durableCredential);
    const expiresAt = clock + 5 * 60_000;

    expect(
      (
        await relay.app.inject({
          method: "PUT",
          url: path,
          payload: { credentialHash: temporaryHash, expiresAt },
        })
      ).statusCode,
    ).toBe(401);

    const created = await relay.app.inject({
      method: "PUT",
      url: path,
      headers,
      payload: { credentialHash: temporaryHash, expiresAt },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toEqual({
      accountId,
      device: {
        routeId,
        deviceId,
        createdAt: clock,
        updatedAt: clock,
        expiresAt,
      },
    });
    expect(created.body).not.toContain(temporaryHash);
    expect(store.authenticateDevice(routeId, deviceId, temporaryCredential, clock)).toBe(true);

    const replay = await relay.app.inject({
      method: "PUT",
      url: path,
      headers,
      payload: { credentialHash: temporaryHash, expiresAt },
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual(created.json());

    const conflictingPut = await relay.app.inject({
      method: "PUT",
      url: path,
      headers,
      payload: { credentialHash: durableHash, expiresAt },
    });
    expect(conflictingPut.statusCode).toBe(409);
    expect(conflictingPut.body).not.toContain(temporaryHash);
    expect(conflictingPut.body).not.toContain(durableHash);

    clock += 1_000;
    const promoted = await relay.app.inject({
      method: "POST",
      url: `${path}/promote`,
      headers,
      payload: { expectedCredentialHash: temporaryHash, credentialHash: durableHash },
    });
    expect(promoted.statusCode).toBe(200);
    expect(promoted.json()).toMatchObject({
      accountId,
      device: { routeId, deviceId, createdAt: clock - 1_000, updatedAt: clock, expiresAt: null },
    });
    expect(promoted.body).not.toContain(temporaryHash);
    expect(promoted.body).not.toContain(durableHash);
    expect(store.authenticateDevice(routeId, deviceId, durableCredential, clock)).toBe(true);

    const replayedPromotion = await relay.app.inject({
      method: "POST",
      url: `${path}/promote`,
      headers,
      payload: { expectedCredentialHash: temporaryHash, credentialHash: durableHash },
    });
    expect(replayedPromotion.statusCode).toBe(200);
    expect(replayedPromotion.json()).toEqual(promoted.json());

    const lateCleanup = await relay.app.inject({
      method: "DELETE",
      url: path,
      headers,
      payload: { expectedCredentialHash: temporaryHash },
    });
    expect(lateCleanup.statusCode).toBe(409);
    expect(store.authenticateDevice(routeId, deviceId, durableCredential, clock)).toBe(true);

    expect(
      (
        await relay.app.inject({
          method: "DELETE",
          url: path,
          headers,
          payload: { expectedCredentialHash: durableHash },
        })
      ).statusCode,
    ).toBe(204);
    expect(
      (
        await relay.app.inject({
          method: "DELETE",
          url: path,
          headers,
          payload: { expectedCredentialHash: durableHash },
        })
      ).statusCode,
    ).toBe(204);
    expect(store.getDevice(routeId, deviceId, clock)).toBeUndefined();

    accountStore.close();
    store.close();
  });

  test("provisions, inspects, rotates, and deletes hashed account and route resources idempotently", async () => {
    const rootToken = generateRelayCredential("rrp");
    const previousRootToken = generateRelayCredential("rrp");
    const accountStore = openRelayAccountStore({
      dbPath: ":memory:",
      loadDatabase: () => {
        throw new Error("memory fixture");
      },
    });
    const store = openRelayRouteStore({
      dbPath: ":memory:",
      loadDatabase: () => {
        throw new Error("memory fixture");
      },
    });
    const relay = createBlindRelayServer({ rootToken, previousRootTokens: [previousRootToken], accountStore, store });
    opened.push(relay);
    const authorization = { authorization: `Bearer ${rootToken}` };
    const accountId = "rra_internalaccount0001";
    const accountPath = `/internal/v1/accounts/${accountId}`;
    const firstAccountCredential = generateRelayAccountCredential();
    const accountPayload = {
      label: "Internal account",
      plan: "free",
      maxRoutes: 3,
      maxDevicesPerRoute: 16,
      credentialHash: relayAccountCredentialHash(firstAccountCredential),
      credentialLookup: relayAccountCredentialLookup(firstAccountCredential),
    };

    const unauthorized = await relay.app.inject({ method: "PUT", url: accountPath, payload: accountPayload });
    expect(unauthorized.statusCode).toBe(401);

    const rawCredentialRejected = await relay.app.inject({
      method: "PUT",
      url: accountPath,
      headers: authorization,
      payload: { ...accountPayload, credential: firstAccountCredential },
    });
    expect(rawCredentialRejected.statusCode).toBe(400);
    expect(accountStore.getAccount(accountId)).toBeUndefined();

    const unknownAccountFieldRejected = await relay.app.inject({
      method: "PUT",
      url: accountPath,
      headers: authorization,
      payload: { ...accountPayload, rawSecret: firstAccountCredential },
    });
    expect(unknownAccountFieldRejected.statusCode).toBe(400);
    expect(accountStore.getAccount(accountId)).toBeUndefined();

    const createdAccount = await relay.app.inject({
      method: "PUT",
      url: accountPath,
      headers: authorization,
      payload: accountPayload,
    });
    expect(createdAccount.statusCode).toBe(201);
    expect(createdAccount.json()).toMatchObject({
      account: { id: accountId, label: "Internal account", revision: 1, status: "active" },
      usage: { routes: 0, maxRoutes: 3 },
    });
    expect(createdAccount.body).not.toContain(firstAccountCredential);
    expect(createdAccount.body).not.toContain(accountPayload.credentialHash);
    expect(createdAccount.body).not.toContain(accountPayload.credentialLookup);

    const replayedAccount = await relay.app.inject({
      method: "PUT",
      url: accountPath,
      headers: authorization,
      payload: accountPayload,
    });
    expect(replayedAccount.statusCode).toBe(200);
    expect(replayedAccount.json()).toEqual(createdAccount.json());

    const conflictingAccount = await relay.app.inject({
      method: "PUT",
      url: accountPath,
      headers: authorization,
      payload: { ...accountPayload, label: "Conflicting account" },
    });
    expect(conflictingAccount.statusCode).toBe(409);

    const accountStatus = await relay.app.inject({
      method: "GET",
      url: `${accountPath}/status`,
      headers: { authorization: `Bearer ${previousRootToken}` },
    });
    expect(accountStatus.statusCode).toBe(200);
    expect(accountStatus.json()).toMatchObject({ account: { id: accountId, revision: 1 } });

    const routeId = "rrt-internal-1";
    const routePath = `${accountPath}/routes/${routeId}`;
    const firstHostCredential = generateRelayCredential("rrh");
    const firstHostHash = relayCredentialHash(firstHostCredential);
    const routePayload = { label: "Primary host", credentialHash: firstHostHash };
    const rawHostCredentialRejected = await relay.app.inject({
      method: "PUT",
      url: routePath,
      headers: authorization,
      payload: { ...routePayload, hostCredential: firstHostCredential },
    });
    expect(rawHostCredentialRejected.statusCode).toBe(400);
    expect(store.getRoute(routeId)).toBeUndefined();

    const unknownRouteFieldRejected = await relay.app.inject({
      method: "PUT",
      url: routePath,
      headers: authorization,
      payload: { ...routePayload, rawSecret: firstHostCredential },
    });
    expect(unknownRouteFieldRejected.statusCode).toBe(400);
    expect(store.getRoute(routeId)).toBeUndefined();

    const createdRoute = await relay.app.inject({
      method: "PUT",
      url: routePath,
      headers: authorization,
      payload: routePayload,
    });
    expect(createdRoute.statusCode).toBe(201);
    expect(createdRoute.json()).toMatchObject({
      accountId,
      route: { id: routeId, label: "Primary host", deviceCount: 0 },
      status: { hostOnline: false, activeDevices: 0 },
      connection: { path: "/v1/connect", protocolVersion: 1 },
    });
    expect(createdRoute.body).not.toContain(firstHostCredential);
    expect(createdRoute.body).not.toContain(firstHostHash);
    expect(store.authenticateHost(routeId, firstHostCredential)).toBe(true);

    const replayedRoute = await relay.app.inject({
      method: "PUT",
      url: routePath,
      headers: authorization,
      payload: routePayload,
    });
    expect(replayedRoute.statusCode).toBe(200);
    expect(replayedRoute.json()).toEqual(createdRoute.json());

    const routeStatus = await relay.app.inject({
      method: "GET",
      url: `${routePath}/status`,
      headers: authorization,
    });
    expect(routeStatus.statusCode).toBe(200);
    expect(routeStatus.json()).toEqual(createdRoute.json());

    const conflictingRoute = await relay.app.inject({
      method: "PUT",
      url: routePath,
      headers: authorization,
      payload: { ...routePayload, credentialHash: relayCredentialHash(generateRelayCredential("rrh")) },
    });
    expect(conflictingRoute.statusCode).toBe(409);

    const nextHostCredential = generateRelayCredential("rrh");
    const nextHostHash = relayCredentialHash(nextHostCredential);
    const rotatedRoute = await relay.app.inject({
      method: "PUT",
      url: `${routePath}/credential`,
      headers: authorization,
      payload: { expectedCredentialHash: firstHostHash, credentialHash: nextHostHash },
    });
    expect(rotatedRoute.statusCode).toBe(200);
    expect(rotatedRoute.body).not.toContain(nextHostHash);
    expect(store.authenticateHost(routeId, firstHostCredential)).toBe(false);
    expect(store.authenticateHost(routeId, nextHostCredential)).toBe(true);

    const replayedRouteRotation = await relay.app.inject({
      method: "PUT",
      url: `${routePath}/credential`,
      headers: authorization,
      payload: { expectedCredentialHash: firstHostHash, credentialHash: nextHostHash },
    });
    expect(replayedRouteRotation.statusCode).toBe(200);

    const staleRouteRotation = await relay.app.inject({
      method: "PUT",
      url: `${routePath}/credential`,
      headers: authorization,
      payload: {
        expectedCredentialHash: firstHostHash,
        credentialHash: relayCredentialHash(generateRelayCredential("rrh")),
      },
    });
    expect(staleRouteRotation.statusCode).toBe(409);
    expect(store.authenticateHost(routeId, nextHostCredential)).toBe(true);

    const nextAccountCredential = generateRelayAccountCredential();
    const nextAccountMaterial = {
      credentialHash: relayAccountCredentialHash(nextAccountCredential),
      credentialLookup: relayAccountCredentialLookup(nextAccountCredential),
    };
    const rotatedAccount = await relay.app.inject({
      method: "PUT",
      url: `${accountPath}/credential`,
      headers: authorization,
      payload: { expectedRevision: 1, ...nextAccountMaterial },
    });
    expect(rotatedAccount.statusCode).toBe(200);
    expect(rotatedAccount.json()).toMatchObject({ account: { revision: 2 } });
    expect(rotatedAccount.body).not.toContain(nextAccountCredential);
    expect(rotatedAccount.body).not.toContain(nextAccountMaterial.credentialHash);
    expect(accountStore.authenticate(firstAccountCredential)).toBeUndefined();
    expect(accountStore.authenticate(nextAccountCredential)?.id).toBe(accountId);

    const replayedAccountRotation = await relay.app.inject({
      method: "PUT",
      url: `${accountPath}/credential`,
      headers: authorization,
      payload: { expectedRevision: 1, ...nextAccountMaterial },
    });
    expect(replayedAccountRotation.statusCode).toBe(200);
    expect(replayedAccountRotation.json()).toMatchObject({ account: { revision: 2 } });

    const metadataPayload = {
      expectedRevision: 2,
      label: "Enterprise account",
      plan: "enterprise",
      maxRoutes: 5,
      maxDevicesPerRoute: 32,
    };
    const updatedMetadata = await relay.app.inject({
      method: "PUT",
      url: `${accountPath}/metadata`,
      headers: authorization,
      payload: metadataPayload,
    });
    expect(updatedMetadata.statusCode).toBe(200);
    expect(updatedMetadata.json()).toMatchObject({
      account: {
        revision: 3,
        label: "Enterprise account",
        plan: "enterprise",
        maxRoutes: 5,
        maxDevicesPerRoute: 32,
      },
      usage: { maxRoutes: 5 },
    });
    const replayedMetadata = await relay.app.inject({
      method: "PUT",
      url: `${accountPath}/metadata`,
      headers: authorization,
      payload: metadataPayload,
    });
    expect(replayedMetadata.statusCode).toBe(200);
    expect(replayedMetadata.json()).toEqual(updatedMetadata.json());
    const unknownMetadataField = await relay.app.inject({
      method: "PUT",
      url: `${accountPath}/metadata`,
      headers: authorization,
      payload: { ...metadataPayload, credentialHash: nextAccountMaterial.credentialHash },
    });
    expect(unknownMetadataField.statusCode).toBe(400);

    const staleAccountRotation = await relay.app.inject({
      method: "PUT",
      url: `${accountPath}/credential`,
      headers: authorization,
      payload: {
        expectedRevision: 1,
        credentialHash: relayAccountCredentialHash(generateRelayAccountCredential()),
        credentialLookup: relayAccountCredentialLookup(generateRelayAccountCredential()),
      },
    });
    expect(staleAccountRotation.statusCode).toBe(409);

    const wrongRouteDelete = await relay.app.inject({
      method: "DELETE",
      url: routePath,
      headers: authorization,
      payload: { expectedCredentialHash: firstHostHash },
    });
    expect(wrongRouteDelete.statusCode).toBe(409);

    const deletedRoute = await relay.app.inject({
      method: "DELETE",
      url: routePath,
      headers: authorization,
      payload: { expectedCredentialHash: nextHostHash },
    });
    expect(deletedRoute.statusCode).toBe(204);
    const replayedRouteDelete = await relay.app.inject({
      method: "DELETE",
      url: routePath,
      headers: authorization,
      payload: { expectedCredentialHash: nextHostHash },
    });
    expect(replayedRouteDelete.statusCode).toBe(204);
    expect(store.getRoute(routeId)).toBeUndefined();

    const finalHostCredential = generateRelayCredential("rrh");
    const finalRouteId = "rrt-internal-final";
    expect(
      (
        await relay.app.inject({
          method: "PUT",
          url: `${accountPath}/routes/${finalRouteId}`,
          headers: authorization,
          payload: { label: "Final host", credentialHash: relayCredentialHash(finalHostCredential) },
        })
      ).statusCode,
    ).toBe(201);

    const deletedAccount = await relay.app.inject({
      method: "DELETE",
      url: accountPath,
      headers: authorization,
      payload: { expectedRevision: 3 },
    });
    expect(deletedAccount.statusCode).toBe(204);
    const replayedAccountDelete = await relay.app.inject({
      method: "DELETE",
      url: accountPath,
      headers: authorization,
      payload: { expectedRevision: 3 },
    });
    expect(replayedAccountDelete.statusCode).toBe(204);
    expect(store.getRoute(finalRouteId)).toBeUndefined();
    expect(
      (
        await relay.app.inject({
          method: "GET",
          url: `${accountPath}/status`,
          headers: authorization,
        })
      ).statusCode,
    ).toBe(404);

    accountStore.close();
  });

  test("normalizes real SQLite credential collisions into stable 409 responses", async () => {
    const rootToken = generateRelayCredential("rrp");
    const accountStore = openRelayAccountStore({ dbPath: ":memory:" });
    const store = openRelayRouteStore({ dbPath: ":memory:" });
    expect(accountStore.mode).toBe("sqlite");
    expect(store.mode).toBe("sqlite");
    const relay = createBlindRelayServer({ rootToken, accountStore, store });
    opened.push({
      app: {
        close: async () => {
          await relay.app.close();
          accountStore.close();
          store.close();
        },
      },
    });
    const headers = { authorization: `Bearer ${rootToken}` };
    const firstCredential = generateRelayAccountCredential();
    const secondCredential = generateRelayAccountCredential();
    const material = (credential: string) => ({
      credentialHash: relayAccountCredentialHash(credential),
      credentialLookup: relayAccountCredentialLookup(credential),
    });
    const payload = (label: string, credential: string) => ({
      label,
      plan: "free",
      maxRoutes: 3,
      maxDevicesPerRoute: 16,
      ...material(credential),
    });
    const firstPath = "/internal/v1/accounts/rra_sqlitecollision001";
    const secondPath = "/internal/v1/accounts/rra_sqlitecollision002";

    expect(
      (
        await relay.app.inject({
          method: "PUT",
          url: firstPath,
          headers,
          payload: payload("First account", firstCredential),
        })
      ).statusCode,
    ).toBe(201);

    const duplicateProvision = await relay.app.inject({
      method: "PUT",
      url: secondPath,
      headers,
      payload: payload("Second account", firstCredential),
    });
    expect(duplicateProvision.statusCode).toBe(409);
    expect(duplicateProvision.json()).toMatchObject({ code: "RELAY_ACCOUNT_EXISTS" });

    expect(
      (
        await relay.app.inject({
          method: "PUT",
          url: secondPath,
          headers,
          payload: payload("Second account", secondCredential),
        })
      ).statusCode,
    ).toBe(201);

    const duplicateRotation = await relay.app.inject({
      method: "PUT",
      url: `${firstPath}/credential`,
      headers,
      payload: { expectedRevision: 1, ...material(secondCredential) },
    });
    expect(duplicateRotation.statusCode).toBe(409);
    expect(duplicateRotation.json()).toMatchObject({ code: "RELAY_ACCOUNT_CREDENTIAL_CONFLICT" });
  });
});
