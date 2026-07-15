import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { Icon } from "../ui/Icon";
import { MobileMenuButton } from "../ui/MobileMenuButton";
import { PANE_MIME } from "../split/dnd";
import { displaySessionName, useSessionNames } from "../session/names";
import type { SessionMeta } from "../types/server";
import { providerSessionDisplay } from "../session/provider-display";
import { ProviderIcon } from "../providers/ProviderIcon";

export interface ChatHeaderProps {
  session: SessionMeta;
  onOpenSettings?: () => void;
  /** Open the terminal Help sheet (gesture + key-bar legend). When provided, a quiet "?" button is rendered
   *  to the left of the gear. Terminal mode wires this to the HelpSheet. */
  onOpenHelp?: () => void;
  /** Open the in-conversation search (a quiet magnifier in the header). When provided, the search button
   *  is rendered to the left of the gear. */
  onOpenSearch?: () => void;
  /** Open the MCP servers panel (the `/mcp` equivalent). When provided, a small sliders button is rendered
   *  to the left of the gear. */
  onOpenMcp?: () => void;
  /** Open the mobile sessions sheet. When provided, a top-left menu button is rendered as the FIRST
   * item in the header row (mobile-only; hidden on the desktop breakpoint where the rail is always
   * visible). This replaces the old floating FAB so nothing overlaps the conversation/composer. */
  onShowSessions?: () => void;
  /** Count of sessions awaiting a permission/question. When > 0 the menu button carries a loud iris
   * "needs you" pip + the count is folded into the button's aria-label. */
  needsYou?: number;
  /** Close/stop this session. When provided, an X button is rendered at the end of the header's right
   * group. Used by terminal mode (which has no composer/settings) so the session is closable from its bar. */
  onClose?: () => void;
  /** Split this pane, opening a NEW pane on the right (desktop split-screen). When provided, a split
   *  button is rendered in the right group. The SESSION keeps running either way — panes are views. */
  onSplitRight?: () => void;
  /** Split this pane, opening a NEW pane below. */
  onSplitDown?: () => void;
  /** In split-screen the header ✕ closes the PANE (the session keeps running in tmux — reopen it from the
   *  rail); single-pane keeps today's close-the-session ✕. This only retitles the button so the user knows
   *  which of the two they're getting — the handler itself is whatever `onClose` was wired to. */
  closeIsPane?: boolean;
  /** Split-screen rearrange: when set (the pane's leaf id), the whole header becomes the pane's DRAG
   *  handle (iTerm2's "drag the pane by its title bar") — drop it on another pane's edge to move it there
   *  (also how the split direction changes) or on its center to swap. Buttons inside still click fine. */
  dragPaneId?: string;
  /** Open the terminal Files panel (attachments to/from claude). When provided, a paperclip button with a
   * count badge is rendered in the right group. Terminal mode only. */
  onOpenFiles?: () => void;
  filesCount?: number;
}

function basename(p: string): string {
  const parts = p.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || p;
}

/** Split glyphs — a frame with a vertical/horizontal divider (the Icon set has none; same 24×24 /
 *  currentColor / 1.75-stroke conventions as SessionList's local PencilGlyph). Decorative. */
function SplitRightGlyph() {
  return (
    <svg
      width="17"
      height="17"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <rect x="3.5" y="5" width="17" height="14" rx="2" />
      <path d="M12 5v14" />
    </svg>
  );
}
function SplitDownGlyph() {
  return (
    <svg
      width="17"
      height="17"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <rect x="3.5" y="5" width="17" height="14" rx="2" />
      <path d="M3.5 12h17" />
    </svg>
  );
}

// A neutral icon tile (spec .ib) that brightens to text on hover — NEUTRAL, no coral. Sized to the 44px
// touch minimum; the glyph inside stays compact. Shared by the search / MCP / settings header buttons.
const iconTileStyle: CSSProperties = {
  width: "36px",
  height: "36px",
  flex: "none",
  display: "grid",
  placeItems: "center",
  borderRadius: 9,
  background: "var(--surface-2)",
  border: "1px solid var(--border)",
  color: "var(--text-muted)",
  cursor: "pointer",
};

