import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApiClient, terminalFileContentRequest, terminalWsUrl, ApiError, claimPairing } from "./client";
import type { CreateSessionBody } from "./client";
import type { CodexLoginCancellation } from "../providers/types";

// Every new outgoing request must make a provider choice. Incoming sessions remain tolerant of old servers.
// @ts-expect-error provider-less create bodies are deliberately forbidden
const providerlessCreate: CreateSessionBody = { cwd: "/x" };
void providerlessCreate;

const conflictingClaudeSafety: CreateSessionBody = {
  provider: "claude",
  cwd: "/x",
  // @ts-expect-error dangerous Claude mode cannot carry an ordinary permission mode
  options: { dangerouslySkip: true, permissionMode: "plan" },
};
void conflictingClaudeSafety;

const conflictingCodexSafety: CreateSessionBody = {
  provider: "codex",
  cwd: "/x",
  // @ts-expect-error dangerous Codex mode cannot carry ordinary sandbox controls
  options: { dangerouslyBypassApprovalsAndSandbox: true, sandbox: "workspace-write" },
};
void conflictingCodexSafety;

const missingLogin: CodexLoginCancellation = { status: "notFound" };
void missingLogin;
// @ts-expect-error login completion states are not cancellation response states
const invalidCancellation: CodexLoginCancellation = { status: "completed" };
void invalidCancellation;

