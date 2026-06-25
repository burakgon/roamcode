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
  // The "live"/active states pulse: thinking/streaming (violet accent), the awaiting violet, and the
  // working/running-tool CYAN dot. All pulses are neutralized under prefers-reduced-motion (global.css).
  const animated =
    state === "thinking" || state === "streaming" || state === "awaiting" || state === "running-tool";
  // The "working" (running-tool) dot is the LIVE signal: a pulsing warm core wrapped in a soft
  // expanding "ping" halo (rc-ping, defined in global.css) — the one chrome dot that earns motion.
  const working = state === "running-tool";
  const color = COLORS[state];
  // The ACTIVE / AWAITING states read as a coral status chip (spec .chip): a warm coral wash with a
  // coral hairline, the glowing dot, and the label in coral-2. Calm states (idle/dormant/done/error)
  // stay a quiet inline dot + muted label so coral never bleeds onto non-attention states.
  const chip = animated;
  return (
    <span
      role="status"
      aria-label={rest["aria-label"] ?? LABELS[state]}
      data-state={state}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: chip ? "7px" : "var(--sp-2)",
        fontFamily: "var(--font-mono)",
        fontSize: "var(--fs-xs)",
        fontWeight: chip ? 600 : 400,
        color: chip ? "var(--coral-2)" : color,
        ...(chip
          ? {
              padding: "5px 11px 5px 9px",
              borderRadius: "999px",
              background: "var(--awaiting-soft)",
              boxShadow: "inset 0 0 0 1px var(--awaiting-line)",
            }
          : {}),
      }}
    >
      <span
        className={working ? "rc-wire-dot rc-wire-dot--live" : "rc-wire-dot"}
        aria-hidden
        style={{
          position: "relative",
          width: chip ? 6 : 8,
          height: chip ? 6 : 8,
          borderRadius: "50%",
          background: color,
          boxShadow: animated ? "0 0 9px rgba(247,124,68,.9)" : "0 0 6px transparent",
          animation: animated ? "rc-pulse 1.2s ease-in-out infinite" : "none",
        }}
      />
      <span style={{ color: chip ? "var(--coral-2)" : "var(--text-muted)" }}>{LABELS[state]}</span>
      <style>{`
        @keyframes rc-pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.35; } }
        /* The "working" ping ring — a soft expanding warm halo around the live dot. */
        .rc-wire-dot--live::after {
          content: ""; position: absolute; inset: -3px;
          border-radius: 50%; border: 1.5px solid var(--working); opacity: 0.5;
          animation: rc-ping 1.9s ease-out infinite;
        }
      `}</style>
    </span>
  );
}
