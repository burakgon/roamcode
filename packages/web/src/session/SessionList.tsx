import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../ui/Icon";
import type { SessionMeta, UsageInfo } from "../types/server";
import { sortSessionsByActivity } from "./order";
import { relativeTime } from "./relative-time";
import { UsageBars } from "./UsageBars";

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
  /** Start a NEW session in the SAME folder as an existing row (the per-row "＋ here"), skipping the
   * directory picker. When omitted, the per-row affordance is hidden. Passes the row's cwd. */
  onNewHere?: (cwd: string) => void;
  /** Close (stop + remove) a session in one tap — the row's ✕ button. */
  onClose: (id: string) => void;
  /** Claude usage limits (GET /usage). When present, two slim bars render at the very top of the rail;
   * null/undefined hides them (the feature is unavailable). */
  usage?: UsageInfo | null;
  /** Current running version label (from GET /version, e.g. "v2026.06.26 · ebe4bd3"), shown as a quiet
   * footer at the bottom of the rail so you always know what's deployed. */
  version?: string;
  /** True when a newer version is available — the footer surfaces a tappable "Update available". */
  updateAvailable?: boolean;
  /** Open the update panel (from the footer's "Update available" affordance). */
  onShowUpdate?: () => void;
  /** Force a fresh update check (the footer's "Check for updates"). Resolves true if an update is now
   * available. When provided + no update is pending, the footer shows the check button. */
  onCheckUpdate?: () => Promise<boolean>;
  /** Open the GLOBAL settings (defaults + notifications) — reachable from the rail without a chat. */
  onOpenSettings?: () => void;
  /** Tap handler for the header's "N need you" badge (CONTRACT C1 — App jumps to the first awaiting
   *  session). When provided, the badge renders as a BUTTON; omitted, it stays a non-interactive span. */
  onNeedsYouTap?: () => void;
}

function basename(p: string): string {
  const parts = p.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || p;
}

function absoluteTime(ms: number): string {
  return new Date(ms).toLocaleString();
}

