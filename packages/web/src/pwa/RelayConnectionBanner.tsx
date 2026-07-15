import type { BrowserRelayStatus } from "../relay/client";
import { Icon } from "../ui/Icon";

export interface RelayConnectionBannerProps {
  status?: BrowserRelayStatus;
  onReconnect?: () => void;
}

const COPY: Partial<Record<BrowserRelayStatus, string>> = {
  connecting: "Opening an end-to-end encrypted link to this host…",
  reconnecting: "Relay interrupted — sessions keep running on the host; reconnecting…",
  revoked: "This device’s relay access was revoked. Pair it again from the host.",
  superseded: "This host is connected in another tab. Reconnect here to take over.",
  error: "Relay identity verification failed, so RoamCode stopped the connection.",
};

/** Relay state is independent from navigator.onLine: a phone may be online while the encrypted host path is not. */
export function RelayConnectionBanner({ status, onReconnect }: RelayConnectionBannerProps) {
  const message = status ? COPY[status] : undefined;
  if (!message) return null;
  const canReconnect = status === "superseded" || status === "error";
  const severe = status === "revoked" || status === "error";
  return (
    <div
      role={severe ? "alert" : "status"}
      aria-live={severe ? "assertive" : "polite"}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: "var(--sp-2)",
        background: "var(--surface-2)",
        borderBottom: `1px solid ${severe ? "var(--err)" : "var(--accent)"}`,
        color: "var(--text)",
        padding: "calc(var(--sp-2) + env(safe-area-inset-top, 0px)) var(--sp-4) var(--sp-2)",
        fontSize: "var(--fs-sm)",
        textAlign: "center",
      }}
    >
      <Icon name="alert" size={15} style={{ color: severe ? "var(--err)" : "var(--accent)" }} />
      <span>{message}</span>
      {canReconnect && onReconnect && (
        <button
          type="button"
          onClick={onReconnect}
          style={{
            border: "1px solid var(--border-strong)",
            borderRadius: "var(--radius-sm)",
            background: "var(--surface-3)",
            color: "var(--text)",
            padding: "var(--sp-1) var(--sp-2)",
            font: "inherit",
          }}
        >
          Reconnect
        </button>
      )}
    </div>
  );
}
