import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { Icon } from "./ui/Icon";

export interface AppLayoutProps {
  children: ReactNode;
  sessionList: ReactNode;
  onShowSessions?: () => void;
  onHideSessions?: () => void;
  sessionsOpen?: boolean;
  /** Count of sessions awaiting a permission/question. When > 0 the mobile sessions toggle shows a
   * loud iris "needs you" badge so attention is visible from any chat, even with the rail closed. */
  needsYou?: number;
  /**
   * When a conversation occupies the main panel, the mobile sheet is collapsed; mounting the hidden
   * session list behind it would leave a duplicate of the active session (cwd/name) in the DOM and
   * a11y tree. Pass `true` to keep the rail's list out of the DOM while it's the off-screen sheet on
   * mobile. On desktop (rail always visible) and on the landing screen this has no effect.
   */
  conversationActive?: boolean;
}

const DESKTOP_QUERY = "(min-width: 768px)";

/**
 * True on the desktop breakpoint (≥768px), where the rail is permanently visible. On mobile the
 * rail is an off-screen bottom sheet: we only MOUNT its contents while it is open so the hidden
 * session list never sits in the DOM/accessibility tree behind the conversation. Falls back to
 * `false` (mobile-first) where `matchMedia` is unavailable (e.g. jsdom / SSR).
 */
function useIsDesktop(): boolean {
  const [desktop, setDesktop] = useState(
    () =>
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia(DESKTOP_QUERY).matches,
  );
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mql = window.matchMedia(DESKTOP_QUERY);
    const onChange = () => setDesktop(mql.matches);
    onChange();
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);
  return desktop;
}

/**
 * Mission-control responsive shell. Desktop (≥768px): left rail + right conversation, with the
 * rail always visible. Mobile: the conversation is full-bleed and the session list lives in a
 * bottom sheet toggled by `sessionsOpen`. A thumb-reachable "Sessions" pill (mobile-only) opens
 * the sheet; a backdrop + the sheet's own close button dismiss it. Layout is CSS-driven so the
 * desktop rail is unaffected by `sessionsOpen`.
 */
