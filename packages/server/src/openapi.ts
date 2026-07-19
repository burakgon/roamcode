import type { ReturnTypeOfDescriptors } from "./providers/registry.js";

type JsonObject = Record<string, unknown>;

const json = (schema: JsonObject) => ({ "application/json": { schema } });
const response = (description: string, schema?: JsonObject) => ({
  description,
  ...(schema ? { content: json(schema) } : {}),
});
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const idempotency = {
  name: "Idempotency-Key",
  in: "header",
  required: false,
  description: "Actor-scoped replay key retained for 24 hours. Reuse with a different request returns 409.",
  schema: { type: "string", minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9._:-]+$" },
};
const idParameter = (name: string) => ({ name, in: "path", required: true, schema: { type: "string" } });

export interface OpenApiBuildOptions {
  serverVersion: string;
  adapters: ReturnTypeOfDescriptors;
}

export function buildOpenApiDocument(options: OpenApiBuildOptions): JsonObject {
  const enabledAdapters = options.adapters.filter((adapter) => adapter.enabled);
  const errorResponses = {
    "400": response("Invalid request", ref("Error")),
    "401": response("Missing, invalid, or revoked credential", ref("Error")),
    "403": response("Origin, scope, or policy denied", ref("Error")),
    "409": response("Revision or idempotency conflict", ref("Error")),
  };
  return {
    openapi: "3.1.0",
    info: {
      title: "RoamCode Command Center API",
      version: options.serverVersion,
      description:
        "Local-first, versioned control plane. Bearer credentials stay in headers; terminal contents and provider credentials are never audit data.",
    },
    servers: [{ url: "/", description: "The authenticated RoamCode host" }],
    security: [{ bearerAuth: [] }],
    paths: {
      "/api/v1/capabilities": {
        get: { operationId: "getCapabilities", responses: { "200": response("Capabilities", ref("Capabilities")) } },
      },
      "/api/v1/hosts": {
        get: { operationId: "listHosts", responses: { "200": response("Host inventory") } },
      },
      "/api/v1/search": {
        get: {
          operationId: "searchCommandCenter",
          parameters: [
            { name: "q", in: "query", required: true, schema: { type: "string", minLength: 1, maxLength: 100 } },
            { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 100, default: 50 } },
          ],
          responses: { "200": response("Ranked metadata-only search results"), ...errorResponses },
        },
      },
      "/api/v1/host": {
        get: { operationId: "getHost", responses: { "200": response("Host and urgency summary") } },
        patch: {
          operationId: "renameHost",
          parameters: [idempotency],
          requestBody: {
            required: true,
            content: json({
              type: "object",
              required: ["label"],
              properties: { label: { type: "string", maxLength: 80 } },
            }),
          },
          responses: { "200": response("Renamed host"), ...errorResponses },
        },
      },
      "/api/v1/workspaces": {
        get: { operationId: "listWorkspaces", responses: { "200": response("Workspace inventory") } },
        post: {
          operationId: "createWorkspace",
          parameters: [idempotency],
          requestBody: { required: true, content: json(ref("WorkspaceCreate")) },
          responses: { "201": response("Created workspace"), ...errorResponses },
        },
      },
      "/api/v1/workspaces/{id}": {
        patch: {
          operationId: "updateWorkspace",
          parameters: [idParameter("id"), idempotency],
          requestBody: {
            required: true,
            content: json({
              type: "object",
              properties: {
                label: { type: "string" },
                sortOrder: { type: "integer", minimum: 0 },
                archived: { type: "boolean" },
              },
            }),
          },
          responses: {
            "200": response("Updated workspace"),
            "404": response("Not found", ref("Error")),
            ...errorResponses,
          },
        },
      },
      "/api/v1/worktrees": {
        post: {
          operationId: "createWorktree",
          parameters: [idempotency],
          requestBody: { required: true, content: json(ref("WorktreeCreate")) },
          responses: {
            "200": response("Recovered existing worktree"),
            "201": response("Created worktree"),
            ...errorResponses,
          },
        },
      },
      "/api/v1/worktrees/open": {
        post: {
          operationId: "openWorktree",
          parameters: [idempotency],
          requestBody: {
            required: true,
            content: json({
              type: "object",
              required: ["cwd"],
              additionalProperties: false,
              properties: { cwd: { type: "string" }, label: { type: "string", maxLength: 80 } },
            }),
          },
          responses: { "200": response("Opened registered worktree"), ...errorResponses },
        },
      },
      "/api/v1/workspaces/{id}/worktree": {
        get: {
          operationId: "getWorktreeStatus",
          parameters: [idParameter("id")],
          responses: { "200": response("Worktree status"), ...errorResponses },
        },
        delete: {
          operationId: "removeWorktree",
          parameters: [idParameter("id"), idempotency],
          requestBody: {
            required: true,
            content: json({
              type: "object",
              required: ["confirm"],
              additionalProperties: false,
              properties: { confirm: { const: true }, force: { type: "boolean", default: false } },
            }),
          },
          responses: { "200": response("Removed and archived worktree"), ...errorResponses },
        },
      },
      "/api/v1/sessions": {
        get: { operationId: "listSessions", responses: { "200": response("Session inventory") } },
        post: {
          operationId: "startSession",
          parameters: [idempotency],
          requestBody: { required: true, content: json(ref("SessionCreate")) },
          responses: { "201": response("Started native terminal session"), ...errorResponses },
        },
      },
      "/api/v1/sessions/{id}": {
        get: {
          operationId: "getSession",
          parameters: [idParameter("id")],
          responses: { "200": response("Session"), "404": response("Not found", ref("Error")) },
        },
      },
      "/api/v1/sessions/{id}/input": {
        post: {
          operationId: "sendSessionInput",
          description:
            "Writes to the provider-owned terminal without changing browser focus. When another client holds input, clientId and its bound leaseId are required.",
          parameters: [idParameter("id"), idempotency],
          requestBody: {
            required: true,
            content: json({
              type: "object",
              required: ["data"],
              properties: {
                data: { type: "string", maxLength: 65536 },
                appendNewline: { type: "boolean", default: false },
                clientId: { type: "string", minLength: 1, maxLength: 128 },
                leaseId: { type: "string", minLength: 1, maxLength: 256 },
              },
            }),
          },
          responses: { "202": response("Input accepted"), ...errorResponses },
        },
      },
      "/api/v1/sessions/{id}/input-lease": {
        get: {
          operationId: "getSessionInputLease",
          description: "Returns public ownership metadata, never the holder or lease identifiers.",
          parameters: [idParameter("id")],
          responses: { "200": response("Current input owner", ref("InputLeaseState")), ...errorResponses },
        },
        post: {
          operationId: "changeSessionInputLease",
          description:
            "Acquires, renews, releases, or explicitly takes over the one writable terminal stream. Takeover requires confirm=true and may be denied by team policy.",
          parameters: [idParameter("id"), idempotency],
          requestBody: { required: true, content: json(ref("InputLeaseRequest")) },
          responses: {
            "200": response("Lease renewed, released, or already owned", ref("InputLeaseGrant")),
            "201": response("Lease granted", ref("InputLeaseGrant")),
            ...errorResponses,
          },
        },
      },
      "/api/v1/agents": {
        get: { operationId: "listAgents", responses: { "200": response("Agent inventory") } },
      },
      "/api/v1/agents/{id}": {
        get: {
          operationId: "getAgent",
          parameters: [idParameter("id")],
          responses: { "200": response("Agent", ref("Agent")), "404": response("Not found", ref("Error")) },
        },
      },
      "/api/v1/agents/{id}/wait": {
        get: {
          operationId: "waitForAgent",
          parameters: [
            idParameter("id"),
            { name: "after", in: "query", schema: { type: "integer", minimum: 0 } },
            { name: "timeoutMs", in: "query", schema: { type: "integer", minimum: 0, maximum: 30000 } },
          ],
          responses: { "200": response("State changed or wait timed out") },
        },
      },
      "/api/v1/agents/{id}/focus": {
        post: {
          operationId: "requestAgentFocus",
          description:
            "Defaults to a non-stealing focus request. Explicit activate mode still requires the client to honor it.",
          parameters: [idParameter("id"), idempotency],
          requestBody: {
            content: json({
              type: "object",
              properties: { mode: { enum: ["request", "activate"], default: "request" } },
            }),
          },
          responses: { "202": response("Focus request emitted"), ...errorResponses },
        },
      },
      "/api/v1/attention": {
        get: { operationId: "listAttention", responses: { "200": response("Server-authoritative inbox") } },
      },
      "/api/v1/attention/{id}": {
        patch: {
          operationId: "updateAttention",
          parameters: [idParameter("id"), idempotency],
          requestBody: {
            required: true,
            content: json({
              type: "object",
              required: ["action"],
              properties: { action: { enum: ["acknowledge", "snooze", "resolve"] }, until: { type: "integer" } },
            }),
          },
          responses: { "200": response("Updated inbox item"), ...errorResponses },
        },
      },
      "/api/v1/devices": {
        get: { operationId: "listDevices", responses: { "200": response("Paired device inventory") } },
      },
      "/api/v1/devices/{id}": {
        patch: {
          operationId: "renameDevice",
          parameters: [idParameter("id"), idempotency],
          responses: { "200": response("Renamed device"), ...errorResponses },
        },
        delete: {
          operationId: "revokeDevice",
          parameters: [idParameter("id"), idempotency],
          responses: { "204": response("Revoked device"), ...errorResponses },
        },
      },
      "/api/v1/team": {
        get: {
          operationId: "getTeam",
          description: "Returns the current member, effective role permissions, and local recovery status.",
          responses: { "200": response("Team access envelope", ref("TeamEnvelope")), ...errorResponses },
        },
        post: {
          operationId: "createTeam",
          parameters: [idempotency],
          requestBody: {
            required: true,
            content: json({
              type: "object",
              required: ["name"],
              additionalProperties: false,
              properties: {
                name: { type: "string", minLength: 1, maxLength: 80 },
                ownerName: { type: "string", minLength: 1, maxLength: 120 },
              },
            }),
          },
          responses: { "201": response("Created team and owner identity", ref("TeamEnvelope")), ...errorResponses },
        },
        patch: {
          operationId: "updateTeam",
          parameters: [idempotency],
          requestBody: {
            required: true,
            content: json({
              type: "object",
              required: ["expectedRevision"],
              additionalProperties: false,
              properties: {
                name: { type: "string", minLength: 1, maxLength: 80 },
                authorizationEnabled: { type: "boolean" },
                expectedRevision: { type: "integer", minimum: 1 },
                confirm: { type: "boolean", description: "Must be true when enabling role enforcement" },
              },
            }),
          },
          responses: { "200": response("Updated team"), ...errorResponses },
        },
      },
      "/api/v1/team/members": {
        get: {
          operationId: "listTeamMembers",
          parameters: [{ name: "includeRemoved", in: "query", schema: { enum: ["0", "1"], default: "0" } }],
          responses: { "200": response("Members with role bindings"), ...errorResponses },
        },
        post: {
          operationId: "createTeamMember",
          parameters: [idempotency],
          requestBody: { required: true, content: json(ref("TeamMemberCreate")) },
          responses: { "201": response("Created person or service identity"), ...errorResponses },
        },
      },
      "/api/v1/team/members/{id}": {
        patch: {
          operationId: "updateTeamMember",
          description: "Suspension immediately revokes live sockets, input ownership, and presence.",
          parameters: [idParameter("id"), idempotency],
          requestBody: {
            required: true,
            content: json({
              type: "object",
              required: ["expectedRevision"],
              additionalProperties: false,
              properties: {
                displayName: { type: "string", minLength: 1, maxLength: 120 },
                status: { enum: ["active", "suspended", "removed"] },
                expectedRevision: { type: "integer", minimum: 1 },
              },
            }),
          },
          responses: { "200": response("Updated member"), "404": response("Member not found"), ...errorResponses },
        },
      },
      "/api/v1/team/roles": {
        post: {
          operationId: "grantTeamRole",
          parameters: [idempotency],
          requestBody: { required: true, content: json(ref("TeamRoleGrant")) },
          responses: { "201": response("Granted idempotent role binding", ref("TeamRoleBinding")), ...errorResponses },
        },
      },
      "/api/v1/team/roles/{id}": {
        delete: {
          operationId: "revokeTeamRole",
          description: "Revocation immediately drops mutable ownership so still-authorized clients must reacquire.",
          parameters: [idParameter("id"), idempotency],
          responses: { "204": response("Revoked role binding"), "404": response("Role not found"), ...errorResponses },
        },
      },
      "/api/v1/team/principals": {
        get: {
          operationId: "listTeamPrincipalBindings",
          responses: { "200": response("Device and local recovery identity assignments"), ...errorResponses },
        },
        post: {
          operationId: "bindTeamPrincipal",
          parameters: [idempotency],
          requestBody: { required: true, content: json(ref("TeamPrincipalBinding")) },
          responses: { "201": response("Assigned principal to member"), ...errorResponses },
        },
        delete: {
          operationId: "unbindTeamPrincipal",
          parameters: [idempotency],
          requestBody: {
            required: true,
            content: json({
              type: "object",
              required: ["actorType", "actorId"],
              additionalProperties: false,
              properties: {
                actorType: { enum: ["device", "host", "local"] },
                actorId: { type: "string", minLength: 1, maxLength: 256 },
              },
            }),
          },
          responses: { "204": response("Unassigned and revoked live mutable access"), ...errorResponses },
        },
      },
      "/api/v1/policy": {
        get: {
          operationId: "getEnterprisePolicy",
          description: "Returns the revisioned organization policy applied to paired clients.",
          responses: { "200": response("Enterprise policy", ref("EnterprisePolicyEnvelope")), ...errorResponses },
        },
        patch: {
          operationId: "updateEnterprisePolicy",
          description:
            "Updates organization policy with optimistic concurrency. Enabling enforcement requires confirm:true and immediately revokes remote mutable ownership.",
          parameters: [idempotency],
          requestBody: { required: true, content: json(ref("EnterprisePolicyPatch")) },
          responses: {
            "200": response("Updated enterprise policy", ref("EnterprisePolicyEnvelope")),
            ...errorResponses,
          },
        },
      },
      "/api/v1/fleet": {
        get: {
          operationId: "getFleetInventory",
          description:
            "Returns privacy-bounded host health, durability, adapter capability, and policy posture metadata.",
          responses: { "200": response("Fleet inventory", ref("FleetInventory")), ...errorResponses },
        },
      },
      "/api/v1/peers": {
        get: {
          operationId: "listPeers",
          description: "Lists explicitly scoped peer hosts. Stored origins and credentials are intentionally omitted.",
          responses: { "200": response("Peer host inventory", ref("PeerList")), ...errorResponses },
        },
        post: {
          operationId: "createPeer",
          description:
            "Verifies the remote v1 identity before storing a server-side credential. The credential and origin are never returned.",
          parameters: [idempotency],
          requestBody: { required: true, content: json(ref("PeerCreate")) },
          responses: { "201": response("Registered peer host", ref("PeerEnvelope")), ...errorResponses },
        },
      },
      "/api/v1/peers/{id}": {
        patch: {
          operationId: "updatePeer",
          parameters: [idParameter("id"), idempotency],
          requestBody: { required: true, content: json(ref("PeerUpdate")) },
          responses: { "200": response("Updated peer scope", ref("PeerEnvelope")), ...errorResponses },
        },
        delete: {
          operationId: "deletePeer",
          parameters: [idParameter("id"), idempotency],
          requestBody: {
            required: true,
            content: json({
              type: "object",
              required: ["confirm"],
              additionalProperties: false,
              properties: { confirm: { const: true } },
            }),
          },
          responses: { "204": response("Removed peer and its stored credential"), ...errorResponses },
        },
      },
      "/api/v1/peers/{id}/verify": {
        post: {
          operationId: "verifyPeer",
          parameters: [idParameter("id"), idempotency],
          requestBody: { required: true, content: json(ref("PeerVerify")) },
          responses: { "200": response("Verified pinned peer identity", ref("PeerEnvelope")), ...errorResponses },
        },
      },
      "/api/v1/peers/{id}/discover": {
        post: {
          operationId: "discoverPeerWorkspaces",
          description:
            "Re-verifies the pinned peer and returns privacy-bounded workspace metadata for an administrator to select. New peers remain workspace-denied until explicitly updated.",
          parameters: [idParameter("id"), idempotency],
          requestBody: { required: true, content: json(ref("PeerVerify")) },
          responses: { "200": response("Discovered peer workspaces", ref("PeerDiscovery")), ...errorResponses },
        },
      },
      "/api/v1/peers/{id}/credential": {
        post: {
          operationId: "rotatePeerCredential",
          description: "Verifies a replacement credential against the pinned remote host identity before activation.",
          parameters: [idParameter("id"), idempotency],
          requestBody: { required: true, content: json(ref("PeerCredentialRotation")) },
          responses: { "200": response("Rotated peer credential", ref("PeerEnvelope")), ...errorResponses },
        },
      },
      "/api/v1/peers/{peerId}/workspaces": {
        get: {
          operationId: "listPeerWorkspaces",
          description: "Returns only workspaces visible through peer scope, local RBAC, and organization policy.",
          parameters: [idParameter("peerId")],
          responses: { "200": response("Filtered remote workspace inventory"), ...errorResponses },
        },
      },
      "/api/v1/peers/{peerId}/agents": {
        get: {
          operationId: "listPeerAgents",
          description: "Returns only agents visible through peer scope, local RBAC, and organization policy.",
          parameters: [idParameter("peerId")],
          responses: { "200": response("Filtered remote agent inventory"), ...errorResponses },
        },
      },
      "/api/v1/peers/{peerId}/sessions": {
        get: {
          operationId: "listPeerSessions",
          parameters: [idParameter("peerId")],
          responses: { "200": response("Filtered remote session inventory"), ...errorResponses },
        },
        post: {
          operationId: "startPeerSession",
          description:
            "Starts an agent in an already-registered remote workspace. Callers choose a workspace id, never a remote filesystem path.",
          parameters: [idParameter("peerId"), idempotency],
          requestBody: { required: true, content: json(ref("PeerSessionCreate")) },
          responses: { "201": response("Started remote native terminal session"), ...errorResponses },
        },
      },
      "/api/v1/peers/{peerId}/sessions/{sessionId}/input": {
        post: {
          operationId: "sendPeerSessionInput",
          description:
            "Sends bounded input without changing browser focus. A caller client id is one-way bound to the local actor before forwarding.",
          parameters: [idParameter("peerId"), idParameter("sessionId"), idempotency],
          requestBody: { required: true, content: json(ref("PeerSessionInput")) },
          responses: { "202": response("Remote input accepted"), ...errorResponses },
        },
      },
      "/api/v1/peers/{peerId}/sessions/{sessionId}/input-lease": {
        get: {
          operationId: "getPeerSessionInputLease",
          parameters: [idParameter("peerId"), idParameter("sessionId")],
          responses: { "200": response("Remote public input ownership", ref("InputLeaseState")), ...errorResponses },
        },
        post: {
          operationId: "changePeerSessionInputLease",
          description:
            "Acquires, renews, releases, takes over, or administratively revokes remote input. Remote RBAC remains authoritative.",
          parameters: [idParameter("peerId"), idParameter("sessionId"), idempotency],
          requestBody: { required: true, content: json(ref("InputLeaseRequest")) },
          responses: {
            "200": response("Remote lease changed", ref("InputLeaseGrant")),
            "201": response("Remote lease granted", ref("InputLeaseGrant")),
            ...errorResponses,
          },
        },
      },
      "/api/v1/peers/{peerId}/agents/{agentId}/wait": {
        get: {
          operationId: "waitForPeerAgent",
          description: "Long-polls bounded remote agent state without terminal transcript or prompt contents.",
          parameters: [
            idParameter("peerId"),
            idParameter("agentId"),
            { name: "after", in: "query", schema: { type: "integer", minimum: 0, default: 0 } },
            {
              name: "timeoutMs",
              in: "query",
              schema: { type: "integer", minimum: 0, maximum: 30000, default: 30000 },
            },
          ],
          responses: { "200": response("Remote agent state"), ...errorResponses },
        },
      },
      "/api/v1/peers/{peerId}/agents/{agentId}/focus": {
        post: {
          operationId: "focusPeerAgent",
          description: "Requests or activates focus on the remote host; it never steals local browser focus.",
          parameters: [idParameter("peerId"), idParameter("agentId"), idempotency],
          requestBody: {
            required: true,
            content: json({
              type: "object",
              additionalProperties: false,
              properties: { mode: { enum: ["request", "activate"], default: "request" } },
            }),
          },
          responses: { "202": response("Remote focus request accepted"), ...errorResponses },
        },
      },
      "/api/v1/presence": {
        get: {
          operationId: "listPresence",
          description: "Returns expiring, privacy-bounded metadata without IP, token, path, prompt, or actor id.",
          parameters: ["hostId", "workspaceId", "sessionId", "agentId"].map((name) => ({
            name,
            in: "query",
            schema: { type: "string", minLength: 1, maxLength: 256 },
          })),
          responses: { "200": response("Active presence records"), ...errorResponses },
        },
        post: {
          operationId: "heartbeatPresence",
          description: "Operating presence is accepted only for the principal that owns the active input lease.",
          requestBody: { required: true, content: json(ref("PresenceHeartbeat")) },
          responses: { "200": response("Refreshed presence"), ...errorResponses },
        },
        delete: {
          operationId: "releasePresence",
          requestBody: {
            required: true,
            content: json({
              type: "object",
              required: ["clientId"],
              additionalProperties: false,
              properties: { clientId: { type: "string", minLength: 1, maxLength: 256 } },
            }),
          },
          responses: { "204": response("Released this client's presence"), ...errorResponses },
        },
      },
      "/api/v1/presence/stream": {
        get: {
          operationId: "streamPresence",
          responses: {
            "200": {
              description: "Privacy-bounded presence snapshot, changes, and heartbeat comments",
              content: { "text/event-stream": { schema: { type: "string" } } },
            },
          },
        },
      },
      "/api/v1/adapters": {
        get: { operationId: "listAdapters", responses: { "200": response("Adapter contract inventory") } },
      },
      "/api/v1/extensions": {
        get: { operationId: "listExtensions", responses: { "200": response("Installed adapter and plugin packages") } },
      },
      "/api/v1/extensions/inspect": {
        post: {
          operationId: "inspectExtension",
          description:
            "Computes the canonical manifest and integrity without installing. Requires host recovery credential.",
          parameters: [idempotency],
          responses: { "200": response("Validated manifest and SHA-256 SRI"), ...errorResponses },
        },
      },
      "/api/v1/extensions/install": {
        post: {
          operationId: "installExtension",
          description: "Installs immutable verified bytes. Requires host recovery credential.",
          parameters: [idempotency],
          requestBody: { required: true, content: json(ref("ExtensionInstall")) },
          responses: { "201": response("Installed disabled extension"), ...errorResponses },
        },
      },
      "/api/v1/extensions/{kind}/{id}": {
        patch: {
          operationId: "setExtensionEnabled",
          parameters: [idParameter("kind"), idParameter("id"), idempotency],
          responses: { "200": response("Updated extension state"), ...errorResponses },
        },
        delete: {
          operationId: "uninstallExtension",
          parameters: [idParameter("kind"), idParameter("id"), idempotency],
          responses: { "204": response("Uninstalled extension"), ...errorResponses },
        },
      },
      "/api/v1/extensions/{kind}/{id}/rollback": {
        post: {
          operationId: "rollbackExtension",
          parameters: [idParameter("kind"), idParameter("id"), idempotency],
          responses: { "200": response("Activated previous verified version"), ...errorResponses },
        },
      },
      "/api/v1/plugins": {
        get: { operationId: "listPlugins", responses: { "200": response("Installed plugin inventory") } },
      },
      "/api/v1/plugins/{id}/actions/{actionId}/run": {
        post: {
          operationId: "runPluginAction",
          parameters: [idParameter("id"), idParameter("actionId"), idempotency],
          responses: { "200": response("Bounded plugin action result"), ...errorResponses },
        },
      },
      "/api/v1/marketplace": {
        get: {
          operationId: "searchMarketplace",
          parameters: [{ name: "q", in: "query", schema: { type: "string", maxLength: 100 } }],
          responses: { "200": response("Compatible trust-labelled registry entries") },
        },
      },
      "/api/v1/automations": {
        get: { operationId: "listAutomations", responses: { "200": response("Automation definitions") } },
        post: {
          operationId: "createAutomation",
          parameters: [idempotency],
          requestBody: { required: true, content: json(ref("Automation")) },
          responses: { "201": response("Created automation"), ...errorResponses },
        },
      },
      "/api/v1/automations/{id}": {
        patch: {
          operationId: "updateAutomation",
          parameters: [idParameter("id"), idempotency],
          responses: { "200": response("Updated automation"), ...errorResponses },
        },
        delete: {
          operationId: "deleteAutomation",
          parameters: [idParameter("id"), idempotency],
          responses: { "204": response("Deleted automation"), ...errorResponses },
        },
      },
      "/api/v1/automations/{id}/run": {
        post: {
          operationId: "runAutomation",
          parameters: [idParameter("id"), idempotency],
          responses: { "200": response("Automation run"), ...errorResponses },
        },
      },
      "/api/v1/automations/{id}/runs": {
        get: {
          operationId: "listAutomationRuns",
          parameters: [idParameter("id")],
          responses: { "200": response("Bounded run history") },
        },
      },
      "/api/v1/events": {
        get: { operationId: "listEvents", responses: { "200": response("Ordered event backfill") } },
      },
      "/api/v1/events/stream": {
        get: {
          operationId: "streamEvents",
          responses: {
            "200": {
              description: "Resumable SSE snapshots, backfill, heartbeats, and overflow resets",
              content: { "text/event-stream": { schema: { type: "string" } } },
            },
          },
        },
      },
      "/api/v1/layout": {
        get: { operationId: "getSharedLayout", responses: { "200": response("Revisioned layout") } },
        put: {
          operationId: "putSharedLayout",
          parameters: [idempotency],
          responses: { "200": response("Saved layout"), ...errorResponses },
        },
      },
      "/api/v1/audit": {
        get: {
          operationId: "listAudit",
          description: "Requires the current host recovery credential.",
          parameters: [
            { name: "after", in: "query", schema: { type: "integer", minimum: 0, default: 0 } },
            { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 1000, default: 500 } },
            {
              name: "order",
              in: "query",
              description:
                "Use latest for a bounded newest-first operational view; latest cannot be combined with after.",
              schema: { enum: ["latest"] },
            },
          ],
          responses: { "200": response("Privacy-safe append-only records", ref("AuditPage")), ...errorResponses },
        },
      },
      "/api/v1/audit/verify": {
        get: {
          operationId: "verifyAudit",
          description: "Requires the current host recovery credential.",
          responses: { "200": response("Audit hash-chain verification", ref("AuditVerification")), ...errorResponses },
        },
      },
      "/api/v1/audit/export": {
        get: {
          operationId: "exportAudit",
          description:
            "Exports a bounded NDJSON page prefixed by an integrity manifest. Requires the current host recovery credential.",
          parameters: [
            { name: "after", in: "query", schema: { type: "integer", minimum: 0, default: 0 } },
            { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 1000, default: 500 } },
          ],
          responses: {
            "200": {
              description: "Audit NDJSON manifest and records",
              headers: {
                "Content-Disposition": {
                  schema: { type: "string" },
                  description: "Stable privacy-safe download filename",
                },
              },
              content: { "application/x-ndjson": { schema: { type: "string" } } },
            },
            ...errorResponses,
          },
        },
      },
      "/api/v1/openapi.json": {
        get: { operationId: "getOpenApi", responses: { "200": response("This OpenAPI document") } },
      },
      "/api/v2/context": {
        get: {
          operationId: "getProductContextV2",
          description: "Returns the authenticated personal or organization context without provider credentials.",
          responses: {
            "200": response("Current product context", {
              type: "object",
              required: ["context"],
              additionalProperties: false,
              properties: { context: ref("ProductContext") },
            }),
            ...errorResponses,
          },
        },
      },
      "/api/v2/nodes": {
        get: {
          operationId: "listNodesV2",
          responses: {
            "200": response("Nodes visible in the current context", {
              type: "object",
              required: ["nodes"],
              additionalProperties: false,
              properties: { nodes: { type: "array", items: ref("Node") } },
            }),
            ...errorResponses,
          },
        },
      },
      "/api/v2/nodes/{nodeId}": {
        get: {
          operationId: "getNodeV2",
          parameters: [idParameter("nodeId")],
          responses: {
            "200": response("Node", {
              type: "object",
              required: ["node"],
              additionalProperties: false,
              properties: { node: ref("Node") },
            }),
            "404": response("Node not found", ref("Error")),
            ...errorResponses,
          },
        },
      },
      "/api/v2/nodes/{nodeId}/runtimes": {
        get: {
          operationId: "listAgentRuntimesV2",
          description:
            "Returns bounded runtime health and capability metadata; probe detail, paths, and credentials are never included.",
          parameters: [idParameter("nodeId")],
          responses: {
            "200": response("Agent runtimes installed on the node", {
              type: "object",
              required: ["runtimes"],
              additionalProperties: false,
              properties: { runtimes: { type: "array", items: ref("AgentRuntime") } },
            }),
            "404": response("Node not found", ref("Error")),
            ...errorResponses,
          },
        },
      },
      "/api/v2/nodes/{nodeId}/sessions": {
        get: {
          operationId: "listNodeSessionsV2",
          parameters: [idParameter("nodeId")],
          responses: {
            "200": response("Sessions running on the node", {
              type: "object",
              required: ["sessions"],
              additionalProperties: false,
              properties: { sessions: { type: "array", items: ref("V2Session") } },
            }),
            "404": response("Node not found", ref("Error")),
            ...errorResponses,
          },
        },
        post: {
          operationId: "startNodeSessionV2",
          description:
            "Starts a native terminal session on the exact node, runtime, and working directory selected by the caller.",
          parameters: [idParameter("nodeId"), idempotency],
          requestBody: { required: true, content: json(ref("V2SessionCreate")) },
          responses: {
            "201": response("Started native terminal session", {
              type: "object",
              required: ["session"],
              additionalProperties: false,
              properties: {
                session: ref("V2Session"),
                rememberedSessionOptions: ref("SessionDefaultsEnvelope"),
                warnings: { type: "array", items: ref("ProviderMetadataWarning") },
              },
            }),
            "404": response("Node or runtime not found", ref("Error")),
            "429": response("Node session capacity reached", ref("Error")),
            "503": response("Runtime unavailable", ref("Error")),
            ...errorResponses,
          },
        },
      },
      "/api/v2/nodes/{nodeId}/access-grants": {
        get: {
          operationId: "listNodeAccessGrantsV2",
          parameters: [idParameter("nodeId")],
          responses: {
            "200": response("Effective node access grants", {
              type: "object",
              required: ["grants"],
              additionalProperties: false,
              properties: { grants: { type: "array", items: ref("NodeAccessGrant") } },
            }),
            "404": response("Node not found", ref("Error")),
            ...errorResponses,
          },
        },
        post: {
          operationId: "createNodeAccessGrantV2",
          description: "Creates a node-scoped grant on this standalone Node.",
          parameters: [idParameter("nodeId"), idempotency],
          requestBody: { required: true, content: json(ref("NodeAccessGrantCreate")) },
          responses: {
            ...errorResponses,
            "201": response("Created node access grant", {
              type: "object",
              required: ["grant"],
              additionalProperties: false,
              properties: { grant: ref("NodeAccessGrant") },
            }),
            "404": response("Node or subject not found", ref("Error")),
          },
        },
      },
      "/api/v2/nodes/{nodeId}/access-grants/{grantId}": {
        delete: {
          operationId: "deleteNodeAccessGrantV2",
          description: "Removes a mutable standalone Node grant.",
          parameters: [idParameter("nodeId"), idParameter("grantId"), idempotency],
          responses: {
            ...errorResponses,
            "204": response("Removed node access grant"),
            "404": response("Node access grant not found", ref("Error")),
          },
        },
      },
      "/api/v2/automations": {
        get: {
          operationId: "listSessionAutomationsV2",
          responses: {
            "200": response("Session automation definitions", {
              type: "object",
              required: ["automations"],
              additionalProperties: false,
              properties: { automations: { type: "array", items: ref("SessionAutomationDefinition") } },
            }),
            ...errorResponses,
          },
        },
        post: {
          operationId: "createSessionAutomationV2",
          parameters: [idempotency],
          requestBody: { required: true, content: json(ref("SessionAutomationCreate")) },
          responses: {
            "201": response("Created session automation", {
              type: "object",
              required: ["automation", "webhookSecrets"],
              additionalProperties: false,
              properties: {
                automation: ref("SessionAutomationDefinition"),
                webhookSecrets: { type: "array", items: ref("SessionAutomationWebhookSecret") },
              },
            }),
            "404": response("Node or runtime not found", ref("Error")),
            ...errorResponses,
          },
        },
      },
      "/api/v2/automations/{automationId}": {
        get: {
          operationId: "getSessionAutomationV2",
          parameters: [idParameter("automationId")],
          responses: {
            "200": response("Session automation", {
              type: "object",
              required: ["automation"],
              additionalProperties: false,
              properties: { automation: ref("SessionAutomationDefinition") },
            }),
            "404": response("Automation not found", ref("Error")),
            ...errorResponses,
          },
        },
        patch: {
          operationId: "updateSessionAutomationV2",
          parameters: [idParameter("automationId"), idempotency],
          requestBody: { required: true, content: json(ref("SessionAutomationPatch")) },
          responses: {
            "200": response("Updated session automation", {
              type: "object",
              required: ["automation", "webhookSecrets"],
              additionalProperties: false,
              properties: {
                automation: ref("SessionAutomationDefinition"),
                webhookSecrets: { type: "array", items: ref("SessionAutomationWebhookSecret") },
              },
            }),
            "404": response("Automation, node, or runtime not found", ref("Error")),
            ...errorResponses,
          },
        },
        delete: {
          operationId: "deleteSessionAutomationV2",
          parameters: [idParameter("automationId"), idempotency],
          responses: {
            "204": response("Deleted session automation"),
            "404": response("Automation not found", ref("Error")),
            ...errorResponses,
          },
        },
      },
      "/api/v2/automations/{automationId}/activity": {
        get: {
          operationId: "listSessionAutomationActivityV2",
          description: "Returns durable schedule and webhook delivery activity, including explicit missed schedules.",
          parameters: [
            idParameter("automationId"),
            { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 100, default: 25 } },
          ],
          responses: {
            "200": response("Bounded automation trigger activity", {
              type: "object",
              required: ["activities"],
              additionalProperties: false,
              properties: { activities: { type: "array", items: ref("SessionAutomationActivity") } },
            }),
            "404": response("Automation not found", ref("Error")),
            ...errorResponses,
          },
        },
      },
      "/api/v2/automations/{automationId}/triggers/{triggerId}/secret": {
        post: {
          operationId: "rotateSessionAutomationWebhookSecretV2",
          parameters: [idParameter("automationId"), idParameter("triggerId"), idempotency],
          requestBody: {
            required: true,
            content: json({
              type: "object",
              required: ["expectedRevision"],
              additionalProperties: false,
              properties: { expectedRevision: { type: "integer", minimum: 1 } },
            }),
          },
          responses: {
            "200": response("Rotated webhook secret shown exactly once", {
              type: "object",
              required: ["automation", "webhookSecret"],
              additionalProperties: false,
              properties: {
                automation: ref("SessionAutomationDefinition"),
                webhookSecret: ref("SessionAutomationWebhookSecret"),
              },
            }),
            "404": response("Automation or webhook trigger not found", ref("Error")),
            ...errorResponses,
          },
        },
      },
      "/api/v2/automation-hooks/{hookId}": {
        post: {
          operationId: "signalSessionAutomationWebhookV2",
          description:
            "Queues a signal-only webhook. The request body is discarded and never becomes task instruction or stored prompt content.",
          security: [{ webhookAuth: [] }],
          parameters: [idParameter("hookId")],
          requestBody: {
            required: false,
            content: json({ description: "Ignored signal payload", nullable: true }),
          },
          responses: {
            "202": response("Webhook signal accepted", {
              type: "object",
              required: ["accepted"],
              additionalProperties: false,
              properties: { accepted: { const: true } },
            }),
            "401": response("Unknown hook or invalid webhook secret", ref("Error")),
            "429": response("Webhook rate limit reached", ref("Error")),
          },
        },
      },
      "/api/v2/automations/{automationId}/runs": {
        get: {
          operationId: "listSessionAutomationRunsV2",
          description:
            "Returns immutable Run history for an owned automation, including after its editable definition has been deleted.",
          parameters: [
            idParameter("automationId"),
            { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 100, default: 25 } },
          ],
          responses: {
            "200": response("Bounded session automation run history", {
              type: "object",
              required: ["runs"],
              additionalProperties: false,
              properties: { runs: { type: "array", items: ref("SessionAutomationRun") } },
            }),
            "404": response("Automation not found", ref("Error")),
            ...errorResponses,
          },
        },
        post: {
          operationId: "runSessionAutomationV2",
          description:
            "Starts a manual run using the definition's exact node, runtime, working directory, options, and instruction.",
          parameters: [idParameter("automationId"), idempotency],
          requestBody: {
            required: false,
            description: "Manual runs use the stored definition and accept no per-run overrides.",
            content: json({ type: "object", maxProperties: 0, additionalProperties: false }),
          },
          responses: {
            "201": response("Started manual automation run and native terminal session", {
              type: "object",
              required: ["run", "session"],
              additionalProperties: false,
              properties: { run: ref("SessionAutomationRun"), session: ref("V2Session") },
            }),
            ...errorResponses,
            "404": response("Automation not found", ref("Error")),
            "409": response("Automation is disabled or the runtime cannot accept task bootstrap", ref("Error")),
            "429": response("Node session capacity reached", ref("Error")),
            "502": response("Durable run failed; session is included when it remains inspectable", {
              type: "object",
              required: ["code", "error", "run"],
              additionalProperties: false,
              properties: {
                code: { type: "string", pattern: "^[A-Z][A-Z0-9_]{0,79}$" },
                error: { type: "string" },
                run: ref("SessionAutomationRun"),
                session: ref("V2Session"),
              },
            }),
            "503": response("Bound node or runtime unavailable", ref("Error")),
          },
        },
      },
    },
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "RoamCode device credential" },
        webhookAuth: { type: "http", scheme: "bearer", bearerFormat: "One-time-shown webhook secret" },
      },
      schemas: {
        Error: {
          type: "object",
          required: ["code", "error"],
          properties: { code: { type: "string" }, error: { type: "string" } },
        },
        Capabilities: {
          type: "object",
          required: ["apiVersion", "protocolVersion", "serverVersion", "serverTime", "features", "providers"],
          properties: {
            serverTime: { type: "integer", description: "Unix epoch milliseconds for skew diagnosis" },
            providers: { type: "array", items: ref("AdapterDescriptor") },
          },
        },
        WorkspaceCreate: {
          type: "object",
          required: ["cwd"],
          additionalProperties: false,
          properties: {
            cwd: { type: "string" },
            label: { type: "string", maxLength: 80 },
            kind: { enum: ["directory", "worktree"] },
          },
        },
        WorktreeCreate: {
          type: "object",
          required: ["repositoryPath", "path"],
          additionalProperties: false,
          properties: {
            repositoryPath: { type: "string" },
            path: { type: "string" },
            branch: { type: "string" },
            baseRef: { type: "string" },
            label: { type: "string", maxLength: 80 },
          },
        },
        ExtensionInstall: {
          type: "object",
          required: ["sourceDirectory", "expectedIntegrity"],
          additionalProperties: false,
          properties: {
            sourceDirectory: { type: "string" },
            expectedIntegrity: { type: "string", pattern: "^sha256-[A-Za-z0-9+/]{43}=$" },
            signature: { type: "string", description: "Base64 Ed25519 signature over the exact SRI string" },
            publicKey: { type: "string", description: "PEM Ed25519 public key" },
            source: { type: "string", maxLength: 500 },
            allowUnsigned: { type: "boolean", default: false },
          },
        },
        SessionCreate: {
          oneOf: enabledAdapters.map((adapter) => ({
            type: "object",
            required: ["cwd", "provider", "options"],
            additionalProperties: false,
            properties: {
              cwd: { type: "string" },
              mode: { const: "terminal" },
              provider: { const: adapter.id },
              options: adapter.optionSchema,
            },
          })),
        },
        Agent: {
          type: "object",
          required: ["id", "sessionId", "workspaceId", "provider", "activity", "createdAt", "updatedAt"],
          properties: { activity: { enum: ["blocked", "working", "done", "idle", "ended", "unknown"] } },
        },
        InputLease: {
          type: "object",
          required: ["owner", "acquiredAt", "renewedAt", "expiresAt", "revision"],
          additionalProperties: false,
          properties: {
            owner: {
              type: "object",
              required: ["actorType", "label"],
              additionalProperties: false,
              properties: {
                actorType: { enum: ["device", "host", "local"] },
                label: { type: "string" },
              },
            },
            acquiredAt: { type: "integer" },
            renewedAt: { type: "integer" },
            expiresAt: { type: "integer" },
            revision: { type: "integer", minimum: 1 },
          },
        },
        InputLeaseState: {
          type: "object",
          required: ["lease"],
          properties: { lease: { oneOf: [ref("InputLease"), { type: "null" }] } },
        },
        InputLeaseRequest: {
          type: "object",
          required: ["action"],
          additionalProperties: false,
          properties: {
            action: { enum: ["acquire", "takeover", "renew", "release", "revoke"] },
            clientId: {
              type: "string",
              minLength: 1,
              maxLength: 128,
              description: "Required for every holder action; omitted for administrator revoke",
            },
            leaseId: { type: "string", minLength: 1, maxLength: 256 },
            confirm: {
              type: "boolean",
              description: "Must be true for takeover of another holder and administrator revoke",
            },
          },
        },
        InputLeaseGrant: {
          type: "object",
          required: ["lease"],
          properties: {
            leaseId: {
              type: "string",
              description: "Returned only to the bound holder; required for renew, release, and input",
            },
            lease: { oneOf: [ref("InputLease"), { type: "null" }] },
          },
        },
        EnterprisePolicy: {
          type: "object",
          required: [
            "enforcementEnabled",
            "allowedHostIds",
            "allowedWorkspaceIds",
            "allowedProviderIds",
            "allowDangerousProviderModes",
            "allowFileTransfer",
            "extensionMode",
            "updateMode",
            "revision",
            "createdAt",
            "updatedAt",
          ],
          additionalProperties: false,
          properties: {
            enforcementEnabled: { type: "boolean" },
            allowedHostIds: {
              oneOf: [
                { type: "array", uniqueItems: true, maxItems: 1000, items: { type: "string" } },
                { type: "null" },
              ],
            },
            allowedWorkspaceIds: {
              oneOf: [
                { type: "array", uniqueItems: true, maxItems: 1000, items: { type: "string" } },
                { type: "null" },
              ],
            },
            allowedProviderIds: {
              oneOf: [
                {
                  type: "array",
                  uniqueItems: true,
                  maxItems: 1000,
                  items: { type: "string", pattern: "^[a-z][a-z0-9-]{0,63}$" },
                },
                { type: "null" },
              ],
            },
            allowDangerousProviderModes: { type: "boolean" },
            allowFileTransfer: { type: "boolean" },
            extensionMode: { enum: ["allow-integrity", "signed-only", "deny"] },
            updateMode: { enum: ["stable-only", "deny"] },
            revision: { type: "integer", minimum: 1 },
            createdAt: { type: "integer", minimum: 0 },
            updatedAt: { type: "integer", minimum: 0 },
          },
        },
        EnterprisePolicyEnvelope: {
          type: "object",
          required: ["policy"],
          additionalProperties: false,
          properties: { policy: ref("EnterprisePolicy") },
        },
        EnterprisePolicyPatch: {
          type: "object",
          required: ["expectedRevision"],
          additionalProperties: false,
          properties: {
            enforcementEnabled: { type: "boolean" },
            allowedHostIds: {
              oneOf: [
                { type: "array", uniqueItems: true, maxItems: 1000, items: { type: "string" } },
                { type: "null" },
              ],
            },
            allowedWorkspaceIds: {
              oneOf: [
                { type: "array", uniqueItems: true, maxItems: 1000, items: { type: "string" } },
                { type: "null" },
              ],
            },
            allowedProviderIds: {
              oneOf: [
                {
                  type: "array",
                  uniqueItems: true,
                  maxItems: 1000,
                  items: { type: "string", pattern: "^[a-z][a-z0-9-]{0,63}$" },
                },
                { type: "null" },
              ],
            },
            allowDangerousProviderModes: { type: "boolean" },
            allowFileTransfer: { type: "boolean" },
            extensionMode: { enum: ["allow-integrity", "signed-only", "deny"] },
            updateMode: { enum: ["stable-only", "deny"] },
            expectedRevision: { type: "integer", minimum: 1 },
            confirm: {
              type: "boolean",
              description: "Must be true when changing enforcementEnabled from false to true",
            },
          },
        },
        FleetInventory: {
          type: "object",
          required: ["revision", "hosts"],
          additionalProperties: false,
          properties: {
            revision: { type: "integer", minimum: 0 },
            hosts: { type: "array", items: ref("FleetHost") },
          },
        },
        FleetHost: {
          type: "object",
          required: [
            "id",
            "label",
            "version",
            "health",
            "activeSessions",
            "dataDurable",
            "policyPosture",
            "adapters",
            "updatedAt",
          ],
          additionalProperties: false,
          properties: {
            id: { type: "string" },
            label: { type: "string" },
            version: { type: "string" },
            health: { enum: ["healthy", "degraded", "offline", "unknown"] },
            activeSessions: { type: "integer", minimum: 0 },
            dataDurable: { type: "boolean" },
            policyPosture: {
              type: "object",
              required: ["enforcementEnabled", "revision", "compliant", "violations"],
              additionalProperties: false,
              properties: {
                enforcementEnabled: { type: "boolean" },
                revision: { type: "integer", minimum: 1 },
                compliant: { type: "boolean" },
                violations: { type: "array", uniqueItems: true, items: { type: "string" } },
              },
            },
            adapters: {
              type: "array",
              items: {
                type: "object",
                required: ["id", "enabled", "source", "capabilities"],
                additionalProperties: false,
                properties: {
                  id: { type: "string" },
                  version: { type: "string" },
                  enabled: { type: "boolean" },
                  source: { type: "string" },
                  capabilities: { type: "object" },
                },
              },
            },
            updatedAt: { type: "integer", minimum: 0 },
          },
        },
        PeerRecord: {
          description: "Privacy-bounded peer metadata. The remote origin and stored credential are never returned.",
          type: "object",
          required: [
            "id",
            "label",
            "remoteHostId",
            "remoteVersion",
            "actions",
            "allowedWorkspaceIds",
            "status",
            "revision",
            "createdAt",
            "updatedAt",
            "lastVerifiedAt",
          ],
          additionalProperties: false,
          properties: {
            id: { type: "string" },
            label: { type: "string", minLength: 1, maxLength: 80 },
            remoteHostId: { type: "string" },
            remoteVersion: { type: "string" },
            actions: {
              type: "array",
              uniqueItems: true,
              minItems: 1,
              items: { enum: ["read", "wait", "send", "start", "focus"] },
            },
            allowedWorkspaceIds: {
              oneOf: [
                { type: "array", uniqueItems: true, maxItems: 1000, items: { type: "string" } },
                { type: "null" },
              ],
            },
            status: { enum: ["active", "suspended"] },
            revision: { type: "integer", minimum: 1 },
            createdAt: { type: "integer", minimum: 0 },
            updatedAt: { type: "integer", minimum: 0 },
            lastVerifiedAt: { type: "integer", minimum: 0 },
          },
        },
        PeerEnvelope: {
          type: "object",
          required: ["peer"],
          additionalProperties: false,
          properties: { peer: ref("PeerRecord") },
        },
        PeerList: {
          type: "object",
          required: ["peers"],
          additionalProperties: false,
          properties: { peers: { type: "array", items: ref("PeerRecord") } },
        },
        PeerCreate: {
          type: "object",
          required: ["confirm"],
          oneOf: [{ required: ["pairingUrl"] }, { required: ["baseUrl", "credential"] }],
          additionalProperties: false,
          properties: {
            label: { type: "string", minLength: 1, maxLength: 80 },
            pairingUrl: {
              type: "string",
              format: "uri",
              maxLength: 8192,
              writeOnly: true,
              description:
                "Preferred enrollment: a five-minute, one-use device pairing link. Mutually exclusive with baseUrl and credential.",
            },
            baseUrl: {
              type: "string",
              format: "uri",
              writeOnly: true,
              description: "HTTPS origin; plain HTTP is accepted only for loopback development.",
            },
            credential: { type: "string", minLength: 16, maxLength: 4096, writeOnly: true },
            actions: {
              type: "array",
              uniqueItems: true,
              minItems: 1,
              items: { enum: ["read", "wait", "send", "start", "focus"] },
              default: ["read", "wait"],
            },
            allowedWorkspaceIds: {
              oneOf: [
                { type: "array", uniqueItems: true, maxItems: 1000, items: { type: "string" } },
                { type: "null" },
              ],
              default: [],
              description:
                "Defaults to no workspace access. Null means all workspaces still permitted by local and remote policy.",
            },
            confirm: { const: true },
          },
        },
        PeerUpdate: {
          type: "object",
          required: ["expectedRevision"],
          additionalProperties: false,
          properties: {
            label: { type: "string", minLength: 1, maxLength: 80 },
            actions: {
              type: "array",
              uniqueItems: true,
              minItems: 1,
              items: { enum: ["read", "wait", "send", "start", "focus"] },
            },
            allowedWorkspaceIds: {
              oneOf: [
                { type: "array", uniqueItems: true, maxItems: 1000, items: { type: "string" } },
                { type: "null" },
              ],
            },
            status: { enum: ["active", "suspended"] },
            expectedRevision: { type: "integer", minimum: 1 },
          },
        },
        PeerVerify: {
          type: "object",
          required: ["expectedRevision"],
          additionalProperties: false,
          properties: { expectedRevision: { type: "integer", minimum: 1 } },
        },
        PeerWorkspace: {
          description: "Setup metadata only; remote filesystem paths are intentionally omitted.",
          type: "object",
          required: ["id", "label", "kind", "archived"],
          additionalProperties: false,
          properties: {
            id: { type: "string" },
            label: { type: "string", minLength: 1, maxLength: 80 },
            kind: { enum: ["directory", "worktree"] },
            archived: { type: "boolean" },
          },
        },
        PeerDiscovery: {
          type: "object",
          required: ["peer", "workspaces"],
          additionalProperties: false,
          properties: {
            peer: ref("PeerRecord"),
            workspaces: { type: "array", maxItems: 1000, items: ref("PeerWorkspace") },
          },
        },
        PeerCredentialRotation: {
          type: "object",
          required: ["expectedRevision", "confirm"],
          oneOf: [{ required: ["pairingUrl"] }, { required: ["credential"] }],
          additionalProperties: false,
          properties: {
            pairingUrl: { type: "string", format: "uri", maxLength: 8192, writeOnly: true },
            credential: { type: "string", minLength: 16, maxLength: 4096, writeOnly: true },
            expectedRevision: { type: "integer", minimum: 1 },
            confirm: { const: true },
          },
        },
        PeerSessionCreate: {
          oneOf: enabledAdapters.map((adapter) => ({
            type: "object",
            required: ["workspaceId", "provider", "options"],
            additionalProperties: false,
            properties: {
              workspaceId: { type: "string", minLength: 1, maxLength: 256 },
              mode: { const: "terminal" },
              provider: { const: adapter.id },
              options: adapter.optionSchema,
            },
          })),
        },
        PeerSessionInput: {
          type: "object",
          required: ["data"],
          additionalProperties: false,
          properties: {
            data: { type: "string", maxLength: 65536 },
            appendNewline: { type: "boolean", default: false },
            clientId: { type: "string", minLength: 1, maxLength: 128 },
            leaseId: { type: "string", minLength: 1, maxLength: 256 },
          },
        },
        AuditRecord: {
          type: "object",
          required: [
            "id",
            "actorType",
            "actorId",
            "action",
            "targetType",
            "result",
            "metadata",
            "createdAt",
            "previousHash",
            "hash",
          ],
          additionalProperties: false,
          properties: {
            id: { type: "integer", minimum: 1 },
            actorType: { enum: ["host", "device", "local", "automation", "plugin", "system"] },
            actorId: { type: "string" },
            action: { type: "string" },
            targetType: { type: "string" },
            targetId: { type: "string" },
            result: { enum: ["success", "denied", "error"] },
            metadata: { type: "object", additionalProperties: true },
            createdAt: { type: "integer", minimum: 0 },
            previousHash: { type: "string", pattern: "^[a-f0-9]{64}$" },
            hash: { type: "string", pattern: "^[a-f0-9]{64}$" },
          },
        },
        AuditPage: {
          type: "object",
          required: ["records", "nextCursor"],
          additionalProperties: false,
          properties: {
            records: { type: "array", items: ref("AuditRecord") },
            nextCursor: { type: "integer", minimum: 0 },
          },
        },
        AuditVerification: {
          type: "object",
          required: ["valid", "count", "head"],
          additionalProperties: false,
          properties: {
            valid: { type: "boolean" },
            count: { type: "integer", minimum: 0 },
            head: { type: "string", pattern: "^[a-f0-9]{64}$" },
          },
        },
        Team: {
          type: "object",
          required: ["id", "name", "authorizationEnabled", "revision", "createdAt", "updatedAt"],
          additionalProperties: false,
          properties: {
            id: { type: "string" },
            name: { type: "string" },
            authorizationEnabled: { type: "boolean" },
            revision: { type: "integer", minimum: 1 },
            createdAt: { type: "integer" },
            updatedAt: { type: "integer" },
          },
        },
        TeamMember: {
          type: "object",
          required: ["id", "displayName", "kind", "status", "revision", "createdAt", "updatedAt"],
          additionalProperties: false,
          properties: {
            id: { type: "string" },
            displayName: { type: "string" },
            kind: { enum: ["person", "service"] },
            status: { enum: ["active", "suspended", "removed"] },
            revision: { type: "integer", minimum: 1 },
            createdAt: { type: "integer" },
            updatedAt: { type: "integer" },
          },
        },
        TeamRoleBinding: {
          type: "object",
          required: ["id", "memberId", "role", "scopeType", "createdAt"],
          additionalProperties: false,
          properties: {
            id: { type: "string" },
            memberId: { type: "string" },
            role: {
              enum: [
                "viewer",
                "operator",
                "node-admin",
                "workspace-manager",
                "extension-manager",
                "policy-admin",
                "organization-admin",
              ],
            },
            scopeType: { enum: ["team", "host", "workspace"] },
            scopeId: { type: "string" },
            createdAt: { type: "integer" },
          },
        },
        TeamEnvelope: {
          type: "object",
          required: ["team", "currentMember", "roles", "permissions", "authorization"],
          properties: {
            team: { oneOf: [ref("Team"), { type: "null" }] },
            currentMember: { oneOf: [ref("TeamMember"), { type: "null" }] },
            roles: { type: "array", items: ref("TeamRoleBinding") },
            permissions: { type: "array", uniqueItems: true, items: { type: "string" } },
            authorization: {
              type: "object",
              required: ["enabled", "localBreakGlass"],
              additionalProperties: false,
              properties: { enabled: { type: "boolean" }, localBreakGlass: { type: "boolean" } },
            },
          },
        },
        TeamMemberCreate: {
          type: "object",
          required: ["displayName"],
          additionalProperties: false,
          properties: {
            displayName: { type: "string", minLength: 1, maxLength: 120 },
            kind: { enum: ["person", "service"], default: "person" },
            role: { $ref: "#/components/schemas/TeamRoleBinding/properties/role" },
            scopeType: { enum: ["team", "host", "workspace"], default: "team" },
            scopeId: { type: "string" },
          },
        },
        TeamRoleGrant: {
          type: "object",
          required: ["memberId", "role"],
          additionalProperties: false,
          properties: {
            memberId: { type: "string", minLength: 1, maxLength: 256 },
            role: { $ref: "#/components/schemas/TeamRoleBinding/properties/role" },
            scopeType: { enum: ["team", "host", "workspace"], default: "team" },
            scopeId: { type: "string" },
          },
        },
        TeamPrincipalBinding: {
          type: "object",
          required: ["memberId", "actorType", "actorId"],
          properties: {
            memberId: { type: "string", minLength: 1, maxLength: 256 },
            actorType: { enum: ["device", "host", "local"] },
            actorId: { type: "string", minLength: 1, maxLength: 256 },
            createdAt: { type: "integer", readOnly: true },
          },
        },
        PresenceHeartbeat: {
          type: "object",
          required: ["clientId", "mode"],
          additionalProperties: false,
          properties: {
            clientId: { type: "string", minLength: 1, maxLength: 256 },
            mode: { enum: ["viewing", "operating"] },
            workspaceId: { type: "string" },
            sessionId: { type: "string" },
            agentId: { type: "string" },
          },
        },
        Presence: {
          description: "Ephemeral public record; principal and client identifiers are intentionally omitted.",
          type: "object",
          required: ["id", "label", "mode", "hostId", "connectedAt", "lastSeenAt", "expiresAt", "revision"],
          additionalProperties: false,
          properties: {
            id: { type: "string" },
            memberId: { type: "string" },
            label: { type: "string" },
            mode: { enum: ["viewing", "operating"] },
            hostId: { type: "string" },
            workspaceId: { type: "string" },
            sessionId: { type: "string" },
            agentId: { type: "string" },
            connectedAt: { type: "integer" },
            lastSeenAt: { type: "integer" },
            expiresAt: { type: "integer" },
            revision: { type: "integer", minimum: 1 },
          },
        },
        Automation: {
          type: "object",
          required: ["name", "trigger", "action", "permissions"],
          properties: {
            name: { type: "string", maxLength: 80 },
            enabled: { type: "boolean" },
            trigger: { type: "object" },
            action: { type: "object" },
            permissions: { type: "array", items: { enum: ["attention:write", "events:write"] } },
          },
        },
        OwnerRef: {
          type: "object",
          required: ["type", "id"],
          additionalProperties: false,
          properties: {
            type: { enum: ["person", "organization"] },
            id: { type: "string", minLength: 1, maxLength: 256 },
          },
        },
        ProductContext: {
          type: "object",
          required: ["kind", "id", "name"],
          additionalProperties: false,
          properties: {
            kind: { enum: ["personal", "organization"] },
            id: { type: "string", minLength: 1, maxLength: 256 },
            name: { type: "string", minLength: 1, maxLength: 80 },
          },
        },
        NodeAlias: {
          type: "object",
          required: ["kind", "id"],
          additionalProperties: false,
          properties: {
            kind: { enum: ["command-host", "peer-host", "direct-host"] },
            id: { type: "string", minLength: 1, maxLength: 512 },
          },
        },
        Node: {
          type: "object",
          required: ["id", "owner", "name", "status", "platform", "lastSeenAt", "aliases"],
          additionalProperties: false,
          properties: {
            id: { type: "string", minLength: 1, maxLength: 256 },
            owner: ref("OwnerRef"),
            name: { type: "string", minLength: 1, maxLength: 80 },
            status: { enum: ["online", "offline", "degraded"] },
            platform: { type: "string", minLength: 1, maxLength: 80 },
            lastSeenAt: { type: "integer", minimum: 0 },
            aliases: { type: "array", uniqueItems: true, maxItems: 64, items: ref("NodeAlias") },
          },
        },
        AgentRuntime: {
          description:
            "Privacy-bounded runtime projection. Probe detail, executable paths, credentials, and launch options are intentionally omitted.",
          type: "object",
          required: [
            "id",
            "nodeId",
            "provider",
            "displayName",
            "availability",
            "authState",
            "capabilities",
            "activeSessionCount",
            "observedAt",
          ],
          additionalProperties: false,
          properties: {
            id: { type: "string", pattern: "^runtime_[A-Za-z0-9_-]{24}$" },
            nodeId: { type: "string", minLength: 1, maxLength: 256 },
            provider: { type: "string", pattern: "^[a-z][a-z0-9-]{0,63}$" },
            displayName: { type: "string", minLength: 1, maxLength: 80 },
            availability: { enum: ["available", "unavailable"] },
            authState: { enum: ["ready", "required", "unknown", "error"] },
            version: { type: "string", maxLength: 120 },
            capabilities: {
              type: "array",
              uniqueItems: true,
              items: { type: "string", pattern: "^[a-z][a-z0-9-]{0,79}$" },
            },
            activeSessionCount: { type: "integer", minimum: 0 },
            observedAt: { type: "integer", minimum: 0 },
          },
        },
        NodeAccessSubject: {
          type: "object",
          required: ["type", "id"],
          additionalProperties: false,
          properties: {
            type: { enum: ["member", "device", "service-account"] },
            id: { type: "string", minLength: 1, maxLength: 256 },
            displayName: { type: "string", minLength: 1, maxLength: 120, readOnly: true },
          },
        },
        NodeAccessGrant: {
          description: "An effective node-level grant projected from standalone authorization data.",
          type: "object",
          required: ["id", "nodeId", "subject", "role", "permissions", "source", "mutable"],
          additionalProperties: false,
          properties: {
            id: { type: "string", minLength: 1, maxLength: 256 },
            nodeId: { type: "string", minLength: 1, maxLength: 256 },
            subject: ref("NodeAccessSubject"),
            role: { enum: ["viewer", "operator", "admin"] },
            permissions: {
              type: "array",
              uniqueItems: true,
              items: { type: "string", pattern: "^[a-z][a-z0-9:_-]{0,79}$" },
            },
            source: { enum: ["local-implicit", "team"] },
            mutable: { type: "boolean" },
            revision: { type: "integer", minimum: 1 },
          },
        },
        NodeAccessGrantCreate: {
          type: "object",
          required: ["subject", "role"],
          additionalProperties: false,
          properties: {
            subject: {
              type: "object",
              required: ["type", "id"],
              additionalProperties: false,
              properties: {
                type: { const: "member" },
                id: { type: "string", minLength: 1, maxLength: 256 },
              },
            },
            role: { enum: ["viewer", "operator", "admin"] },
          },
        },
        V2Session: {
          description:
            "A native terminal session bound directly to a Node and AgentRuntime with no indirect placement identifiers.",
          type: "object",
          required: [
            "id",
            "nodeId",
            "agentRuntimeId",
            "provider",
            "cwd",
            "mode",
            "status",
            "dangerouslySkip",
            "createdAt",
            "lastActivityAt",
          ],
          additionalProperties: false,
          properties: {
            id: { type: "string", minLength: 1, maxLength: 256 },
            nodeId: { type: "string", minLength: 1, maxLength: 256 },
            agentRuntimeId: { type: "string", pattern: "^runtime_[A-Za-z0-9_-]{24}$" },
            provider: { type: "string", pattern: "^[a-z][a-z0-9-]{0,63}$" },
            cwd: { type: "string", minLength: 1 },
            name: { type: "string", minLength: 1, maxLength: 80 },
            mode: { const: "terminal" },
            status: { enum: ["running", "ended"] },
            activity: { enum: ["working", "blocked", "idle"] },
            awaiting: { type: "boolean" },
            dangerouslySkip: { type: "boolean" },
            model: { type: "string", maxLength: 256 },
            effort: { type: "string", maxLength: 80 },
            permissionMode: { enum: ["default", "acceptEdits", "plan", "bypassPermissions"] },
            sandbox: { enum: ["read-only", "workspace-write", "danger-full-access"] },
            approvalPolicy: { enum: ["untrusted", "on-request", "never"] },
            automation: {
              type: "object",
              required: ["id", "runId", "status"],
              additionalProperties: false,
              properties: {
                id: { type: "string", minLength: 1, maxLength: 256 },
                runId: { type: "string", minLength: 1, maxLength: 256 },
                status: { enum: ["starting", "running", "needs-input", "ready", "failed", "cancelled"] },
              },
            },
            identityState: { enum: ["pending", "exact", "ambiguous"] },
            resumeIdentity: { enum: ["optional", "required", "unsupported"] },
            providerSessionId: { type: "string", minLength: 1, maxLength: 512 },
            createdAt: { type: "integer", minimum: 0 },
            lastActivityAt: { type: "integer", minimum: 0 },
          },
        },
        V2SessionCreate: {
          type: "object",
          required: ["agentRuntimeId", "cwd"],
          additionalProperties: false,
          properties: {
            agentRuntimeId: { type: "string", pattern: "^runtime_[A-Za-z0-9_-]{24}$" },
            cwd: { type: "string", minLength: 1 },
            runtimeOptions: {
              type: "object",
              additionalProperties: true,
              description: "Validated against the selected runtime adapter's option schema at launch time.",
            },
          },
        },
        SessionDefaults: {
          type: "object",
          required: ["effort", "dangerouslySkip"],
          additionalProperties: false,
          properties: {
            provider: { type: "string", pattern: "^[a-z][a-z0-9-]{0,63}$" },
            effort: { type: "string", minLength: 1, maxLength: 128 },
            model: { type: "string", minLength: 1, maxLength: 128 },
            dangerouslySkip: { type: "boolean" },
            permissionMode: { enum: ["default", "acceptEdits", "plan", "bypassPermissions"] },
            addDirs: { type: "array", maxItems: 32, items: { type: "string", minLength: 1, maxLength: 4096 } },
            codex: {
              type: "object",
              additionalProperties: false,
              properties: {
                model: { type: "string", minLength: 1, maxLength: 128 },
                reasoningEffort: { type: "string", minLength: 1, maxLength: 128 },
                sandbox: { enum: ["read-only", "workspace-write", "danger-full-access"] },
                approvalPolicy: { enum: ["untrusted", "on-request", "never"] },
                profile: { type: "string", minLength: 1, maxLength: 128 },
                webSearch: { type: "boolean" },
                addDirs: {
                  type: "array",
                  maxItems: 32,
                  items: { type: "string", minLength: 1, maxLength: 4096 },
                },
                dangerouslyBypassApprovalsAndSandbox: { type: "boolean" },
              },
            },
          },
        },
        SessionDefaultsEnvelope: {
          type: "object",
          required: ["defaults", "revision"],
          additionalProperties: false,
          properties: {
            defaults: { oneOf: [ref("SessionDefaults"), { type: "null" }] },
            revision: { type: "integer", minimum: 0 },
            updatedAt: { type: "integer", minimum: 0 },
          },
        },
        ProviderMetadataWarning: {
          type: "object",
          required: ["code", "message"],
          additionalProperties: false,
          properties: {
            code: { const: "PROVIDER_METADATA_UNAVAILABLE" },
            message: { type: "string", minLength: 1, maxLength: 500 },
          },
        },
        SessionAutomationTrigger: {
          type: "object",
          required: ["type"],
          additionalProperties: false,
          properties: { type: { const: "manual" } },
        },
        SessionAutomationConfiguredTrigger: {
          oneOf: [
            {
              type: "object",
              required: ["id", "type", "enabled", "cron", "timeZone", "missedRunPolicy"],
              additionalProperties: false,
              properties: {
                id: { type: "string", minLength: 1, maxLength: 256 },
                type: { const: "schedule" },
                enabled: { type: "boolean" },
                cron: { type: "string", minLength: 9, maxLength: 120 },
                timeZone: { type: "string", minLength: 1, maxLength: 80 },
                missedRunPolicy: { const: "skip" },
              },
            },
            {
              type: "object",
              required: ["id", "type", "enabled", "hookId"],
              additionalProperties: false,
              properties: {
                id: { type: "string", minLength: 1, maxLength: 256 },
                type: { const: "webhook" },
                enabled: { type: "boolean" },
                hookId: { type: "string", pattern: "^rcwh_[A-Za-z0-9_-]{24,80}$" },
              },
            },
          ],
        },
        SessionAutomationTriggerInput: {
          oneOf: [
            {
              type: "object",
              required: ["type", "enabled", "cron", "timeZone", "missedRunPolicy"],
              additionalProperties: false,
              properties: {
                id: { type: "string", minLength: 1, maxLength: 256 },
                type: { const: "schedule" },
                enabled: { type: "boolean" },
                cron: { type: "string", minLength: 9, maxLength: 120 },
                timeZone: { type: "string", minLength: 1, maxLength: 80 },
                missedRunPolicy: { const: "skip" },
              },
            },
            {
              type: "object",
              required: ["type", "enabled"],
              additionalProperties: false,
              properties: {
                id: { type: "string", minLength: 1, maxLength: 256 },
                type: { const: "webhook" },
                enabled: { type: "boolean" },
                hookId: { type: "string", pattern: "^rcwh_[A-Za-z0-9_-]{24,80}$" },
              },
            },
          ],
        },
        SessionAutomationDefinition: {
          type: "object",
          required: [
            "id",
            "owner",
            "name",
            "enabled",
            "nodeId",
            "agentRuntimeId",
            "provider",
            "cwd",
            "trigger",
            "triggers",
            "instruction",
            "runtimeOptions",
            "revision",
            "createdAt",
            "updatedAt",
          ],
          additionalProperties: false,
          properties: {
            id: { type: "string", minLength: 1, maxLength: 256 },
            owner: ref("OwnerRef"),
            name: { type: "string", minLength: 1, maxLength: 80 },
            enabled: { type: "boolean" },
            nodeId: { type: "string", minLength: 1, maxLength: 256 },
            agentRuntimeId: { type: "string", pattern: "^runtime_[A-Za-z0-9_-]{24}$" },
            provider: { type: "string", pattern: "^[a-z][a-z0-9-]{0,63}$" },
            cwd: { type: "string", minLength: 1 },
            trigger: ref("SessionAutomationTrigger"),
            triggers: { type: "array", maxItems: 16, items: ref("SessionAutomationConfiguredTrigger") },
            instruction: {
              type: "string",
              minLength: 1,
              maxLength: 32768,
              "x-maxBytes": 32768,
              description: "UTF-8 encoded instruction must not exceed 32 KiB; the server enforces the byte limit.",
            },
            runtimeOptions: { type: "object", additionalProperties: true, "x-maxBytes": 65536 },
            revision: { type: "integer", minimum: 1 },
            createdAt: { type: "integer", minimum: 0 },
            updatedAt: { type: "integer", minimum: 0 },
          },
        },
        SessionAutomationCreate: {
          type: "object",
          required: ["name", "nodeId", "agentRuntimeId", "cwd", "instruction"],
          additionalProperties: false,
          properties: {
            name: { type: "string", minLength: 1, maxLength: 80 },
            enabled: { type: "boolean", default: true },
            nodeId: { type: "string", minLength: 1, maxLength: 256 },
            agentRuntimeId: { type: "string", pattern: "^runtime_[A-Za-z0-9_-]{24}$" },
            cwd: { type: "string", minLength: 1 },
            trigger: ref("SessionAutomationTrigger"),
            triggers: { type: "array", maxItems: 16, items: ref("SessionAutomationTriggerInput") },
            instruction: {
              type: "string",
              minLength: 1,
              maxLength: 32768,
              "x-maxBytes": 32768,
              description: "UTF-8 encoded instruction must not exceed 32 KiB.",
            },
            runtimeOptions: { type: "object", additionalProperties: true, "x-maxBytes": 65536 },
          },
        },
        SessionAutomationPatch: {
          type: "object",
          required: ["expectedRevision"],
          minProperties: 2,
          additionalProperties: false,
          properties: {
            expectedRevision: { type: "integer", minimum: 1 },
            name: { type: "string", minLength: 1, maxLength: 80 },
            enabled: { type: "boolean" },
            nodeId: { type: "string", minLength: 1, maxLength: 256 },
            agentRuntimeId: { type: "string", pattern: "^runtime_[A-Za-z0-9_-]{24}$" },
            cwd: { type: "string", minLength: 1 },
            trigger: ref("SessionAutomationTrigger"),
            triggers: { type: "array", maxItems: 16, items: ref("SessionAutomationTriggerInput") },
            instruction: {
              type: "string",
              minLength: 1,
              maxLength: 32768,
              "x-maxBytes": 32768,
              description: "UTF-8 encoded instruction must not exceed 32 KiB.",
            },
            runtimeOptions: { type: "object", additionalProperties: true, "x-maxBytes": 65536 },
          },
        },
        SessionAutomationWebhookSecret: {
          type: "object",
          required: ["triggerId", "hookId", "secret", "path"],
          additionalProperties: false,
          properties: {
            triggerId: { type: "string", minLength: 1, maxLength: 256 },
            hookId: { type: "string", pattern: "^rcwh_[A-Za-z0-9_-]{24,80}$" },
            secret: { type: "string", pattern: "^rcws_[A-Za-z0-9_-]{43}$" },
            path: { type: "string", pattern: "^/api/v2/automation-hooks/rcwh_[A-Za-z0-9_-]{24,80}$" },
          },
        },
        SessionAutomationActivity: {
          type: "object",
          required: ["id", "automationId", "triggerId", "source", "status", "invocationId", "createdAt", "updatedAt"],
          additionalProperties: false,
          properties: {
            id: { type: "string", minLength: 1, maxLength: 256 },
            automationId: { type: "string", minLength: 1, maxLength: 256 },
            triggerId: { type: "string", minLength: 1, maxLength: 256 },
            source: { enum: ["schedule", "webhook"] },
            status: { enum: ["queued", "started", "failed", "missed", "expired"] },
            invocationId: { type: "string", minLength: 1, maxLength: 256 },
            scheduledFor: { type: "integer", minimum: 0 },
            missedCount: { type: "integer", minimum: 1 },
            runId: { type: "string", minLength: 1, maxLength: 256 },
            failureCode: { type: "string", pattern: "^[A-Z][A-Z0-9_]{0,79}$" },
            createdAt: { type: "integer", minimum: 0 },
            updatedAt: { type: "integer", minimum: 0 },
          },
        },
        SessionAutomationRun: {
          description:
            "Privacy-bounded run state with its exact execution binding; terminal transcript, instruction, and provider detail are omitted.",
          type: "object",
          required: [
            "id",
            "automationId",
            "definitionRevision",
            "invocationId",
            "sessionId",
            "nodeId",
            "agentRuntimeId",
            "cwd",
            "status",
            "createdAt",
            "updatedAt",
          ],
          additionalProperties: false,
          properties: {
            id: { type: "string", minLength: 1, maxLength: 256 },
            automationId: { type: "string", minLength: 1, maxLength: 256 },
            definitionRevision: { type: "integer", minimum: 1 },
            invocationId: { type: "string", minLength: 1, maxLength: 256 },
            sessionId: { type: "string", minLength: 1, maxLength: 256 },
            nodeId: { type: "string", minLength: 1, maxLength: 256 },
            agentRuntimeId: { type: "string", pattern: "^runtime_[A-Za-z0-9_-]{24}$" },
            cwd: { type: "string", minLength: 1 },
            status: { enum: ["starting", "running", "needs-input", "ready", "failed", "cancelled"] },
            failureCode: { type: "string", pattern: "^[A-Z][A-Z0-9_]{0,79}$" },
            createdAt: { type: "integer", minimum: 0 },
            updatedAt: { type: "integer", minimum: 0 },
          },
        },
        AdapterManifestV1: {
          type: "object",
          required: [
            "schemaVersion",
            "id",
            "version",
            "displayName",
            "platforms",
            "resumeIdentity",
            "capabilities",
            "stateAuthority",
            "optionSchema",
          ],
          additionalProperties: false,
          properties: {
            schemaVersion: { const: 1 },
            id: { type: "string", pattern: "^[a-z][a-z0-9-]{0,63}$" },
            version: { type: "string" },
            displayName: { type: "string" },
            platforms: { type: "array", items: { enum: ["darwin", "linux"] } },
            resumeIdentity: { enum: ["optional", "required", "unsupported"] },
            capabilities: { type: "object" },
            stateAuthority: { type: "array", items: { enum: ["native-events", "runtime-signals", "pane-heuristics"] } },
            optionSchema: { type: "object" },
          },
        },
        AdapterDescriptor: {
          type: "object",
          required: [
            "schemaVersion",
            "id",
            "version",
            "displayName",
            "platforms",
            "resumeIdentity",
            "capabilities",
            "stateAuthority",
            "optionSchema",
            "source",
            "enabled",
          ],
          additionalProperties: false,
          properties: {
            schemaVersion: { const: 1 },
            id: { type: "string", pattern: "^[a-z][a-z0-9-]{0,63}$" },
            version: { type: "string" },
            displayName: { type: "string" },
            platforms: { type: "array", items: { enum: ["darwin", "linux"] } },
            resumeIdentity: { enum: ["optional", "required", "unsupported"] },
            capabilities: { type: "object" },
            stateAuthority: {
              type: "array",
              items: { enum: ["native-events", "runtime-signals", "pane-heuristics"] },
            },
            optionSchema: { type: "object" },
            source: { enum: ["built-in", "installed"] },
            enabled: { type: "boolean" },
          },
        },
      },
    },
    "x-roamcode-adapters": options.adapters,
  };
}
