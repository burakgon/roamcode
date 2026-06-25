import type { CSSProperties } from "react";
import { Icon } from "../ui/Icon";
import type { SubagentThread, SubagentUsage } from "../store/frame-reducer";

/**
 * Shared presentation primitives for the subagent feature (the in-chat SubagentCard, the SubagentTray
 * above the composer, and the SubagentView drill-in). Design language: subagents are "missions the
 * lead agent dispatched to its team" — flat surfaces + hairlines, and CORAL ONLY on a RUNNING status
 * dot/pulse. Done = a neutral check; failed = a restrained warning (icon + text, never loud).
 */

export type SubagentStatus = SubagentThread["status"];

/** Human label for a subagent status — pairs with the dot/icon so color is never the only signal. */
export function statusLabel(status: SubagentStatus): string {
  return status === "completed" ? "Done" : status === "failed" ? "Failed" : "Running";
}

/** Compact token count: 11401 → "11.4k", 940 → "940". */
export function formatTokens(n: number | undefined): string | undefined {
  if (n === undefined) return undefined;
  return n < 1000 ? `${n}` : `${(n / 1000).toFixed(1)}k`;
}

/** Compact duration: 4112 → "4.1s", 720 → "720ms", 90000 → "1.5m". */
export function formatDuration(ms: number | undefined): string | undefined {
  if (ms === undefined) return undefined;
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  return s < 60 ? `${s.toFixed(1)}s` : `${(s / 60).toFixed(1)}m`;
}

/** A one-line usage chip body, e.g. "11.4k tok · 1 tool · 4.1s". Empty when there is nothing to show. */
export function formatUsage(usage: SubagentUsage | undefined): string {
  if (!usage) return "";
  const parts: string[] = [];
  const tok = formatTokens(usage.tokens);
  if (tok) parts.push(`${tok} tok`);
  if (usage.toolUses !== undefined) parts.push(`${usage.toolUses} ${usage.toolUses === 1 ? "tool" : "tools"}`);
  const dur = formatDuration(usage.durationMs);
  if (dur) parts.push(dur);
  return parts.join(" · ");
}

const PULSE = "rc-sa-pulse";
const PULSE_KEYFRAMES = `@keyframes ${PULSE} { 0%,100% { opacity: 1; } 50% { opacity: 0.35; } }`;

/**
 * The subagent status dot. RUNNING is the one coral signal (a soft coral halo + pulse); DONE is a
 * neutral muted dot; FAILED is a restrained err dot. The pulse is auto-neutralized under
 * prefers-reduced-motion (global.css). `role=status` + `aria-label` carry the state to assistive tech.
 */
export function SubagentDot({ status, size = 7 }: { status: SubagentStatus; size?: number }) {
  const running = status === "running";
  const color = status === "failed" ? "var(--err)" : running ? "var(--coral)" : "var(--text-muted)";
  return (
    <span
      role="status"
      aria-label={statusLabel(status)}
      style={{
        position: "relative",
        flex: "none",
        width: size,
        height: size,
        borderRadius: "50%",
        background: color,
        boxShadow: running ? "0 0 0 3px rgba(247,124,68,.14)" : "none",
        animation: running ? `${PULSE} 1.2s ease-in-out infinite` : "none",
      }}
    >
      <style>{PULSE_KEYFRAMES}</style>
    </span>
  );
}

/** The agent glyph tile — neutral, coral-tinted while running. The lead's "team member" mark. */
export function AgentGlyph({ status, size = 34 }: { status: SubagentStatus; size?: number }) {
  const running = status === "running";
  const tile: CSSProperties = {
    width: size,
    height: size,
    flex: "none",
    borderRadius: "var(--radius-sm)",
    display: "grid",
    placeItems: "center",
    background: running ? "var(--accent-soft)" : "var(--surface-2)",
    border: `1px solid ${running ? "var(--accent-line)" : "var(--border)"}`,
    color: running ? "var(--coral-2)" : "var(--text-muted)",
  };
  return (
    <span aria-hidden style={tile}>
      <Icon name="agent" size={Math.round(size * 0.55)} />
    </span>
  );
}

/** The tiny finished-state glyph used inside tray chips (a neutral check / restrained warn). */
export function StatusGlyph({ status, size = 13 }: { status: SubagentStatus; size?: number }) {
  if (status === "completed") return <Icon name="check" size={size} label="Done" style={{ color: "var(--ok)" }} />;
  if (status === "failed") return <Icon name="alert" size={size} label="Failed" style={{ color: "var(--err)" }} />;
  return <SubagentDot status="running" />;
}

/** The mono micro-caps eyebrow (subagent_type), reused across the card + view header. */
export const eyebrowStyle: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: "10px",
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  color: "var(--text-faint)",
};
