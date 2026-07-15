import type { AttachSpawnOptions } from "../config.js";
import type { AdapterManifestV1 } from "./adapter-contract.js";

/** Public adapter identity. Built-ins are ordinary ids under the same contract; third parties are not
 * forced through a source-code union update. Runtime validation is owned by ProviderRegistry. */
export type ProviderId = string;

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
  effort?: string;
  permissionMode?: "default" | "acceptEdits" | "plan" | "bypassPermissions";
  dangerouslySkip?: boolean;
  addDirs?: string[];
  legacyArgs?: string[];
};

export type CodexSessionOptions = {
  provider: "codex";
  model?: string;
  reasoningEffort?: string;
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  approvalPolicy?: "untrusted" | "on-request" | "never";
  profile?: string;
  webSearch?: boolean;
  dangerouslyBypassApprovalsAndSandbox?: boolean;
  addDirs?: string[];
};

export interface ProviderSessionOptions {
  provider: ProviderId;
  model?: string;
  effort?: string;
  reasoningEffort?: string;
  permissionMode?: ClaudeSessionOptions["permissionMode"];
  dangerouslySkip?: boolean;
  sandbox?: CodexSessionOptions["sandbox"];
  approvalPolicy?: CodexSessionOptions["approvalPolicy"];
  profile?: string;
  webSearch?: boolean;
  dangerouslyBypassApprovalsAndSandbox?: boolean;
  addDirs?: string[];
  legacyArgs?: string[];
  [key: string]: unknown;
}
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

export interface ProviderRuntimeMetadata {
  model?: string;
  effort?: string;
}

export interface AgentProvider {
  /** Exact public, versioned adapter contract. Optional only for legacy in-process test doubles. */
  readonly manifest?: Readonly<AdapterManifestV1>;
  readonly id: ProviderId;
  readonly displayName: string;
  readonly resumeIdentity: "optional" | "required" | "unsupported";
  probe(): Promise<ProviderAvailability>;
  buildProcess(context: ProviderProcessContext): Promise<ProcessSpec>;
  /** Stateful parsers must be created per spawned process; providers are registry singletons. */
  createRuntimeSignalParser?(): ProviderRuntimeSignalParser;
  runtimeSignals(chunk: string): ProviderRuntimeSignal[];
  classifyPane(pane: string): "working" | "blocked" | "idle";
  /** Read provider-owned live model/effort chrome from a captured pane. Optional because not every TUI
   * exposes these values. A missing/invalid result must leave launch metadata untouched. */
  runtimeMetadata?(pane: string): ProviderRuntimeMetadata | undefined;
  cleanup(paths: readonly string[]): void;
}

/** Installable and built-in adapters must implement this strict public shape. */
export interface ProviderAdapterV1 extends AgentProvider {
  readonly manifest: Readonly<AdapterManifestV1>;
}
