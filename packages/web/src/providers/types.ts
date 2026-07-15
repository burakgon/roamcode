/** Public provider ids are manifest-owned; built-ins remain the well-known `claude` and `codex` ids. */
export type ProviderId = string;

export interface ProviderDescriptor {
  id: ProviderId;
  displayName: string;
  version?: string;
  schemaVersion?: number;
  source?: "built-in" | "installed";
  enabled?: boolean;
  platforms?: Array<"darwin" | "linux">;
  resumeIdentity: "optional" | "required" | "unsupported" | string;
  capabilities?: Partial<
    Record<
      "probe" | "launch" | "resume" | "state" | "identity" | "metadata" | "usage" | "login" | "attachments" | "cleanup",
      boolean
    >
  >;
  stateAuthority?: string[];
  optionSchema?: Record<string, unknown>;
}

export interface ProviderSummary {
  terminalAvailable: boolean;
  metadataAvailable: boolean;
  version?: string;
  detail?: string;
}

export type ProviderSummaries = Record<string, ProviderSummary | undefined>;

type ClaudeSessionOptionValues = {
  model?: string;
  effort?: string;
  addDirs?: string[];
};

export type ClaudeSessionOptions = ClaudeSessionOptionValues &
  (
    | { dangerouslySkip: true; permissionMode?: never }
    | {
        dangerouslySkip?: false;
        permissionMode?: "default" | "acceptEdits" | "plan" | "bypassPermissions";
      }
  );

type CodexSessionOptionValues = {
  model?: string;
  reasoningEffort?: string;
  profile?: string;
  webSearch?: boolean;
  addDirs?: string[];
};

export type CodexSessionOptions = CodexSessionOptionValues &
  (
    | {
        dangerouslyBypassApprovalsAndSandbox: true;
        sandbox?: never;
        approvalPolicy?: never;
      }
    | {
        dangerouslyBypassApprovalsAndSandbox?: false;
        sandbox?: "read-only" | "workspace-write" | "danger-full-access";
        approvalPolicy?: "untrusted" | "on-request" | "never";
      }
  );

interface CreateSessionBase {
  cwd: string;
  mode?: "terminal";
}

type GenericProviderSessionOptions = Record<string, unknown> &
  ({ dangerouslySkip: true; permissionMode?: never } | { dangerouslySkip?: false; permissionMode?: unknown }) &
  (
    | { dangerouslyBypassApprovalsAndSandbox: true; sandbox?: never; approvalPolicy?: never }
    | { dangerouslyBypassApprovalsAndSandbox?: false; sandbox?: unknown; approvalPolicy?: unknown }
  );

export type CreateSessionBody =
  | (CreateSessionBase & { provider: "claude"; options: ClaudeSessionOptions })
  | (CreateSessionBase & { provider: "codex"; options: CodexSessionOptions })
  | (CreateSessionBase & { provider: ProviderId; options: GenericProviderSessionOptions });

export interface ProviderWarning {
  code: "PROVIDER_METADATA_UNAVAILABLE";
  message: string;
}

export type CodexIdentityState = "pending" | "exact" | "ambiguous";

export interface CodexModel {
  value: string;
  id: string;
  displayName: string;
  description: string;
  isDefault: boolean;
  reasoningOptions?: Array<{
    value: string;
    description: string;
    isDefault: boolean;
  }>;
  supportedReasoningEfforts: string[];
  defaultReasoningEffort: string;
}

export interface CodexUsageBar {
  id: string;
  label: string;
  percent: number;
  resetsAt?: number;
  windowDurationMs?: number;
}

export interface CodexUsage {
  bars: CodexUsageBar[];
  credits?: {
    hasCredits: boolean;
    unlimited: boolean;
    balance?: string;
    resetCreditsAvailable?: number;
  };
  fetchedAt: number;
}

export interface CodexAuthStatus {
  available: boolean;
  authenticated?: boolean;
  authMethod?: "none" | "apiKey" | "chatgpt";
  plan?: string;
}

export interface ClaudeLoginStart {
  loginId: string;
  url: string;
}

export interface CodexLoginStart {
  loginId: string;
  userCode: string;
  verificationUrl: string;
  expiresAt: number;
}

export interface ClaudeProviderVersion {
  installed: string | null;
  latest: string | null;
}

export type CodexInstallProvenance = "npm" | "chatgpt" | "homebrew" | "unknown";

export interface CodexProviderVersion {
  installed: string;
  provenance: CodexInstallProvenance;
  latest?: string;
  updateAvailable?: boolean;
  updateHint?: string;
}

export type CodexLoginCancellation = { status: "canceled" | "notFound" };
export type CodexLoginStatus = {
  status: "pending" | "completed" | "failed" | "canceled" | "expired" | "notFound";
};
