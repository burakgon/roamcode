import { Icon } from "../ui/Icon";
import type { SubagentThread } from "../store/frame-reducer";
import { SubagentDot, StatusGlyph } from "./subagent-ui";

/**
 * The SUBAGENT TRAY — a slim one-line strip directly above the composer (the CLI's "under the textbox"
 * position). Renders NOTHING when there are no subagents. Otherwise: a leading agents glyph + count,
 * then a horizontally-scrollable row of chips (one per TOP-LEVEL subagent — nested children are
 * reachable inside their parent's transcript). Running chips pulse coral; the active count is the one
 * coral accent. Tap a chip → open that SubagentView.
 */
export function SubagentTray({
  subagents,
  subagentOrder,
  onOpen,
}: {
  subagents: Record<string, SubagentThread>;
  subagentOrder: string[];
  onOpen: (id: string) => void;
}) {
  // Only top-level missions show in the tray (a nested subagent lives inside its parent's transcript).
  const ids = subagentOrder.filter((id) => {
    const t = subagents[id];
    return t !== undefined && t.parentId === undefined;
  });
  if (ids.length === 0) return null;

  const running = ids.filter((id) => subagents[id]?.status === "running").length;
  const countLabel = `${ids.length} ${ids.length === 1 ? "agent" : "agents"}`;

  return (
    <div
      role="group"
      aria-label={`Subagents — ${countLabel}${running > 0 ? `, ${running} running` : ""}`}
      style={{
        display: "flex",
        alignItems: "center",
        gap: "var(--sp-2)",
        padding: "var(--sp-2) var(--sp-3)",
        borderTop: "1px solid var(--border)",
        background: "var(--surface)",
      }}
    >
      <span style={{ display: "flex", alignItems: "center", gap: "6px", flex: "none" }}>
        <Icon name="agent" size={15} style={{ color: running > 0 ? "var(--coral-2)" : "var(--text-muted)" }} />
        <span
          style={{
            fontFamily: "var(--font-display)",
            fontSize: "var(--fs-xs)",
            fontWeight: 600,
            // The active count is the one coral accent; idle/all-done reads neutral.
            color: running > 0 ? "var(--coral-2)" : "var(--text-muted)",
            whiteSpace: "nowrap",
          }}
        >
          {countLabel}
        </span>
      </span>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--sp-2)",
          overflowX: "auto",
          flex: 1,
          // Hide the scrollbar visually but keep it scrollable (matches the app's quiet chrome).
          scrollbarWidth: "none",
          minWidth: 0,
        }}
      >
        {ids.map((id) => {
          const t = subagents[id]!;
          const type = t.type ?? "subagent";
          const running = t.status === "running";
          const detail = running ? t.activity : undefined;
          return (
            <button
              key={id}
              type="button"
              onClick={() => onOpen(id)}
              aria-label={`Open ${type} subagent`}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "6px",
                flex: "none",
                maxWidth: "62vw",
                minHeight: 30,
                padding: "4px var(--sp-2)",
                borderRadius: "var(--radius-pill)",
                background: "var(--surface-2)",
                border: `1px solid ${running ? "var(--accent-line)" : "var(--border)"}`,
                color: "var(--text-muted)",
                cursor: "pointer",
                font: "inherit",
                fontSize: "var(--fs-xs)",
              }}
            >
              {running ? <SubagentDot status="running" size={6} /> : <StatusGlyph status={t.status} size={12} />}
              <span style={{ color: "var(--text)", whiteSpace: "nowrap" }}>{type}</span>
              {detail && (
                <span
                  style={{
                    fontFamily: "var(--font-mono)",
                    color: "var(--text-faint)",
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    maxWidth: 160,
                  }}
                >
                  {detail}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
