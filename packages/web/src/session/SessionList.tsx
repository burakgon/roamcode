import { Icon } from "../ui/Icon";
import { LiveWire } from "../ui/LiveWire";
import type { LiveWireState } from "../ui/LiveWire";
import type { SessionMeta } from "../types/server";
import { sortSessionsByActivity } from "./order";
import { relativeTime } from "./relative-time";

export interface SessionListProps {
  sessions: SessionMeta[];
  activeId?: string;
  /** Per-session activity stamps (ms) from the store — drives the most-recent-first order + the
   * per-row relative time. A missing id falls back to that session's createdAt. */
  lastActiveAt: Record<string, number>;
  /** "Wall clock" for the relative-time labels, passed in so the component itself stays free of
   * Date.now() (the parent owns the clock + can re-tick to keep labels fresh). */
  now: number;
  onSelect: (id: string) => void;
  onNew: () => void;
  /** Close (stop + remove) a session in one tap — the row's ✕ button. */
  onClose: (id: string) => void;
  viewWireState: (id: string) => LiveWireState;
}

function basename(p: string): string {
  const parts = p.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || p;
}

function absoluteTime(ms: number): string {
  return new Date(ms).toLocaleString();
}

/** Count of sessions with a pending permission/question (`meta.awaiting`). Drives the global badge. */
export function awaitingCount(sessions: SessionMeta[]): number {
  return sessions.reduce((n, s) => (s.awaiting ? n + 1 : n), 0);
}

/**
 * The global "N need you" badge — a loud iris pill shown in the rail header and on the mobile sessions
 * toggle so a pending permission/question is visible from ANY chat. Renders nothing at zero. The count
 * is paired with text ("need you") so the signal is never color-only (a11y).
 */
export function NeedsYouBadge({ count, className }: { count: number; className?: string }) {
  if (count <= 0) return null;
  return (
    <span className={`rc-needs${className ? ` ${className}` : ""}`} role="status">
      <span className="rc-needs__n">{count}</span>
      <span className="rc-needs__label">need you</span>
    </span>
  );
}

/**
 * The session rail / sheet: a calm, scannable, hairline-separated list (Variant A). Sessions are
 * ordered most-recently-opened/active first (chat-app style) via the store's lastActiveAt stamps, so
 * the session you just opened or that's streaming floats to the top. Each row is one clean entry —
 * the cwd basename in the display font, the muted path beneath it, and a meta line carrying the
 * LiveWire status dot, the model·effort, and a compact relative time. A clear amber left-rail marks
 * the active row. Two affordances live on the right of each row: nothing extra in the body, and a
 * small ✕ button that closes (stops + removes) that session in one tap without selecting it. The
 * header carries a "New session" `+` icon button and a live session count. Works as the desktop rail
 * (var(--rail-w)) and as the mobile sheet.
 */
