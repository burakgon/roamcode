import type { ReactNode } from "react";

export interface AppLayoutProps {
  children: ReactNode;
  sessionList: ReactNode;
  onShowSessions?: () => void;
  onHideSessions?: () => void;
  sessionsOpen?: boolean;
}

/**
 * Mission-control responsive shell. Desktop (≥768px): left rail + right conversation, with the
 * rail always visible. Mobile: the conversation is full-bleed and the session list lives in a
 * bottom sheet toggled by `sessionsOpen`. A thumb-reachable "Sessions" pill (mobile-only) opens
 * the sheet; a backdrop + the sheet's own close button dismiss it. Layout is CSS-driven so the
 * desktop rail is unaffected by `sessionsOpen`.
 */
export function AppLayout({ children, sessionList, onShowSessions, onHideSessions, sessionsOpen }: AppLayoutProps) {
  const open = sessionsOpen ? "true" : "false";
  return (
    <div className="rc-shell">
      {sessionsOpen && (
        <button
          type="button"
          className="rc-scrim"
          aria-label="Close sessions"
          onClick={onHideSessions}
        />
      )}

      <aside className="rc-rail" data-testid="sessions-rail" data-open={open}>
        <div className="rc-rail__close">
          <button type="button" className="rc-rail__close-btn" aria-label="Hide sessions" onClick={onHideSessions}>
            Close
          </button>
        </div>
        {sessionList}
      </aside>

      <main className="rc-main">{children}</main>

      {/* Thumb-reachable mobile control — opens the sessions sheet. Hidden on desktop. */}
      <button
        type="button"
        className="rc-sessions-fab"
        aria-label="Show sessions"
        aria-expanded={sessionsOpen ? "true" : "false"}
        onClick={onShowSessions}
      >
        ☰ Sessions
      </button>

      <style>{`
        .rc-shell { height: 100%; display: flex; flex-direction: column; position: relative; }
        .rc-main { flex: 1; min-height: 0; overflow-y: auto; }
        .rc-rail {
          background: var(--surface); border-bottom: 1px solid var(--border);
          position: fixed; left: 0; right: 0; bottom: 0; z-index: 40;
          max-height: 80vh; overflow-y: auto;
          border-top: 1px solid var(--border);
          border-top-left-radius: var(--radius); border-top-right-radius: var(--radius);
          box-shadow: var(--shadow);
          transform: translateY(0);
          animation: rc-rail-in 220ms cubic-bezier(0.16, 1, 0.3, 1);
        }
        @keyframes rc-rail-in { from { transform: translateY(16px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
        .rc-rail[data-open="false"] { display: none; }
        .rc-rail__close { display: flex; justify-content: flex-end; padding: var(--sp-2) var(--sp-3) 0; }
        .rc-rail__close-btn {
          min-height: var(--tap-min); background: transparent; border: none;
          color: var(--text-muted); cursor: pointer; padding: 0 var(--sp-2); font: inherit;
        }
        .rc-scrim {
          position: fixed; inset: 0; z-index: 39; border: none; cursor: pointer;
          background: var(--scrim); animation: rc-fade 160ms ease;
        }
        @keyframes rc-fade { from { opacity: 0; } to { opacity: 1; } }
        .rc-sessions-fab {
          position: fixed; left: 50%; transform: translateX(-50%);
          bottom: calc(env(safe-area-inset-bottom, 0px) + var(--sp-4));
          z-index: 38; min-height: var(--tap-min); padding: 0 var(--sp-5);
          background: var(--accent); color: var(--on-accent); border: none;
          border-radius: 999px; font: inherit; font-weight: 600; cursor: pointer;
          box-shadow: var(--shadow);
        }
        @media (min-width: 768px) {
          .rc-shell { flex-direction: row; }
          .rc-rail {
            position: static; width: var(--rail-w); max-height: none; height: 100%;
            border-bottom: none; border-top: none; border-radius: 0;
            border-right: 1px solid var(--border);
            display: block !important; box-shadow: none; animation: none;
          }
          .rc-rail__close, .rc-scrim, .rc-sessions-fab { display: none; }
        }
      `}</style>
    </div>
  );
}
