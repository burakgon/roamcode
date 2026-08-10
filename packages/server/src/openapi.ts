import type { ReturnTypeOfDescriptors } from "./providers/registry.js";

type JsonObject = Record<string, unknown>;

const json = (schema: JsonObject) => ({ "application/json": { schema } });
const response = (description: string, schema?: JsonObject) => ({
  description,
  ...(schema ? { content: json(schema) } : {}),
});
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const idParameter = (name: string) => ({ name, in: "path", required: true, schema: { type: "string" } });
const idempotency = {
  name: "Idempotency-Key",
  in: "header",
  required: false,
  description: "Actor-scoped replay key retained for 24 hours. Reuse with a different request returns 409.",
  schema: { type: "string", minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9._:-]+$" },
};

export interface OpenApiBuildOptions {
  serverVersion: string;
  adapters: ReturnTypeOfDescriptors;
}

export function buildOpenApiDocument(options: OpenApiBuildOptions): JsonObject {
  const errors = {
    "400": response("Invalid request", ref("Error")),
    "401": response("Missing, invalid, or revoked credential", ref("Error")),
    "403": response("Origin denied", ref("Error")),
    "409": response("Revision, lease, or idempotency conflict", ref("Error")),
  };
  const automationParameters = [idParameter("automationId")];
  const instruction = { type: "string", minLength: 1, maxLength: 32 * 1024, "x-maxBytes": 32 * 1024 };
  const runtimeOptions = { type: "object", maxProperties: 64, "x-maxBytes": 64 * 1024 };
  const automationProperties = {
    name: { type: "string", minLength: 1, maxLength: 120 },
    enabled: { type: "boolean" },
    nodeId: { type: "string", minLength: 1, maxLength: 256 },
    agentRuntimeId: { type: "string", pattern: "^runtime_[A-Za-z0-9_-]{24}$" },
    cwd: { type: "string", minLength: 1 },
    instruction,
    runtimeOptions,
    trigger: ref("SessionAutomationTrigger"),
    triggers: { type: "array", maxItems: 16, items: ref("SessionAutomationConfiguredTrigger") },
  };

  return {
    openapi: "3.1.0",
    info: {
      title: "RoamCode API",
      version: options.serverVersion,
      description:
        "Personal, local-first control for Sessions, workspaces, devices, input ownership, presence, and v2 Automations.",
    },
    servers: [{ url: "/", description: "The current authenticated RoamCode origin" }],
    security: [{ bearerAuth: [] }],
    paths: {
      "/api/v1/capabilities": {
        get: { operationId: "getCapabilities", responses: { "200": response("Capabilities", ref("Capabilities")) } },
      },
      "/api/v1/hosts": {
        get: { operationId: "listHosts", responses: { "200": response("Current host inventory") } },
      },
      "/api/v1/host": {
        get: { operationId: "getHost", responses: { "200": response("Host summary") } },
        patch: {
          operationId: "renameHost",
          parameters: [idempotency],
          requestBody: {
            required: true,
            content: json({
              type: "object",
              required: ["label"],
              additionalProperties: false,
              properties: { label: { type: "string", minLength: 1, maxLength: 80 } },
            }),
          },
          responses: { "200": response("Renamed host"), ...errors },
        },
      },
      "/api/v1/search": {
        get: {
          operationId: "searchMetadata",
          parameters: [
            { name: "q", in: "query", required: true, schema: { type: "string", minLength: 1, maxLength: 100 } },
            { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 100, default: 50 } },
          ],
          responses: { "200": response("Ranked host, workspace, Session, and agent metadata"), ...errors },
        },
      },
      "/api/v1/workspaces": {
        get: { operationId: "listWorkspaces", responses: { "200": response("Workspace inventory") } },
        post: {
          operationId: "createWorkspace",
          parameters: [idempotency],
          requestBody: { required: true, content: json(ref("WorkspaceCreate")) },
          responses: { "201": response("Created workspace"), ...errors },
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
              additionalProperties: false,
              properties: {
                label: { type: "string", minLength: 1, maxLength: 80 },
                sortOrder: { type: "integer", minimum: 0 },
                archived: { type: "boolean" },
              },
            }),
          },
          responses: { "200": response("Updated workspace"), "404": response("Not found", ref("Error")), ...errors },
        },
      },
      "/api/v1/worktrees": {
        post: {
          operationId: "createWorktree",
          parameters: [idempotency],
          requestBody: { required: true, content: json(ref("WorktreeCreate")) },
          responses: { "200": response("Recovered worktree"), "201": response("Created worktree"), ...errors },
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
              properties: {
                cwd: { type: "string" },
                label: { type: "string", maxLength: 80 },
                projectId: { type: "string" },
              },
            }),
          },
          responses: { "200": response("Opened worktree"), ...errors },
        },
      },
      "/api/v1/workspaces/{id}/worktree": {
        get: {
          operationId: "getWorktreeStatus",
          parameters: [idParameter("id")],
          responses: { "200": response("Worktree status"), ...errors },
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
              properties: {
                confirm: { const: true },
                force: { type: "boolean", default: false },
                stopSessions: { type: "boolean", default: false },
              },
            }),
          },
          responses: { "200": response("Removed worktree"), ...errors },
        },
      },
      "/api/v1/sessions": {
        get: { operationId: "listSessions", responses: { "200": response("Session inventory") } },
        post: {
          operationId: "startSession",
          parameters: [idempotency],
          requestBody: { required: true, content: json(ref("SessionCreate")) },
          responses: {
            "201": response("Started terminal Session"),
            "429": response("Capacity reached", ref("Error")),
            ...errors,
          },
        },
      },
      "/api/v1/sessions/{id}": {
        get: {
          operationId: "getSession",
          parameters: [idParameter("id")],
          responses: { "200": response("Session"), "404": response("Not found", ref("Error")) },
        },
        patch: {
          operationId: "renameSession",
          parameters: [idParameter("id"), idempotency],
          responses: { "204": response("Renamed Session"), ...errors },
        },
        delete: {
          operationId: "deleteSession",
          parameters: [idParameter("id"), idempotency],
          responses: { "204": response("Deleted Session"), ...errors },
        },
      },
      "/api/v1/sessions/{id}/agent-state": {
        post: {
          operationId: "reportAgentState",
          parameters: [idParameter("id"), idempotency],
          responses: { "202": response("Accepted state signal"), ...errors },
        },
      },
      "/api/v1/sessions/{id}/input-lease": {
        get: {
          operationId: "getInputLease",
          parameters: [idParameter("id")],
          responses: { "200": response("Public input ownership", ref("InputLeaseGrant")), ...errors },
        },
        post: {
          operationId: "changeInputLease",
          parameters: [idParameter("id"), idempotency],
          requestBody: { required: true, content: json(ref("InputLeaseRequest")) },
          responses: { "200": response("Released or revoked input"), "201": response("Acquired input"), ...errors },
        },
      },
      "/api/v1/sessions/{id}/input": {
        post: {
          operationId: "sendSessionInput",
          parameters: [idParameter("id"), idempotency],
          requestBody: {
            required: true,
            content: json({
              type: "object",
              required: ["data"],
              additionalProperties: false,
              properties: {
                data: { type: "string" },
                appendNewline: { type: "boolean" },
                clientId: { type: "string" },
                leaseId: { type: "string" },
              },
            }),
          },
          responses: { "202": response("Accepted input"), ...errors },
        },
      },
      "/api/v1/agents": {
        get: { operationId: "listAgents", responses: { "200": response("Agent inventory") } },
      },
      "/api/v1/agents/{id}": {
        get: {
          operationId: "getAgent",
          parameters: [idParameter("id")],
          responses: { "200": response("Agent"), ...errors },
        },
      },
      "/api/v1/agents/{id}/wait": {
        get: {
          operationId: "waitForAgent",
          parameters: [
            idParameter("id"),
            { name: "after", in: "query", schema: { type: "integer", minimum: 0, default: 0 } },
            { name: "timeoutMs", in: "query", schema: { type: "integer", minimum: 0, maximum: 30_000 } },
          ],
          responses: { "200": response("Agent change or timeout"), ...errors },
        },
      },
      "/api/v1/agents/{id}/focus": {
        post: {
          operationId: "focusAgent",
          parameters: [idParameter("id"), idempotency],
          responses: { "202": response("Focus requested without stealing it by default"), ...errors },
        },
      },
      "/api/v1/layout": {
        get: { operationId: "getLayout", responses: { "200": response("Shared layout") } },
        put: {
          operationId: "putLayout",
          parameters: [idempotency],
          responses: { "200": response("Saved layout"), ...errors },
        },
      },
      "/api/v1/events": {
        get: {
          operationId: "listEvents",
          parameters: [
            { name: "after", in: "query", schema: { type: "integer", minimum: 0, default: 0 } },
            { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 1000, default: 500 } },
          ],
          responses: { "200": response("Resumable command events"), ...errors },
        },
      },
      "/api/v1/events/stream": {
        get: {
          operationId: "streamEvents",
          parameters: [{ name: "after", in: "query", schema: { type: "integer", minimum: 0 } }],
          responses: {
            "200": { description: "Server-sent event stream", content: { "text/event-stream": {} } },
            ...errors,
          },
        },
      },
      "/api/v1/devices": {
        get: { operationId: "listDevices", responses: { "200": response("Paired devices") } },
      },
      "/api/v1/devices/{id}": {
        patch: {
          operationId: "renameDevice",
          parameters: [idParameter("id"), idempotency],
          responses: { "200": response("Renamed device"), ...errors },
        },
        delete: {
          operationId: "revokeDevice",
          parameters: [idParameter("id"), idempotency],
          responses: { "204": response("Revoked device"), ...errors },
        },
      },
      "/api/v1/presence": {
        get: { operationId: "listPresence", responses: { "200": response("Ephemeral presence") } },
        post: {
          operationId: "heartbeatPresence",
          parameters: [idempotency],
          responses: { "200": response("Presence heartbeat"), ...errors },
        },
        delete: {
          operationId: "releasePresence",
          parameters: [idempotency],
          responses: { "204": response("Released presence"), ...errors },
        },
      },
      "/api/v1/presence/stream": {
        get: {
          operationId: "streamPresence",
          responses: {
            "200": { description: "Server-sent presence stream", content: { "text/event-stream": {} } },
            ...errors,
          },
        },
      },
      "/api/v1/adapters": {
        get: {
          operationId: "listAdapters",
          responses: {
            "200": response("Built-in runtime adapters", {
              type: "object",
              required: ["adapters"],
              additionalProperties: false,
              properties: { adapters: { type: "array", items: ref("AdapterDescriptor") } },
            }),
          },
        },
      },
      "/api/v1/openapi.json": {
        get: { operationId: "getOpenApi", responses: { "200": response("This OpenAPI document") } },
      },
      "/api/v2/context": {
        get: {
          operationId: "getPersonalContextV2",
          responses: {
            "200": response("Current personal context", {
              type: "object",
              required: ["context"],
              additionalProperties: false,
              properties: { context: ref("ProductContext") },
            }),
            ...errors,
          },
        },
      },
      "/api/v2/nodes": {
        get: {
          operationId: "listNodesV2",
          responses: {
            "200": response("Current Node", {
              type: "object",
              required: ["nodes"],
              additionalProperties: false,
              properties: { nodes: { type: "array", items: ref("Node") } },
            }),
            ...errors,
          },
        },
      },
      "/api/v2/nodes/{nodeId}": {
        get: {
          operationId: "getNodeV2",
          parameters: [idParameter("nodeId")],
          responses: { "200": response("Node"), "404": response("Not found", ref("Error")), ...errors },
        },
      },
      "/api/v2/nodes/{nodeId}/runtimes": {
        get: {
          operationId: "listAgentRuntimesV2",
          parameters: [idParameter("nodeId")],
          responses: {
            "200": response("Built-in agent runtimes"),
            "404": response("Not found", ref("Error")),
            ...errors,
          },
        },
      },
      "/api/v2/nodes/{nodeId}/sessions": {
        get: {
          operationId: "listNodeSessionsV2",
          parameters: [idParameter("nodeId")],
          responses: { "200": response("Node Sessions"), ...errors },
        },
        post: {
          operationId: "startNodeSessionV2",
          parameters: [idParameter("nodeId"), idempotency],
          requestBody: { required: true, content: json(ref("V2SessionCreate")) },
          responses: {
            "201": response("Started terminal Session", {
              type: "object",
              required: ["session"],
              additionalProperties: false,
              properties: { session: ref("V2Session") },
            }),
            "404": response("Not found", ref("Error")),
            "429": response("Capacity reached", ref("Error")),
            ...errors,
          },
        },
      },
      "/api/v2/automations": {
        get: { operationId: "listAutomationsV2", responses: { "200": response("Personal Automations") } },
        post: {
          operationId: "createAutomationV2",
          parameters: [idempotency],
          requestBody: { required: true, content: json(ref("SessionAutomationCreate")) },
          responses: {
            "201": response("Created Automation", {
              type: "object",
              required: ["automation", "webhookSecrets"],
              additionalProperties: false,
              properties: {
                automation: ref("SessionAutomationDefinition"),
                webhookSecrets: { type: "array", items: ref("SessionAutomationWebhookSecret") },
              },
            }),
            ...errors,
          },
        },
      },
      "/api/v2/automations/{automationId}": {
        get: {
          operationId: "getAutomationV2",
          parameters: automationParameters,
          responses: { "200": response("Automation"), "404": response("Not found", ref("Error")), ...errors },
        },
        patch: {
          operationId: "updateAutomationV2",
          parameters: [...automationParameters, idempotency],
          requestBody: { required: true, content: json(ref("SessionAutomationPatch")) },
          responses: { "200": response("Updated Automation"), ...errors },
        },
        delete: {
          operationId: "deleteAutomationV2",
          parameters: [...automationParameters, idempotency],
          responses: { "204": response("Deleted Automation"), ...errors },
        },
      },
      "/api/v2/automations/{automationId}/activity": {
        get: {
          operationId: "listAutomationActivityV2",
          parameters: automationParameters,
          responses: { "200": response("Automation activity") },
        },
      },
      "/api/v2/automations/{automationId}/triggers/{triggerId}/secret": {
        post: {
          operationId: "rotateAutomationWebhookSecretV2",
          parameters: [idParameter("automationId"), idParameter("triggerId"), idempotency],
          responses: { "200": response("Rotated webhook secret"), ...errors },
        },
      },
      "/api/v2/automations/{automationId}/runs": {
        get: {
          operationId: "listAutomationRunsV2",
          parameters: automationParameters,
          responses: { "200": response("Automation runs") },
        },
        post: {
          operationId: "runAutomationV2",
          parameters: [...automationParameters, idempotency],
          responses: {
            "201": response("Started Automation Session", {
              type: "object",
              required: ["run", "session"],
              additionalProperties: false,
              properties: { run: ref("SessionAutomationRun"), session: ref("V2Session") },
            }),
            "502": response("Session bootstrap failed", {
              type: "object",
              required: ["code", "error", "run"],
              properties: {
                code: { type: "string" },
                error: { type: "string" },
                run: ref("SessionAutomationRun"),
                session: ref("V2Session"),
              },
            }),
            ...errors,
          },
        },
      },
      "/api/v2/automation-hooks/{hookId}": {
        post: {
          operationId: "invokeAutomationWebhookV2",
          security: [{ bearerAuth: [] }],
          parameters: [idParameter("hookId")],
          responses: {
            "202": response("Signal accepted"),
            "401": response("Invalid webhook secret", ref("Error")),
            "429": response("Rate limited", ref("Error")),
          },
        },
      },
    },
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer", description: "Host, paired-device, or webhook credential" },
      },
      schemas: {
        Error: {
          type: "object",
          required: ["error"],
          properties: { code: { type: "string" }, error: { type: "string" } },
        },
        Capabilities: {
          type: "object",
          required: ["apiVersion", "protocolVersion", "serverVersion", "serverTime", "host", "features", "providers"],
          additionalProperties: false,
          properties: {
            apiVersion: { const: "v1" },
            protocolVersion: { const: 1 },
            serverVersion: { type: "string" },
            serverTime: { type: "integer", minimum: 0 },
            host: { type: "object" },
            features: {
              type: "object",
              required: [
                "workspaces",
                "agents",
                "resumableEvents",
                "sharedLayout",
                "idempotentMutations",
                "devicePairing",
                "inputLeases",
                "multiObserver",
                "presence",
              ],
              additionalProperties: false,
              properties: Object.fromEntries(
                [
                  "workspaces",
                  "agents",
                  "resumableEvents",
                  "sharedLayout",
                  "idempotentMutations",
                  "devicePairing",
                  "inputLeases",
                  "multiObserver",
                  "presence",
                ].map((name) => [name, { type: "boolean" }]),
              ),
            },
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
          additionalProperties: false,
          oneOf: [{ required: ["projectId", "branch"] }, { required: ["repositoryPath", "path"] }],
          properties: {
            projectId: { type: "string" },
            branch: { type: "string" },
            baseRef: { type: "string" },
            label: { type: "string", maxLength: 80 },
            repositoryPath: { type: "string" },
            path: { type: "string" },
          },
        },
        SessionCreate: {
          type: "object",
          required: ["cwd"],
          additionalProperties: false,
          properties: { cwd: { type: "string" }, mode: { const: "terminal" } },
        },
        V2SessionCreate: {
          type: "object",
          required: ["cwd"],
          additionalProperties: false,
          properties: { cwd: { type: "string" } },
        },
        InputLeaseRequest: {
          type: "object",
          required: ["action"],
          additionalProperties: false,
          properties: {
            action: { enum: ["acquire", "takeover", "renew", "release", "revoke"] },
            clientId: { type: "string" },
            leaseId: { type: "string" },
            confirm: { type: "boolean" },
          },
        },
        InputLeaseGrant: {
          type: "object",
          properties: {
            leaseId: { type: "string", writeOnly: true },
            lease: { type: ["object", "null"] },
            revoked: { type: "boolean" },
          },
        },
        ProductContext: {
          type: "object",
          required: ["kind", "id", "name"],
          additionalProperties: false,
          properties: { kind: { const: "personal" }, id: { type: "string" }, name: { type: "string" } },
        },
        Node: {
          type: "object",
          required: ["id", "owner", "name", "status", "platform", "lastSeenAt"],
          additionalProperties: false,
          properties: {
            id: { type: "string" },
            owner: {
              type: "object",
              required: ["type", "id"],
              additionalProperties: false,
              properties: { type: { const: "person" }, id: { type: "string" } },
            },
            name: { type: "string" },
            status: { enum: ["online", "offline", "degraded"] },
            platform: { type: "string" },
            lastSeenAt: { type: "integer", minimum: 0 },
          },
        },
        AgentRuntime: {
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
            id: { type: "string" },
            nodeId: { type: "string" },
            provider: { type: "string" },
            displayName: { type: "string" },
            availability: { enum: ["available", "unavailable"] },
            authState: { enum: ["ready", "required", "unknown", "error"] },
            version: { type: "string" },
            capabilities: { type: "array", items: { type: "string" } },
            activeSessionCount: { type: "integer", minimum: 0 },
            observedAt: { type: "integer", minimum: 0 },
          },
        },
        TerminalLaunch: {
          oneOf: [
            {
              type: "object",
              required: ["kind"],
              additionalProperties: false,
              properties: { kind: { const: "shell" } },
            },
            {
              type: "object",
              required: ["kind", "owner", "provider"],
              additionalProperties: false,
              properties: {
                kind: { const: "managed" },
                owner: { enum: ["automation", "legacy"] },
                provider: { type: "string" },
              },
            },
          ],
        },
        TerminalAgent: { type: "object" },
        V2Session: {
          type: "object",
          required: [
            "id",
            "nodeId",
            "launch",
            "cwd",
            "mode",
            "status",
            "dangerouslySkip",
            "createdAt",
            "lastActivityAt",
          ],
          additionalProperties: false,
          properties: {
            id: { type: "string" },
            nodeId: { type: "string" },
            agentRuntimeId: { type: "string" },
            launch: ref("TerminalLaunch"),
            agent: ref("TerminalAgent"),
            provider: { type: "string" },
            cwd: { type: "string" },
            workspaceId: { type: "string" },
            name: { type: "string" },
            mode: { const: "terminal" },
            status: { enum: ["running", "ended"] },
            activity: { enum: ["working", "blocked", "idle"] },
            awaiting: { type: "boolean" },
            dangerouslySkip: { type: "boolean" },
            model: { type: "string" },
            effort: { type: "string" },
            permissionMode: { type: "string" },
            sandbox: { type: "string" },
            approvalPolicy: { type: "string" },
            identityState: { type: "string" },
            resumeIdentity: { enum: ["optional", "required", "unsupported"] },
            providerSessionId: { type: "string" },
            createdAt: { type: "integer" },
            lastActivityAt: { type: "integer" },
            automation: { type: "object" },
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
                id: { type: "string" },
                type: { const: "schedule" },
                enabled: { type: "boolean" },
                cron: { type: "string" },
                timeZone: { type: "string" },
                missedRunPolicy: { const: "skip" },
              },
            },
            {
              type: "object",
              required: ["id", "type", "enabled", "hookId"],
              additionalProperties: false,
              properties: {
                id: { type: "string" },
                type: { const: "webhook" },
                enabled: { type: "boolean" },
                hookId: { type: "string" },
              },
            },
          ],
        },
        SessionAutomationWebhookSecret: {
          type: "object",
          required: ["triggerId", "hookId", "secret", "path"],
          additionalProperties: false,
          properties: {
            triggerId: { type: "string" },
            hookId: { type: "string" },
            secret: { type: "string", writeOnly: true },
            path: { type: "string" },
          },
        },
        SessionAutomationActivity: {
          type: "object",
          required: ["id", "automationId", "triggerId", "source", "status", "invocationId", "createdAt", "updatedAt"],
          additionalProperties: false,
          properties: {
            id: { type: "string" },
            automationId: { type: "string" },
            triggerId: { type: "string" },
            source: { enum: ["schedule", "webhook"] },
            status: { enum: ["queued", "started", "failed", "missed", "expired"] },
            invocationId: { type: "string" },
            scheduledFor: { type: "integer" },
            missedCount: { type: "integer" },
            runId: { type: "string" },
            failureCode: { type: "string" },
            createdAt: { type: "integer" },
            updatedAt: { type: "integer" },
          },
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
            "instruction",
            "runtimeOptions",
            "trigger",
            "triggers",
            "revision",
            "createdAt",
            "updatedAt",
          ],
          additionalProperties: false,
          properties: {
            id: { type: "string" },
            owner: {
              type: "object",
              required: ["type", "id"],
              additionalProperties: false,
              properties: { type: { const: "person" }, id: { type: "string" } },
            },
            ...automationProperties,
            provider: { type: "string" },
            revision: { type: "integer", minimum: 1 },
            createdAt: { type: "integer" },
            updatedAt: { type: "integer" },
          },
        },
        SessionAutomationCreate: {
          type: "object",
          required: ["name", "nodeId", "agentRuntimeId", "cwd", "instruction"],
          additionalProperties: false,
          properties: automationProperties,
        },
        SessionAutomationPatch: {
          type: "object",
          required: ["expectedRevision"],
          additionalProperties: false,
          properties: { ...automationProperties, expectedRevision: { type: "integer", minimum: 1 } },
        },
        SessionAutomationRun: {
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
            id: { type: "string" },
            automationId: { type: "string" },
            definitionRevision: { type: "integer", minimum: 1 },
            invocationId: { type: "string" },
            sessionId: { type: "string" },
            nodeId: { type: "string" },
            agentRuntimeId: { type: "string" },
            cwd: { type: "string" },
            status: { enum: ["starting", "running", "needs-input", "ready", "failed", "cancelled"] },
            failureCode: { type: "string" },
            createdAt: { type: "integer" },
            updatedAt: { type: "integer" },
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
      },
    },
    "x-roamcode-adapters": options.adapters,
  };
}
