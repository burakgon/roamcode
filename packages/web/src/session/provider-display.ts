import type { SessionMeta } from "../types/server";

export interface ProviderSessionDisplay {
  provider: "Claude" | "Codex";
  model?: string;
  effort?: string;
  safety: string[];
  dangerous: boolean;
}

/** Convert transport metadata into provider-native, user-facing labels. Legacy payloads are Claude. */
export function providerSessionDisplay(session: SessionMeta): ProviderSessionDisplay {
  const provider = session.provider === "codex" ? "Codex" : "Claude";
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
