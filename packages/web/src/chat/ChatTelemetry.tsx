import type { LiveWireState } from "../ui/LiveWire";

/**
 * The conversation TELEMETRY strip — a quiet bar pinned between the chat log and the composer, so the
 * two things you watch while working are right where your eyes already are (next to the textbox), not
 * up in the header:
 *
 *  - LEFT  the live model state (the "live wire"), reacting the instant you send: a dot that radar-pings
 *          while the agent works + a label with a typing-style ellipsis (Thinking… / Streaming…).
 *  - RIGHT the context meter — how full the model's window is, so you know when to /compact. A slim
 *          track tinted coral → amber → red as it fills, with the percent + token count in mono.
 *
 * Both stay readable at 390px and reduce to a static dot/label under prefers-reduced-motion.
 */

/** The model's context window in tokens — a NAME-based heuristic used only as a fallback. Current Claude
 *  models (Opus/Sonnet/Haiku 4.x) are 200k; a 1M-context variant (e.g. Sonnet's 1M beta, surfaced as
 *  "…[1m]") maps to 1M. Prefer the authoritative `contextWindow` the CLI reports per turn (see the
 *  `contextWindow` prop); this only covers the first frames before any result, or odd model strings. */
function contextWindowFor(model?: string): number {
  if (model && /\b1m\b|\[1m\]/i.test(model)) return 1_000_000;
  return 200_000;
}

/** Working states animate (ping + ellipsis); the rest are a calm static dot + label. */
const WORKING: ReadonlySet<LiveWireState> = new Set(["thinking", "streaming", "running-tool"]);

const STATUS_LABEL: Record<LiveWireState, string> = {
  idle: "Ready",
  dormant: "Dormant",
  thinking: "Thinking",
  streaming: "Streaming",
  awaiting: "Awaiting you",
  "running-tool": "Running tool",
  success: "Done",
  error: "Error",
};

/** The live states earn the coral accent so "Claude is working / needs you" is unmistakable right by
 * the composer — error stays red, idle/done/dormant stay quiet neutral. */
function statusColor(state: LiveWireState): string {
  if (state === "error") return "var(--err)";
  if (state === "awaiting" || WORKING.has(state)) return "var(--coral-2)";
  return "var(--text-muted)";
}

/** The context meter's fill: coral with headroom, amber as it tightens, red when /compact is due. */
export function contextFillColor(percent: number): string {
  if (percent > 92) return "var(--err)";
  if (percent > 80) return "var(--warn)";
  return "var(--coral)";
}

/** Compact token count: 900 → "900", 5400 → "5.4k", 90000 → "90k", 128000 → "128k". */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  const k = n / 1000;
  return `${k < 10 ? k.toFixed(1) : Math.round(k)}k`;
}

export interface ChatTelemetryProps {
  wireState: LiveWireState;
  /** Context-window fill in tokens (from the last result's usage). Omitted → the meter is hidden. */
  contextTokens?: number;
  /** The AUTHORITATIVE context window for the running model (from the last result's `modelUsage`, e.g.
   *  1_000_000 for a 1M variant). The meter's true denominator — used over the `model`-name heuristic so
   *  a 1M session never reads as a false "full". Omitted (no result yet) → fall back to `contextWindowFor`. */
  contextWindow?: number;
  /** Fallback only: infer the window from the model name when `contextWindow` isn't reported yet. */
  model?: string;
  /** TRUE while a user-issued `/compact` is being processed — the label reads "Compacting…" (the wire is
   *  a normal working state; only the label changes) so the user sees that compaction is underway. */
  compacting?: boolean;
  /** TRUE while the live WS link is down after having been up — the label reads "Reconnecting…" so a
   *  dropped stream is visible rather than looking like Claude just went quiet. Outranks the wire label. */
  reconnecting?: boolean;
}

