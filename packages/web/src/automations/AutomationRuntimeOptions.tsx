import { ClaudeSessionOptions, type ClaudeOptionDraft } from "../providers/ClaudeSessionOptions";
import { CodexSessionOptions, type CodexOptionDraft } from "../providers/CodexSessionOptions";
import { DynamicAdapterOptions } from "../providers/DynamicAdapterOptions";
import type { CodexModel, ProviderDescriptor } from "../providers/types";
import type { ModelInfo } from "../types/server";

export interface AutomationRuntimeOptionsProps {
  provider: string;
  displayName: string;
  value: Record<string, unknown>;
  onChange: (value: Record<string, unknown>) => void;
  providerCatalog?: ProviderDescriptor[];
  claudeModels?: ModelInfo[];
  codexModels?: CodexModel[];
  codexProfiles?: string[];
  claudeMetadataState?: "loading" | "ready" | "unavailable";
  codexMetadataState?: "loading" | "ready" | "unavailable";
  disabled?: boolean;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function replaceManagedOptions(
  current: Record<string, unknown>,
  managedKeys: ReadonlySet<string>,
  next: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...Object.fromEntries(Object.entries(current).filter(([key]) => !managedKeys.has(key))),
    ...next,
  };
}

const CLAUDE_OPTION_KEYS = new Set(["effort", "model", "permissionMode", "addDirs", "dangerouslySkip"]);
const CODEX_OPTION_KEYS = new Set([
  "model",
  "reasoningEffort",
  "sandbox",
  "approvalPolicy",
  "profile",
  "webSearch",
  "addDirs",
  "dangerouslyBypassApprovalsAndSandbox",
]);

function claudeDraft(value: Record<string, unknown>): ClaudeOptionDraft {
  return {
    effort: typeof value.effort === "string" ? value.effort : "medium",
    model: typeof value.model === "string" ? value.model : "",
    permissionMode: typeof value.permissionMode === "string" ? value.permissionMode : "default",
    addDirs: strings(value.addDirs),
    dangerouslySkip: value.dangerouslySkip === true,
  };
}

function claudeOptions(value: ClaudeOptionDraft): Record<string, unknown> {
  const common = {
    ...(value.effort ? { effort: value.effort } : {}),
    ...(value.model ? { model: value.model } : {}),
    ...(value.addDirs.length > 0 ? { addDirs: value.addDirs } : {}),
  };
  return value.dangerouslySkip
    ? { ...common, dangerouslySkip: true }
    : { ...common, ...(value.permissionMode !== "default" ? { permissionMode: value.permissionMode } : {}) };
}

function codexDraft(value: Record<string, unknown>): CodexOptionDraft {
  return {
    model: typeof value.model === "string" ? value.model : "",
    reasoningEffort: typeof value.reasoningEffort === "string" ? value.reasoningEffort : "medium",
    sandbox: typeof value.sandbox === "string" ? value.sandbox : "workspace-write",
    approvalPolicy: typeof value.approvalPolicy === "string" ? value.approvalPolicy : "on-request",
    profile: typeof value.profile === "string" ? value.profile : "",
    webSearch: value.webSearch === true,
    addDirs: strings(value.addDirs),
    dangerouslyBypassApprovalsAndSandbox: value.dangerouslyBypassApprovalsAndSandbox === true,
  };
}

function codexOptions(value: CodexOptionDraft): Record<string, unknown> {
  const common = {
    ...(value.model ? { model: value.model } : {}),
    ...(value.reasoningEffort ? { reasoningEffort: value.reasoningEffort } : {}),
    ...(value.profile ? { profile: value.profile } : {}),
    ...(value.webSearch ? { webSearch: true } : {}),
    ...(value.addDirs.length > 0 ? { addDirs: value.addDirs } : {}),
  };
  return value.dangerouslyBypassApprovalsAndSandbox
    ? { ...common, dangerouslyBypassApprovalsAndSandbox: true }
    : { ...common, sandbox: value.sandbox, approvalPolicy: value.approvalPolicy };
}

export function AutomationRuntimeOptions({
  provider,
  displayName,
  value,
  onChange,
  providerCatalog = [],
  claudeModels = [],
  codexModels = [],
  codexProfiles = [],
  claudeMetadataState = "unavailable",
  codexMetadataState = "unavailable",
  disabled,
}: AutomationRuntimeOptionsProps) {
  if (provider === "claude") {
    return (
      <fieldset className="rc-automation-runtime-options" disabled={disabled}>
        <legend>Claude Code runtime</legend>
        <ClaudeSessionOptions
          value={claudeDraft(value)}
          onChange={(next) => onChange(replaceManagedOptions(value, CLAUDE_OPTION_KEYS, claudeOptions(next)))}
          models={claudeModels}
          metadataState={claudeMetadataState}
          normalizeInitialCatalog={false}
        />
      </fieldset>
    );
  }
  if (provider === "codex") {
    return (
      <fieldset className="rc-automation-runtime-options" disabled={disabled}>
        <legend>Codex runtime</legend>
        <CodexSessionOptions
          value={codexDraft(value)}
          onChange={(next) => onChange(replaceManagedOptions(value, CODEX_OPTION_KEYS, codexOptions(next)))}
          models={codexModels}
          profiles={codexProfiles}
          metadataState={codexMetadataState}
          normalizeInitialCatalog={false}
        />
      </fieldset>
    );
  }
  const descriptor = providerCatalog.find((candidate) => candidate.id === provider);
  return (
    <fieldset className="rc-automation-runtime-options" disabled={disabled}>
      <legend>{displayName} runtime</legend>
      <DynamicAdapterOptions
        displayName={displayName}
        schema={descriptor?.optionSchema}
        value={value}
        disabled={disabled}
        onChange={onChange}
      />
    </fieldset>
  );
}
