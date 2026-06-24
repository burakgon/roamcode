import { Mono } from "../ui/Mono";
import { Button } from "../ui/Button";
import { LiveWire } from "../ui/LiveWire";
import type { LiveWireState } from "../ui/LiveWire";
import type { SessionMeta } from "../types/server";

export interface ChatHeaderProps {
  session: SessionMeta;
  wireState: LiveWireState;
  onOpenSettings?: () => void;
}

function basename(p: string): string {
  const parts = p.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || p;
}

export function ChatHeader({ session, wireState, onOpenSettings }: ChatHeaderProps) {
  return (
    <header
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        padding: "var(--sp-4)",
        borderBottom: "1px solid var(--border)",
        background: "var(--surface)",
      }}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-1)", minWidth: 0 }}>
        <strong className="display" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {basename(session.cwd)}
        </strong>
        {/* Truncate the cwd so a long path can't overrun and overprint the right-side status
            group at narrow widths (390px). The parent column is already a `min-width:0` flex
            child, which is what lets the ellipsis actually clip instead of forcing overflow. */}
        <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          <Mono muted>{session.cwd}</Mono>
        </div>
        {/* Surface the ACTIVE per-session settings so the user can confirm model/effort and — most
            importantly — that --dangerously-skip-permissions is in effect (no permission prompts). */}
        <div style={{ display: "flex", gap: "var(--sp-2)", flexWrap: "wrap", fontSize: "var(--fs-sm)" }}>
          {session.model && <Mono muted>{session.model}</Mono>}
          {session.effort && <Mono muted>· {session.effort}</Mono>}
          {session.permissionMode === "bypassPermissions" ? (
            <span style={{ color: "var(--accent)" }}>· skip-permissions</span>
          ) : (
            session.permissionMode && <Mono muted>· {session.permissionMode}</Mono>
          )}
        </div>
      </div>
      {/* `flex: none` so the status/settings group keeps its intrinsic width and is never
          squeezed or overlapped by the path column. */}
      <div style={{ display: "flex", alignItems: "center", gap: "var(--sp-3)", flex: "none" }}>
        <LiveWire state={wireState} aria-label={`Session ${basename(session.cwd)} — ${wireState}`} />
        {onOpenSettings && (
          <Button variant="ghost" onClick={onOpenSettings} aria-label="Session settings">
            Settings
          </Button>
        )}
      </div>
    </header>
  );
}
