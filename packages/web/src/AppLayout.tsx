import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { Icon } from "./ui/Icon";

export interface AppLayoutProps {
  children: ReactNode;
  sessionList: ReactNode;
  /** Open the mobile sessions sheet. Kept on the layout's plumbing for the caller (App), but the
   * trigger itself now lives in the header / landing state (a top-left, in-flow menu button) rather
   * than a floating FAB — so it never overlaps the conversation or composer. */
  onShowSessions?: () => void;
  onHideSessions?: () => void;
  sessionsOpen?: boolean;
  /** Count of sessions awaiting a permission/question. Drives the "needs you" pip on the (now header-
   * /landing-owned) mobile menu button, so attention is visible from any chat with the rail closed. */
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
 * bottom sheet toggled by `sessionsOpen`. The sheet is opened by a top-left, in-flow menu button
 * owned by the header / landing state (not a floating FAB, so nothing overlaps the composer); a
 * backdrop + the sheet's own close button dismiss it. Layout is CSS-driven so the desktop rail is
 * unaffected by `sessionsOpen`.
 */
export function AppLayout({
  children,
  sessionList,
  onHideSessions,
  sessionsOpen,
  conversationActive,
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

      <style>{`
        .rc-shell { height: 100%; display: flex; flex-direction: column; position: relative; }
        .rc-main { flex: 1; min-height: 0; overflow-y: auto; }
        /* The mobile sessions SHEET — a liquid-glass panel (translucent warm fill + blur) over the
           warm-dark atmosphere, separated from the chat by a hairline and lifted by the modal drop
           shadow. The sticky .sl-head (owned by SessionList) is its own glass bar. */
        .rc-rail {
          background: var(--glass-strong);
          backdrop-filter: var(--glass-blur);
          -webkit-backdrop-filter: var(--glass-blur);
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
          width: 40px; height: 4px; flex: none;
          margin: var(--sp-2) auto 0;
          border-radius: 999px; background: var(--border-strong);
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
        @media (min-width: 768px) {
          .rc-shell { flex-direction: row; }
          /* On desktop the rail is a permanent two-pane sister to the chat — transparent so the
             warm-dark atmosphere shows through behind the glass session cards, separated from the
             chat by a simple hairline. */
          .rc-rail {
            position: static; width: var(--rail-w); max-height: none; height: 100%;
            background: transparent; backdrop-filter: none; -webkit-backdrop-filter: none;
            border-top: none; border-radius: 0;
            border-right: 1px solid var(--border);
            box-shadow: none;
            display: block !important; animation: none;
          }
          .rc-rail__handle, .rc-rail__close, .rc-scrim { display: none; }
        }
      `}</style>
    </div>
  );
}
