import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Button } from "../ui/Button";
import { Mono } from "../ui/Mono";
import { Icon } from "../ui/Icon";
import { useFocusTrap } from "../ui/useFocusTrap";
import { fuzzyFilter } from "./fuzzy";
import { loadDirBranches, loadFavoriteDirs, recordDirBranch, toggleFavoriteDir } from "./recents";
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
 * mono paths, a segmented breadcrumb, pinned favorites, recents, a fuzzy filter, and git-repo badges
 * that show the branch as TEXT (not color-only). Each row can be USED directly (pick a visible
 * subfolder without entering it) or PINNED to the top. Dismissible via the Cancel button or the
 * Escape key; focus moves to the filter on open so the sheet is keyboard-navigable immediately.
 */
export function DirectoryPicker({ listDir, recents, onPick, onCancel, topSlot }: DirectoryPickerProps) {
  const [listing, setListing] = useState<DirListing | undefined>();
  const [filter, setFilter] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);
  // Favorites are managed locally (seeded from localStorage) so a pin/unpin re-renders immediately.
  const [favorites, setFavorites] = useState<string[]>(() => loadFavoriteDirs());
  const filterRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  // Cached git branches for bare paths (recents/favorites don't carry entry metadata). Recomputed each
  // render off localStorage — the map is tiny and bounded.
  const branches = loadDirBranches();

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

  // The trap moves focus into the sheet; nudge it to the filter so the sheet is immediately searchable
  // (runs after useFocusTrap's mount effect, so it wins on open). SKIP on touch (coarse pointer): there,
  // auto-focusing pops the on-screen keyboard over the directory list the moment the picker opens.
  useEffect(() => {
    const coarse = typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches;
    if (!coarse) filterRef.current?.focus();
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

  // Pick a directory, first recording any branch we know so it can label the path as a recent later.
  const pick = (path: string, branch?: string) => {
    if (branch) recordDirBranch(path, branch);
    onPick(path);
  };
  const toggleFav = (path: string, branch?: string) => setFavorites(toggleFavoriteDir(path, branch));

  // Recents minus anything already pinned (favorites render first, so avoid a duplicate row).
  const recentsOnly = recents.filter((p) => !favorites.includes(p));

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
            onKeyDown={(e) => {
              // Typing an ABSOLUTE path + Enter jumps straight there (terminal `cd /deep/path` parity) —
              // far faster than clicking through the tree to a known location. A bad path surfaces the
              // server's listDir error like any other navigation.
              if (e.key === "Enter" && filter.startsWith("/")) {
                e.preventDefault();
                navigate(filter);
              }
            }}
            placeholder="Filter directories… (or type /abs/path + Enter)"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
          />
        </div>

        <div className="rc-picker__crumbrow">
          {listing && <Breadcrumb path={listing.path} parent={listing.parent} onNavigate={navigate} />}
          {loading && listing && (
            <span className="rc-picker__loading" role="status">
              Loading…
            </span>
          )}
        </div>
      </header>

      <div className="rc-picker__body" aria-busy={loading}>
        {error && (
          <div role="alert" className="rc-picker__error">
            {error}
          </div>
        )}

        {favorites.length > 0 && (
          <section>
            <h2 className="rc-picker__section-label">Favorites</h2>
            <ul className="rc-picker__list">
              {favorites.map((p) => (
                <PathRow
                  key={p}
                  path={p}
                  branch={branches[p]}
                  favorited
                  onUse={() => pick(p, branches[p])}
                  onToggleFav={() => toggleFav(p, branches[p])}
                />
              ))}
            </ul>
          </section>
        )}

        {recentsOnly.length > 0 && (
          <section>
            <h2 className="rc-picker__section-label">Recents</h2>
            <ul className="rc-picker__list">
              {recentsOnly.map((p) => (
                <PathRow
                  key={p}
                  path={p}
                  branch={branches[p]}
                  favorited={false}
                  onUse={() => pick(p, branches[p])}
                  onToggleFav={() => toggleFav(p, branches[p])}
                />
              ))}
            </ul>
          </section>
        )}

        <section>
          <h2 className="rc-picker__section-label">Browse</h2>
          {loading && !listing && <div className="rc-picker__hint">Loading…</div>}
          <ul className="rc-picker__list">
            {entries.map((e) => (
              <li key={e.path} className="rc-picker__item">
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
                <div className="rc-picker__row-actions">
                  {/* Pick a visible subfolder WITHOUT entering it. */}
                  <button
                    type="button"
                    className="rc-picker__use"
                    onClick={() => pick(e.path, e.gitBranch)}
                    aria-label={`Use ${e.name}`}
                  >
                    Use
                  </button>
                  <FavButton
                    favorited={favorites.includes(e.path)}
                    name={e.name}
                    onClick={() => toggleFav(e.path, e.gitBranch)}
                  />
                </div>
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

/** A pinned/recent row: the whole row USES the path; a trailing star toggles the pin. */
function PathRow({
  path,
  branch,
  favorited,
  onUse,
  onToggleFav,
}: {
  path: string;
  branch?: string;
  favorited: boolean;
  onUse: () => void;
  onToggleFav: () => void;
}) {
  return (
    <li className="rc-picker__item">
      <button type="button" className="rc-picker__row" onClick={onUse} aria-label={`Use ${path}`}>
        <span className="rc-picker__row-main">
          <span className="rc-picker__folder" aria-hidden="true">
            <Icon name="folder" size={16} />
          </span>
          <Mono>{path}</Mono>
        </span>
        {branch && (
          <span className="rc-picker__git" title={`git branch: ${branch}`}>
            git:{branch}
          </span>
        )}
      </button>
      <div className="rc-picker__row-actions">
        <FavButton favorited={favorited} name={path} onClick={onToggleFav} />
      </div>
    </li>
  );
}

/** The pin toggle — one star icon, coral when pinned, faint when not. */
function FavButton({ favorited, name, onClick }: { favorited: boolean; name: string; onClick: () => void }) {
  return (
    <button
      type="button"
      className={`rc-picker__pin${favorited ? " rc-picker__pin--on" : ""}`}
      onClick={onClick}
      aria-pressed={favorited}
      aria-label={favorited ? `Unpin ${name}` : `Pin ${name}`}
      title={favorited ? "Unpin" : "Pin to top"}
    >
      <Icon name="star" size={16} />
    </button>
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
     clean near-black base + the one faint top glow as the app (an opaque cover, not a see-through
     pane); desktop becomes a centered floating-glass card instead. */
  background-color: var(--bg);
  background-image: var(--top-glow);
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
    border: 1px solid var(--border-strong);
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
  padding: calc(var(--sp-4) + env(safe-area-inset-top, 0px)) var(--sp-4) var(--sp-4);
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
.rc-picker__crumbrow { display: flex; align-items: center; gap: var(--sp-2); flex-wrap: wrap; }
.rc-picker__crumbrow > .rc-picker__crumbs { flex: 1; min-width: 0; }
.rc-picker__loading {
  flex: none; color: var(--text-muted); font-family: var(--font-mono); font-size: var(--fs-xs);
  animation: rc-picker-pulse 1s ease-in-out infinite;
}
@keyframes rc-picker-pulse { 0%, 100% { opacity: 0.5; } 50% { opacity: 1; } }
@media (prefers-reduced-motion: reduce) { .rc-picker__loading { animation: none; } }
.rc-picker__crumbs {
  display: flex; align-items: center; gap: 2px; flex-wrap: wrap;
  font-family: var(--font-mono); font-size: var(--fs-sm);
}
.rc-picker__crumb-wrap { display: inline-flex; align-items: center; }
.rc-picker__crumb {
  background: transparent; border: none; cursor: pointer;
  color: var(--text-muted); font: inherit;
  min-height: var(--tap-min); display: inline-flex; align-items: center;
  padding: 4px var(--sp-1); border-radius: var(--radius-sm);
}
.rc-picker__crumb:hover { color: var(--text); background: var(--surface-2); }
.rc-picker__crumb[aria-current="location"] { color: var(--text); font-weight: 600; }
.rc-picker__crumb--up { color: var(--text-muted); }
.rc-picker__crumb-sep { color: var(--border); padding: 0 1px; }
.rc-picker__body {
  flex: 1; min-height: 0; overflow-y: auto;
  padding: var(--sp-4); display: grid; gap: var(--sp-5);
  -webkit-overflow-scrolling: touch;
  transition: opacity 120ms ease;
}
/* Dim the (stale) list while a navigation is in flight — a quiet in-progress cue. */
.rc-picker__body[aria-busy="true"] { opacity: 0.6; }
.rc-picker__section-label {
  margin: 0 0 var(--sp-2) 0;
  color: var(--text-muted); font-size: var(--fs-xs);
  font-family: var(--font-display); font-weight: 600;
  text-transform: uppercase; letter-spacing: 0.08em;
}
.rc-picker__list { list-style: none; margin: 0; padding: 0; }
/* A row is now a container: the main USE button plus trailing actions (Use / pin). */
.rc-picker__item {
  display: flex; align-items: center; gap: var(--sp-1);
  border-bottom: 1px solid var(--border);
}
.rc-picker__row {
  flex: 1; min-width: 0; text-align: left; min-height: var(--tap-min);
  display: flex; justify-content: space-between; align-items: center; gap: var(--sp-2);
  background: transparent; border: none;
  color: var(--text); padding: var(--sp-2) var(--sp-2); cursor: pointer;
  border-radius: var(--radius-sm);
  transition: background 120ms ease;
}
.rc-picker__row:hover, .rc-picker__row:focus-visible { background: var(--surface); }
.rc-picker__row:active { background: var(--surface-2); }
.rc-picker__row-main { display: flex; align-items: center; gap: var(--sp-2); min-width: 0; }
.rc-picker__row-main > :nth-child(2) { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rc-picker__folder { color: var(--text-muted); display: grid; place-items: center; flex: none; }
.rc-picker__slash { color: var(--text-faint); font-family: var(--font-mono); }
.rc-picker__row:hover .rc-picker__folder { color: var(--text); }
.rc-picker__row-actions { display: flex; align-items: center; gap: 2px; flex: none; }
.rc-picker__use {
  min-height: var(--tap-min); padding: 0 var(--sp-3);
  background: transparent; border: 1px solid var(--border); border-radius: var(--radius-sm);
  color: var(--text-muted); font: inherit; font-size: var(--fs-sm); cursor: pointer;
  transition: border-color 120ms ease, color 120ms ease;
}
.rc-picker__use:hover { color: var(--text); border-color: var(--text-faint); }
.rc-picker__pin {
  width: var(--tap-min); height: var(--tap-min); flex: none;
  display: grid; place-items: center;
  background: transparent; border: none; cursor: pointer;
  color: var(--text-faint); border-radius: var(--radius-sm);
  transition: color 120ms ease;
}
.rc-picker__pin:hover { color: var(--text-muted); }
.rc-picker__pin--on { color: var(--coral); }
.rc-picker__pin--on:hover { color: var(--coral); }
/* git-branch chip — a NEUTRAL chip (spec: not coral): an elevated surface + hairline, muted mono. */
.rc-picker__git {
  flex: none; color: var(--text-muted);
  font-family: var(--font-mono); font-size: var(--fs-xs);
  background: var(--surface-2);
  border: 1px solid var(--border); border-radius: var(--radius-sm);
  padding: 2px var(--sp-2); white-space: nowrap;
}
.rc-picker__hint { color: var(--text-muted); padding: var(--sp-2); }
.rc-picker__error {
  color: var(--err); border: 1px solid var(--err); border-radius: var(--radius-sm);
  padding: var(--sp-3); background: var(--surface);
}
.rc-picker__foot {
  padding: var(--sp-4); padding-bottom: calc(var(--sp-4) + env(safe-area-inset-bottom, 0px));
  border-top: 1px solid var(--border);
  display: grid; gap: var(--sp-2);
}
.rc-picker__foot button { width: 100%; }
.rc-picker__current { margin: 0; font-size: var(--fs-sm); color: var(--text-muted); overflow-wrap: anywhere; }
`;
