import type { CodexIdentityState } from "../../providers/types";

export interface ProductContext {
  kind: "personal";
  id: string;
  name: string;
}

export interface NodeRecord {
  id: string;
  owner: { type: "person"; id: string };
  name: string;
  status: "online" | "offline" | "degraded";
  platform: string;
  lastSeenAt: number;
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
  cwd: string;
}

export interface V2Session {
  id: string;
  nodeId: string;
  agentRuntimeId?: string;
  launch: { kind: "shell" } | { kind: "managed"; provider: string };
  agent?: {
    provider: string;
    source: "managed" | "process" | "integration";
    activity: "working" | "blocked" | "idle";
    model?: string;
    effort?: string;
    identityState?: CodexIdentityState;
    providerSessionId?: string;
  };
  /** Compatibility projection supplied only while an agent is active. */
  provider?: string;
  cwd: string;
  /** Optional command-center placement used by the project/worktree rail. */
  workspaceId?: string;
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
}

export interface NodeSessionResponse {
  session: V2Session;
}
