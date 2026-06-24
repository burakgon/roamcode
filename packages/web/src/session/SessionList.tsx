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
        <button type="button" className="rc-sl__new" onClick={onNew} aria-label="New session">
          <Icon name="plus" size={18} />
        </button>
      </div>
      <ul className="rc-sl__list">
        {ordered.map((s) => {
          const selected = s.id === activeId;
          const name = basename(s.cwd);
          const activeAt = lastActiveAt[s.id] ?? s.createdAt;
          return (
            <li key={s.id} className="rc-sl__item">
              <button
                type="button"
                className={`rc-sl__row${selected ? " rc-sl__row--active" : ""}`}
                onClick={() => onSelect(s.id)}
                aria-current={selected ? "true" : undefined}
              >
                <span className="rc-sl__rail" aria-hidden="true" />
                <span className="rc-sl__main">
                  <span className="rc-sl__top">
                    <strong className="display rc-sl__name">{name}</strong>
                    <LiveWire state={viewWireState(s.id)} />
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
.rc-sl__head {
  flex: none;
  display: flex; align-items: center; justify-content: space-between; gap: var(--sp-2);
  padding: var(--sp-3) var(--sp-4);
  border-bottom: 1px solid var(--border);
}
.rc-sl__title {
  display: inline-flex; align-items: baseline; gap: var(--sp-2);
  font-size: var(--fs-lg); letter-spacing: 0.01em; color: var(--text);
}
.rc-sl__count { color: var(--text-faint); }
.rc-sl__count-n { color: var(--text-muted); font-variant-numeric: tabular-nums; }
.rc-sl__new {
  width: var(--tap-min); height: var(--tap-min); flex: none;
  display: grid; place-items: center;
  border-radius: var(--radius);
  background: var(--surface-2); border: 1px solid var(--border);
  color: var(--text-muted); cursor: pointer;
  transition: color 120ms ease, border-color 120ms ease, background 120ms ease;
}
.rc-sl__new:hover { color: var(--accent); border-color: var(--accent); }
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
.rc-sl__row--active { background: var(--surface-2); }
/* The selected accent edge — a hairline amber rail down the left, calm not loud. */
.rc-sl__rail { flex: none; width: 2px; background: transparent; }
.rc-sl__row--active .rc-sl__rail { background: var(--accent); }
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
  background: transparent; border: 1px solid transparent; border-radius: var(--radius-sm);
  color: var(--text-faint); cursor: pointer;
  transition: color 120ms ease, background 120ms ease, border-color 120ms ease;
}
.rc-sl__close:hover, .rc-sl__close:focus-visible {
  color: var(--err); background: var(--err-bg); border-color: var(--err-border);
}
.rc-sl__empty { padding: var(--sp-4); color: var(--text-muted); font-size: var(--fs-sm); line-height: 1.5; }
.rc-sl__empty-em { color: var(--accent); font-family: var(--font-display); font-weight: 600; }
@keyframes rc-row-in {
  from { opacity: 0; transform: translateY(-2px); }
  to { opacity: 1; transform: none; }
}
`;
