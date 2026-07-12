export interface SettingCopy {
  label: string;
  help: string;
}

export const effortCopy: Record<string, SettingCopy> = {
  minimal: { label: "Minimal", help: "Fastest response with the lightest reasoning." },
  low: { label: "Low", help: "Fast response for clear, well-scoped work." },
  medium: { label: "Medium", help: "Balanced speed and depth for everyday work." },
  high: { label: "High", help: "Deeper reasoning for difficult, multi-step work." },
  xhigh: { label: "Extra high", help: "Very deep reasoning for the hardest standard tasks." },
  max: { label: "Max", help: "Maximum supported reasoning; expect the longest response time." },
};

export function copyForEffort(value: string, providerDescription?: string): SettingCopy {
  return (
    effortCopy[value] ?? {
      label: value,
      help: providerDescription || "Provider-advertised reasoning level.",
    }
  );
}

export const codexSandboxCopy: Record<string, SettingCopy> = {
  "read-only": { label: "Read only", help: "Inspect and plan without file writes." },
  "workspace-write": {
    label: "Workspace write",
    help: "Read, edit, and run inside the active workspace; the recommended balanced sandbox.",
  },
  "danger-full-access": {
    label: "Danger full access",
    help: "Remove workspace isolation; use only in an externally trusted environment.",
  },
};

export const codexApprovalCopy: Record<string, SettingCopy> = {
  untrusted: { label: "Untrusted", help: "Ask before commands outside Codex's trusted set." },
  "on-request": {
    label: "On request",
    help: "Let Codex request elevation when needed; the recommended interactive policy.",
  },
  never: { label: "Never", help: "Never ask, while the selected sandbox still applies." },
};

export const claudePermissionCopy: Record<string, SettingCopy> = {
  default: { label: "Default", help: "Ask before tool use when Claude requires approval." },
  acceptEdits: { label: "Accept edits", help: "Accept file edits automatically while retaining other prompts." },
  plan: { label: "Plan", help: "Inspect and plan before making changes." },
};
