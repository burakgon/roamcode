import { Icon } from "../ui/Icon";
import type { SubagentThread } from "../store/frame-reducer";
import { AgentGlyph, SubagentDot, eyebrowStyle, formatUsage, statusLabel } from "./subagent-ui";

/**
 * The in-chat SUBAGENT CARD: rendered where an `Agent`/`Task` tool spawned a subagent (a "mission the
 * lead dispatched"). Distinct from the quiet "Worked · N steps" tool cluster (ordinary tools). A flat
 * `.rc-glass` card with a hairline: the agent glyph, the `subagent_type` eyebrow, the `description`
 * title, a status dot, a live `activity` line while running, and on completion a usage chip + a quiet
 * "View transcript →" affordance. The WHOLE card is tappable → opens the SubagentView.
 */
export function SubagentCard({ thread, onOpen }: { thread: SubagentThread; onOpen: () => void }) {
  const running = thread.status === "running";
  const type = thread.type ?? "subagent";
  const title = thread.description || thread.summary || "Subagent";
  const usage = formatUsage(thread.usage);
  const nested = thread.parentId !== undefined;

  return (
    <button
      type="button"
      onClick={onOpen}
      className="rc-glass"
      aria-label={`${type} subagent: ${title} — ${statusLabel(thread.status)}. View transcript.`}
      style={{
        display: "flex",
        alignItems: "center",
        gap: "var(--sp-3)",
        width: "100%",
        textAlign: "left",
        padding: "var(--sp-3)",
        borderRadius: "var(--radius)",
        cursor: "pointer",
        font: "inherit",
        color: "var(--text)",
        // A subtle coral edge while running marks an in-flight mission (the only coral on the card).
        borderColor: running ? "var(--accent-line)" : undefined,
      }}
    >
      <AgentGlyph status={thread.status} />
      <span style={{ minWidth: 0, flex: 1, display: "grid", gap: 3 }}>
        <span style={{ display: "flex", alignItems: "center", gap: "var(--sp-2)" }}>
          <span style={eyebrowStyle}>{type}</span>
          {nested && (
            <span style={{ ...eyebrowStyle, color: "var(--text-faint)" }} title="Nested — spawned by another subagent">
              · nested
            </span>
          )}
        </span>
        <span
          style={{
            fontWeight: 600,
            fontSize: "var(--fs-sm)",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {title}
        </span>
        {running ? (
          thread.activity ? (
            <span
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: "var(--fs-xs)",
                color: "var(--text-muted)",
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              {thread.activity}
            </span>
          ) : null
        ) : (
          <span style={{ display: "flex", alignItems: "center", gap: "var(--sp-2)", flexWrap: "wrap" }}>
            {usage && (
              <span
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: "var(--fs-xs)",
                  color: "var(--text-faint)",
                  background: "var(--surface-2)",
                  border: "1px solid var(--border)",
                  borderRadius: "var(--radius-pill)",
                  padding: "1px var(--sp-2)",
                }}
              >
                {usage}
              </span>
            )}
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 3,
                fontSize: "var(--fs-xs)",
                color: "var(--text-muted)",
              }}
            >
              View transcript
              <Icon name="arrow-right" size={12} />
            </span>
          </span>
        )}
      </span>
      <span style={{ display: "flex", alignItems: "center", gap: "var(--sp-2)", flex: "none" }}>
        <span style={{ fontSize: "var(--fs-xs)", color: thread.status === "failed" ? "var(--err)" : "var(--text-muted)" }}>
          {statusLabel(thread.status)}
        </span>
        <SubagentDot status={thread.status} />
      </span>
    </button>
  );
}
