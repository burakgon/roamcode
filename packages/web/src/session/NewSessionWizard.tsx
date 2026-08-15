import { useEffect, useRef, useState } from "react";
import type { MouseEvent } from "react";
import { ApiError, type ApiClient, type CreateSessionBody, type CreateSessionResponse } from "../api/client";
import { DirectoryPicker } from "../picker/DirectoryPicker";
import { pushRecentDir } from "../picker/recents";
import type { SessionMeta } from "../types/server";
import { Icon } from "../ui/Icon";
import { Mono } from "../ui/Mono";
import { useFocusTrap } from "../ui/useFocusTrap";
import { TROUBLESHOOTING_URL } from "../config";

const SESSION_NAMES_KEY = "rc-session-names";

function saveSessionName(id: string, name: string): void {
  const trimmed = name.trim();
  if (!trimmed) return;
  try {
    const raw = window.localStorage?.getItem(SESSION_NAMES_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : {};
    const all = parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
    all[id] = trimmed;
    window.localStorage?.setItem(SESSION_NAMES_KEY, JSON.stringify(all));
  } catch {
    // Storage can be unavailable in private mode; the rail falls back to the folder name.
  }
}

function basename(path: string): string {
  const parts = path.replace(/\/+$/u, "").split("/");
  return parts[parts.length - 1] || path;
}

export interface NewSessionWizardProps {
  api: Pick<ApiClient, "listDir" | "createSession"> & Partial<Pick<ApiClient, "mkdir" | "searchDirs">>;
  recents: string[];
  /**
   * The Node's own report of whether it can start terminals at all (GET /version → `terminalAvailable`).
   * The field existed and had NO consumer: on a Node without tmux or a loadable node-pty, "New terminal"
   * looked entirely normal and only failed after the user had browsed for a directory. `undefined` on an
   * older server means "unknown", which stays permissive.
   */
  terminalAvailable?: boolean;
  initialCwd?: string;
  createSession?: (body: CreateSessionBody) => Promise<CreateSessionResponse>;
  onCreated: (session: SessionMeta) => void;
  onClose: () => void;
}

/**
 * Manual Sessions are intentionally terminal-first: choose a directory and open an ordinary interactive
 * shell. RoamCode does not choose, configure, authenticate, or launch a coding agent on the user's behalf.
 */
export function NewSessionWizard({
  api,
  recents,
  terminalAvailable,
  initialCwd,
  createSession,
  onCreated,
  onClose,
}: NewSessionWizardProps) {
  const [cwd, setCwd] = useState<string | undefined>(initialCwd);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const dialogRef = useRef<HTMLDivElement>(null);
  const onConfirmStep = Boolean(cwd);

  useFocusTrap(dialogRef, onConfirmStep);

  useEffect(() => {
    if (!onConfirmStep) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [onConfirmStep]);

  useEffect(() => {
    if (!onConfirmStep || busy) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose, onConfirmStep]);

  // Say this BEFORE the directory browse, not after it. The server answers this create with a 400 and an
  // actionable hint, but making someone pick a folder first only to be told the Node can't do it is a
  // detour with a dead end at the end of it.
  if (terminalAvailable === false) {
    return (
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="New terminal"
        className="rc-wizard"
        onClick={(event) => event.target === event.currentTarget && onClose()}
      >
        <section className="rc-wizard__card">
          <div className="rc-wizard__body">
            <header className="rc-wizard__head">
              <span className="rc-wizard__head-icon" aria-hidden="true">
                <Icon name="alert" size={18} />
              </span>
              <div>
                <strong className="display rc-wizard__title">This Node can&apos;t open terminals</strong>
                <p>Persistent sessions need both tmux and a loadable node-pty on the machine running RoamCode.</p>
              </div>
            </header>
            <div role="alert" className="rc-wizard__error">
              <Icon name="alert" size={16} />
              <span>
                Install tmux there (and make sure node-pty builds), then reopen this.{" "}
                <a href={TROUBLESHOOTING_URL} target="_blank" rel="noreferrer" className="rc-wizard__link">
                  Troubleshooting
                </a>
              </span>
            </div>
            <div className="rc-wizard__actions">
              <button type="button" className="rc-wizard__cancel" onClick={onClose}>
                Close
              </button>
            </div>
          </div>
        </section>
        <style>{wizardCss}</style>
      </div>
    );
  }

  if (!cwd) {
    return (
      <DirectoryPicker
        listDir={api.listDir}
        mkdir={api.mkdir}
        searchDirs={api.searchDirs}
        recents={recents}
        onPick={setCwd}
        onCancel={onClose}
      />
    );
  }

  const onBackdrop = (event: MouseEvent<HTMLDivElement>) => {
    if (!busy && event.target === event.currentTarget) onClose();
  };

  const start = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const response = await (createSession ?? api.createSession)({ cwd, mode: "terminal" });
      saveSessionName(response.session.id, name);
      pushRecentDir(cwd);
      onCreated(response.session);
    } catch (caught) {
      setError(
        caught instanceof ApiError || caught instanceof Error ? caught.message : "The terminal could not be opened.",
      );
      setBusy(false);
    }
  };

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label="New terminal"
      className="rc-wizard"
      onClick={onBackdrop}
    >
      <section className="rc-wizard__card">
        <div className="rc-wizard__body">
          <header className="rc-wizard__head">
            <span className="rc-wizard__head-icon" aria-hidden="true">
              <Icon name="terminal" size={18} />
            </span>
            <div>
              <strong className="display rc-wizard__title">New terminal</strong>
              <p>Open a shell, then start any tool you want.</p>
            </div>
          </header>

          <div className="rc-wizard__dir">
            <span className="rc-wizard__dir-icon" aria-hidden="true">
              <Icon name="folder" size={16} />
            </span>
            <Mono>{cwd}</Mono>
            <button
              type="button"
              className="rc-wizard__change"
              onClick={() => setCwd(undefined)}
              aria-label="Change directory"
              disabled={busy}
            >
              Change
            </button>
          </div>

          <label className="rc-wizard__field">
            <span className="rc-wizard__field-label">Name (optional)</span>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={basename(cwd)}
              aria-label="terminal name"
              className="rc-wizard__control"
              disabled={busy}
              maxLength={80}
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
            />
          </label>

          {error && (
            <div role="alert" className="rc-wizard__error">
              <Icon name="alert" size={16} />
              <span>{error}</span>
            </div>
          )}

          <div className="rc-wizard__actions">
            <button type="button" className="rc-wizard__start" disabled={busy} onClick={start}>
              {busy ? "Opening…" : "Open terminal"}
            </button>
            <button type="button" className="rc-wizard__cancel" onClick={onClose} disabled={busy}>
              Cancel
            </button>
          </div>
        </div>
      </section>
      <style>{wizardCss}</style>
    </div>
  );
}

