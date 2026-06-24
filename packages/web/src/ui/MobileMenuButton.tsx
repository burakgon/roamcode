import { Icon } from "./Icon";

export interface MobileMenuButtonProps {
  /** Open the mobile sessions sheet. */
  onShowSessions: () => void;
  /** Count of sessions awaiting a permission/question. When > 0 the button carries a loud iris
   * "needs you" pip and the count is folded into the button's aria-label. */
  needsYou?: number;
}

/**
 * The mobile, top-left, IN-FLOW "Show sessions" menu button — a glassy icon tile that warms to violet
 * on hover/focus, with an iris "needs you" count pip when sessions are awaiting attention. It replaces
 * the old floating FAB: rendered as a normal flex/grid child (header row's first item, or the top-left
 * of the landing panel) so it never overlaps the conversation or composer. Mobile-only — hidden at the
 * desktop breakpoint (≥768px) where the session rail is permanently visible. Reduced-motion-safe.
 */
export function MobileMenuButton({ onShowSessions, needsYou = 0 }: MobileMenuButtonProps) {
  return (
    <button
      type="button"
      className="rc-menu-btn"
      onClick={onShowSessions}
      aria-label={needsYou > 0 ? `Show sessions, ${needsYou} need you` : "Show sessions"}
    >
      <Icon name="menu" size={18} />
      {needsYou > 0 && (
        <span className="rc-menu-btn__badge" aria-hidden="true">
          {needsYou}
        </span>
      )}
      <style>{`
        /* Mockup .iconbtn — a compact 38px glassy tile (radius 11px) that warms to accent on hover. */
        .rc-menu-btn {
          position: relative; flex: none;
          width: 38px; height: 38px;
          display: grid; place-items: center;
          border-radius: 11px;
          background: var(--surface-2); border: 1px solid var(--border);
          color: var(--text-muted); cursor: pointer;
          transition: color 120ms ease, border-color 120ms ease, background 120ms ease;
        }
        .rc-menu-btn:hover { color: var(--accent); border-color: var(--accent-line); }
        /* The iris "needs you" count pip pinned to the top-right corner — tabular so 1/2/9 line up,
           ringed in --bg so it lifts off the surface. Restrained (no loud halo) — the loud awaiting
           signal lives on the rail row + the iris card; this is a quiet at-a-glance count. */
        .rc-menu-btn__badge {
          position: absolute; top: -4px; right: -4px;
          min-width: 18px; height: 18px; padding: 0 5px;
          display: grid; place-items: center;
          background: var(--iris); color: var(--on-iris);
          border: 2px solid var(--bg); border-radius: 999px;
          font-family: var(--font-mono); font-size: 11px; font-weight: 700; line-height: 1;
          font-variant-numeric: tabular-nums;
        }
        /* Desktop (≥768px): the rail is always visible, so the menu button is unnecessary. */
        @media (min-width: 768px) { .rc-menu-btn { display: none; } }
        @media (prefers-reduced-motion: reduce) { .rc-menu-btn { transition: none; } }
      `}</style>
    </button>
  );
}
