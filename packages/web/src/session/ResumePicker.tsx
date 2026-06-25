import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Icon } from "../ui/Icon";
import { useFocusTrap } from "../ui/useFocusTrap";
import { relativeTime } from "./relative-time";
import type { ResumableSession } from "../types/server";

export interface ResumePickerProps {
  /** Fetch past resumable conversations, recent-first. Optionally scoped to a cwd. */
  getResumable: (cwd?: string) => Promise<ResumableSession[]>;
  /** The wizard's current cwd, if any — when present the list defaults to this directory with a
   * toggle to show all. */
  scopeCwd?: string;
  /** Wall clock (ms) for the relative-time labels — passed in so this stays free of Date.now(). */
  now: number;
  /** Resume the chosen conversation. The picker awaits this; the row stays disabled while it runs and
   * an inline error is shown if it rejects (e.g. a 404 when the transcript vanished). */
  onResume: (sessionId: string) => Promise<void>;
  /** Optional content rendered at the very top (above the heading) — hosts the new/resume toggle. */
  topSlot?: ReactNode;
  /** Dismiss the whole wizard. */
  onCancel: () => void;
}

function basename(p: string): string {
  const parts = p.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || p;
}

/**
 * The Resume pane (Variant A): a scannable, recent-first list of past Claude conversations. Each row
 * leads with the conversation's first user message (the eye-level summary), then a meta line — the cwd
 * basename + muted full path, the git branch (with a branch glyph), a relative time, and the message
 * count. A search field filters by summary/path client-side. When opened from a chosen directory the
 * list defaults to that cwd with a "Show all" toggle. Tapping a row resumes it; the row disables while
 * its request is in flight and any error (404 etc.) surfaces inline.
 */
