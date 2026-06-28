export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

// Selectable starting/active permission modes. bypassPermissions is intentionally NOT here — it's
// expressed by the separate "Dangerously skip permissions" toggle (an explicit, scarier opt-in).
export const PERMISSION_MODES = ["default", "acceptEdits", "plan"] as const;

/** Map an effort level onto a thinking-token budget for set_max_thinking_tokens. */
export const EFFORT_THINKING_TOKENS: Record<string, number> = {
  low: 1024,
  medium: 4096,
  high: 8192,
  xhigh: 16384,
  max: 32768,
};

export interface SessionDefaults {
  effort: string;
  model?: string;
  dangerouslySkip: boolean;
  /** Default starting permission mode for new sessions (default | acceptEdits | plan). */
  permissionMode?: string;
}

const KEY = "remote-coder.defaults";
const FALLBACK: SessionDefaults = { effort: "medium", dangerouslySkip: false };

export function loadDefaults(): SessionDefaults {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...FALLBACK };
    const parsed = JSON.parse(raw) as Partial<SessionDefaults>;
    return {
      // Validate against the known set: a stale/invalid stored effort (e.g. "ultra" from an old build)
      // would yield a <select> with no matching option + an undefined thinking-token budget on apply.
      effort:
        typeof parsed.effort === "string" && (EFFORTS as readonly string[]).includes(parsed.effort)
          ? parsed.effort
          : FALLBACK.effort,
      model: typeof parsed.model === "string" ? parsed.model : undefined,
      dangerouslySkip: parsed.dangerouslySkip === true,
      // Only honor a known mode; a stale/invalid stored value falls back to the implicit default.
      permissionMode:
        typeof parsed.permissionMode === "string" &&
        (PERMISSION_MODES as readonly string[]).includes(parsed.permissionMode)
          ? parsed.permissionMode
          : undefined,
    };
  } catch {
    return { ...FALLBACK };
  }
}

export function saveDefaults(d: SessionDefaults): void {
  localStorage.setItem(KEY, JSON.stringify(d));
}
