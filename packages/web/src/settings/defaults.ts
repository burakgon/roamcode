import type { CodexSessionOptions, ProviderId } from "../providers/types";

// Effort/reasoning levels, matching the claude CLI's `--effort` flag. The server pushes `--effort <level>`
// so the spawned session ACTUALLY runs at this level (NOT a thinking-token budget: modern models use adaptive
// reasoning, so effort is the primary control — an earlier effort→MAX_THINKING_TOKENS map was wrong and unused,
// removed). "max" is session-only (valid via --effort, not in settings.json).
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

// Selectable starting/active permission modes. bypassPermissions is intentionally NOT here — it's
// expressed by the separate "Dangerously skip permissions" toggle (an explicit, scarier opt-in).
export const PERMISSION_MODES = ["default", "acceptEdits", "plan"] as const;

export interface SessionDefaults {
  /** Provider used by the most recently created session. Absent on an unset or legacy server document. */
  provider?: ProviderId;
  effort: string;
  model?: string;
  dangerouslySkip: boolean;
  /** Starting permission mode remembered from the last Claude launch. */
  permissionMode?: string;
  addDirs?: string[];
  /** Provider-specific Codex values are retained when a later Claude session is launched. */
  codex?: CodexSessionOptions;
}

const KEY = "roamcode.defaults";
const FALLBACK: SessionDefaults = { effort: "medium", dangerouslySkip: false };
const PROVIDERS = ["claude", "codex"] as const;
const SANDBOXES = ["read-only", "workspace-write", "danger-full-access"] as const;
const APPROVAL_POLICIES = ["untrusted", "on-request", "never"] as const;
const MODEL_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/\u005b\u005d-]*$/;
const EFFORT_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const CLAUDE_MODEL_VALUE = /^[^\x00-\x1f\x7f]+$/;
const PROFILE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const PATH_TOKEN = /^\/[^\x00-\x1f\x7f]*$/;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function token(value: unknown, pattern: RegExp, maxLength = 128): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength && pattern.test(value)
    ? value
    : undefined;
}

function enumValue<const T extends readonly string[]>(value: unknown, values: T): T[number] | undefined {
  return typeof value === "string" && (values as readonly string[]).includes(value) ? (value as T[number]) : undefined;
}

function paths(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) return undefined;
  const normalized = value.filter(
    (item): item is string => typeof item === "string" && item.length <= 4096 && PATH_TOKEN.test(item),
  );
  return normalized.length === value.length ? normalized : undefined;
}

function normalizeCodexDefaults(value: unknown): CodexSessionOptions | undefined {
  const raw = record(value);
  if (!raw) return undefined;
  const dangerous = raw.dangerouslyBypassApprovalsAndSandbox === true;
  const model = token(raw.model, MODEL_TOKEN);
  const reasoningEffort = token(raw.reasoningEffort, EFFORT_TOKEN);
  const sandbox = enumValue(raw.sandbox, SANDBOXES);
  const approvalPolicy = enumValue(raw.approvalPolicy, APPROVAL_POLICIES);
  const profile = token(raw.profile, PROFILE_TOKEN);
  const addDirs = paths(raw.addDirs);
  const common = {
    ...(model ? { model } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(profile ? { profile } : {}),
    ...(typeof raw.webSearch === "boolean" ? { webSearch: raw.webSearch } : {}),
    ...(addDirs ? { addDirs } : {}),
  };
  const normalized: CodexSessionOptions = dangerous
    ? { ...common, dangerouslyBypassApprovalsAndSandbox: true }
    : {
        ...common,
        ...(sandbox ? { sandbox } : {}),
        ...(approvalPolicy ? { approvalPolicy } : {}),
      };
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

export function normalizeSessionDefaults(value: unknown): SessionDefaults {
  const raw = record(value) ?? {};
  // Provider catalogs are additive: retain a bounded future Claude effort just as we do for Codex
  // reasoning, while still falling back for whitespace, control characters, and overlong values.
  const effort = token(raw.effort, EFFORT_TOKEN) ?? FALLBACK.effort;
  const model = token(raw.model, CLAUDE_MODEL_VALUE);
  const provider = enumValue(raw.provider, PROVIDERS);
  const permissionMode = raw.dangerouslySkip === true ? undefined : enumValue(raw.permissionMode, PERMISSION_MODES);
  const addDirs = paths(raw.addDirs);
  const codex = normalizeCodexDefaults(raw.codex);
  return {
    ...(provider ? { provider } : {}),
    effort,
    dangerouslySkip: raw.dangerouslySkip === true,
    ...(model ? { model } : {}),
    ...(permissionMode ? { permissionMode } : {}),
    ...(addDirs ? { addDirs } : {}),
    ...(codex ? { codex } : {}),
  };
}

export function defaultSessionDefaults(): SessionDefaults {
  return { ...FALLBACK };
}

/** Remove the retired browser-owned defaults cache. New-session choices now live only on the server. */
export function clearLegacyDefaultsCache(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // Storage may be unavailable in private/restricted contexts; it is never read again either way.
  }
}
