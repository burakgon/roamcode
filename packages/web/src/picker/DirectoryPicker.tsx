import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Button } from "../ui/Button";
import { Mono } from "../ui/Mono";
import { Icon } from "../ui/Icon";
import { useFocusTrap } from "../ui/useFocusTrap";
import { fuzzyFilter } from "./fuzzy";
import type { DirEntry, DirListing } from "../types/server";

export interface DirectoryPickerProps {
  listDir: (path?: string) => Promise<DirListing>;
  recents: string[];
  onPick: (path: string) => void;
  onCancel: () => void;
  /** Optional content rendered at the very top of the sheet header (above the title) — the new/resume
   * segmented toggle injects here so the toggle reads as the first thing in the new-session flow. */
  topSlot?: ReactNode;
}

/**
 * The headline feature: a focused, full-height sheet for browsing the host filesystem.
 * Mobile-first — large tap targets, a thumb-reachable primary action ("Use this directory"),
 * mono paths, a segmented breadcrumb, recents, a fuzzy filter, and git-repo badges that show
 * the branch as TEXT (not color-only). Dismissible via the Cancel button or the Escape key;
 * focus moves to the filter on open so the sheet is keyboard-navigable immediately.
 */
export function DirectoryPicker({ listDir, recents, onPick, onCancel, topSlot }: DirectoryPickerProps) {
  const [listing, setListing] = useState<DirListing | undefined>();
  const [filter, setFilter] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);
  const filterRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  // Real modal semantics: trap Tab within the sheet and restore focus to the trigger on close.
  useFocusTrap(dialogRef);

  const navigate = useCallback(
    (path?: string) => {
      setError(undefined);
      setLoading(true);
      setFilter("");
      listDir(path)
        .then((next) => {
          setListing(next);
          setLoading(false);
        })
        .catch((e: unknown) => {
          setError(e instanceof Error ? e.message : "failed to list directory");
          setLoading(false);
        });
    },
    [listDir],
  );

  // Initial load — start at the server's fsRoot (path undefined).
  useEffect(() => {
    navigate(undefined);
  }, [navigate]);

  // The trap moves focus into the sheet; nudge it specifically to the filter so the sheet is
  // immediately searchable. Runs after useFocusTrap's mount effect, so it wins on open.
  useEffect(() => {
    filterRef.current?.focus();
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onCancel();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  const entries: DirEntry[] = listing
    ? fuzzyFilter(
        listing.entries.filter((e) => e.isDirectory),
        filter,
      )
    : [];

  return (
    <div ref={dialogRef} role="dialog" aria-modal="true" aria-label="Pick a directory" className="rc-picker">
      <header className="rc-picker__head">
        {topSlot}
        <div className="rc-picker__title">
          <strong className="display" style={{ fontSize: "var(--fs-lg)" }}>
            Pick a directory
          </strong>
          <Button variant="ghost" onClick={onCancel} aria-label="Cancel">
            Cancel
          </Button>
        </div>

        <div className="rc-picker__filter">
          <span aria-hidden="true" className="rc-picker__filter-icon">
            /
          </span>
          <input
            ref={filterRef}
            aria-label="Filter directories"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter directories…"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
          />
        </div>

        {listing && <Breadcrumb path={listing.path} parent={listing.parent} onNavigate={navigate} />}
      </header>

      <div className="rc-picker__body">
        {error && (
          <div role="alert" className="rc-picker__error">
            {error}
          </div>
        )}

        {recents.length > 0 && (
          <section>
            <h2 className="rc-picker__section-label">Recents</h2>
            <ul className="rc-picker__list">
              {recents.map((p) => (
                <li key={p}>
                  <button type="button" className="rc-picker__row" onClick={() => onPick(p)}>
                    <span className="rc-picker__star" aria-hidden="true">
                      <Icon name="star" size={14} />
                    </span>
                    <Mono>{p}</Mono>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section>
          <h2 className="rc-picker__section-label">Browse</h2>
          {loading && !listing && <div className="rc-picker__hint">Loading…</div>}
          <ul className="rc-picker__list">
            {entries.map((e) => (
              <li key={e.path}>
                <button
                  type="button"
                  className="rc-picker__row"
                  onClick={() => navigate(e.path)}
                  aria-label={`Open ${e.name}${e.isGitRepo ? `, git branch ${e.gitBranch ?? "unknown"}` : ""}`}
                >
                  <span className="rc-picker__row-main">
                    <span className="rc-picker__folder" aria-hidden="true">
                      <Icon name="folder" size={16} />
                    </span>
                    <Mono>{e.name}</Mono>
                    <span className="rc-picker__slash" aria-hidden="true">
                      /
                    </span>
                  </span>
                  {e.isGitRepo && (
                    <span className="rc-picker__git" title={`git branch: ${e.gitBranch ?? "?"}`}>
                      git:{e.gitBranch ?? "?"}
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
          {listing && entries.length === 0 && !error && (
            <div className="rc-picker__hint">{filter ? "No matches." : "No subdirectories here."}</div>
          )}
        </section>
      </div>

      <footer className="rc-picker__foot">
        {listing && (
          <p className="rc-picker__current">
            Selected: <Mono muted>{listing.path}</Mono>
          </p>
        )}
        <Button
          variant="primary"
          onClick={() => listing && onPick(listing.path)}
          disabled={!listing}
          aria-label="Use this directory"
        >
          Use this directory
        </Button>
      </footer>

      <style>{pickerCss}</style>
    </div>
  );
}

interface BreadcrumbProps {
  path: string;
  parent?: string;
  onNavigate: (path?: string) => void;
}

/** Segmented, navigable breadcrumb of the current absolute path. */
function Breadcrumb({ path, parent, onNavigate }: BreadcrumbProps) {
  const segments = path.split("/").filter(Boolean);
  // Build the absolute path for each crumb so a tap jumps straight there.
  const crumbs = segments.map((name, i) => ({ name, full: "/" + segments.slice(0, i + 1).join("/") }));

  return (
    <nav aria-label="Current path" className="rc-picker__crumbs">
      {parent !== undefined && (
        <button
          type="button"
          className="rc-picker__crumb rc-picker__crumb--up"
          onClick={() => onNavigate(parent)}
          aria-label="Up one directory"
        >
          <Icon name="arrow-up" size={15} />
        </button>
      )}
      <button type="button" className="rc-picker__crumb" onClick={() => onNavigate("/")}>
        /
      </button>
      {crumbs.map((c, i) => (
        <span key={c.full} className="rc-picker__crumb-wrap">
          {i > 0 && (
            <span className="rc-picker__crumb-sep" aria-hidden="true">
              /
            </span>
          )}
          <button
            type="button"
            className="rc-picker__crumb"
            onClick={() => onNavigate(c.full)}
            aria-current={i === crumbs.length - 1 ? "location" : undefined}
          >
            {c.name}
          </button>
        </span>
      ))}
    </nav>
  );
}

const pickerCss = `
.rc-picker {
  position: fixed; inset: 0; z-index: 50;
  /* Mobile full-bleed sheet — it OWNS the viewport (a takeover over the chat), so it paints the same
     warm-dark atmosphere as the app base (an opaque cover, not a see-through pane); desktop becomes a
     centered liquid-glass card instead. */
  background-color: var(--bg);
  background-image: var(--atmosphere);
  display: flex; flex-direction: column;
  animation: rc-picker-in 200ms cubic-bezier(0.16, 1, 0.3, 1);
}
@media (min-width: 768px) {
  .rc-picker {
    inset: auto; left: 50%; top: 50%; transform: translate(-50%, -50%);
    width: min(92vw, 560px); height: min(86vh, 720px);
    background: var(--glass-strong);
    backdrop-filter: var(--glass-blur);
    -webkit-backdrop-filter: var(--glass-blur);
    border-radius: var(--radius);
    box-shadow: var(--glass-shadow);
    overflow: hidden;
  }
}
@keyframes rc-picker-in {
  from { transform: translateY(16px); opacity: 0; }
  to { transform: translateY(0); opacity: 1; }
}
@media (min-width: 768px) {
  @keyframes rc-picker-in {
    from { transform: translate(-50%, calc(-50% + 8px)); opacity: 0; }
    to { transform: translate(-50%, -50%); opacity: 1; }
  }
}
.rc-picker__head {
  padding: var(--sp-4);
  border-bottom: 1px solid var(--border);
  display: grid; gap: var(--sp-3);
}
.rc-picker__title { display: flex; justify-content: space-between; align-items: center; }
.rc-picker__filter {
  display: flex; align-items: center; gap: var(--sp-2);
  min-height: var(--tap-min);
  background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--radius-sm); padding: 0 var(--sp-3);
}
.rc-picker__filter:focus-within { border-color: var(--accent-line); box-shadow: var(--focus-glow); }
.rc-picker__filter-icon { color: var(--text-muted); font-family: var(--font-mono); }
.rc-picker__filter input {
  flex: 1; min-height: var(--tap-min);
  background: transparent; border: none; outline: none;
  color: var(--text); font-family: var(--font-mono); font-size: var(--fs-base);
}
.rc-picker__crumbs {
  display: flex; align-items: center; gap: 2px; flex-wrap: wrap;
  font-family: var(--font-mono); font-size: var(--fs-sm);
}
.rc-picker__crumb-wrap { display: inline-flex; align-items: center; }
.rc-picker__crumb {
  background: transparent; border: none; cursor: pointer;
  color: var(--text-muted); font: inherit;
  padding: 4px var(--sp-1); border-radius: var(--radius-sm);
}
.rc-picker__crumb:hover { color: var(--text); background: var(--surface-2); }
.rc-picker__crumb[aria-current="location"] { color: var(--text); font-weight: 600; }
.rc-picker__crumb--up { color: var(--accent); }
.rc-picker__crumb-sep { color: var(--border); padding: 0 1px; }
.rc-picker__body {
  flex: 1; min-height: 0; overflow-y: auto;
  padding: var(--sp-4); display: grid; gap: var(--sp-5);
  -webkit-overflow-scrolling: touch;
}
.rc-picker__section-label {
  margin: 0 0 var(--sp-2) 0;
  color: var(--text-muted); font-size: var(--fs-xs);
  font-family: var(--font-display); font-weight: 600;
  text-transform: uppercase; letter-spacing: 0.08em;
}
.rc-picker__list { list-style: none; margin: 0; padding: 0; }
.rc-picker__row {
  width: 100%; text-align: left; min-height: var(--tap-min);
  display: flex; justify-content: space-between; align-items: center; gap: var(--sp-2);
  background: transparent; border: none; border-bottom: 1px solid var(--border);
  color: var(--text); padding: var(--sp-2) var(--sp-2); cursor: pointer;
  transition: background 120ms ease;
}
.rc-picker__row:hover, .rc-picker__row:focus-visible { background: var(--surface); }
.rc-picker__row:active { background: var(--surface-2); }
.rc-picker__row-main { display: flex; align-items: center; gap: var(--sp-2); min-width: 0; }
.rc-picker__folder { color: var(--text-muted); display: grid; place-items: center; flex: none; }
.rc-picker__slash { color: var(--text-faint); font-family: var(--font-mono); }
.rc-picker__star { color: var(--accent); display: grid; place-items: center; flex: none; }
.rc-picker__row:hover .rc-picker__folder { color: var(--accent); }
.rc-picker__git {
  flex: none; color: var(--accent);
  font-family: var(--font-mono); font-size: var(--fs-xs);
  background: var(--accent-soft);
  border: 1px solid var(--accent-line); border-radius: var(--radius-sm);
  padding: 2px var(--sp-2); white-space: nowrap;
}
.rc-picker__hint { color: var(--text-muted); padding: var(--sp-2); }
.rc-picker__error {
  color: var(--err); border: 1px solid var(--err); border-radius: var(--radius-sm);
  padding: var(--sp-3); background: var(--surface);
}
.rc-picker__foot {
  padding: var(--sp-4); border-top: 1px solid var(--border);
  display: grid; gap: var(--sp-2);
}
.rc-picker__foot button { width: 100%; }
.rc-picker__current { margin: 0; font-size: var(--fs-sm); color: var(--text-muted); overflow-wrap: anywhere; }
`;
