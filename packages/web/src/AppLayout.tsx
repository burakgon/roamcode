import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Icon } from "./ui/Icon";
import { useFocusTrap } from "./ui/useFocusTrap";
import type { RailMode } from "./hosts/host-ui-state";

export interface AppLayoutProps {
  children: ReactNode;
  sessionList?: ReactNode;
  /** Hide the mobile sessions sheet (the scrim / sheet close-button / Escape). The OPEN trigger now lives
   * in the header / landing state (a top-left in-flow menu button), so this layout no longer needs an
   * onShowSessions or a needsYou pip — those were dead props. */
  onHideSessions?: () => void;
  sessionsOpen?: boolean;
  /** Desktop rail density. Mobile always uses the full-width switcher. */
  railMode?: RailMode;
  /**
   * When a conversation occupies the main panel, the mobile switcher is closed; mounting the hidden
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
 * rail always visible. Mobile: the conversation is full-bleed and `sessionsOpen` replaces it with a
 * full-screen switcher above the persistent terminal key bar. An in-flow header/landing control opens
 * it, while its own close button dismisses it. Layout is CSS-driven so the desktop rail is unaffected.
 */
export function AppLayout({
  children,
  sessionList,
  onHideSessions,
  sessionsOpen,
  conversationActive,
  railMode = "expanded",
}: AppLayoutProps) {
  const sessionSheetOpen = Boolean(sessionsOpen);
  const open = sessionSheetOpen ? "true" : "false";
  const isDesktop = useIsDesktop();
  // The mobile switcher is a modal overlay; the desktop rail is a permanent pane. Only the modal
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
  const showRailContent = isDesktop || sessionSheetOpen || !conversationActive;
  return (
    <div className="rc-shell" data-conversation-active={conversationActive ? "true" : "false"}>
      {sessionSheetOpen && (
        <button type="button" className="rc-scrim" aria-label="Close sessions" onClick={onHideSessions} />
      )}

      <aside
        ref={railRef}
        className="rc-rail"
        data-testid="sessions-rail"
        data-open={open}
        data-mode={railMode}
        {...(sheetIsModal ? { role: "dialog", "aria-modal": true, "aria-label": "Sessions" } : {})}
      >
        {/* Mobile-only close control overlays the switcher's shared header row. Hidden on desktop. */}
        <div className="rc-rail__chrome">
          <button type="button" className="rc-rail__close-btn" aria-label="Hide sessions" onClick={onHideSessions}>
            <Icon name="x" size={18} />
          </button>
        </div>
        {showRailContent && sessionList && <div className="rc-rail__body">{sessionList}</div>}
      </aside>

      <main className="rc-main">{children}</main>

      <style>{`
        /* flex:1 (not height:100%) so the shell fills the space LEFT by any top banners instead of taking
           the full --app-height and overflowing under them (see #root in global.css). */
        .rc-shell { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; position: relative; }
        .rc-main { flex: 1; min-height: 0; overflow-y: auto; }
        .rc-rail__body { min-height: 0; }
        /* Mobile Sessions is an app surface rather than a partial workaround sheet. It occupies the full
           viewport above the always-available terminal key bar, so long lists scroll natively in one region. */
        .rc-rail {
          background: var(--bg);
          position: fixed; inset: 0; z-index: 40;
          max-height: none; overflow: hidden;
          border: 0; border-radius: 0; box-shadow: none;
          display: flex; flex-direction: column;
          transform: translateY(0);
          animation: rc-rail-in 160ms cubic-bezier(0.16, 1, 0.3, 1);
        }
        .rc-shell[data-conversation-active="true"] .rc-rail {
          bottom: calc(57px + var(--kb-safe-bottom, env(safe-area-inset-bottom, 0px)));
        }
        @keyframes rc-rail-in { from { transform: translateY(8px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
        .rc-rail[data-open="false"] { display: none; }
        .rc-rail__body { flex: 1; min-height: 0; overflow: hidden; }
        /* The close control shares the Sessions header row, matching the selected full-screen reference. */
        .rc-rail__chrome {
          position: absolute; inset: 0 auto auto 0; z-index: 2;
          width: 56px; height: calc(64px + env(safe-area-inset-top, 0px));
        }
        .rc-rail__close-btn {
          position: absolute; top: calc(10px + env(safe-area-inset-top, 0px)); left: 8px;
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
          background: var(--bg); animation: rc-fade 140ms ease;
        }
        .rc-shell[data-conversation-active="true"] .rc-scrim {
          bottom: calc(57px + var(--kb-safe-bottom, env(safe-area-inset-bottom, 0px)));
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
            transition: width 160ms ease;
          }
          .rc-rail[data-mode="compact"] { width: var(--rail-w-compact); }
          .rc-rail__body { flex: 1; min-height: 0; overflow: hidden; }
          .rc-rail__chrome, .rc-scrim { display: none; }
        }
      `}</style>
    </div>
  );
}