export function ResumePicker({ getResumable, scopeCwd, now, onResume, topSlot, onCancel }: ResumePickerProps) {
  const [scoped, setScoped] = useState<boolean>(Boolean(scopeCwd));
  const [rows, setRows] = useState<ResumableSession[] | undefined>();
  const [loadError, setLoadError] = useState<string | undefined>();
  const [query, setQuery] = useState("");
  const [pendingId, setPendingId] = useState<string | undefined>();
  const [rowError, setRowError] = useState<{ id: string; message: string } | undefined>();
  const dialogRef = useRef<HTMLDivElement>(null);

  // Real modal semantics: trap Tab within the sheet and restore focus to the trigger on close; close
  // on Escape (matching the directory picker the toggle flips between).
  useFocusTrap(dialogRef);
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onCancel();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  const activeCwd = scoped ? scopeCwd : undefined;

  useEffect(() => {
    let cancelled = false;
    setRows(undefined);
    setLoadError(undefined);
    getResumable(activeCwd)
      .then((r) => {
        if (!cancelled) setRows(r);
      })
      .catch((e: unknown) => {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : "failed to load past sessions");
      });
    return () => {
      cancelled = true;
    };
  }, [getResumable, activeCwd]);

  // Client-side filter by summary or cwd. The list is already recent-first from the server; we keep
  // that order and only narrow it.
  const filtered = useMemo(() => {
    if (!rows) return [];
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(
      (r) => r.summary.toLowerCase().includes(q) || (r.cwd ? r.cwd.toLowerCase().includes(q) : false),
    );
  }, [rows, query]);

  async function resume(sessionId: string) {
    if (pendingId) return;
    setPendingId(sessionId);
    setRowError(undefined);
    try {
      await onResume(sessionId);
      // On success the wizard closes (the parent unmounts us), so no further state work is needed.
    } catch (e) {
      setRowError({ id: sessionId, message: e instanceof Error ? e.message : "failed to resume" });
      setPendingId(undefined);
    }
  }

  const emptyLabel =
    activeCwd !== undefined ? `No past sessions in ${basename(activeCwd)}.` : "No past sessions yet.";

  return (
    <div ref={dialogRef} role="dialog" aria-modal="true" aria-label="Resume a past session" className="rc-resume">
      <header className="rc-resume__head">
        {topSlot}
        <div className="rc-resume__title-row">
          <strong className="display rc-resume__title">Resume a session</strong>
          <button type="button" className="rc-resume__cancel" onClick={onCancel}>
            Cancel
          </button>
        </div>

        <div className="rc-resume__search">
          <span aria-hidden="true" className="rc-resume__search-icon">
            <Icon name="search" size={16} />
          </span>
          <input
            aria-label="Search past sessions"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search past sessions…"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
          />
        </div>

        {scopeCwd && (
          <div className="rc-resume__scope" role="group" aria-label="Scope">
            <button
              type="button"
              className={`rc-resume__scope-btn${scoped ? " rc-resume__scope-btn--on" : ""}`}
              aria-pressed={scoped}
              onClick={() => setScoped(true)}
            >
              This directory
            </button>
            <button
              type="button"
              className={`rc-resume__scope-btn${!scoped ? " rc-resume__scope-btn--on" : ""}`}
              aria-pressed={!scoped}
              onClick={() => setScoped(false)}
            >
              All
            </button>
          </div>
        )}
      </header>

      <div className="rc-resume__body">
        {loadError && (
          <div role="alert" className="rc-resume__error">
            <Icon name="alert" size={16} />
            <span>{loadError}</span>
          </div>
        )}

        {!loadError && rows === undefined && <div className="rc-resume__hint">Loading…</div>}

        {!loadError && rows !== undefined && filtered.length === 0 && (
          <div className="rc-resume__hint">{query.trim() ? "No matches." : emptyLabel}</div>
        )}

        <ul className="rc-resume__list">
          {filtered.map((r) => {
            const inFlight = pendingId === r.sessionId;
            const disabled = pendingId !== undefined; // disable all rows while any resume is running
            const name = r.cwd ? basename(r.cwd) : "unknown";
            return (
              <li key={r.sessionId} className="rc-resume__item">
                <button
                  type="button"
                  className="rc-resume__row"
                  onClick={() => void resume(r.sessionId)}
                  disabled={disabled}
                  aria-busy={inFlight || undefined}
                  aria-label={`Resume ${r.summary || name}, ${r.messageCount} messages`}
                >
                  <span className="rc-resume__summary">{r.summary || "(no summary)"}</span>
                  <span className="rc-resume__meta">
                    <span className="rc-resume__cwd">
                      <span className="rc-resume__cwd-name">{name}</span>
                      {r.cwd && (
                        <span className="rc-resume__cwd-path" title={r.cwd}>
                          {r.cwd}
                        </span>
                      )}
                    </span>
                  </span>
                  <span className="rc-resume__meta rc-resume__meta--sub">
                    {r.gitBranch && (
                      <span className="rc-resume__chip" title={`git branch: ${r.gitBranch}`}>
                        <Icon name="branch" size={13} />
                        <span>{r.gitBranch}</span>
                      </span>
                    )}
                    <span className="rc-resume__chip">
                      <Icon name="history" size={13} />
                      <time dateTime={new Date(r.lastActivity).toISOString()}>{relativeTime(r.lastActivity, now)}</time>
                    </span>
                    <span className="rc-resume__chip" title={`${r.messageCount} messages`}>
                      {r.messageCount} msg
                    </span>
                    {inFlight && <span className="rc-resume__chip rc-resume__chip--busy">Resuming…</span>}
                  </span>
                </button>
                {rowError && rowError.id === r.sessionId && (
                  <div role="alert" className="rc-resume__row-error">
                    <Icon name="alert" size={14} />
                    <span>{rowError.message}</span>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </div>

      <style>{resumeCss}</style>
    </div>
  );
}

const resumeCss = `
.rc-resume {
  position: fixed; inset: 0; z-index: 50;
  /* Mobile full-bleed takeover — paints the same warm-dark atmosphere as the app base (an opaque
     cover over the chat, not a see-through pane); desktop becomes a centered liquid-glass card. */
  background-color: var(--bg);
  background-image: var(--atmosphere);
  display: flex; flex-direction: column;
  animation: rc-resume-in 200ms cubic-bezier(0.16, 1, 0.3, 1);
}
@keyframes rc-resume-in { from { opacity: 0; } to { opacity: 1; } }
@media (min-width: 768px) {
  .rc-resume {
    inset: auto; left: 50%; top: 50%; transform: translate(-50%, -50%);
    width: min(94vw, 560px); height: min(86vh, 680px);
    background: var(--glass-strong);
    backdrop-filter: var(--glass-blur);
    -webkit-backdrop-filter: var(--glass-blur);
    border-radius: var(--radius-lg);
    box-shadow: var(--glass-shadow);
  }
}
.rc-resume__head {
  flex: none; display: grid; gap: var(--sp-3);
  padding: var(--sp-4);
  border-bottom: 1px solid var(--border);
}
.rc-resume__title-row { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-2); }
.rc-resume__title { font-size: var(--fs-lg); }
.rc-resume__cancel {
  min-height: 36px; padding: 0 var(--sp-3);
  background: transparent; border: none; color: var(--accent);
  font: inherit; font-weight: 500; cursor: pointer; border-radius: var(--radius-sm);
}
.rc-resume__cancel:hover { background: var(--surface); }
.rc-resume__search {
  display: flex; align-items: center; gap: var(--sp-2);
  min-height: var(--tap-min);
  background: var(--surface-2); border: 1px solid var(--border);
  border-radius: var(--radius-sm); padding: 0 var(--sp-3);
  transition: border-color 120ms ease;
}
.rc-resume__search:focus-within { border-color: var(--accent-line); box-shadow: var(--focus-glow); }
.rc-resume__search-icon { color: var(--text-muted); display: grid; place-items: center; }
.rc-resume__search input {
  flex: 1; min-width: 0; background: transparent; border: none; outline: none;
  color: var(--text); font: inherit;
}
.rc-resume__scope { display: flex; gap: var(--sp-2); }
.rc-resume__scope-btn {
  min-height: 34px; padding: 0 var(--sp-3);
  background: var(--surface-2); border: 1px solid var(--border); border-radius: 999px;
  color: var(--text-muted); cursor: pointer; font: inherit; font-size: var(--fs-xs); font-weight: 600;
  transition: color 120ms ease, border-color 120ms ease, background 120ms ease;
}
.rc-resume__scope-btn--on { color: var(--accent); border-color: var(--accent-line); background: var(--accent-soft); }
.rc-resume__body { flex: 1; min-height: 0; overflow-y: auto; padding: var(--sp-2) 0; }
.rc-resume__hint { padding: var(--sp-5) var(--sp-4); color: var(--text-muted); font-size: var(--fs-sm); }
.rc-resume__error {
  display: flex; align-items: center; gap: var(--sp-2);
  margin: var(--sp-3) var(--sp-4);
  color: var(--err); background: var(--err-bg); border: 1px solid var(--err-border);
  border-radius: var(--radius-sm); padding: var(--sp-2) var(--sp-3); font-size: var(--fs-sm);
}
.rc-resume__list { list-style: none; margin: 0; padding: 0; }
.rc-resume__item { border-bottom: 1px solid var(--border); }
.rc-resume__row {
  width: 100%; text-align: left;
  display: grid; gap: var(--sp-2);
  min-height: var(--tap-min);
  padding: var(--sp-3) var(--sp-4);
  background: transparent; border: none; color: var(--text); cursor: pointer;
  transition: background 120ms ease;
}
.rc-resume__row:hover { background: var(--surface); }
.rc-resume__row:disabled { cursor: default; opacity: 0.55; }
/* The row being resumed stays full-opacity (it shows its own "Resuming…" chip) — only the OTHER
   rows dim while a resume is in flight. */
.rc-resume__row[aria-busy="true"] { opacity: 1; }
.rc-resume__summary {
  font-size: var(--fs-base); line-height: 1.4; color: var(--text);
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
}
.rc-resume__meta { display: flex; align-items: center; gap: var(--sp-2); min-width: 0; }
.rc-resume__cwd { display: flex; align-items: baseline; gap: var(--sp-2); min-width: 0; }
.rc-resume__cwd-name {
  font-family: var(--font-display); font-weight: 600; font-size: var(--fs-sm); color: var(--text);
  flex: none;
}
.rc-resume__cwd-path {
  font-family: var(--font-mono); font-size: var(--fs-xs); color: var(--text-muted);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0;
}
.rc-resume__meta--sub { flex-wrap: wrap; }
.rc-resume__chip {
  display: inline-flex; align-items: center; gap: 4px;
  font-family: var(--font-mono); font-size: var(--fs-xs); color: var(--text-faint);
  font-variant-numeric: tabular-nums;
}
.rc-resume__chip time { color: var(--text-muted); }
.rc-resume__chip--busy { color: var(--accent); }
.rc-resume__row-error {
  display: flex; align-items: center; gap: var(--sp-2);
  margin: 0 var(--sp-4) var(--sp-3);
  color: var(--err); font-size: var(--fs-xs);
}
`;