export function ChatTelemetry({
  wireState,
  contextTokens,
  contextWindow,
  model,
  compacting,
  reconnecting,
}: ChatTelemetryProps) {
  // Compaction counts as a working state for ALL the visuals: a /compact emits no streaming/tool frames,
  // so the wire stays idle — but the indicator must still look alive (coral dot, ping, typing ellipsis).
  // Reconnecting is NOT a working state (Claude isn't producing tokens we can see) — it's a calm amber
  // notice, so it suppresses the working visuals.
  const working = !reconnecting && (WORKING.has(wireState) || !!compacting);
  // The dot radar-pings whenever the session is "live": the agent working OR waiting on you. Only the
  // agent-working states get the typing ellipsis (it would misread on an awaiting-you state).
  const pinging = working || (!reconnecting && wireState === "awaiting");
  const color = reconnecting ? "var(--warn)" : compacting ? "var(--coral-2)" : statusColor(wireState);
  // "Reconnecting…" outranks "Compacting…", which outranks the wire's own label.
  const label = reconnecting ? "Reconnecting…" : compacting ? "Compacting…" : STATUS_LABEL[wireState];

  // Prefer the CLI's authoritative window; the name heuristic is a fallback for the pre-result frames.
  let windowTokens = contextWindow && contextWindow > 0 ? contextWindow : contextWindowFor(model);
  const hasContext = typeof contextTokens === "number" && contextTokens > 0;
  // Safety net: occupancy can NEVER exceed the window, so if it does our window value is a wrong
  // (name-based) guess — a 1M-context session whose model string lacks a "1m" marker (e.g. opus-4-8 on a
  // 1M window). Snap up to the 1M tier so the meter shows a real % instead of pinning to a false 100%.
  if (hasContext && contextTokens! > windowTokens) windowTokens = Math.max(windowTokens, 1_000_000);
  const percent = hasContext ? Math.min(100, Math.round((contextTokens! / windowTokens) * 100)) : 0;
  const fill = contextFillColor(percent);
  const tight = percent > 80;

  return (
    <div className="rc-tele">
      <span className="rc-tele__status" role="status" data-state={wireState} aria-label={`Model ${label}`}>
        <span className={`rc-tele__dot${pinging ? " rc-tele__dot--live" : ""}`} style={{ background: color }}>
          {pinging && <span className="rc-tele__ping" style={{ background: color }} aria-hidden="true" />}
        </span>
        <span className="rc-tele__label" style={{ color }}>
          {label}
        </span>
        {working && (
          <span className="rc-tele__dots" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
        )}
      </span>

      {hasContext && (
        <span
          className="rc-tele__ctx"
          aria-label={`Context ${percent}% full — ${contextTokens!.toLocaleString()} of ${windowTokens.toLocaleString()} tokens`}
          title={tight ? "Context is filling up — consider /compact" : undefined}
        >
          <span className="rc-tele__ctx-key">ctx</span>
          <span className="rc-tele__track">
            <span className="rc-tele__fill" style={{ width: `${percent}%`, background: fill }} />
          </span>
          <span className="rc-tele__ctx-num" style={tight ? { color: fill } : undefined}>
            {percent}% · {formatTokens(contextTokens!)}
          </span>
        </span>
      )}

      <style>{telemetryCss}</style>
    </div>
  );
}

const telemetryCss = `
.rc-tele {
  flex: none;
  display: flex; align-items: center; justify-content: space-between; gap: var(--sp-3);
  padding: 7px var(--sp-4);
  border-top: 1px solid var(--border);
  background: var(--surface);
  font-family: var(--font-mono); font-size: var(--fs-xs);
}
.rc-tele__status { display: inline-flex; align-items: center; gap: 7px; min-width: 0; }
/* The live-wire dot. While the agent works it emits a single expanding radar ring (the ::ping sibling)
   — calmer + more "alive" than a blunt opacity blink. */
.rc-tele__dot { position: relative; width: 8px; height: 8px; border-radius: 50%; flex: none; }
/* Live (working / awaiting): the dot BREATHES with a coral glow AND emits an expanding ring — a strong,
   unmistakable "Claude is working" pulse right next to the input. */
.rc-tele__dot--live { animation: rc-tele-glow 1.3s ease-in-out infinite; }
@keyframes rc-tele-glow {
  0%, 100% { box-shadow: 0 0 4px 0 rgba(247, 124, 68, 0.55); transform: scale(1); }
  50% { box-shadow: 0 0 11px 2px rgba(247, 124, 68, 0.95); transform: scale(1.2); }
}
.rc-tele__ping {
  position: absolute; inset: 0; border-radius: 50%;
  animation: rc-tele-ping 1.3s cubic-bezier(0, 0, 0.2, 1) infinite;
}
@keyframes rc-tele-ping {
  0% { transform: scale(1); opacity: 0.7; }
  80%, 100% { transform: scale(3.4); opacity: 0; }
}
.rc-tele__label { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
/* Typing-style trailing dots while working — the universal "it's responding" cue, right by the input.
   Bright coral + a bounce so it reads clearly on the dark bar (the old faint dots were near-invisible). */
.rc-tele__dots { display: inline-flex; align-items: center; gap: 3px; flex: none; }
.rc-tele__dots i { width: 4px; height: 4px; border-radius: 50%; background: var(--coral-2); opacity: 0.3; animation: rc-tele-typing 1.1s ease-in-out infinite; }
.rc-tele__dots i:nth-child(2) { animation-delay: 0.16s; }
.rc-tele__dots i:nth-child(3) { animation-delay: 0.32s; }
@keyframes rc-tele-typing { 0%, 70%, 100% { opacity: 0.3; transform: translateY(0); } 35% { opacity: 1; transform: translateY(-3px); } }
.rc-tele__ctx { display: inline-flex; align-items: center; gap: 6px; flex: none; color: var(--text-faint); }
.rc-tele__ctx-key { letter-spacing: 0.04em; }
.rc-tele__track { width: 52px; height: 4px; border-radius: 999px; background: var(--surface-2); border: 1px solid var(--border); overflow: hidden; }
.rc-tele__fill { display: block; height: 100%; border-radius: 999px; transition: width 0.4s ease, background 0.3s ease; }
.rc-tele__ctx-num { color: var(--text-muted); }
@media (prefers-reduced-motion: reduce) {
  .rc-tele__ping, .rc-tele__dots i, .rc-tele__dot--live { animation: none; }
  .rc-tele__ping { display: none; }
}
`;
