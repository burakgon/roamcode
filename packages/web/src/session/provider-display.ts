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

/** Convert live agent metadata into user-facing labels. A neutral shell is a terminal, not an implicit Claude. */
export function providerSessionDisplay(session: SessionMeta): ProviderSessionDisplay {
  const providerId = session.agent?.provider ?? session.provider;
  if (!providerId) {
    return { provider: "Terminal", dangerous: false, safety: ["user-controlled shell"] };
  }
  const provider = providerDisplayName(providerId);
  const model = session.agent?.model ?? session.model;
  const effort = session.agent?.effort ?? session.effort;
  if (session.launch?.kind === "shell") {
    return {
      provider,
      model,
      effort: providerId === "codex" && effort ? `${effort} reasoning` : effort,
      dangerous: false,
      safety: ["agent-controlled settings"],
    };
  }
  if (provider === "Codex") {
    return {
      provider,
      model,
      effort: effort ? `${effort} reasoning` : undefined,
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
      model,
      effort,
      dangerous: session.dangerouslySkip,
      safety: session.dangerouslySkip ? ["adapter reported unsafe mode"] : ["adapter-managed safety"],
    };
  }
  const dangerous = session.dangerouslySkip || session.permissionMode === "bypassPermissions";
  return {
    provider,
    model,
    effort,
    dangerous,
    safety: dangerous
      ? ["skip-permissions"]
      : [session.permissionMode ? `${session.permissionMode} permissions` : "default permissions"],
  };
}
