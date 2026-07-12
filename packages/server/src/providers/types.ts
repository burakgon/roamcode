import type { AttachSpawnOptions } from "../config.js";

export type ProviderId = "claude" | "codex";

export interface ProviderAvailability {
  terminalAvailable: boolean;
  metadataAvailable: boolean;
  version?: string;
  detail?: string;
}

export class ProviderError extends Error {
  constructor(
    readonly code:
      "PROVIDER_UNAVAILABLE" | "INVALID_PROVIDER_OPTIONS" | "RESUME_IDENTITY_UNAVAILABLE" | "OSS_PROVIDER_DEFERRED",
    message: string,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export type ClaudeSessionOptions = {
  provider: "claude";
  model?: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  permissionMode?: "default" | "acceptEdits" | "plan" | "bypassPermissions";
  dangerouslySkip?: boolean;
  addDirs?: string[];
  legacyArgs?: string[];
};

export type CodexSessionOptions = {
  provider: "codex";
  model?: string;
  reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh";
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  approvalPolicy?: "untrusted" | "on-request" | "never";
  profile?: string;
  webSearch?: boolean;
  dangerouslyBypassApprovalsAndSandbox?: boolean;
  addDirs?: string[];
};

export type ProviderSessionOptions = ClaudeSessionOptions | CodexSessionOptions;
export type LaunchIntent = "fresh" | "resume";

export interface ProcessSpec {
  executable: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cleanupPaths: string[];
  /** Revalidates ephemeral launch proof immediately before the terminal process is spawned. */
  preSpawnCheck?: () => void | Promise<void>;
  integration?: {
    attachments: "ready" | "degraded";
    activity: "ready" | "degraded";
    detail?: string;
  };
}

export interface CodexProfileLaunchProof {
  readonly profile: string;
  readonly codexHome: string;
  readonly assertUnchanged: () => Promise<void>;
}

export interface ProviderProcessContext {
  roamSessionId: string;
  cwd: string;
  intent: LaunchIntent;
  options: ProviderSessionOptions;
  providerSessionId?: string;
  /** Late-bound after listen so both providers share the real loopback MCP callback configuration. */
  attach?: AttachSpawnOptions;
  /** Transfer temporary-artifact ownership as soon as paths exist, so a later build rejection is cleanable. */
  registerCleanupPaths?(paths: readonly string[]): void;
}

export type ProviderRuntimeSignal =
  { type: "working" } | { type: "blocked" } | { type: "idle" } | { type: "provider-session-id"; id: string };

export interface ProviderRuntimeSignalParser {
  push(chunk: string): ProviderRuntimeSignal[];
}

export interface AgentProvider {
  readonly id: ProviderId;
  readonly displayName: string;
  readonly resumeIdentity: "optional" | "required";
  probe(): Promise<ProviderAvailability>;
  buildProcess(context: ProviderProcessContext): Promise<ProcessSpec>;
  /** Stateful parsers must be created per spawned process; providers are registry singletons. */
  createRuntimeSignalParser?(): ProviderRuntimeSignalParser;
  runtimeSignals(chunk: string): ProviderRuntimeSignal[];
  classifyPane(pane: string): "working" | "blocked" | "idle";
  cleanup(paths: readonly string[]): void;
}
