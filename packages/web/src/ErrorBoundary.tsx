import { Component, type ErrorInfo, type ReactNode } from "react";
import { hardRefresh } from "./update/stale-client";

interface Props {
  children: ReactNode;
  /** Compact = the in-chat pane fallback (a crashing session shouldn't nuke the whole shell); full =
   *  the top-level last-resort fallback. */
  variant?: "full" | "compact";
  /** Label for what failed (e.g. "this conversation") — shown in the message. */
  label?: string;
}
interface State {
  error?: Error;
}

/**
 * Catches a RENDER crash anywhere below it and shows a visible, recoverable fallback instead of letting
 * React unmount the whole tree to a blank/gray screen (the "gray screen stuck" bug — there was no boundary
 * at all). The message surfaces the actual error so the failure is diagnosable, and "Reload" runs a
 * hardRefresh (drops the service-worker precache + caches) so a stale/corrupt precached bundle — a likely
 * cause right after an OTA update — is cleared, not reloaded from cache into the same crash.
 *
 * Note: a render crash, not an effect/async error (those don't unmount the tree). Keyed by the caller
 * (e.g. session id) so switching context resets the boundary.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = {};

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Goes to the browser console so a future occurrence is diagnosable (the fallback also shows it).
    console.error("[roamcode] render crash caught by ErrorBoundary:", error, info.componentStack);
  }

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    const compact = this.props.variant === "compact";
    const what = this.props.label ?? "the app";
    return (
      <div
        role="alert"
        style={{
          display: "grid",
          gap: "var(--sp-3)",
          placeContent: "center",
          justifyItems: "start",
          textAlign: "left",
          height: compact ? "100%" : "100dvh",
          padding: "var(--sp-5)",
          maxWidth: 520,
          margin: "0 auto",
          color: "var(--text)",
          background: "var(--bg)",
        }}
      >
        <div style={{ fontFamily: "var(--font-display)", fontSize: "var(--fs-lg, var(--fs-base))", fontWeight: 600 }}>
          Something went wrong rendering {what}
        </div>
        <p style={{ margin: 0, color: "var(--text-muted)", fontSize: "var(--fs-sm)", lineHeight: 1.5 }}>
          A reload usually fixes it — it clears a stale cached app version (a common cause right after an update). If it
          keeps happening, the message below says what failed.
        </p>
        <pre
          style={{
            margin: 0,
            width: "100%",
            maxHeight: "32vh",
            overflow: "auto",
            padding: "var(--sp-3)",
            background: "var(--code-bg)",
            border: "1px solid var(--code-border)",
            borderRadius: "var(--radius-sm)",
            color: "var(--code-text)",
            fontFamily: "var(--font-mono)",
            fontSize: "var(--fs-xs)",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
          }}
        >
          {error.message || String(error)}
        </pre>
        <button
          type="button"
          onClick={() => void hardRefresh()}
          style={{
            minHeight: "var(--tap-min)",
            padding: "0 var(--sp-4)",
            borderRadius: "var(--radius-sm)",
            border: "1px solid transparent",
            background: "var(--accent-grad)",
            color: "var(--on-accent)",
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          Reload
        </button>
      </div>
    );
  }
}