const baseUrl = "http://127.0.0.1:4280";
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("ApiClient", () => {
  it("reads and acts on versioned command-center resources", async () => {
    const capabilities = {
      apiVersion: "v1",
      protocolVersion: 1,
      serverVersion: "1.0.0",
      host: { id: "h1", label: "Studio", createdAt: 1, updatedAt: 1 },
      features: {
        workspaces: true,
        agents: true,
        attention: true,
        resumableEvents: true,
        devicePairing: true,
        directMultiHost: false,
        relay: false,
        plugins: false,
      },
      providers: [],
    } as const;
    const workspace = {
      id: "w1",
      label: "Storefront",
      cwd: "/work/store",
      kind: "directory" as const,
      sortOrder: 0,
      createdAt: 1,
      updatedAt: 1,
    };
    const item = {
      id: "a1",
      workspaceId: "w1",
      sessionId: "s1",
      agentId: "agent_s1",
      kind: "blocked" as const,
      state: "open" as const,
      title: "Needs a decision",
      urgency: 100,
      occurrenceCount: 1,
      createdAt: 1,
      updatedAt: 1,
    };
    fetchMock
      .mockResolvedValueOnce(jsonResponse(capabilities))
      .mockResolvedValueOnce(jsonResponse({ workspaces: [workspace] }))
      .mockResolvedValueOnce(jsonResponse({ items: [item], unreadCount: 1 }))
      .mockResolvedValueOnce(jsonResponse({ item: { ...item, state: "snoozed", snoozedUntil: 9_000 } }))
      .mockResolvedValueOnce(jsonResponse({ events: [{ id: 3, type: "attention.created" }], nextCursor: 3 }));
    const api = createApiClient({ baseUrl, getToken: () => "tok" });

    await expect(api.getCommandCenterCapabilities()).resolves.toEqual(capabilities);
    await expect(api.listWorkspaces()).resolves.toEqual([workspace]);
    await expect(api.listAttention()).resolves.toEqual({ items: [item], unreadCount: 1 });
    await expect(api.updateAttention("a/1", "snooze", 9_000)).resolves.toMatchObject({ state: "snoozed" });
    await expect(api.listCommandEvents(2, 10)).resolves.toMatchObject({ nextCursor: 3 });

    expect(fetchMock.mock.calls.map((call) => String(call[0]))).toEqual([
      `${baseUrl}/api/v1/capabilities`,
      `${baseUrl}/api/v1/workspaces`,
      `${baseUrl}/api/v1/attention`,
      `${baseUrl}/api/v1/attention/a%2F1`,
      `${baseUrl}/api/v1/events?after=2&limit=10`,
    ]);
    const action = fetchMock.mock.calls[3]![1] as RequestInit;
    expect(action.method).toBe("PATCH");
    expect(JSON.parse(action.body as string)).toEqual({ action: "snooze", until: 9_000 });
  });

  it("loads the live adapter catalog with its generated option schema", async () => {
    const adapter = {
      id: "review-agent",
      displayName: "Review Agent",
      version: "1.2.0",
      source: "installed" as const,
      enabled: true,
      resumeIdentity: "required" as const,
      optionSchema: {
        type: "object",
        additionalProperties: false,
        properties: { mode: { enum: ["safe", "fast"] } },
      },
    };
    fetchMock.mockResolvedValueOnce(jsonResponse({ adapters: [adapter], packages: [] }));
    const api = createApiClient({ baseUrl, getToken: () => "tok" });

    await expect(api.listAdapters()).resolves.toEqual([adapter]);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${baseUrl}/api/v1/adapters`);
    expect((init as RequestInit).headers).toEqual({ authorization: "Bearer tok" });
  });

  it("streams resumable command events with the bearer token only in a header", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(encoder.encode('id: 4\nevent: command\ndata: {"id":4,"type":"attention.created"}\n\n'));
        controller.enqueue(encoder.encode('id: 4\nevent: ready\ndata: {"cursor":4}\n\n'));
        controller.close();
      },
    });
    fetchMock.mockResolvedValueOnce(
      new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }),
    );
    const api = createApiClient({ baseUrl, getToken: () => "stream-token" });
    const messages: string[] = [];

    await new Promise<void>((resolve) => {
      let unsubscribe = () => {};
      unsubscribe = api.subscribeCommandEvents({
        after: 3,
        onEvent: (message) => {
          messages.push(message.event);
          if (message.event === "ready") {
            unsubscribe();
            resolve();
          }
        },
      });
    });

    expect(messages).toEqual(["command", "ready"]);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${baseUrl}/api/v1/events/stream?after=3`);
    expect(String(url)).not.toContain("stream-token");
    expect((init as RequestInit).headers).toMatchObject({
      accept: "text/event-stream",
      authorization: "Bearer stream-token",
    });
  });

  it("uses an injected relay transport and resumes events through bounded polling", async () => {
    const event = {
      id: 7,
      type: "attention.created",
      resourceType: "attention",
      resourceId: "a7",
      payload: {},
      createdAt: 10,
    };
    const relayRequest = vi.fn().mockResolvedValueOnce(jsonResponse({ events: [event], nextCursor: 7 }));
    const api = createApiClient({
      baseUrl: "https://relay-host.invalid",
      getToken: () => "relay-device-token",
      request: relayRequest,
      supportsStreaming: false,
    });

    await new Promise<void>((resolve) => {
      let unsubscribe = () => {};
      unsubscribe = api.subscribeCommandEvents({
        after: 6,
        onEvent: (message) => {
          expect(message).toEqual({ event: "command", id: 7, data: event });
          unsubscribe();
          resolve();
        },
      });
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(relayRequest).toHaveBeenCalledWith(
      "https://relay-host.invalid/api/v1/events?after=6&limit=500",
      expect.objectContaining({ headers: { authorization: "Bearer relay-device-token" } }),
    );
  });

  it("starts a no-store remote pairing through the active host transport", async () => {
    const response = {
      pairing: { expiresAt: 1234 },
      url: "https://app.roamcode.example/#relay-pair=opaque",
    };
    fetchMock.mockResolvedValueOnce(jsonResponse(response, 201));
    const api = createApiClient({ baseUrl, getToken: () => "device-token" });

    await expect(api.startRelayPairing()).resolves.toEqual(response);
    expect(fetchMock).toHaveBeenCalledWith(
      `${baseUrl}/api/v1/relay/pairing`,
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          authorization: "Bearer device-token",
          "content-type": "application/json",
          "idempotency-key": expect.any(String),
        }),
        body: "{}",
      }),
    );
  });

  it("cancels direct and relay pairing capabilities through authenticated no-body mutations", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const api = createApiClient({ baseUrl, getToken: () => "device-token" });

    await expect(api.cancelPairing(`rcp_${"s".repeat(43)}`)).resolves.toBeUndefined();
    await expect(api.cancelRelayPairing("pending-device")).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      `${baseUrl}/pairing/cancel`,
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ authorization: "Bearer device-token" }),
        body: JSON.stringify({ secret: `rcp_${"s".repeat(43)}` }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      `${baseUrl}/api/v1/relay/pairing/cancel`,
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          authorization: "Bearer device-token",
          "idempotency-key": expect.any(String),
        }),
        body: JSON.stringify({ deviceId: "pending-device" }),
      }),
    );
  });

  it("reads privacy-bounded relay connector health", async () => {
    const status = {
      configured: true,
      pairingAvailable: true,
      status: "online",
      activeDevices: 2,
      reconnects: 1,
    } as const;
    fetchMock.mockResolvedValueOnce(jsonResponse(status));
    const api = createApiClient({ baseUrl, getToken: () => "device-token" });

    await expect(api.getRelayStatus()).resolves.toEqual(status);
    expect(fetchMock).toHaveBeenCalledWith(
      `${baseUrl}/api/v1/relay/status`,
      expect.objectContaining({ headers: { authorization: "Bearer device-token" } }),
    );
  });

  it("reads privacy-bounded managed-host sync and recovery state", async () => {
    const status = {
      v: 1,
      mode: "managed",
      configured: true,
      sync: { state: "expired", lastSuccessfulAt: 1_000 },
      authorization: { status: "expired", revision: 7, expiresAt: 2_000, expired: true },
      action: "check-host-connectivity",
    } as const;
    fetchMock.mockResolvedValueOnce(jsonResponse(status));
    const api = createApiClient({ baseUrl, getToken: () => "device-token" });

    await expect(api.getCloudStatus()).resolves.toEqual(status);
    expect(fetchMock).toHaveBeenCalledWith(
      `${baseUrl}/api/v1/cloud/status`,
      expect.objectContaining({ headers: { authorization: "Bearer device-token" } }),
    );
  });

  it("manages host and workspace hierarchy through stable v1 mutations", async () => {
    const host = { id: "h1", label: "Build host", createdAt: 1, updatedAt: 2 };
    const workspace = {
      id: "w1",
      label: "Storefront",
      cwd: "/work/store",
      kind: "worktree" as const,
      sortOrder: 0,
      createdAt: 1,
      updatedAt: 1,
    };
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ host }))
      .mockResolvedValueOnce(jsonResponse({ workspace }, 201))
      .mockResolvedValueOnce(jsonResponse({ workspace: { ...workspace, label: "Web", sortOrder: 2 } }));
    const api = createApiClient({ baseUrl, getToken: () => "tok" });

    await expect(api.renameCommandHost("Build host")).resolves.toEqual(host);
    await expect(api.createWorkspace("/work/store", "Storefront", "worktree")).resolves.toEqual(workspace);
    await expect(api.updateWorkspace("w/1", { label: "Web", sortOrder: 2 })).resolves.toMatchObject({ label: "Web" });

    expect(fetchMock.mock.calls.map((call) => String(call[0]))).toEqual([
      `${baseUrl}/api/v1/host`,
      `${baseUrl}/api/v1/workspaces`,
      `${baseUrl}/api/v1/workspaces/w%2F1`,
    ]);
    expect(JSON.parse((fetchMock.mock.calls[1]![1] as RequestInit).body as string)).toEqual({
      cwd: "/work/store",
      label: "Storefront",
      kind: "worktree",
    });
  });

  it("manages independently revocable devices with authenticated routes", async () => {
    const inventory = {
      currentDeviceId: "phone",
      devices: [{ id: "phone", name: "Phone", createdAt: 1, lastSeenAt: 2 }],
    };
    fetchMock
      .mockResolvedValueOnce(jsonResponse(inventory))
      .mockResolvedValueOnce(jsonResponse({ secret: "rcp_once", expiresAt: 123, scopes: ["direct"] }, 201))
      .mockResolvedValueOnce(jsonResponse({ device: { ...inventory.devices[0], name: "Travel phone" } }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(jsonResponse({ token: "new-host-token", revokedDevices: 2 }));
    const api = createApiClient({ baseUrl, getToken: () => "device-token" });

    await expect(api.listDevices()).resolves.toEqual(inventory);
    await expect(api.startPairing()).resolves.toEqual({ secret: "rcp_once", expiresAt: 123, scopes: ["direct"] });
    await expect(api.renameDevice("phone", "Travel phone")).resolves.toMatchObject({ name: "Travel phone" });
    await expect(api.revokeDevice("old device")).resolves.toBeUndefined();
    await expect(api.resetAccess()).resolves.toEqual({ token: "new-host-token", revokedDevices: 2 });

    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      `${baseUrl}/api/v1/devices`,
      `${baseUrl}/pairing/start`,
      `${baseUrl}/api/v1/devices/phone`,
      `${baseUrl}/api/v1/devices/old%20device`,
      `${baseUrl}/access/reset`,
    ]);
    const pairing = fetchMock.mock.calls[1]![1] as RequestInit;
    expect(pairing.headers).toMatchObject({
      authorization: "Bearer device-token",
      "content-type": "application/json",
    });
    expect(JSON.parse(pairing.body as string)).toEqual({ scopes: ["direct"] });
  });

  it("claims a pairing publicly without sending an existing bearer token", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        {
          token: "device-token",
          device: { id: "phone", name: "Phone", createdAt: 1, lastSeenAt: 1 },
        },
        201,
      ),
    );
    await expect(claimPairing("rcp_once", "Phone", baseUrl)).resolves.toMatchObject({ token: "device-token" });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${baseUrl}/pairing/claim`);
    expect((init as RequestInit).headers).toEqual({ "content-type": "application/json" });
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ secret: "rcp_once", name: "Phone" });
  });

  it("confirms cloud enrollment through the authenticated host without sending an actor or callback URL", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ enrolled: true, actorId: "canonical-device" }, 201));
    const api = createApiClient({ baseUrl, getToken: () => "device-token" });
    const enrollmentId = "11111111-1111-4111-8111-111111111111";
    const challenge = `rce_${"c".repeat(43)}`;

    await expect(api.confirmCloudDeviceEnrollment(enrollmentId, challenge)).resolves.toEqual({
      enrolled: true,
      actorId: "canonical-device",
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${baseUrl}/api/v1/cloud/device-enrollments/confirm`);
    expect((init as RequestInit).headers).toMatchObject({
      authorization: "Bearer device-token",
      "content-type": "application/json",
      "idempotency-key": expect.any(String),
    });
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ v: 1, enrollmentId, challenge });
  });

  it("getSessionDefaults GETs the authenticated defaults envelope", async () => {
    const envelope = {
      defaults: { effort: "medium", dangerouslySkip: false },
      revision: 3,
      updatedAt: 1_234,
    };
    fetchMock.mockResolvedValueOnce(jsonResponse(envelope));
    const api = createApiClient({ baseUrl, getToken: () => "tok" });

    await expect(api.getSessionDefaults()).resolves.toEqual(envelope);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${baseUrl}/settings/session-defaults`);
    expect((init as RequestInit).method).toBeUndefined();
    expect((init as RequestInit).headers).toEqual({ authorization: "Bearer tok" });
  });

  it("putSessionDefaults PUTs the complete document and expected revision", async () => {
    const defaults = {
      effort: "high",
      model: "claude-opus-4-1",
      dangerouslySkip: false,
      permissionMode: "plan" as const,
    };
    const envelope = { defaults, revision: 4, updatedAt: 2_345 };
    fetchMock.mockResolvedValueOnce(jsonResponse(envelope));
    const api = createApiClient({ baseUrl, getToken: () => "tok" });

    await expect(api.putSessionDefaults(defaults, 3)).resolves.toEqual(envelope);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${baseUrl}/settings/session-defaults`);
    expect((init as RequestInit).method).toBe("PUT");
    expect((init as RequestInit).headers).toEqual({
      "content-type": "application/json",
      authorization: "Bearer tok",
    });
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ defaults, expectedRevision: 3 });
  });

  it("preserves the structured settings conflict body on ApiError", async () => {
    const body = {
      code: "SETTINGS_CONFLICT",
      error: "Session defaults revision conflict",
      current: {
        defaults: { effort: "low", dangerouslySkip: false },
        revision: 5,
        updatedAt: 3_456,
      },
    };
    fetchMock.mockResolvedValueOnce(jsonResponse(body, 409));
    const api = createApiClient({ baseUrl, getToken: () => "tok" });

    await expect(api.putSessionDefaults({ effort: "high", dangerouslySkip: false }, 4)).rejects.toMatchObject({
      status: 409,
      code: "SETTINGS_CONFLICT",
      message: "Session defaults revision conflict",
      body,
    });
  });

  it("listSessions GETs the versioned session resource with a bearer token", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ sessions: [{ id: "s1", cwd: "/p", dangerouslySkip: false, status: "running", createdAt: 1 }] }),
    );
    const api = createApiClient({ baseUrl, getToken: () => "tok" });
    const sessions = await api.listSessions();
    expect(sessions).toHaveLength(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${baseUrl}/api/v1/sessions`);
    expect((init as RequestInit).headers).toMatchObject({ authorization: "Bearer tok" });
  });

  it("binds terminal input lease mutations and sends to the exact holder", async () => {
    const lease = {
      owner: { actorType: "device", label: "Automation" },
      acquiredAt: 1,
      renewedAt: 1,
      expiresAt: 31_000,
      revision: 2,
    } as const;
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ lease }))
      .mockResolvedValueOnce(jsonResponse({ leaseId: "lease-1", lease }, 201))
      .mockResolvedValueOnce(jsonResponse({ accepted: true, focused: false }, 202));
    const api = createApiClient({ baseUrl, getToken: () => "tok" });

    await expect(api.getSessionInputLease("s/1")).resolves.toEqual(lease);
    await expect(
      api.changeSessionInputLease("s/1", { action: "takeover", clientId: "agent-a", confirm: true }),
    ).resolves.toMatchObject({ leaseId: "lease-1" });
    await expect(api.sendSessionInput("s/1", "continue", { clientId: "agent-a", leaseId: "lease-1" })).resolves.toEqual(
      { accepted: true, focused: false },
    );

    expect(fetchMock.mock.calls.map((call) => String(call[0]))).toEqual([
      `${baseUrl}/api/v1/sessions/s%2F1/input-lease`,
      `${baseUrl}/api/v1/sessions/s%2F1/input-lease`,
      `${baseUrl}/api/v1/sessions/s%2F1/input`,
    ]);
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      action: "takeover",
      clientId: "agent-a",
      confirm: true,
    });
    expect(JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body))).toEqual({
      data: "continue",
      clientId: "agent-a",
      leaseId: "lease-1",
    });
  });

  it("manages privacy-bounded peers and discovers workspace metadata before granting scope", async () => {
    const peer = {
      id: "peer-1",
      label: "Build host",
      remoteHostId: "host-2",
      remoteVersion: "1.2.3",
      actions: ["read", "wait"] as const,
      allowedWorkspaceIds: [] as string[],
      status: "active" as const,
      revision: 1,
      createdAt: 1,
      updatedAt: 1,
      lastVerifiedAt: 1,
    };
    const workspace = { id: "workspace-2", label: "Build", kind: "directory" as const, archived: false };
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ peers: [peer] }))
      .mockResolvedValueOnce(jsonResponse({ peer }, 201))
      .mockResolvedValueOnce(jsonResponse({ peer: { ...peer, revision: 2 }, workspaces: [workspace] }))
      .mockResolvedValueOnce(jsonResponse({ peer: { ...peer, revision: 3, allowedWorkspaceIds: [workspace.id] } }))
      .mockResolvedValueOnce(jsonResponse({ peer: { ...peer, revision: 4 } }))
      .mockResolvedValueOnce(jsonResponse({ peer: { ...peer, revision: 5 } }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const api = createApiClient({ baseUrl, getToken: () => "local-device" });

    await expect(api.listPeers()).resolves.toEqual([peer]);
    const pairingUrl = `https://build.example/#pair=rcp_${"s".repeat(43)}`;
    await expect(api.createPeer({ pairingUrl })).resolves.toEqual(peer);
    await expect(api.discoverPeerWorkspaces("peer/1", 1)).resolves.toMatchObject({ workspaces: [workspace] });
    await expect(
      api.updatePeer("peer/1", { expectedRevision: 2, allowedWorkspaceIds: [workspace.id] }),
    ).resolves.toMatchObject({ revision: 3 });
    await expect(api.verifyPeer("peer/1", 3)).resolves.toMatchObject({ revision: 4 });
    const replacementPairingUrl = `https://build.example/#pair=rcp_${"r".repeat(43)}`;
    await expect(api.rotatePeerCredential("peer/1", { pairingUrl: replacementPairingUrl }, 4)).resolves.toMatchObject({
      revision: 5,
    });
    await expect(api.removePeer("peer/1")).resolves.toBeUndefined();

    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      `${baseUrl}/api/v1/peers`,
      `${baseUrl}/api/v1/peers`,
      `${baseUrl}/api/v1/peers/peer%2F1/discover`,
      `${baseUrl}/api/v1/peers/peer%2F1`,
      `${baseUrl}/api/v1/peers/peer%2F1/verify`,
      `${baseUrl}/api/v1/peers/peer%2F1/credential`,
      `${baseUrl}/api/v1/peers/peer%2F1`,
    ]);
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      pairingUrl,
      confirm: true,
    });
    expect(JSON.parse(String(fetchMock.mock.calls[5]?.[1]?.body))).toEqual({
      pairingUrl: replacementPairingUrl,
      expectedRevision: 4,
      confirm: true,
    });
    expect(JSON.parse(String(fetchMock.mock.calls[6]?.[1]?.body))).toEqual({ confirm: true });
  });

  it("operates remote agents through the same lease and non-stealing focus contract", async () => {
    const workspace = {
      id: "workspace-2",
      label: "Build",
      cwd: "/remote/build",
      kind: "directory" as const,
      sortOrder: 0,
      createdAt: 1,
      updatedAt: 1,
    };
    const agent = {
      id: "agent-2",
      sessionId: "session-2",
      workspaceId: workspace.id,
      provider: "codex",
      activity: "working" as const,
      createdAt: 1,
      updatedAt: 2,
    };
    const session = { id: "session-2", cwd: workspace.cwd, workspaceId: workspace.id };
    const lease = {
      owner: { actorType: "device" as const, label: "Federation service" },
      acquiredAt: 1,
      renewedAt: 1,
      expiresAt: 31_000,
      revision: 1,
    };
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ workspaces: [workspace] }))
      .mockResolvedValueOnce(jsonResponse({ agents: [agent] }))
      .mockResolvedValueOnce(jsonResponse({ sessions: [session] }))
      .mockResolvedValueOnce(jsonResponse({ session }, 201))
      .mockResolvedValueOnce(jsonResponse({ lease }))
      .mockResolvedValueOnce(jsonResponse({ leaseId: "lease-2", lease }, 201))
      .mockResolvedValueOnce(jsonResponse({ accepted: true, focused: false }, 202))
      .mockResolvedValueOnce(jsonResponse({ agent, timedOut: false }))
      .mockResolvedValueOnce(
        jsonResponse({ accepted: true, focused: false, agentId: agent.id, sessionId: session.id }, 202),
      );
    const api = createApiClient({ baseUrl, getToken: () => "local-device" });

    await expect(api.listPeerWorkspaces("peer-1")).resolves.toEqual([workspace]);
    await expect(api.listPeerAgents("peer-1")).resolves.toEqual([agent]);
    await expect(api.listPeerSessions("peer-1")).resolves.toEqual([session]);
    await expect(
      api.createPeerSession("peer-1", {
        workspaceId: workspace.id,
        provider: "codex",
        options: { sandbox: "workspace-write", approvalPolicy: "on-request" },
      }),
    ).resolves.toMatchObject({ session });
    await expect(api.getPeerSessionInputLease("peer-1", session.id)).resolves.toEqual(lease);
    await expect(
      api.changePeerSessionInputLease("peer-1", session.id, { action: "acquire", clientId: "automation-1" }),
    ).resolves.toMatchObject({ leaseId: "lease-2" });
    await expect(
      api.sendPeerSessionInput("peer-1", session.id, "continue", {
        clientId: "automation-1",
        leaseId: "lease-2",
      }),
    ).resolves.toEqual({ accepted: true, focused: false });
    await expect(api.waitPeerAgent("peer-1", agent.id, 2, 10)).resolves.toMatchObject({ timedOut: false });
    await expect(api.focusPeerAgent("peer-1", agent.id)).resolves.toMatchObject({ focused: false });

    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      `${baseUrl}/api/v1/peers/peer-1/workspaces`,
      `${baseUrl}/api/v1/peers/peer-1/agents`,
      `${baseUrl}/api/v1/peers/peer-1/sessions`,
      `${baseUrl}/api/v1/peers/peer-1/sessions`,
      `${baseUrl}/api/v1/peers/peer-1/sessions/session-2/input-lease`,
      `${baseUrl}/api/v1/peers/peer-1/sessions/session-2/input-lease`,
      `${baseUrl}/api/v1/peers/peer-1/sessions/session-2/input`,
      `${baseUrl}/api/v1/peers/peer-1/agents/agent-2/wait?after=2&timeoutMs=10`,
      `${baseUrl}/api/v1/peers/peer-1/agents/agent-2/focus`,
    ]);
  });

  it("operates team membership and privacy-bounded presence through the active host", async () => {
    const team = {
      id: "team-1",
      name: "Engineering",
      authorizationEnabled: false,
      revision: 1,
      createdAt: 1,
      updatedAt: 1,
    } as const;
    const member = {
      id: "member-1",
      displayName: "Reviewer",
      kind: "person" as const,
      status: "active" as const,
      revision: 1,
      createdAt: 1,
      updatedAt: 1,
    };
    const presence = {
      id: "presence-1",
      label: "Reviewer browser",
      mode: "viewing" as const,
      hostId: "host-1",
      sessionId: "session-1",
      connectedAt: 1,
      lastSeenAt: 1,
      expiresAt: 46_000,
      revision: 1,
    };
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ team, currentMember: member, roles: [], permissions: [], authorization: { enabled: false } }),
      )
      .mockResolvedValueOnce(jsonResponse({ member, roles: [] }, 201))
      .mockResolvedValueOnce(jsonResponse({ presence, heartbeatMs: 15_000 }))
      .mockResolvedValueOnce(jsonResponse({ presence: [presence] }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const api = createApiClient({ baseUrl, getToken: () => "device-token" });

    await expect(api.getTeam()).resolves.toMatchObject({ team: { id: "team-1" } });
    await expect(api.createTeamMember({ displayName: "Reviewer" })).resolves.toMatchObject({ id: "member-1" });
    await expect(
      api.heartbeatPresence({ clientId: "tab-1", mode: "viewing", sessionId: "session-1" }),
    ).resolves.toMatchObject({ heartbeatMs: 15_000 });
    await expect(api.listPresence({ sessionId: "session-1" })).resolves.toEqual([presence]);
    await expect(api.releasePresence("tab-1")).resolves.toBeUndefined();

    expect(fetchMock.mock.calls.map((call) => String(call[0]))).toEqual([
      `${baseUrl}/api/v1/team`,
      `${baseUrl}/api/v1/team/members`,
      `${baseUrl}/api/v1/presence`,
      `${baseUrl}/api/v1/presence?sessionId=session-1`,
      `${baseUrl}/api/v1/presence`,
    ]);
    expect(JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body))).toEqual({
      clientId: "tab-1",
      mode: "viewing",
      sessionId: "session-1",
    });
    expect((fetchMock.mock.calls[2]?.[1]?.headers as Record<string, string>).authorization).toBe("Bearer device-token");
  });

  it("reads and updates enterprise posture and exports audit data with header authentication", async () => {
    const policy = {
      enforcementEnabled: false,
      allowedHostIds: null,
      allowedWorkspaceIds: null,
      allowedProviderIds: null,
      allowDangerousProviderModes: false,
      allowFileTransfer: true,
      extensionMode: "allow-integrity",
      allowRelay: true,
      updateMode: "stable-only",
      revision: 1,
      createdAt: 1,
      updatedAt: 1,
    } as const;
    const fleet = { revision: 1, hosts: [] };
    const verification = { valid: true, count: 0, head: "0".repeat(64) };
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ policy }))
      .mockResolvedValueOnce(jsonResponse({ policy: { ...policy, allowRelay: false, revision: 2 } }))
      .mockResolvedValueOnce(jsonResponse(fleet))
      .mockResolvedValueOnce(jsonResponse({ records: [], nextCursor: 0 }))
      .mockResolvedValueOnce(jsonResponse({ records: [], nextCursor: 0 }))
      .mockResolvedValueOnce(jsonResponse(verification))
      .mockResolvedValueOnce(
        new Response('{"type":"manifest"}\n', {
          status: 200,
          headers: { "content-type": "application/x-ndjson" },
        }),
      );
    const api = createApiClient({ baseUrl, getToken: () => "host-recovery" });

    await expect(api.getEnterprisePolicy()).resolves.toEqual(policy);
    await expect(api.updateEnterprisePolicy({ allowRelay: false, expectedRevision: 1 })).resolves.toMatchObject({
      allowRelay: false,
      revision: 2,
    });
    await expect(api.getFleetInventory()).resolves.toEqual(fleet);
    await expect(api.listAudit(4, 25)).resolves.toEqual({ records: [], nextCursor: 0 });
    await expect(api.listLatestAudit(20)).resolves.toEqual({ records: [], nextCursor: 0 });
    await expect(api.verifyAudit()).resolves.toEqual(verification);
    await expect(api.exportAudit(4, 25)).resolves.toBe('{"type":"manifest"}\n');

    expect(fetchMock.mock.calls.map((call) => String(call[0]))).toEqual([
      `${baseUrl}/api/v1/policy`,
      `${baseUrl}/api/v1/policy`,
      `${baseUrl}/api/v1/fleet`,
      `${baseUrl}/api/v1/audit?after=4&limit=25`,
      `${baseUrl}/api/v1/audit?order=latest&limit=20`,
      `${baseUrl}/api/v1/audit/verify`,
      `${baseUrl}/api/v1/audit/export?after=4&limit=25`,
    ]);
    for (const [url, init] of fetchMock.mock.calls) {
      expect(String(url)).not.toContain("host-recovery");
      expect((init as RequestInit).headers).toMatchObject({ authorization: "Bearer host-recovery" });
    }
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ method: "PATCH" });
    expect(fetchMock.mock.calls[6]?.[1]?.headers).toMatchObject({ accept: "application/x-ndjson" });
  });

  it("createSession POSTs a discriminated Claude body and preserves non-fatal warnings", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        {
          session: {
            id: "s2",
            provider: "claude",
            cwd: "/x",
            dangerouslySkip: false,
            status: "running",
            createdAt: 2,
          },
          warnings: [{ code: "PROVIDER_METADATA_UNAVAILABLE", message: "metadata unavailable" }],
        },
        201,
      ),
    );
    const api = createApiClient({ baseUrl, getToken: () => undefined });
    const created = await api.createSession({ provider: "claude", cwd: "/x", options: { model: "opus" } });
    expect(created.session.id).toBe("s2");
    expect(created.warnings).toEqual([{ code: "PROVIDER_METADATA_UNAVAILABLE", message: "metadata unavailable" }]);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${baseUrl}/api/v1/sessions`);
    expect((init as RequestInit).method).toBe("POST");
    expect((init as RequestInit).headers).toMatchObject({ "idempotency-key": expect.stringMatching(/^web-/) });
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      provider: "claude",
      cwd: "/x",
      options: { model: "opus" },
    });
  });

  it("preserves the server error code when provider options become stale", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ code: "INVALID_PROVIDER_OPTIONS", error: "Invalid Codex model or reasoning selection" }, 400),
    );
    const api = createApiClient({ baseUrl, getToken: () => undefined });

    await expect(
      api.createSession({
        provider: "codex",
        cwd: "/x",
        options: { model: "gpt-stale", reasoningEffort: "high" },
      }),
    ).rejects.toMatchObject({
      status: 400,
      code: "INVALID_PROVIDER_OPTIONS",
      message: "Invalid Codex model or reasoning selection",
    });
  });

  it("POSTs a provider-native Codex body without flattening its controls", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        session: {
          id: "c1",
          provider: "codex",
          identityState: "pending",
          cwd: "/x",
          dangerouslySkip: false,
          status: "running",
          createdAt: 2,
        },
      }),
    );
    const api = createApiClient({ baseUrl, getToken: () => undefined });
    await api.createSession({
      provider: "codex",
      cwd: "/x",
      options: {
        model: "gpt-future-custom",
        sandbox: "workspace-write",
        approvalPolicy: "on-request",
        reasoningEffort: "high",
      },
    });
    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      provider: "codex",
      cwd: "/x",
      options: {
        model: "gpt-future-custom",
        sandbox: "workspace-write",
        approvalPolicy: "on-request",
        reasoningEffort: "high",
      },
    });
  });

  it("throws ApiError with status 401 on unauthorized", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "unauthorized" }, 401));
    const api = createApiClient({ baseUrl, getToken: () => "bad" });
    await expect(api.listSessions()).rejects.toMatchObject({ status: 401 });
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "unauthorized" }, 401));
    await expect(api.listSessions()).rejects.toBeInstanceOf(ApiError);
  });

  it("listDir GETs /fs/list with the path query", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ path: "/home", entries: [] }));
    const api = createApiClient({ baseUrl, getToken: () => undefined });
    await api.listDir("/home/u");
    expect(fetchMock.mock.calls[0]![0]).toBe(`${baseUrl}/fs/list?path=${encodeURIComponent("/home/u")}`);
  });

  it("deleteSession DELETEs the versioned resource and resolves on a 204 with no body", async () => {
    // A 204 No Content with an empty body — the client must NOT try to parse JSON (that would throw).
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    const api = createApiClient({ baseUrl, getToken: () => "tok" });
    await expect(api.deleteSession("s1")).resolves.toBeUndefined();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${baseUrl}/api/v1/sessions/s1`);
    expect((init as RequestInit).method).toBe("DELETE");
    expect((init as RequestInit).headers).toMatchObject({ authorization: "Bearer tok" });
  });

  it("deleteSession rejects with ApiError on a real failure (5xx)", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "boom" }, 500));
    const api = createApiClient({ baseUrl, getToken: () => "tok" });
    await expect(api.deleteSession("s1")).rejects.toMatchObject({ status: 500, message: "boom" });
  });

  it("rotateToken returns the new credential without overwriting another host's legacy store", async () => {
    localStorage.clear();
    localStorage.setItem("roamcode.token", "old-token");
    fetchMock.mockResolvedValueOnce(jsonResponse({ token: "fresh-token" }));
    const api = createApiClient({ baseUrl, getToken: () => "old-token" });
    const next = await api.rotateToken();
    expect(next).toBe("fresh-token");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${baseUrl}/token/rotate`);
    expect((init as RequestInit).method).toBe("POST");
    expect((init as RequestInit).headers).toMatchObject({ authorization: "Bearer old-token" });
    // Multi-host callers persist under their selected host id; the generic client must not overwrite host A.
    expect(localStorage.getItem("roamcode.token")).toBe("old-token");
  });

  it("downloadUrl includes path and token", () => {
    const api = createApiClient({ baseUrl, getToken: () => "tok" });
    expect(api.downloadUrl("/home/u/a.txt")).toBe(
      `${baseUrl}/fs/download?path=${encodeURIComponent("/home/u/a.txt")}&token=tok`,
    );
  });

  it("getVersion GETs /version and returns the version info", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        current: "v1.0.0",
        latest: "v1.1.0",
        behind: 2,
        releaseCount: 2,
        updatable: true,
        updateAvailable: true,
        updateAction: "update",
        installation: "managed",
        runningVersion: "1.0.0",
        activeVersion: "1.0.0",
        installDrift: false,
        checkStatus: "fresh",
        runningBuild: "1.0.0",
        buildDrift: false,
        changelog: [
          { id: "1.1.0:0", version: "1.1.0", subject: "new", group: "new", when: "2h", date: "2026-06-25T10:00:00Z" },
        ],
      }),
    );
    const api = createApiClient({ baseUrl, getToken: () => "tok" });
    const v = await api.getVersion();
    expect(v.behind).toBe(2);
    expect(v.updateAvailable).toBe(true);
    expect(fetchMock.mock.calls[0]![0]).toBe(`${baseUrl}/version`);
  });

  it("applyUpdate POSTs /update with confirm:true and returns the accepted operation", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ ok: true, state: "starting", operationId: "op-1", target: "1.1.0" }, 202),
    );
    const api = createApiClient({ baseUrl, getToken: () => "tok" });
    await expect(api.applyUpdate("v1.1.0")).resolves.toMatchObject({ operationId: "op-1", target: "1.1.0" });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${baseUrl}/update`);
    expect((init as RequestInit).method).toBe("POST");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ confirm: true, target: "v1.1.0" });
  });

  it("applyUpdate rejects with ApiError when the server refuses (409)", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: "not a git checkout" }, 409));
    const api = createApiClient({ baseUrl, getToken: () => "tok" });
    await expect(api.applyUpdate()).rejects.toMatchObject({ status: 409 });
    await expect(api.applyUpdate()).rejects.toBeInstanceOf(ApiError);
  });

  it("getUpdateStatus GETs /update/status", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ state: "verifying", phase: "boot smoke" }));
    const api = createApiClient({ baseUrl, getToken: () => "tok" });
    const s = await api.getUpdateStatus();
    expect(s.state).toBe("verifying");
    expect(fetchMock.mock.calls[0]![0]).toBe(`${baseUrl}/update/status`);
  });

  it("getModels aliases the Claude provider model route and returns the list", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ models: [{ value: "opus[1m]", displayName: "Opus" }] }));
    const api = createApiClient({ baseUrl, getToken: () => undefined });
    const models = await api.getModels();
    expect(models).toEqual([{ value: "opus[1m]", displayName: "Opus" }]);
    expect(fetchMock.mock.calls[0]![0]).toBe(`${baseUrl}/providers/claude/models`);
  });

  it("uses provider routes and preserves each provider's native metadata shape", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          providers: {
            claude: { terminalAvailable: true, metadataAvailable: false },
            codex: { terminalAvailable: true, metadataAvailable: true, version: "1.2.3" },
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          models: [
            {
              value: "gpt-future-custom",
              id: "custom",
              displayName: "Future Custom",
              description: "custom model",
              isDefault: false,
              supportedReasoningEfforts: ["low", "high"],
              defaultReasoningEffort: "high",
            },
          ],
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ profiles: ["personal", "work.secure"] }))
      .mockResolvedValueOnce(
        jsonResponse({ usage: { bars: [{ id: "primary", label: "Primary", percent: 25 }], fetchedAt: 7 } }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ installed: "1.2.3", provenance: "npm", latest: "1.2.4", updateAvailable: true }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ available: true, authenticated: true, authMethod: "chatgpt", plan: "plus" }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          loginId: "login-1",
          userCode: "ABCD",
          verificationUrl: "https://example.test/device",
          expiresAt: 9,
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ status: "pending" }))
      .mockResolvedValueOnce(jsonResponse({ status: "canceled" }));

    const api = createApiClient({ baseUrl, getToken: () => "tok" });
    const providers = await api.getProviders();
    const models = await api.getProviderModels("codex");
    const profiles = await api.getProviderProfiles("codex");
    const usage = await api.getProviderUsage("codex");
    const version = await api.getProviderVersion("codex");
    const auth = await api.getProviderAuthStatus("codex");
    const login = await api.startProviderLogin("codex");
    const loginStatus = await api.getProviderLoginStatus("codex", "login-1");
    const canceled = await api.cancelProviderLogin("codex", "login-1");

    expect(providers.codex).toEqual({ terminalAvailable: true, metadataAvailable: true, version: "1.2.3" });
    expect(models[0]).toMatchObject({ value: "gpt-future-custom", supportedReasoningEfforts: ["low", "high"] });
    expect(profiles).toEqual(["personal", "work.secure"]);
    expect(usage).toMatchObject({ bars: [{ id: "primary", label: "Primary", percent: 25 }] });
    expect(version).toMatchObject({ installed: "1.2.3", provenance: "npm", latest: "1.2.4" });
    expect(auth).toMatchObject({ available: true, authenticated: true, authMethod: "chatgpt" });
    expect(login).toMatchObject({ loginId: "login-1", userCode: "ABCD" });
    expect(loginStatus).toEqual({ status: "pending" });
    expect(canceled).toEqual({ status: "canceled" });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      `${baseUrl}/providers`,
      `${baseUrl}/providers/codex/models`,
      `${baseUrl}/providers/codex/profiles`,
      `${baseUrl}/providers/codex/usage`,
      `${baseUrl}/providers/codex/version`,
      `${baseUrl}/providers/codex/auth/status`,
      `${baseUrl}/providers/codex/auth/login/start`,
      `${baseUrl}/providers/codex/auth/login/status?loginId=login-1`,
      `${baseUrl}/providers/codex/auth/login/cancel`,
    ]);
    expect(JSON.parse((fetchMock.mock.calls[8]![1] as RequestInit).body as string)).toEqual({ loginId: "login-1" });
  });

  it("keeps old metadata methods as thin Claude aliases over provider routes", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ usage: null }))
      .mockResolvedValueOnce(jsonResponse({ models: [] }))
      .mockResolvedValueOnce(jsonResponse({ available: true, loggedIn: true }))
      .mockResolvedValueOnce(jsonResponse({ loginId: "l1", url: "https://example.test" }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }))
      .mockResolvedValueOnce(jsonResponse({ installed: "1.0.0", latest: "1.1.0" }));
    const api = createApiClient({ baseUrl, getToken: () => undefined });

    await api.getUsage();
    await api.getModels();
    await api.getAuthStatus();
    await api.startAuthLogin();
    await api.cancelAuthLogin();
    await api.getClaudeVersion();

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      `${baseUrl}/providers/claude/usage`,
      `${baseUrl}/providers/claude/models`,
      `${baseUrl}/providers/claude/auth/status`,
      `${baseUrl}/providers/claude/auth/login/start`,
      `${baseUrl}/providers/claude/auth/login/cancel`,
      `${baseUrl}/providers/claude/version`,
    ]);
  });

  it("renameSession PATCHes the versioned resource with the trimmed name (204, no body)", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    const api = createApiClient({ baseUrl, getToken: () => "tok" });
    await expect(api.renameSession("s1", "  My session  ")).resolves.toBeUndefined();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${baseUrl}/api/v1/sessions/s1`);
    expect((init as RequestInit).method).toBe("PATCH");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ name: "My session" });
  });

  it("renameSession sends name:null for an empty string (clears the server name)", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    const api = createApiClient({ baseUrl, getToken: () => "tok" });
    await api.renameSession("s1", "   ");
    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ name: null });
  });

  it("rollbackUpdate POSTs /update/rollback with confirm:true and surfaces a 409 as ApiError", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ ok: true, state: "starting", operationId: "op-r", target: "1.0.0" }, 202),
    );
    const api = createApiClient({ baseUrl, getToken: () => "tok" });
    await expect(api.rollbackUpdate()).resolves.toMatchObject({ operationId: "op-r", target: "1.0.0" });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${baseUrl}/update/rollback`);
    expect((init as RequestInit).method).toBe("POST");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ confirm: true });
    // No previous build recorded → 409 rejects with the status the UI maps to its human message.
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "no previous build" }, 409));
    await expect(api.rollbackUpdate()).rejects.toMatchObject({ status: 409 });
  });

  it("mkdir POSTs /fs/mkdir with the path and rejects a 409 (exists) with ApiError", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ path: "/home/u/new-proj" }));
    const api = createApiClient({ baseUrl, getToken: () => "tok" });
    const created = await api.mkdir("/home/u/new-proj");
    expect(created).toEqual({ path: "/home/u/new-proj" });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${baseUrl}/fs/mkdir`);
    expect((init as RequestInit).method).toBe("POST");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ path: "/home/u/new-proj" });
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "exists" }, 409));
    await expect(api.mkdir("/home/u/new-proj")).rejects.toMatchObject({ status: 409 });
  });

  it("searchDirs GETs /fs/search with q + base and returns the results array", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ results: [{ path: "/home/u/deep/web", name: "web", isGitRepo: true }] }),
    );
    const api = createApiClient({ baseUrl, getToken: () => "tok" });
    const results = await api.searchDirs("web", "/home/u");
    expect(results).toEqual([{ path: "/home/u/deep/web", name: "web", isGitRepo: true }]);
    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toBe(`${baseUrl}/fs/search?q=web&base=${encodeURIComponent("/home/u")}`);
  });
});

describe("terminalWsUrl", () => {
  it("fetches relay file content with header auth and never places the device token in the URL", async () => {
    const request = vi.fn<typeof globalThis.fetch>(async () => new Response("file", { status: 200 }));
    await terminalFileContentRequest(
      "session 1",
      "file 1",
      "inline",
      { headers: { range: "bytes=0-99" } },
      { baseUrl: "https://app.roamcode.example", getToken: () => "relay-token", request },
    );

    const [url, init] = request.mock.calls[0]!;
    expect(String(url)).toBe(
      "https://app.roamcode.example/sessions/session%201/files/file%201/content?disposition=inline",
    );
    expect(String(url)).not.toContain("relay-token");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer relay-token");
    expect(new Headers(init?.headers).get("range")).toBe("bytes=0-99");
  });

  it("appends respawn ONLY when a mode is chosen (Resume conversation → respawn=continue)", () => {
    // Absent (fresh spawn / plain re-attach): no respawn key rides the query at all.
    expect(terminalWsUrl("s1", 80, 24)).not.toContain("respawn=");
    // The ended overlay's Resume: the same URL + respawn=continue.
    const resume = terminalWsUrl("s1", 80, 24, "continue");
    expect(resume).toContain("/sessions/s1/terminal");
    expect(resume).toContain("respawn=continue");
    expect(resume).toContain("cols=80");
    expect(resume).toContain("rows=24");
    // Explicit fresh is also expressible (the server treats absent and fresh identically).
    expect(terminalWsUrl("s1", 80, 24, "fresh")).toContain("respawn=fresh");
  });

  it("keeps a remote host origin and credential paired", () => {
    const url = terminalWsUrl("s1", 80, 24, undefined, {
      baseUrl: "https://host-b.example",
      getToken: () => "host-b-token",
    });
    expect(url).toContain("wss://host-b.example/sessions/s1/terminal");
    expect(url).toContain("token=host-b-token");
    expect(url).not.toContain("host-a");
  });
});