export function ChatHeader({
  session,
  onOpenSettings,
  onOpenHelp,
  onOpenSearch,
  onOpenMcp,
  onShowSessions,
  needsYou = 0,
  onClose,
  onSplitRight,
  onSplitDown,
  closeIsPane = false,
  dragPaneId,
  onOpenFiles,
  filesCount = 0,
}: ChatHeaderProps) {
  // The session's display name — live: re-reads on every rename (the rail dispatches the change event).
  const names = useSessionNames();
  const displayName = displaySessionName(session, names);
  // The split button's direction menu ("side by side" vs "stacked") — one button, pick on press (user
  // request). Any outside click closes it (the button itself stopPropagation-toggles).
  const [splitMenuOpen, setSplitMenuOpen] = useState(false);
  useEffect(() => {
    if (!splitMenuOpen) return undefined;
    const close = (): void => setSplitMenuOpen(false);
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [splitMenuOpen]);
  // Keep the default bar to identity + concise runtime. The path and full safety policy are available in
  // one disclosure instead of competing with the conversation controls (especially on a phone).
  const [runtimeDetailsOpen, setRuntimeDetailsOpen] = useState(false);
  useEffect(() => {
    if (!runtimeDetailsOpen) return undefined;
    const close = (): void => setRuntimeDetailsOpen(false);
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [runtimeDetailsOpen]);
  const providerMeta = providerSessionDisplay(session);
  const provider = session.provider ?? "claude";
  const compactEffort = providerMeta.effort?.replace(/ reasoning$/, "");
  const runtime = [
    ...(providerMeta.model ? [{ kind: "model", value: providerMeta.model }] : []),
    ...(compactEffort ? [{ kind: "effort", value: compactEffort }] : []),
  ];
  const runtimeDetails = [providerMeta.provider, providerMeta.model, providerMeta.effort].filter(
    (part): part is string => Boolean(part),
  );
  return (
    <header
      aria-label={`Session ${basename(session.cwd)}`}
      draggable={dragPaneId !== undefined || undefined}
      onDragStart={
        dragPaneId !== undefined
          ? (e) => {
              e.dataTransfer.setData(PANE_MIME, dragPaneId);
              e.dataTransfer.effectAllowed = "move";
            }
          : undefined
      }
      title={dragPaneId !== undefined ? "Drag to move this pane" : undefined}
      style={{
        display: "flex",
        alignItems: "center",
        gap: "10px",
        // Compact, flat top bar (spec .bar): a single hairline border-bottom, no glass, no float.
        // Sits flush against the chat — small + precise, neutral status.
        padding: "calc(6px + env(safe-area-inset-top, 0px)) 14px 6px",
        borderBottom: "1px solid var(--border)",
        background: "var(--bg)",
      }}
    >
      {/* Top-left, IN-FLOW mobile menu button — the first item in the header row, before the cwd, so
          it never overlaps the session name (the name sits to its right). Mobile-only (hidden at the
          desktop breakpoint where the rail is always visible). Replaces the old floating FAB. */}
      {onShowSessions && <MobileMenuButton onShowSessions={onShowSessions} needsYou={needsYou} />}
      {/* The brand mark. Hidden on mobile (the menu button is the left affordance there; showing both
          the menu button AND the mark crowds the bar). Shown on desktop, where there's no menu button. */}
      <span
        aria-hidden
        className="rc-hdr-mark"
        style={{
          width: 26,
          height: 26,
          flex: "none",
          borderRadius: 7,
          display: "grid",
          placeItems: "center",
          background: "var(--tile-bg)",
          border: "1px solid var(--tile-edge)",
          color: "var(--coral)",
        }}
      >
        <Icon name="terminal" size={15} />
      </span>
      <style>{`
        .rc-hdr-iconbtn:hover { color: var(--text); border-color: var(--border-strong); }
        .rc-hdr-files-btn { display: none !important; }
        @media (hover: hover) and (pointer: fine) { .rc-hdr-files-btn { display: grid !important; } }
        .rc-hdr-provider-icon { margin-right: 6px; }
        .rc-hdr-runtime-item { display: inline-flex; align-items: center; flex: none; }
        .rc-hdr-runtime-sep { flex: none; margin: 0 6px; color: var(--text-faint); }
        .rc-hdr-details-wrap { position: relative; flex: none; }
        .rc-hdr-details-btn--danger {
          width: auto !important; padding: 0 10px; gap: 6px;
          display: inline-flex !important; align-items: center; justify-content: center;
          color: var(--warn) !important; background: rgba(217, 164, 65, .12) !important;
          border-color: rgba(217, 164, 65, .36) !important;
          font: 600 var(--fs-xs)/1 var(--font-mono);
        }
        .rc-hdr-details-popover {
          position: absolute; top: calc(100% + 7px); right: 0; z-index: 80;
          width: min(330px, calc(100vw - 20px)); max-height: min(430px, calc(100vh - 78px)); overflow: auto;
          padding: 12px; display: flex; flex-direction: column; gap: 11px;
          background: var(--surface-2); border: 1px solid var(--border-strong); border-radius: 10px;
          box-shadow: var(--shadow-1); color: var(--text);
        }
        .rc-hdr-details-title { font-size: var(--fs-sm); font-weight: 600; }
        .rc-hdr-details-row { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
        .rc-hdr-details-label {
          display: inline-flex; align-items: center; gap: 5px;
          color: var(--text-faint); font: var(--fs-xs)/1.3 var(--font-mono); text-transform: uppercase; letter-spacing: .04em;
        }
        .rc-hdr-details-value {
          color: var(--text-muted); font: var(--fs-xs)/1.5 var(--font-mono); overflow-wrap: anywhere;
        }
        .rc-hdr-details-row--danger .rc-hdr-details-label,
        .rc-hdr-details-row--danger .rc-hdr-details-value { color: var(--warn); }
        @media (max-width: 767px) {
          .rc-hdr-mark { display: none !important; }
          .rc-hdr-runtime-item--model { display: none; }
          .rc-hdr-details-btn--danger { width: 36px !important; padding: 0; }
          .rc-hdr-details-btn-label { display: none; }
          .rc-hdr-details-popover {
            position: fixed; top: calc(55px + env(safe-area-inset-top, 0px)); left: 10px; right: 10px;
            width: auto; max-height: calc(100vh - 72px - env(safe-area-inset-top, 0px));
          }
        }
      `}</style>
      {/* `flex: 1` so the identity column takes the slack between the menu button and the right-side
          status group (keeping that group pinned right); `min-width: 0` lets the path ellipsis clip.
          Mockup .hdr-id: the bold name (.cwd) over ONE quiet mono .meta line. */}
      <div style={{ display: "flex", flexDirection: "column", gap: "1px", minWidth: 0, flex: 1 }}>
        {/* The session's DISPLAY name (the rail rename if set, else the cwd basename — it used to show the
            stale basename after a rename; session/names.ts keeps this live) — the clearest header line. */}
        <strong
          className="display"
          style={{
            fontSize: "13px",
            fontWeight: 600,
            letterSpacing: "0.2px",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {displayName}
        </strong>
        {/* ONE compact mono line: provider mark + model · effort. The provider's full name, directory and
            safety policy remain in the details disclosure, keeping desktop calmer and mobile legible. */}
        <div
          className="rc-hdr-meta"
          style={{
            display: "flex",
            gap: "6px",
            alignItems: "center",
            minWidth: 0,
            overflow: "hidden",
            fontSize: "var(--fs-xs)",
          }}
        >
          <span
            className="rc-hdr-runtime"
            style={{
              fontFamily: "var(--font-mono)",
              color: "var(--text-muted)",
              display: "flex",
              alignItems: "center",
              flex: "1 1 auto",
              minWidth: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            <ProviderIcon provider={provider} className="rc-hdr-provider-icon" />
            {runtime.map((part, index) => (
              <span key={part.kind} className={`rc-hdr-runtime-item rc-hdr-runtime-item--${part.kind}`}>
                {index > 0 && (
                  <span className="rc-hdr-runtime-sep" aria-hidden="true">
                    ·
                  </span>
                )}
                {part.value}
              </span>
            ))}
          </span>
        </div>
      </div>
      {/* `flex: none` so the status/settings group keeps its intrinsic width and is never
          squeezed or overlapped by the path column. */}
      <div style={{ display: "flex", alignItems: "center", gap: "8px", flex: "none" }}>
        <div className="rc-hdr-details-wrap">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setRuntimeDetailsOpen((open) => !open);
            }}
            aria-label={providerMeta.dangerous ? "Unsafe session details" : "Session details"}
            aria-expanded={runtimeDetailsOpen}
            title="Session runtime and safety details"
            className={`rc-hdr-iconbtn${providerMeta.dangerous ? " rc-hdr-details-btn--danger" : ""}`}
            style={iconTileStyle}
          >
            <Icon name={providerMeta.dangerous ? "alert" : "sliders"} size={16} />
            {providerMeta.dangerous && <span className="rc-hdr-details-btn-label">Unsafe</span>}
          </button>
          {runtimeDetailsOpen && (
            <div
              className="rc-hdr-details-popover"
              role="group"
              aria-label="Session runtime and safety"
              onClick={(e) => e.stopPropagation()}
            >
              <strong className="rc-hdr-details-title">Session details</strong>
              <div className="rc-hdr-details-row">
                <span className="rc-hdr-details-label">Runtime</span>
                <span className="rc-hdr-details-value">{runtimeDetails.join(" · ")}</span>
              </div>
              <div className="rc-hdr-details-row">
                <span className="rc-hdr-details-label">
                  <Icon name="folder" size={13} />
                  Directory
                </span>
                <span className="rc-hdr-details-value">{session.cwd}</span>
              </div>
              <div className={`rc-hdr-details-row${providerMeta.dangerous ? " rc-hdr-details-row--danger" : ""}`}>
                <span className="rc-hdr-details-label">
                  <Icon name={providerMeta.dangerous ? "alert" : "lock"} size={13} />
                  Safety
                </span>
                <span className="rc-hdr-details-value">{providerMeta.safety.join(" · ")}</span>
              </div>
            </div>
          )}
        </div>
        {onOpenFiles && (
          <button
            type="button"
            onClick={onOpenFiles}
            aria-label={filesCount > 0 ? `Files, ${filesCount}` : "Files"}
            className="rc-hdr-iconbtn rc-hdr-files-btn"
            style={{ ...iconTileStyle, position: "relative" }}
          >
            <Icon name="paperclip" size={17} />
            {filesCount > 0 && (
              <span
                aria-hidden
                style={{
                  position: "absolute",
                  top: -5,
                  right: -5,
                  minWidth: 17,
                  height: 17,
                  padding: "0 4px",
                  display: "grid",
                  placeItems: "center",
                  background: "var(--coral)",
                  color: "var(--on-accent)",
                  border: "2px solid var(--bg)",
                  borderRadius: 999,
                  font: "700 10px/1 var(--font-mono)",
                }}
              >
                {filesCount}
              </span>
            )}
          </button>
        )}
        {onOpenHelp && (
          <button
            type="button"
            onClick={onOpenHelp}
            aria-label="Help — gestures and keys"
            className="rc-hdr-iconbtn"
            // No "?" glyph in the icon set (and icons live outside chat/) — a mono "?" reads unambiguously.
            style={{ ...iconTileStyle, fontFamily: "var(--font-mono)", fontWeight: 700, fontSize: 16 }}
          >
            ?
          </button>
        )}
        {onOpenSearch && (
          <button
            type="button"
            onClick={onOpenSearch}
            aria-label="Search conversation"
            className="rc-hdr-iconbtn"
            style={iconTileStyle}
          >
            <Icon name="search" size={17} />
          </button>
        )}
        {onOpenMcp && (
          <button
            type="button"
            onClick={onOpenMcp}
            aria-label="MCP servers"
            className="rc-hdr-iconbtn"
            style={iconTileStyle}
          >
            <Icon name="sliders" size={17} />
          </button>
        )}
        {(onSplitRight || onSplitDown) && (
          <div style={{ position: "relative", flex: "none" }}>
            {/* ONE split button (user request) — pressing it asks which way: side-by-side or stacked. */}
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation(); // don't let the document listener instantly re-close it
                setSplitMenuOpen((v) => !v);
              }}
              aria-label="Split pane"
              aria-expanded={splitMenuOpen}
              title="Split this pane"
              className="rc-hdr-iconbtn"
              style={iconTileStyle}
            >
              <SplitRightGlyph />
            </button>
            {splitMenuOpen && (
              <div className="rc-hdr-splitmenu" role="menu" aria-label="Split direction">
                {onSplitRight && (
                  <button
                    type="button"
                    role="menuitem"
                    className="rc-hdr-splitmenu__item"
                    onClick={() => {
                      setSplitMenuOpen(false);
                      onSplitRight();
                    }}
                  >
                    <SplitRightGlyph />
                    Side by side
                  </button>
                )}
                {onSplitDown && (
                  <button
                    type="button"
                    role="menuitem"
                    className="rc-hdr-splitmenu__item"
                    onClick={() => {
                      setSplitMenuOpen(false);
                      onSplitDown();
                    }}
                  >
                    <SplitDownGlyph />
                    Stacked
                  </button>
                )}
                <style>{`
                  .rc-hdr-splitmenu {
                    position: absolute; top: calc(100% + 6px); right: 0; z-index: 60;
                    display: flex; flex-direction: column; gap: 2px; padding: 4px;
                    background: var(--surface-2); border: 1px solid var(--border-strong);
                    border-radius: 10px; box-shadow: var(--shadow-1); min-width: 150px;
                  }
                  .rc-hdr-splitmenu__item {
                    display: flex; align-items: center; gap: 8px;
                    padding: 8px 10px; border-radius: 7px; cursor: pointer; text-align: left;
                    background: transparent; border: none; color: var(--text);
                    font-size: var(--fs-sm); font-family: inherit; white-space: nowrap;
                  }
                  .rc-hdr-splitmenu__item:hover { background: var(--surface-3); }
                `}</style>
              </div>
            )}
          </div>
        )}
        {onOpenSettings && (
          <button
            type="button"
            onClick={onOpenSettings}
            aria-label="Session settings"
            className="rc-hdr-iconbtn"
            style={iconTileStyle}
          >
            <Icon name="settings" size={17} />
            <style>{`.rc-hdr-iconbtn:hover { color: var(--text); border-color: var(--border-strong); }`}</style>
          </button>
        )}
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            aria-label={closeIsPane ? "Close pane" : "Close session"}
            title={closeIsPane ? "Close this pane (the session keeps running — reopen it from the rail)" : undefined}
            className="rc-hdr-iconbtn"
            style={iconTileStyle}
          >
            <Icon name="x" size={17} />
          </button>
        )}
      </div>
    </header>
  );
}