export function SessionList({
  sessions,
  activeId,
  lastActiveAt,
  now,
  onSelect,
  onNew,
  onClose,
  viewWireState,
}: SessionListProps) {
  const ordered = sortSessionsByActivity(sessions, lastActiveAt);
  const needs = awaitingCount(sessions);

  return (
    <div className="rc-sl">
      <div className="rc-sl__head">
        <span className="display rc-sl__title">
          Sessions
          <span className="rc-sl__count" aria-hidden="true">
            ·
          </span>
          <span className="rc-sl__count-n">{sessions.length}</span>
        </span>
        {/* The global "needs you" badge sits in the header so it's visible whenever the rail is open. */}
        <NeedsYouBadge count={needs} className="rc-sl__needs" />
        <button type="button" className="rc-sl__new" onClick={onNew} aria-label="New session">
          <Icon name="plus" size={18} />
        </button>
      </div>
      <ul className="rc-sl__list">
        {ordered.map((s) => {
          const selected = s.id === activeId;
          const name = basename(s.cwd);
          const activeAt = lastActiveAt[s.id] ?? s.createdAt;
          const awaiting = Boolean(s.awaiting);
          return (
            <li key={s.id} className={`rc-sl__item${awaiting ? " rc-sl__item--awaiting" : ""}`}>
              <button
                type="button"
                className={`rc-sl__row${selected ? " rc-sl__row--active" : ""}${awaiting ? " rc-sl__row--awaiting" : ""}`}
                onClick={() => onSelect(s.id)}
                aria-current={selected ? "true" : undefined}
              >
                <span className="rc-sl__rail" aria-hidden="true" />
                <span className="rc-sl__main">
                  <span className="rc-sl__top">
                    <strong className="display rc-sl__name">{name}</strong>
                    {/* The awaiting indicator is the LOUD signal — a high-visibility iris "needs you"
                        chip that clearly out-shouts every other per-row status. It's text-labelled so
                        it never relies on color alone. */}
                    {awaiting ? (
                      <span className="rc-sl__await" role="status" aria-label={`${name} needs you`}>
                        <span className="rc-sl__await-dot" aria-hidden="true" />
                        needs you
                      </span>
                    ) : (
                      <LiveWire state={viewWireState(s.id)} />
                    )}
                  </span>
                  {/* Keep the full path as one text node (muted, ellipsised) so it stays scannable
                      and selectable; the basename is what the eye lands on above it. */}
                  <span className="rc-sl__path" title={s.cwd}>
                    {s.cwd}
                  </span>
                  <span className="rc-sl__meta">
                    <time className="rc-sl__time" dateTime={new Date(activeAt).toISOString()} title={absoluteTime(activeAt)}>
                      {relativeTime(activeAt, now)}
                    </time>
                    {s.model && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span>{s.model}</span>
                      </>
                    )}
                    {s.effort && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span>{s.effort}</span>
                      </>
                    )}
                  </span>
                </span>
              </button>
              {/* Separate tap target on the right — closes the session in ONE tap (like closing a
                  browser tab) without selecting it. stopPropagation isn't needed (it's a sibling
                  button, not nested), but it must not bubble into a row select. */}
              <button
                type="button"
                className="rc-sl__close"
                onClick={(e) => {
                  e.stopPropagation();
                  onClose(s.id);
                }}
                aria-label={`Close session ${name}`}
              >
                <Icon name="x" size={16} />
              </button>
            </li>
          );
        })}
        {sessions.length === 0 && (
          <li className="rc-sl__empty">
            No sessions yet. Tap{" "}
            <span className="rc-sl__empty-em" aria-hidden="true">
              +
            </span>{" "}
            above to start one.
          </li>
        )}
      </ul>

      <style>{sessionListCss}</style>
    </div>
  );
}

