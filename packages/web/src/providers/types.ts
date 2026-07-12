export type ProviderId = "claude" | "codex";

export interface ProviderSummary {
  terminalAvailable: boolean;
  metadataAvailable: boolean;
  version?: string;
  detail?: string;
}

export type ProviderSummaries = Partial<Record<ProviderId, ProviderSummary>>;

type ClaudeSessionOptionValues = {
  model?: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
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
  reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh";
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

export type CreateSessionBody =
  | (CreateSessionBase & { provider: "claude"; options: ClaudeSessionOptions })
  | (CreateSessionBase & { provider: "codex"; options: CodexSessionOptions });

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