export function AppLayout({
  children,
  sessionList,
  onShowSessions,
  onHideSessions,
  sessionsOpen,
  conversationActive,
  needsYou = 0,
}: AppLayoutProps) {
  const open = sessionsOpen ? "true" : "false";
  const isDesktop = useIsDesktop();
  // On desktop the rail is permanently visible, so always mount the list. On mobile the rail is a
  // bottom sheet: keep mounting the list (so it's ready when the sheet opens) EXCEPT while a
  // conversation owns the main panel and the sheet is closed — then the hidden list would just be a
  // duplicate of the active session behind the chat, so we drop it from the DOM/a11y tree.
  const showRailContent = isDesktop || Boolean(sessionsOpen) || !conversationActive;
  return (
    <div className="rc-shell">
      {sessionsOpen && (
        <button type="button" className="rc-scrim" aria-label="Close sessions" onClick={onHideSessions} />
      )}

      <aside className="rc-rail" data-testid="sessions-rail" data-open={open}>
        {/* The sheet's grab-handle + close affordance (mobile only). Hairline, restrained chrome. */}
        <div className="rc-rail__handle" aria-hidden="true" />
        <div className="rc-rail__close">
          <button type="button" className="rc-rail__close-btn" aria-label="Hide sessions" onClick={onHideSessions}>
            <Icon name="x" size={18} />
          </button>
        </div>
        {showRailContent && sessionList}
      </aside>

      <main className="rc-main">{children}</main>

      {/* Thumb-reachable mobile control — opens the sessions sheet. An icon button (not a heavy text
          button), anchored bottom-right so it never sits on the composer's Image/File/Send row. When
          sessions need attention it carries a loud iris count badge (visible with the rail closed). */}
      <button
        type="button"
        className="rc-sessions-fab"
        aria-label={needsYou > 0 ? `Show sessions, ${needsYou} need you` : "Show sessions"}
        aria-expanded={sessionsOpen ? "true" : "false"}
        onClick={onShowSessions}
      >
        <Icon name="menu" size={20} />
        {needsYou > 0 && (
          <span className="rc-fab-badge" aria-hidden="true">
            {needsYou}
          </span>
        )}
      </button>

      <style>{`
        .rc-shell { height: 100%; display: flex; flex-direction: column; position: relative; }
        .rc-main { flex: 1; min-height: 0; overflow-y: auto; }
        .rc-rail {
          background: var(--surface);
          position: fixed; left: 0; right: 0; bottom: 0; z-index: 40;
          max-height: 82vh; overflow-y: auto;
          border-top: 1px solid var(--border);
          border-top-left-radius: var(--radius-lg); border-top-right-radius: var(--radius-lg);
          box-shadow: var(--shadow);
          transform: translateY(0);
          animation: rc-rail-in 240ms cubic-bezier(0.16, 1, 0.3, 1);
        }
        @keyframes rc-rail-in { from { transform: translateY(24px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
        .rc-rail[data-open="false"] { display: none; }
        /* The sheet grab-handle — a small centered hairline pill (mobile-only). */
        .rc-rail__handle {
          width: 36px; height: 4px; flex: none;
          margin: var(--sp-2) auto 0;
          border-radius: 999px; background: var(--border);
        }
        .rc-rail__close {
          display: flex; justify-content: flex-end;
          padding: var(--sp-1) var(--sp-2) 0;
          margin-top: -34px; /* float the close over the handle row so the list starts higher */
        }
        .rc-rail__close-btn {
          width: var(--tap-min); height: var(--tap-min); flex: none;
          display: grid; place-items: center;
          background: transparent; border: none;
          color: var(--text-muted); cursor: pointer;
          border-radius: var(--radius);
          transition: color 120ms ease, background 120ms ease;
        }
        .rc-rail__close-btn:hover { color: var(--text); background: var(--surface-2); }
        .rc-scrim {
          position: fixed; inset: 0; z-index: 39; border: none; cursor: pointer;
          background: var(--scrim); animation: rc-fade 180ms ease;
        }
        @keyframes rc-fade { from { opacity: 0; } to { opacity: 1; } }
        .rc-sessions-fab {
          /* Anchored to the bottom-RIGHT corner (not dead-center) so it never sits on top of the
             composer's Image/File/Send row. The composer also reserves bottom clearance (see
             Composer.tsx), so the controls stay fully tappable with the FAB visible at 390px. */
          position: fixed; right: var(--sp-4);
          bottom: calc(env(safe-area-inset-bottom, 0px) + var(--sp-4));
          z-index: 38;
          width: 52px; height: 52px; flex: none;
          display: grid; place-items: center;
          background: var(--accent); color: var(--on-accent); border: none;
          border-radius: 999px; cursor: pointer;
          box-shadow: 0 6px 18px rgba(232, 163, 61, 0.34), var(--shadow);
          transition: transform 120ms ease;
        }
        .rc-sessions-fab:hover { transform: translateY(-1px); }
        /* The iris "needs you" count on the FAB — a small loud pip pinned to the top-right corner,
           tabular so 1/2/9 line up. iris on dark ink so it reads on the amber FAB. */
        .rc-fab-badge {
          position: absolute; top: -2px; right: -2px;
          min-width: 20px; height: 20px; padding: 0 5px;
          display: grid; place-items: center;
          background: var(--iris); color: var(--on-iris);
          border: 2px solid var(--bg); border-radius: 999px;
          font-family: var(--font-mono); font-size: 11px; font-weight: 700; line-height: 1;
          font-variant-numeric: tabular-nums;
        }
        @media (min-width: 768px) {
          .rc-shell { flex-direction: row; }
          .rc-rail {
            position: static; width: var(--rail-w); max-height: none; height: 100%;
            border-top: none; border-radius: 0;
            border-right: 1px solid var(--border);
            display: block !important; box-shadow: none; animation: none;
          }
          .rc-rail__handle, .rc-rail__close, .rc-scrim, .rc-sessions-fab { display: none; }
        }
      `}</style>
    </div>
  );
}
