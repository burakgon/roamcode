import type { CSSProperties } from "react";
import { Mono } from "../ui/Mono";
import { Icon } from "../ui/Icon";
import { MobileMenuButton } from "../ui/MobileMenuButton";
import { LiveWire } from "../ui/LiveWire";
import type { LiveWireState } from "../ui/LiveWire";
import type { SessionMeta } from "../types/server";

export interface ChatHeaderProps {
  session: SessionMeta;
  wireState: LiveWireState;
  onOpenSettings?: () => void;
  /** Open the mobile sessions sheet. When provided, a top-left menu button is rendered as the FIRST
   * item in the header row (mobile-only; hidden on the desktop breakpoint where the rail is always
   * visible). This replaces the old floating FAB so nothing overlaps the conversation/composer. */
  onShowSessions?: () => void;
  /** Count of sessions awaiting a permission/question. When > 0 the menu button carries a loud iris
   * "needs you" pip + the count is folded into the button's aria-label. */
  needsYou?: number;
}

function basename(p: string): string {
  const parts = p.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || p;
}

const midDot: CSSProperties = { fontFamily: "var(--font-mono)", color: "var(--text-faint)", flex: "none" };

export function ChatHeader({ session, wireState, onOpenSettings, onShowSessions, needsYou = 0 }: ChatHeaderProps) {
  return (
    <header
      className="rc-glass"
      style={{
        display: "flex",
        alignItems: "center",
        gap: "10px",
        // Floating liquid-glass top bar (spec .bar.glass): the .rc-glass material (translucent warm
        // fill + heavy blur, the 4-layer thickness shadow, refraction rim + specular sweep), inset a
        // touch from the edges so it reads as floating chrome over the warm-dark atmosphere.
        margin: "calc(10px + env(safe-area-inset-top, 0px)) 10px 4px",
        padding: "11px 14px",
        borderRadius: "17px",
      }}
    >
      {/* Top-left, IN-FLOW mobile menu button — the first item in the header row, before the cwd, so
          it never overlaps the session name (the name sits to its right). Mobile-only (hidden at the
          desktop breakpoint where the rail is always visible). Replaces the old floating FAB. */}
      {onShowSessions && <MobileMenuButton onShowSessions={onShowSessions} needsYou={needsYou} />}
      {/* The coral brand mark — a small clay-coral tile with a soft glow + inset top highlight (spec
          .mark). The ONE coral moment on the left of the bar; the terminal glyph reads in dark ink. */}
      <span
        aria-hidden
        style={{
          width: 33,
          height: 33,
          flex: "none",
          borderRadius: 10,
          display: "grid",
          placeItems: "center",
          background: "var(--tile-bg)",
          color: "#fff3ea",
          boxShadow:
            "inset 0 1px 0 rgba(255,240,230,.6), 0 6px 16px -6px rgba(247,124,68,.85), 0 0 16px -3px rgba(247,124,68,.45)",
        }}
      >
        <Icon name="terminal" size={17} />
      </span>
      {/* `flex: 1` so the identity column takes the slack between the menu button and the right-side
          status group (keeping that group pinned right); `min-width: 0` lets the path ellipsis clip.
          Mockup .hdr-id: the bold name (.cwd) over ONE quiet mono .meta line. */}
      <div style={{ display: "flex", flexDirection: "column", gap: "1px", minWidth: 0, flex: 1 }}>
        {/* cwd basename in the display font — the session's name, the clearest line in the header. */}
        <strong
          className="display"
          style={{
            fontSize: "var(--fs-base)",
            letterSpacing: "0.005em",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {basename(session.cwd)}
        </strong>
        {/* ONE compact mono meta line (mockup .hdr-id .meta): the full cwd, then the active
            model/effort, then — most importantly — that --dangerously-skip-permissions is in effect
            (flagged in accent). Truncated as one ellipsised row so a long path can't overprint the
            right-side status group at 390px. */}
        <div
          style={{
            display: "flex",
            gap: "6px",
            alignItems: "center",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
            fontSize: "var(--fs-xs)",
          }}
        >
          <Mono muted>{session.cwd}</Mono>
          {session.model && (
            <>
              <span aria-hidden style={midDot}>·</span>
              <Mono muted>{session.model}</Mono>
            </>
          )}
          {session.effort && (
            <>
              <span aria-hidden style={midDot}>·</span>
              <Mono muted>{session.effort}</Mono>
            </>
          )}
          {session.permissionMode === "bypassPermissions" ? (
            <span style={{ fontFamily: "var(--font-mono)", color: "var(--accent)", flex: "none" }}>
              · skip-permissions
            </span>
          ) : (
            session.permissionMode && (
              <>
                <span aria-hidden style={midDot}>·</span>
                <Mono muted>{session.permissionMode}</Mono>
              </>
            )
          )}
        </div>
      </div>
      {/* `flex: none` so the status/settings group keeps its intrinsic width and is never
          squeezed or overlapped by the path column. */}
      <div style={{ display: "flex", alignItems: "center", gap: "10px", flex: "none" }}>
        <LiveWire state={wireState} aria-label={`Session ${basename(session.cwd)} — ${wireState}`} />
        {onOpenSettings && (
          <button
            type="button"
            onClick={onOpenSettings}
            aria-label="Session settings"
            className="rc-hdr-iconbtn"
            style={{
              // Mockup .iconbtn — a compact 38px glassy tile (radius 11px) that warms to accent on
              // hover, NOT a full --tap-min/--radius tile. Sits flush in the right status group.
              width: 38,
              height: 38,
              flex: "none",
              display: "grid",
              placeItems: "center",
              borderRadius: 11,
              background: "var(--surface-2)",
              border: "1px solid var(--border)",
              color: "var(--text-muted)",
              cursor: "pointer",
            }}
          >
            <Icon name="settings" size={18} />
            <style>{`.rc-hdr-iconbtn:hover { color: var(--accent); border-color: var(--accent-line); }`}</style>
          </button>
        )}
      </div>
    </header>
  );
}
