export type LiveWireState =
  | "idle"
  | "dormant"
  | "thinking"
  | "streaming"
  | "awaiting"
  | "running-tool"
  | "success"
  | "error";

const LABELS: Record<LiveWireState, string> = {
  idle: "Idle",
  dormant: "Dormant",
  thinking: "Thinking",
  streaming: "Streaming",
  awaiting: "Awaiting you",
  "running-tool": "Running tool",
  success: "Done",
  error: "Error",
};

const COLORS: Record<LiveWireState, string> = {
  idle: "var(--text-muted)",
  // Dormant = resumable, process not live. A CALM, idle-ish look (faint, not the error tint): the
  // session is fine, just sleeping. Never reads as an error.
  dormant: "var(--text-faint)",
  thinking: "var(--accent)",
  streaming: "var(--accent)",
  awaiting: "var(--iris)",
  "running-tool": "var(--cyan)",
  success: "var(--ok)",
  error: "var(--err)",
};

export interface LiveWireProps {
  state: LiveWireState;
  "aria-label"?: string;
}

/**
 * The session's signature "live wire": a slim signal whose color + motion encode the
 * remote link's state. The pulse animation (defined in global/inline CSS) is disabled
 * under prefers-reduced-motion via the global stylesheet. Color is paired with a text
 * label so it is never the sole signal (a11y).
 */
export function LiveWire({ state, ...rest }: LiveWireProps) {
  const animated = state === "thinking" || state === "streaming" || state === "awaiting";
  const color = COLORS[state];
  return (
    <span
      role="status"
      aria-label={rest["aria-label"] ?? LABELS[state]}
      data-state={state}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "var(--sp-2)",
        fontFamily: "var(--font-mono)",
        fontSize: "var(--fs-xs)",
        color,
      }}
    >
      <span
        aria-hidden
        style={{
          width: 8,
          height: 8,
          borderRadius: "50%",
          background: color,
          boxShadow: `0 0 6px ${animated ? color : "transparent"}`,
          animation: animated ? "rc-pulse 1.2s ease-in-out infinite" : "none",
        }}
      />
      <span style={{ color: "var(--text-muted)" }}>{LABELS[state]}</span>
      <style>{`@keyframes rc-pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.35; } }`}</style>
    </span>
  );
}
