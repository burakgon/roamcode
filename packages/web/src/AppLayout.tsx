import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Icon } from "./ui/Icon";
import { useFocusTrap } from "./ui/useFocusTrap";

export interface AppLayoutProps {
  children: ReactNode;
  sessionList?: ReactNode;
  /** One product navigation plane. It shares the existing rail instead of creating a second icon rail. */
  navigation?: ReactNode;
  /** The same destinations in a thumb-reachable mobile treatment, rendered outside terminal workbenches. */
  mobileNavigation?: ReactNode;
  /** Only Sessions owns the mobile session switcher sheet. Other destinations keep the rail desktop-only. */
  showSessionRail?: boolean;
  /** Keep global navigation out of an active terminal workbench so the terminal retains its full viewport. */
  showMobileNavigation?: boolean;
  /** Hide the mobile sessions sheet (the scrim / sheet close-button / Escape). The OPEN trigger now lives
   * in the header / landing state (a top-left in-flow menu button), so this layout no longer needs an
   * onShowSessions or a needsYou pip — those were dead props. */
  onHideSessions?: () => void;
  sessionsOpen?: boolean;
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
  navigation,
  mobileNavigation,
  showSessionRail = true,
  showMobileNavigation = false,
  onHideSessions,
  sessionsOpen,
  conversationActive,
}: AppLayoutProps) {
  const sessionSheetOpen = showSessionRail && Boolean(sessionsOpen);
  const open = sessionSheetOpen ? "true" : "false";
  const isDesktop = useIsDesktop();
  // The mobile sheet is a MODAL (scrim + overlay); the desktop rail is a permanent pane. Only the modal
  // form gets dialog semantics: a focus trap, Escape-to-close, and role/aria-modal.
  const railRef = useRef<HTMLElement>(null);
  const sheetIsModal = sessionSheetOpen && !isDesktop;
  useFocusTrap(railRef, sheetIsModal);
  useEffect(() => {
    if (!sheetIsModal) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onHideSessions?.();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sheetIsModal, onHideSessions]);
  // On desktop the rail is permanently visible, so always mount the list. On mobile the rail is a
  // bottom sheet: keep mounting the list (so it's ready when the sheet opens) EXCEPT while a
  // conversation owns the main panel and the sheet is closed — then the hidden list would just be a
  // duplicate of the active session behind the chat, so we drop it from the DOM/a11y tree.
  const showRailContent = showSessionRail && (isDesktop || sessionSheetOpen || !conversationActive);
  return (
    <div className="rc-shell">
      {sessionSheetOpen && (
        <button type="button" className="rc-scrim" aria-label="Close sessions" onClick={onHideSessions} />
      )}

      <aside
        ref={railRef}
        className="rc-rail"
        data-testid="sessions-rail"
        data-open={open}
        {...(sheetIsModal ? { role: "dialog", "aria-modal": true, "aria-label": "Sessions" } : {})}
      >
        {navigation && <div className="rc-rail__navigation">{navigation}</div>}
        {/* Mobile-only sheet chrome: a centered grab-handle + a right-aligned close, in their OWN
            fixed-height row, so the content below (the usage bars, the session list) never sits under
            the close button. Hidden on desktop. */}
        <div className="rc-rail__chrome">
          <span className="rc-rail__handle" aria-hidden="true" />
          <button type="button" className="rc-rail__close-btn" aria-label="Hide sessions" onClick={onHideSessions}>
            <Icon name="x" size={18} />
          </button>
        </div>
        {showRailContent && sessionList && <div className="rc-rail__body">{sessionList}</div>}
      </aside>

      <main className="rc-main">{children}</main>
      {showMobileNavigation && mobileNavigation && (
        <div className="rc-shell__mobile-navigation">{mobileNavigation}</div>
      )}

      <style>{`
        /* flex:1 (not height:100%) so the shell fills the space LEFT by any top banners instead of taking
           the full --app-height and overflowing under them (see #root in global.css). */
        .rc-shell { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; position: relative; }
        .rc-main { flex: 1; min-height: 0; overflow-y: auto; }
        .rc-rail__navigation {
          display: block; flex: none;
          padding: 0 var(--sp-3) var(--sp-3);
          border-bottom: 1px solid var(--border);
        }
        .rc-rail__body { min-height: 0; }
        .rc-shell__mobile-navigation { flex: none; position: relative; z-index: 20; }
        /* The mobile sessions sheet is floating chrome, so it uses the system's restrained translucent
           surface and blur. A hairline and neutral shadow separate it from the terminal. */
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
        /* Mobile sheet chrome row — its OWN height so the close never overlaps the content below. */
        .rc-rail__chrome { position: relative; flex: none; height: 40px; }
        /* The sheet grab-handle — a small centered hairline pill, absolutely centered in the chrome row. */
        .rc-rail__handle {
          position: absolute; top: 8px; left: 50%; transform: translateX(-50%);
          width: 40px; height: 4px; border-radius: 999px; background: var(--border-strong);
        }
        .rc-rail__close-btn {
          position: absolute; top: 0; right: 6px;
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
          /* On desktop the rail is a permanent sister pane separated from the terminal by one hairline. */
          .rc-rail {
            position: static; width: var(--rail-w); max-height: none; height: 100%;
            background: transparent; backdrop-filter: none; -webkit-backdrop-filter: none;
            border-top: none; border-radius: 0;
            border-right: 1px solid var(--border);
            box-shadow: none; overflow: hidden;
            display: flex !important; flex-direction: column; animation: none;
          }
          .rc-rail__navigation {
            display: block; flex: none;
            padding: var(--sp-3);
            border-bottom: 1px solid var(--border);
          }
          .rc-rail__body { flex: 1; min-height: 0; overflow-y: auto; }
          .rc-shell__mobile-navigation { display: none; }
          .rc-rail__chrome, .rc-scrim { display: none; }
        }
      `}</style>
    </div>
  );
}