// Client-only session names: a per-session-id editable label, kept ONLY in this browser's localStorage
// (the server has no concept of a session name). A row with no custom name falls back to its cwd
// basename, so the rail always reads sensibly. Kept here (not the store) per the app's "client-only data
// lives in localStorage" convention.
const NAMES_KEY = "rc-session-names";
function loadSessionNames(): Record<string, string> {
  try {
    const raw = window.localStorage?.getItem(NAMES_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : {};
    return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}
function saveSessionName(id: string, name: string): void {
  try {
    const all = loadSessionNames();
    const trimmed = name.trim();
    if (trimmed) all[id] = trimmed;
    else delete all[id]; // clearing the field reverts to the cwd basename
    window.localStorage?.setItem(NAMES_KEY, JSON.stringify(all));
  } catch {
    /* storage blocked (private mode) — the rename just won't persist */
  }
}

/** A clear, human label for each terminal-session `status`, so the rail distinguishes a live PTY from an
 * exited one — every status carries a distinct word (never a blank glyph). `ended` is the real dead-session
 * state the server emits when a terminal exits/crashes; dormant/errored/stopped are legacy/back-compat. */
const STATUS_LABEL: Record<SessionMeta["status"], string> = {
  running: "live",
  ended: "ended",
  dormant: "dormant",
  errored: "errored",
  stopped: "stopped",
};

/** The footer's "Check for updates" — forces a fresh server-side check so you never wait on the poll.
 * Shows "Checking…" in flight; if an update turns up the parent swaps this for the coral "Update
 * available" pill, otherwise it briefly confirms "Up to date". */
function CheckUpdateButton({ onCheck }: { onCheck: () => Promise<boolean> }) {
  const [state, setState] = useState<"idle" | "checking" | "uptodate">("idle");
  // Guard against setState after unmount: the footer can swap to the "Update available" pill (or drop
  // when version goes falsy) while the check is in flight or the "Up to date" timer is pending.
  const mounted = useRef(true);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(
    () => () => {
      mounted.current = false;
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  return (
    <button
      type="button"
      className="rc-sl__check"
      disabled={state === "checking"}
      aria-label="Check for updates"
      onClick={async () => {
        setState("checking");
        try {
          const found = await onCheck();
          if (!mounted.current) return;
          if (found) {
            setState("idle"); // parent re-renders into the "Update available" pill
          } else {
            setState("uptodate");
            timer.current = setTimeout(() => {
              if (mounted.current) setState("idle");
            }, 2500);
          }
        } catch {
          if (mounted.current) setState("idle");
        }
      }}
    >
      {state === "checking" ? "Checking…" : state === "uptodate" ? "Up to date ✓" : "Check for updates"}
    </button>
  );
}

/**
 * The per-row status for a TERMINAL session — a terminal glyph + a DISTINCT text label per `status`
 * (live / ended / dormant / errored / stopped) so a dead session reads a clear word, never a blank glyph.
 * Always text-labelled so it never relies on color alone; "live" gets a quiet accent + a pulsing dot,
 * "ended" reads faint (a dead PTY), "errored" reads in the error tint, and dormant/stopped read muted.
 */
function TerminalState({ status }: { status: SessionMeta["status"] }) {
  const live = status === "running";
  return (
    <span className={`rc-sl__term rc-sl__term--${status}${live ? " rc-sl__term--live" : ""}`} role="status">
      <Icon name="terminal" size={13} />
      {live && <span className="rc-sl__term-dot" aria-hidden="true" />}
      {STATUS_LABEL[status]}
    </span>
  );
}

/**
 * A loud per-row warning that this session was spawned with `--dangerously-skip-permissions` — the CLI
 * runs tool calls without prompting, so it must be unmissable at a glance. A restrained amber (`--warn`)
 * pill with a ⚠ glyph, TEXT-labelled ("skip-perms") so it never relies on color alone. The full context
 * lives on the aria-label + title (the visible text stays compact for the tight rail).
 */
function SkipPermsBadge() {
  return (
    <span
      className="rc-sl__skip"
      role="img"
      aria-label="Danger: this session runs with permissions skipped"
      title="Spawned with --dangerously-skip-permissions (tool calls run without prompting)"
    >
      <span className="rc-sl__skip-icon" aria-hidden="true">
        ⚠
      </span>
      skip-perms
    </span>
  );
}

/** A small pencil (edit) glyph — the Icon set has no "edit" entry and Icon.tsx is out of scope here, so
 * this matches the same 24×24 / currentColor / ~1.75px-stroke conventions locally. Decorative. */
function PencilGlyph() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </svg>
  );
}

/**
 * Count of sessions with a pending permission/question (`meta.awaiting`). Drives the "needs you" badges.
 * `excludeId` drops one session from the count — pass the session you're actively viewing so its own header
 * badge counts only the OTHER conversations waiting on you (you don't need to be nagged about the one on screen).
 */
export function awaitingCount(sessions: SessionMeta[], excludeId?: string): number {
  return sessions.reduce((n, s) => (s.awaiting && s.id !== excludeId ? n + 1 : n), 0);
}

/**
 * The global "N need you" badge — a loud iris pill shown in the rail header and on the mobile sessions
 * toggle so a pending permission/question is visible from ANY chat. Renders nothing at zero. The count
 * is paired with text ("need you") so the signal is never color-only (a11y).
 *
 * When `onTap` is supplied the badge becomes a BUTTON (App wires it to jump to the first awaiting
 * session — CONTRACT C1); with no handler it stays a non-interactive `role="status"` span (a11y-safe,
 * so a screen reader announces the count without a phantom control).
 */
export function NeedsYouBadge({
  count,
  className,
  onTap,
}: {
  count: number;
  className?: string;
  onTap?: () => void;
}) {
  if (count <= 0) return null;
  const inner = (
    <>
      <span className="rc-needs__n">{count}</span>
      <span className="rc-needs__label">need you</span>
    </>
  );
  if (onTap) {
    return (
      <button
        type="button"
        className={`rc-needs rc-needs--tap${className ? ` ${className}` : ""}`}
        onClick={onTap}
        aria-label={`${count} ${count === 1 ? "session needs" : "sessions need"} you — go to the first`}
      >
        {inner}
      </button>
    );
  }
  return (
    <span className={`rc-needs${className ? ` ${className}` : ""}`} role="status">
      {inner}
    </span>
  );
}

/**
 * The session rail / sheet: a calm, scannable, hairline-separated list (Variant A). Sessions are
 * ordered most-recently-opened/active first (chat-app style) via the store's lastActiveAt stamps, so
 * the session you just opened or that's streaming floats to the top. Each row is one clean entry —
 * the cwd basename in the display font, the muted path beneath it, and a meta line carrying the
 * terminal status, the model·effort, and a compact relative time. A clear amber left-rail marks
 * the active row. Two affordances live on the right of each row: nothing extra in the body, and a
 * small ✕ button that closes (stops + removes) that session in one tap without selecting it. The
 * header carries a "New session" `+` icon button and a live session count. Works as the desktop rail
 * (var(--rail-w)) and as the mobile sheet.
 */
/** Show the search/filter box only once the list is long enough to actually need scanning. Kept low (3)
 * because even 3–4 similarly-named sibling-folder sessions already can't be told apart by eye. */
const SEARCH_MIN = 3;

export function SessionList({
  sessions,
  activeId,
  lastActiveAt,
  now,
  onSelect,
  onNew,
  onNewHere,
  onClose,
  usage,
  version,
  updateAvailable,
  onShowUpdate,
  onCheckUpdate,
  onOpenSettings,
  onNeedsYouTap,
}: SessionListProps) {
  const ordered = sortSessionsByActivity(sessions, lastActiveAt);
  const needs = awaitingCount(sessions);

  // Search/filter (by name or cwd) — surfaced only for longer lists.
  const [query, setQuery] = useState("");
  // Client-only session names (localStorage). `namesVersion` bumps after a rename to re-read the map.
  const [namesVersion, setNamesVersion] = useState(0);
  const names = useMemo(() => loadSessionNames(), [namesVersion]);
  const displayName = (s: SessionMeta): string => names[s.id]?.trim() || basename(s.cwd);
  // Inline rename: which row is being edited + its draft label.
  const [editingId, setEditingId] = useState<string | undefined>(undefined);
  const [editDraft, setEditDraft] = useState("");
  const startEdit = (s: SessionMeta) => {
    setEditingId(s.id);
    setEditDraft(displayName(s));
  };
  const commitEdit = () => {
    if (editingId) {
      saveSessionName(editingId, editDraft);
      setNamesVersion((v) => v + 1);
    }
    setEditingId(undefined);
  };
  const cancelEdit = () => setEditingId(undefined);

  const showSearch = sessions.length >= SEARCH_MIN;
  const q = query.trim().toLowerCase();
  const shown =
    q.length > 0
      ? ordered.filter((s) => displayName(s).toLowerCase().includes(q) || s.cwd.toLowerCase().includes(q))
      : ordered;

  return (
    <div className="rc-sl">
      {/* The usage bars sit at the VERY top of the rail — the first thing in the list, above the
          header's "needs you" badge and the session rows. Renders nothing when usage is unavailable. */}
      <UsageBars usage={usage} now={now} />
      <div className="rc-sl__head">
        <span className="display rc-sl__title">
          Sessions
          <span className="rc-sl__count" aria-hidden="true">
            ·
          </span>
          <span className="rc-sl__count-n">{sessions.length}</span>
        </span>
        {/* The global "needs you" badge sits in the header so it's visible whenever the rail is open.
            With onNeedsYouTap it's tappable (jumps to the first awaiting session — C1). */}
        <NeedsYouBadge count={needs} className="rc-sl__needs" onTap={onNeedsYouTap} />
        {onOpenSettings && (
          <button type="button" className="rc-sl__settings" onClick={onOpenSettings} aria-label="Settings">
            <Icon name="settings" size={18} />
          </button>
        )}
        <button type="button" className="rc-sl__new" onClick={onNew} aria-label="New session">
          <Icon name="plus" size={18} />
        </button>
      </div>
      {/* A filter box — only for longer lists (SEARCH_MIN+), where scanning by eye stops being enough.
          Matches name OR cwd, so you can find a session by either. */}
      {showSearch && (
        <div className="rc-sl__search">
          <Icon name="search" size={15} />
          <input
            type="text"
            className="rc-sl__search-input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter by name or path"
            aria-label="Filter sessions"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
          />
          {query && (
            <button
              type="button"
              className="rc-sl__search-clear"
              onClick={() => setQuery("")}
              aria-label="Clear filter"
            >
              <Icon name="x" size={14} />
            </button>
          )}
        </div>
      )}
      <ul className="rc-sl__list">
        {shown.map((s) => {
          const selected = s.id === activeId;
          const name = displayName(s);
          const activeAt = lastActiveAt[s.id] ?? s.createdAt;
          const awaiting = Boolean(s.awaiting);
          // A dead PTY (server "ended") reads muted so it's obviously not a live session. Awaiting wins
          // the row treatment (its loud coral wash), so only dim when there's nothing pending on it.
          const ended = s.status === "ended" && !awaiting;
          const editing = editingId === s.id;
          return (
            <li key={s.id} className={`rc-sl__item${awaiting ? " rc-sl__item--awaiting" : ""}`}>
              {editing ? (
                // Rename in place: the whole row becomes an edit form (no nested interactive elements).
                // Enter/blur commits, Escape cancels. Clearing the field reverts to the cwd basename.
                <form
                  className="rc-sl__edit"
                  onSubmit={(e) => {
                    e.preventDefault();
                    commitEdit();
                  }}
                >
                  <input
                    className="rc-sl__edit-input"
                    value={editDraft}
                    onChange={(e) => setEditDraft(e.target.value)}
                    onBlur={commitEdit}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") {
                        e.preventDefault();
                        cancelEdit();
                      }
                    }}
                    aria-label={`Rename ${basename(s.cwd)}`}
                    placeholder={basename(s.cwd)}
                    autoFocus
                    autoCapitalize="off"
                    autoCorrect="off"
                    spellCheck={false}
                  />
                  <button type="submit" className="rc-sl__edit-btn" aria-label="Save name">
                    <Icon name="check" size={16} />
                  </button>
                  <button
                    type="button"
                    className="rc-sl__edit-btn"
                    // onMouseDown (not onClick) so it fires BEFORE the input's blur-commit swallows it.
                    onMouseDown={(e) => {
                      e.preventDefault();
                      cancelEdit();
                    }}
                    aria-label="Cancel rename"
                  >
                    <Icon name="x" size={16} />
                  </button>
                </form>
              ) : (
                <>
                  <button
                    type="button"
                    className={`rc-sl__row${selected ? " rc-sl__row--active" : ""}${awaiting ? " rc-sl__row--awaiting" : ""}${ended ? " rc-sl__row--ended" : ""}`}
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
                          // A terminal glyph + a DISTINCT text label per status (live / ended / dormant /
                          // errored / stopped) — never a blank glyph, never color-only.
                          <TerminalState status={s.status} />
                        )}
                      </span>
                      {/* Keep the full path as one text node (muted, ellipsised) so it stays scannable
                          and selectable; the basename is what the eye lands on above it. */}
                      <span className="rc-sl__path" title={s.cwd}>
                        {s.cwd}
                      </span>
                      <span className="rc-sl__meta">
                        {/* Leads the meta line when armed — an unmissable amber warning that this
                            session skips permission prompts (--dangerously-skip-permissions). */}
                        {s.dangerouslySkip && <SkipPermsBadge />}
                        <time
                          className="rc-sl__time"
                          dateTime={new Date(activeAt).toISOString()}
                          title={absoluteTime(activeAt)}
                        >
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
                  {/* Row actions on the right, each a SEPARATE tap target that never bubbles into a row
                      select: start another session in the same folder, rename the row, then the ✕ close. */}
                  <span className="rc-sl__actions">
                    {onNewHere && (
                      <button
                        type="button"
                        className="rc-sl__act"
                        onClick={(e) => {
                          e.stopPropagation();
                          onNewHere(s.cwd);
                        }}
                        aria-label={`Start a session in ${name}`}
                        title="New session in this folder"
                      >
                        <Icon name="plus" size={15} />
                      </button>
                    )}
                    <button
                      type="button"
                      className="rc-sl__act"
                      onClick={(e) => {
                        e.stopPropagation();
                        startEdit(s);
                      }}
                      aria-label={`Rename ${name}`}
                      title="Rename"
                    >
                      <PencilGlyph />
                    </button>
                    {/* Closes (stops + removes) the session in ONE tap without selecting it. The aria-label
                        stays "Close session …"; the title spells out that it stops + removes. */}
                    <button
                      type="button"
                      className="rc-sl__close"
                      onClick={(e) => {
                        e.stopPropagation();
                        onClose(s.id);
                      }}
                      aria-label={`Close session ${name}`}
                      title={`Stop & remove ${name}`}
                    >
                      <Icon name="x" size={16} />
                    </button>
                  </span>
                </>
              )}
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
        {sessions.length > 0 && shown.length === 0 && (
          <li className="rc-sl__empty">No sessions match “{query.trim()}”.</li>
        )}
      </ul>

      {/* A quiet footer at the bottom of the rail showing the running version (so you always know
          what's deployed) + a tappable "Update available" when a newer one is out. */}
      {version && (
        <div className="rc-sl__footer">
          <span className="rc-sl__version" title={version}>
            {version}
          </span>
          {updateAvailable && onShowUpdate ? (
            <button type="button" className="rc-sl__update" onClick={onShowUpdate} aria-label="Update available">
              Update available
            </button>
          ) : (
            onCheckUpdate && <CheckUpdateButton onCheck={onCheckUpdate} />
          )}
        </div>
      )}

      <style>{sessionListCss}</style>
    </div>
  );
}

const sessionListCss = `
.rc-sl { display: flex; flex-direction: column; height: 100%; }
/* Version footer — pinned at the bottom of the rail; quiet mono label + a coral "Update available". */
.rc-sl__footer {
  flex: none;
  display: flex; align-items: center; justify-content: space-between; gap: var(--sp-2);
  padding: 8px 13px calc(8px + env(safe-area-inset-bottom, 0px));
  border-top: 1px solid var(--border);
}
.rc-sl__version {
  font-family: var(--font-mono); font-size: var(--fs-xs); color: var(--text-faint);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.rc-sl__update {
  flex: none; font: inherit; font-size: var(--fs-xs); font-weight: 600; cursor: pointer;
  color: var(--on-accent); background: var(--coral); border: 1px solid transparent;
  border-radius: var(--radius-pill); padding: 2px var(--sp-2);
}
.rc-sl__update:hover { filter: brightness(1.08); }
/* Secondary, quiet "Check for updates" — a hairline pill, never coral (that's reserved for an actual
   available update). */
.rc-sl__check {
  flex: none; font: inherit; font-size: var(--fs-xs); cursor: pointer;
  color: var(--text-muted); background: transparent; border: 1px solid var(--border);
  border-radius: var(--radius-pill); padding: 2px var(--sp-2); white-space: nowrap;
}
.rc-sl__check:hover:not(:disabled) { color: var(--text); border-color: var(--border-strong); }
.rc-sl__check:disabled { opacity: 0.6; cursor: default; }
/* The rail header — a flat surface bar with a hairline below (no glass blur). */
.rc-sl__head {
  flex: none;
  display: flex; align-items: center; gap: 9px;
  padding: calc(12px + env(safe-area-inset-top, 0px)) 13px 12px;
  border-bottom: 1px solid var(--border);
  background: var(--bar-glass);
  position: sticky; top: 0; z-index: 1;
}
.rc-sl__title {
  /* margin-right:auto pins the "+" to the right edge ALWAYS — previously only the needs-you badge
     carried it, so with zero awaiting sessions (the common case) the badge was null and "+" packed
     against the title. */
  margin-right: auto;
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
.rc-sl__needs { margin-left: var(--sp-2); }
/* When the badge carries a tap handler (C1 — jump to the first awaiting session) it renders as a
   BUTTON: reset the UA chrome down to the same pill, add a pointer + hover lift + focus ring. */
.rc-needs--tap { cursor: pointer; font: inherit; font-family: var(--font-mono); font-size: var(--fs-xs);
  transition: filter 120ms ease, border-color 120ms ease; }
.rc-needs--tap:hover { filter: brightness(1.08); border-color: var(--awaiting); }
.rc-needs--tap:focus-visible { outline: 2px solid var(--awaiting); outline-offset: 2px; }
/* The settings gear — a NEUTRAL icon button (coral is reserved for the "+" CTA), opening the global
   defaults + notifications without entering a chat. */
.rc-sl__settings {
  width: var(--tap-min); height: var(--tap-min); flex: none;
  display: grid; place-items: center;
  border-radius: 9px;
  background: var(--surface-2); border: 1px solid var(--border);
  color: var(--text-muted); cursor: pointer;
  transition: color 120ms ease, border-color 120ms ease;
}
.rc-sl__settings:hover, .rc-sl__settings:focus-visible { color: var(--text); border-color: var(--border-strong); }
/* The "+" new-session button — the coral PRIMARY (spec): a compact 34px FLAT coral tile with a dark
   ink glyph. The one coral CTA in the rail. */
.rc-sl__new {
  width: var(--tap-min); height: var(--tap-min); flex: none;
  display: grid; place-items: center;
  border-radius: 9px;
  background: var(--coral); border: 1px solid transparent;
  color: var(--on-accent); cursor: pointer;
  transition: filter 120ms ease;
}
.rc-sl__new:hover, .rc-sl__new:focus-visible {
  filter: brightness(1.08);
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
/* The ACTIVE row is a FLAT surface lift — quiet, scannable, not a wash. */
.rc-sl__row--active { background: var(--surface-2); }
/* The selected edge — a NEUTRAL left rail (coral is reserved for awaiting/needs-you, so the active
   marker is grayscale and never competes). */
.rc-sl__rail { flex: none; width: 2px; background: transparent; }
.rc-sl__row--active .rc-sl__rail { background: var(--border-strong); }
/* An awaiting row: a flat --awaiting-soft (coral) wash + a coral left edge — the ONE place a row uses
   coral, because it IS the needs-you signal. The pulsing chip dot is the motion. */
.rc-sl__item--awaiting { background: var(--awaiting-soft); }
.rc-sl__row--awaiting .rc-sl__rail { width: 2px; background: var(--awaiting); }
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
  animation: rc-sl-pulse 1.2s ease-in-out infinite;
}
/* Own keyframe name (rc-sl-pulse) so this rail pulse never collides with another component's keyframe. */
@keyframes rc-sl-pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.35; } }
/* Terminal-session status — a terminal glyph + a DISTINCT label per status (live / dormant / errored /
   stopped). Quiet mono pill; "live" gets a pulsing dot + brighter text, "errored" reads in the error
   tint, dormant/stopped stay muted/faint. Never color-only (always paired with text). */
.rc-sl__term {
  display: inline-flex; align-items: center; gap: var(--sp-1);
  font-family: var(--font-mono); font-size: var(--fs-xs); line-height: 1.4;
  color: var(--text-faint); white-space: nowrap;
}
.rc-sl__term--live { color: var(--text-muted); }
/* "ended" = a dead PTY — reads faint (paired with the "ended" word so it's never color-only). */
.rc-sl__term--ended { color: var(--text-faint); }
.rc-sl__term--dormant { color: var(--text-faint); }
.rc-sl__term--stopped { color: var(--text-faint); }
.rc-sl__term--errored { color: var(--err); }
.rc-sl__term-dot {
  width: 7px; height: 7px; border-radius: 50%; background: var(--accent); flex: none;
  animation: rc-sl-pulse 1.2s ease-in-out infinite;
}
/* An ENDED (dead) session's row reads dimmed so it's obviously not live at a glance — a secondary cue
   on top of the "ended" text label (never dim-only). The right-hand actions stay full-strength (they're
   a sibling of the row button) so closing a dead session is still easy. */
.rc-sl__row--ended { opacity: 0.6; }
.rc-sl__row--ended .rc-sl__name { color: var(--text-muted); }
/* The per-row "skip-perms" warning — a restrained amber (--warn) pill flagging a session spawned with
   --dangerously-skip-permissions. Loud enough to catch the eye against the faint meta line, TEXT-labelled
   (never color-only). No --warn-soft/-line token exists, so the wash/hairline are inline amber rgba
   matching #d9a441 (same pattern as --awaiting-soft/-line). */
.rc-sl__skip {
  display: inline-flex; align-items: center; gap: var(--sp-1);
  padding: 1px 7px; border-radius: 999px;
  background: rgba(217, 164, 65, 0.13); border: 1px solid rgba(217, 164, 65, 0.42);
  color: var(--warn); font-family: var(--font-mono); font-size: var(--fs-xs); line-height: 1.4;
  font-weight: 600; white-space: nowrap;
}
.rc-sl__skip-icon { font-size: 0.95em; line-height: 1; }
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
/* Row actions live on the right of each item — a compact cluster of separate tap targets (＋ here,
   rename, ✕) that never bubble into a row select. Kept tight so three fit a narrow phone rail. */
.rc-sl__actions {
  flex: none; align-self: center;
  display: flex; align-items: center; gap: 2px;
  padding-right: var(--sp-2);
}
/* The neutral per-row action buttons (＋ here / rename) — quiet by default, brightening on hover. */
.rc-sl__act {
  flex: none;
  width: 34px; height: 34px;
  display: grid; place-items: center;
  background: transparent; border: 1px solid transparent; border-radius: 8px;
  color: var(--text-faint); cursor: pointer;
  transition: color 120ms ease, background 120ms ease, border-color 120ms ease;
}
.rc-sl__act:hover, .rc-sl__act:focus-visible {
  color: var(--text); background: var(--surface); border-color: var(--border);
}
/* The ✕ close button — a clearly separated, comfortably tappable target; muted by default, warming to
   the error tint on hover/focus to read as the destructive "stop & remove" action. */
.rc-sl__close {
  flex: none;
  width: 34px; height: 34px;
  display: grid; place-items: center;
  background: transparent; border: 1px solid transparent; border-radius: 8px;
  color: var(--text-faint); cursor: pointer;
  transition: color 120ms ease, background 120ms ease, border-color 120ms ease;
}
.rc-sl__close:hover, .rc-sl__close:focus-visible {
  color: var(--err); background: var(--err-soft); border-color: var(--err-line);
}
/* The filter box — a hairline field below the header; a leading magnifier + a clear-when-typed ✕. */
.rc-sl__search {
  flex: none;
  display: flex; align-items: center; gap: var(--sp-2);
  margin: var(--sp-2) 13px;
  padding: 0 var(--sp-2);
  background: var(--surface-2); border: 1px solid var(--border);
  border-radius: var(--radius-sm); color: var(--text-muted);
  transition: border-color 120ms ease;
}
.rc-sl__search:focus-within { border-color: var(--accent-line); box-shadow: var(--focus-glow); }
.rc-sl__search-input {
  flex: 1; min-width: 0; min-height: 36px;
  background: transparent; border: none; outline: none;
  color: var(--text); font: inherit; font-size: var(--fs-sm);
}
.rc-sl__search-clear {
  flex: none; display: grid; place-items: center;
  width: 28px; height: 28px; border-radius: var(--radius-sm);
  background: transparent; border: none; color: var(--text-faint); cursor: pointer;
}
.rc-sl__search-clear:hover { color: var(--text); }
/* Inline rename form — replaces the row while editing so there are no nested interactive elements. */
.rc-sl__edit {
  flex: 1; min-width: 0;
  display: flex; align-items: center; gap: var(--sp-1);
  padding: var(--sp-2) var(--sp-2) var(--sp-2) var(--sp-4);
}
.rc-sl__edit-input {
  flex: 1; min-width: 0; min-height: 36px;
  background: var(--surface-2); border: 1px solid var(--accent-line);
  border-radius: var(--radius-sm); color: var(--text);
  padding: 0 var(--sp-2); font: inherit; font-size: var(--fs-base); font-weight: 600;
}
.rc-sl__edit-input:focus { outline: none; box-shadow: var(--focus-glow); }
.rc-sl__edit-btn {
  flex: none; width: 34px; height: 34px;
  display: grid; place-items: center;
  background: transparent; border: 1px solid transparent; border-radius: 8px;
  color: var(--text-muted); cursor: pointer;
  transition: color 120ms ease, background 120ms ease, border-color 120ms ease;
}
.rc-sl__edit-btn:hover, .rc-sl__edit-btn:focus-visible {
  color: var(--text); background: var(--surface); border-color: var(--border);
}
.rc-sl__empty { padding: var(--sp-4); color: var(--text-muted); font-size: var(--fs-sm); line-height: 1.5; }
.rc-sl__empty-em { color: var(--accent); font-family: var(--font-display); font-weight: 600; }
@keyframes rc-row-in {
  from { opacity: 0; transform: translateY(-2px); }
  to { opacity: 1; transform: none; }
}
`;