const wizardCss = `
.rc-wizard {
  position: fixed; inset: 0; z-index: 50; background: var(--scrim);
  display: grid; place-items: center; padding: var(--sp-5);
}
.rc-wizard__card {
  width: min(92vw, 460px); max-height: calc(100dvh - 2 * var(--sp-5));
  overflow: hidden; background: var(--glass-strong);
  backdrop-filter: var(--glass-blur); -webkit-backdrop-filter: var(--glass-blur);
  border: 1px solid var(--border-strong); border-radius: var(--radius-lg); box-shadow: var(--glass-shadow);
}
.rc-wizard__body { overflow-y: auto; padding: var(--sp-5); display: grid; gap: var(--sp-4); }
.rc-wizard__head { display: flex; align-items: flex-start; gap: var(--sp-3); }
.rc-wizard__head p { margin: 4px 0 0; color: var(--text-muted); font-size: var(--fs-sm); }
.rc-wizard__head-icon {
  width: 30px; height: 30px; flex: none; display: grid; place-items: center;
  border-radius: var(--radius-sm); background: var(--surface-2);
  border: 1px solid var(--border-strong); color: var(--text-muted);
}
.rc-wizard__title { font-size: var(--fs-lg); }
.rc-wizard__dir {
  display: flex; align-items: center; gap: var(--sp-2); flex-wrap: wrap;
  font-size: var(--fs-sm); background: var(--surface-2); border: 1px solid var(--border);
  border-radius: var(--radius-sm); padding: var(--sp-2) var(--sp-3);
}
.rc-wizard__dir-icon { color: var(--text-muted); display: grid; }
.rc-wizard__dir > :nth-child(2) { color: var(--text); overflow-wrap: anywhere; flex: 1; min-width: 0; }
.rc-wizard__change {
  min-height: var(--tap-min); padding: 0 var(--sp-2); background: transparent; border: 0;
  color: var(--text-muted); font: inherit; cursor: pointer; border-radius: var(--radius-sm);
}
.rc-wizard__field { display: grid; gap: var(--sp-2); }
.rc-wizard__field-label { color: var(--text-muted); font-size: var(--fs-sm); }
.rc-wizard__control {
  min-height: var(--tap-min); padding: 0 var(--sp-3); background: var(--surface-2);
  border: 1px solid var(--border); border-radius: var(--radius-sm); color: var(--text); font: inherit;
}
.rc-wizard__control:focus { border-color: var(--accent-line); box-shadow: var(--focus-glow); }
.rc-wizard__error {
  display: flex; align-items: center; gap: var(--sp-2); color: var(--err);
  background: var(--err-bg); border: 1px solid var(--err-border);
  border-radius: var(--radius-sm); padding: var(--sp-2) var(--sp-3); font-size: var(--fs-sm);
}
.rc-wizard__link { color: inherit; text-decoration: underline; }
.rc-wizard__actions { display: flex; gap: var(--sp-3); }
.rc-wizard__start, .rc-wizard__cancel {
  min-height: var(--tap-min); border-radius: var(--radius-sm); cursor: pointer; font: inherit; padding: 0 var(--sp-4);
}
.rc-wizard__start {
  flex: 1; border: 0; background: var(--accent-grad); color: var(--on-accent); font-weight: 600;
}
.rc-wizard__cancel { background: transparent; border: 1px solid var(--border-strong); color: var(--text); }
.rc-wizard button:disabled { opacity: .5; cursor: default; }
`;