const sessionListCss = `
.rc-sl { display: flex; flex-direction: column; height: 100%; }
/* The rail header — a glassy bar so the ambient glow shows through it, with a hairline below. */
.rc-sl__head {
  flex: none;
  display: flex; align-items: center; gap: 9px;
  padding: calc(12px + env(safe-area-inset-top, 0px)) 13px 12px;
  border-bottom: 1px solid var(--border);
  background: var(--bar-glass);
  backdrop-filter: var(--glass-blur);
  -webkit-backdrop-filter: var(--glass-blur);
  position: sticky; top: 0; z-index: 1;
}
.rc-sl__title {
  display: inline-flex; align-items: baseline; gap: var(--sp-2);
  font-size: var(--fs-lg); letter-spacing: 0.01em; color: var(--text);
}
.rc-sl__count { color: var(--text-faint); }
.rc-sl__count-n { color: var(--text-muted); font-variant-numeric: tabular-nums; }
/* The global "N need you" badge — a FLAT awaiting pill (mockup .sl-needs): an --awaiting-soft wash
   with an --awaiting-line hairline. No halo: it pushes the New button right; the loud awaiting signal
   lives on the rail row + the iris card. */
.rc-needs {
  display: inline-flex; align-items: center; gap: var(--sp-1);
  padding: 3px 9px; border-radius: 999px;
  background: var(--awaiting-soft); border: 1px solid var(--awaiting-line);
  color: var(--awaiting); font-family: var(--font-mono); font-size: var(--fs-xs); line-height: 1.4;
  white-space: nowrap;
}
.rc-needs__n { font-weight: 700; font-variant-numeric: tabular-nums; }
.rc-needs__label { color: var(--awaiting); }
.rc-sl__needs { margin-left: var(--sp-2); margin-right: auto; }
/* The "+" new-session button — a compact 38px glassy tile (mockup .sl-new) that warms to accent
   (color + hairline only) on hover/focus. No glow/fill. */
.rc-sl__new {
  width: 38px; height: 38px; flex: none;
  display: grid; place-items: center;
  border-radius: 11px;
  background: var(--surface-2); border: 1px solid var(--border);
  color: var(--text-muted); cursor: pointer;
  transition: color 120ms ease, border-color 120ms ease;
}
.rc-sl__new:hover, .rc-sl__new:focus-visible {
  color: var(--accent); border-color: var(--accent-line);
}
.rc-sl__list { list-style: none; margin: 0; padding: 0; overflow-y: auto; flex: 1; }
/* The row + its ✕ live side by side in the list item; a hairline divider sits on the item so it
   spans both. A subtle entrance fade (reduce-motion-neutralized globally) softens reorders. */
.rc-sl__item {
  position: relative;
  display: flex; align-items: stretch;
  border-bottom: 1px solid var(--border);
  animation: rc-row-in 140ms ease both;
}
.rc-sl__row {
  position: relative;
  flex: 1; min-width: 0; text-align: left;
  min-height: var(--tap-min);
  display: flex; align-items: stretch; gap: 0;
  background: transparent; border: none;
  color: var(--text); cursor: pointer;
  padding: 0;
  transition: background 120ms ease;
}
.rc-sl__row:hover { background: var(--surface); }
/* The ACTIVE row is a FLAT surface lift (mockup .sl-row.active) — quiet, scannable, not a wash. */
.rc-sl__row--active { background: var(--surface-2); }
/* The selected accent edge — a FLAT violet left rail (mockup .sl-row.active .sl-rail). The one violet
   accent on the row; no bloom, so it never out-shouts an awaiting row. */
.rc-sl__rail { flex: none; width: 3px; background: transparent; }
.rc-sl__row--active .rc-sl__rail { background: var(--accent); }
/* An awaiting row (mockup .sl-item.awaiting): a flat --awaiting-soft wash + a flat awaiting left edge.
   The pulsing chip dot is the motion; the row itself stays restrained (no glow). */
.rc-sl__item--awaiting { background: var(--awaiting-soft); }
.rc-sl__row--awaiting .rc-sl__rail { width: 3px; background: var(--awaiting); }
/* The per-row "needs you" chip — a FLAT awaiting pill (mockup .await-chip): --awaiting-soft wash,
   --awaiting-line hairline. The only motion is the pulsing dot (color paired with the "needs you"
   text so it's never color-only). */
.rc-sl__await {
  display: inline-flex; align-items: center; gap: var(--sp-1);
  padding: 2px 9px; border-radius: 999px;
  background: var(--awaiting-soft); border: 1px solid var(--awaiting-line);
  color: var(--awaiting); font-family: var(--font-mono); font-size: var(--fs-xs); line-height: 1.4;
  white-space: nowrap;
}
.rc-sl__await-dot {
  width: 8px; height: 8px; border-radius: 50%; background: var(--awaiting); flex: none;
  box-shadow: 0 0 7px var(--awaiting);
  animation: rc-pulse 1.2s ease-in-out infinite;
}
@keyframes rc-pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.35; } }
.rc-sl__main {
  flex: 1; min-width: 0;
  display: flex; flex-direction: column; gap: 3px;
  padding: var(--sp-3) var(--sp-3) var(--sp-3) var(--sp-4);
}
.rc-sl__top { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-2); }
.rc-sl__name {
  font-size: var(--fs-base); font-weight: 600;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0;
}
.rc-sl__path {
  font-family: var(--font-mono); font-size: var(--fs-xs); color: var(--text-muted);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.rc-sl__meta {
  display: flex; align-items: center; gap: var(--sp-1); flex-wrap: wrap;
  font-family: var(--font-mono); font-size: var(--fs-xs); color: var(--text-faint);
}
.rc-sl__time { color: var(--text-muted); font-variant-numeric: tabular-nums; }
/* The ✕ close button — a clearly separated, comfortably tappable target on the right edge of the
   row. Slightly smaller than the primary --tap-min row hit area but still easy to hit on mobile;
   muted by default, warming to the error tint on hover/focus to read as a destructive action. */
.rc-sl__close {
  flex: none; align-self: center;
  width: 36px; height: 36px; margin-right: var(--sp-2);
  display: grid; place-items: center;
  background: transparent; border: 1px solid transparent; border-radius: 8px;
  color: var(--text-faint); cursor: pointer;
  transition: color 120ms ease, background 120ms ease, border-color 120ms ease;
}
.rc-sl__close:hover, .rc-sl__close:focus-visible {
  color: var(--err); background: var(--err-soft); border-color: var(--err-line);
}
.rc-sl__empty { padding: var(--sp-4); color: var(--text-muted); font-size: var(--fs-sm); line-height: 1.5; }
.rc-sl__empty-em { color: var(--accent); font-family: var(--font-display); font-weight: 600; }
@keyframes rc-row-in {
  from { opacity: 0; transform: translateY(-2px); }
  to { opacity: 1; transform: none; }
}
`;
