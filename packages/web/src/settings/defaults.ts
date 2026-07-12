import type { CodexSessionOptions } from "../providers/types";

// Effort/reasoning levels, matching the claude CLI's `--effort` flag. The server pushes `--effort <level>`
// so the spawned session ACTUALLY runs at this level (NOT a thinking-token budget: modern models use adaptive
// reasoning, so effort is the primary control — an earlier effort→MAX_THINKING_TOKENS map was wrong and unused,
// removed). "max" is session-only (valid via --effort, not in settings.json).
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

// Selectable starting/active permission modes. bypassPermissions is intentionally NOT here — it's
// expressed by the separate "Dangerously skip permissions" toggle (an explicit, scarier opt-in).
export const PERMISSION_MODES = ["default", "acceptEdits", "plan"] as const;

export interface SessionDefaults {
  effort: string;
  model?: string;
  dangerouslySkip: boolean;
  /** Default starting permission mode for new sessions (default | acceptEdits | plan). */
  permissionMode?: string;
  /** Provider-specific Codex values are retained without ever retaining a provider selection. */
  codex?: CodexSessionOptions;
}

const KEY = "roamcode.defaults";
const FALLBACK: SessionDefaults = { effort: "medium", dangerouslySkip: false };
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
  const permissionMode = raw.dangerouslySkip === true ? undefined : enumValue(raw.permissionMode, PERMISSION_MODES);
  const codex = normalizeCodexDefaults(raw.codex);
  return {
    effort,
    dangerouslySkip: raw.dangerouslySkip === true,
    ...(model ? { model } : {}),
    ...(permissionMode ? { permissionMode } : {}),
    ...(codex ? { codex } : {}),
  };
}

export function loadDefaults(): SessionDefaults {
  let raw: string | null;
  try {
    raw = localStorage.getItem(KEY);
  } catch {
    return { ...FALLBACK };
  }
  if (!raw) return { ...FALLBACK };

  let normalized: SessionDefaults;
  try {
    normalized = normalizeSessionDefaults(JSON.parse(raw));
  } catch {
    normalized = { ...FALLBACK };
  }

  const serialized = JSON.stringify(normalized);
  if (serialized !== raw) {
    try {
      localStorage.setItem(KEY, serialized);
    } catch {
      // Read-only/quota-limited storage must not discard the already-normalized in-memory value.
    }
  }
  return normalized;
}

export function saveDefaults(d: SessionDefaults): void {
  const serialized = JSON.stringify(normalizeSessionDefaults(d));
  try {
    localStorage.setItem(KEY, serialized);
  } catch {
    // Settings remain usable when private mode, quota, or policy makes localStorage read-only.
  }
}
