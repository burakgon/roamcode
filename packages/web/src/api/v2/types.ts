import type { ProviderWarning } from "../../providers/types";
import type { CodexIdentityState } from "../../providers/types";
import type { SessionDefaultsEnvelope } from "../../types/server";

export interface ProductContext {
  kind: "personal" | "organization";
  id: string;
  name: string;
}

export interface NodeAlias {
  kind: "command-host" | "cloud-host" | "peer-host" | "direct-host" | "relay-route";
  id: string;
}

export interface NodeRecord {
  id: string;
  owner: { type: "person" | "organization"; id: string };
  name: string;
  status: "online" | "offline" | "degraded";
  platform: string;
  lastSeenAt: number;
  aliases: NodeAlias[];
}

export type AgentRuntimeAuthState = "ready" | "required" | "unknown" | "error";

export interface AgentRuntimeRecord {
  id: string;
  nodeId: string;
  provider: string;
  displayName: string;
  availability: "available" | "unavailable";
  authState: AgentRuntimeAuthState;
  version?: string;
  capabilities: string[];
  activeSessionCount: number;
  observedAt: number;
}

export interface CreateNodeSessionInput {
  agentRuntimeId: string;
  cwd: string;
  runtimeOptions?: Record<string, unknown>;
}

export interface V2Session {
  id: string;
  nodeId: string;
  agentRuntimeId: string;
  provider: string;
  cwd: string;
  name?: string;
  mode: "terminal";
  status: "running" | "ended";
  activity?: "working" | "blocked" | "idle";
  awaiting?: boolean;
  dangerouslySkip: boolean;
  model?: string;
  effort?: string;
  permissionMode?: "default" | "acceptEdits" | "plan" | "bypassPermissions";
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  approvalPolicy?: "untrusted" | "on-request" | "never";
  identityState?: CodexIdentityState;
  resumeIdentity?: "optional" | "required" | "unsupported";
  providerSessionId?: string;
  createdAt: number;
  lastActivityAt: number;
  automation?: { id: string; runId: string; status: SessionAutomationRunStatus };
}

export interface NodeSessionResponse {
  session: V2Session;
  rememberedSessionOptions?: SessionDefaultsEnvelope;
  warnings?: ProviderWarning[];
}

export type SessionAutomationRunStatus = "starting" | "running" | "needs-input" | "ready" | "failed" | "cancelled";

export interface SessionAutomationDefinition {
  id: string;
  owner: { type: "person" | "organization"; id: string };
  name: string;
  enabled: boolean;
  nodeId: string;
  agentRuntimeId: string;
  provider: string;
  cwd: string;
  instruction: string;
  runtimeOptions: Record<string, unknown>;
  trigger: { type: "manual" };
  revision: number;
  createdAt: number;
  updatedAt: number;
}

export interface CreateSessionAutomationInput {
  name: string;
  enabled?: boolean;
  nodeId: string;
  agentRuntimeId: string;
  cwd: string;
  instruction: string;
  runtimeOptions?: Record<string, unknown>;
  trigger?: { type: "manual" };
}

export interface UpdateSessionAutomationInput {
  expectedRevision: number;
  name?: string;
  enabled?: boolean;
  nodeId?: string;
  agentRuntimeId?: string;
  cwd?: string;
  instruction?: string;
  runtimeOptions?: Record<string, unknown>;
  trigger?: { type: "manual" };
}

export interface SessionAutomationRun {
  id: string;
  automationId: string;
  definitionRevision: number;
  invocationId: string;
  sessionId: string;
  nodeId: string;
  agentRuntimeId: string;
  cwd: string;
  status: SessionAutomationRunStatus;
  failureCode?: string;
  createdAt: number;
  updatedAt: number;
}

export interface SessionAutomationRunResponse {
  run: SessionAutomationRun;
  session: V2Session;
}

export interface SessionAutomationRunFailureBody {
  code: string;
  error: string;
  run?: SessionAutomationRun;
  session?: V2Session;
}
