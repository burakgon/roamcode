import type { SessionMeta } from "../types/server";

export interface ProviderSessionDisplay {
  provider: string;
  model?: string;
  effort?: string;
  safety: string[];
  dangerous: boolean;
}

/** Stable fallback label for manifest-owned provider ids when a descriptor is not available. */
export function providerDisplayName(providerId: string): string {
  if (providerId === "codex") return "Codex";
  if (providerId === "claude") return "Claude";
  return providerId
    .split("-")
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join(" ");
}

/** Convert transport metadata into provider-native, user-facing labels. Legacy payloads are Claude. */
export function providerSessionDisplay(session: SessionMeta): ProviderSessionDisplay {
  const providerId = session.provider ?? "claude";
  const provider = providerDisplayName(providerId);
  if (provider === "Codex") {
    return {
      provider,
      model: session.model,
      effort: session.effort ? `${session.effort} reasoning` : undefined,
      dangerous: session.dangerouslySkip,
      safety: session.dangerouslySkip
        ? ["bypass approvals and sandbox"]
        : session.sandbox || session.approvalPolicy
          ? [
              ...(session.sandbox ? [`${session.sandbox} sandbox`] : []),
              ...(session.approvalPolicy ? [`${session.approvalPolicy} approvals`] : []),
            ]
          : ["provider-default safety"],
    };
  }
  if (provider !== "Claude") {
    return {
      provider,
      model: session.model,
      effort: session.effort,
      dangerous: session.dangerouslySkip,
      safety: session.dangerouslySkip ? ["adapter reported unsafe mode"] : ["adapter-managed safety"],
    };
  }
  const dangerous = session.dangerouslySkip || session.permissionMode === "bypassPermissions";
  return {
    provider,
    model: session.model,
    effort: session.effort,
    dangerous,
    safety: dangerous
      ? ["skip-permissions"]
      : [session.permissionMode ? `${session.permissionMode} permissions` : "default permissions"],
  };
}
