import { useEffect, useMemo, useRef, useState } from "react";
import type { ApiClient } from "../api/client";
import { DirectoryPicker } from "../picker/DirectoryPicker";
import { loadRecentDirs } from "../picker/recents";
import type { HostRecord, WorkspaceRecord, WorktreeRecord } from "../types/server";
import { Icon } from "../ui/Icon";
import { InlineConfirm } from "../ui/InlineConfirm";
import { useFocusTrap } from "../ui/useFocusTrap";

type WorkspaceConfirmation =
  | { kind: "archive"; workspaceId: string; label: string }
  | { kind: "remove"; workspaceId: string; label: string; force: boolean; message: string };

type WorktreePreview = WorktreeRecord & { runningSessions: number };

type WorkspaceApi = Pick<
  ApiClient,
  | "renameCommandHost"
  | "createWorkspace"
  | "updateWorkspace"
  | "createWorktree"
  | "openWorktree"
  | "getWorktreeStatus"
  | "removeWorktree"
  | "listDir"
  | "mkdir"
  | "searchDirs"
>;

export interface WorkspaceManagerProps {
  open: boolean;
  host: HostRecord;
  workspaces: WorkspaceRecord[];
  api: WorkspaceApi;
  onHostChanged: (host: HostRecord) => void;
  onWorkspacesChanged: () => void | Promise<void>;
  onStartSession: (cwd: string) => void;
  onClose: () => void;
  /** Opens the manager directly in project-scoped worktree creation from the rail's project action. */
  initialProjectId?: string;
}

export function WorkspaceManager({
  open,
  host,
  workspaces,
  api,
  onHostChanged,
  onWorkspacesChanged,
  onStartSession,
  onClose,
  initialProjectId,
}: WorkspaceManagerProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [hostDraft, setHostDraft] = useState(host.label);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [newKind, setNewKind] = useState<"directory" | "worktree" | "new-worktree">("directory");
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [branch, setBranch] = useState("");
  const [baseRef, setBaseRef] = useState("");
  const [worktreeStatus, setWorktreeStatus] = useState<Record<string, WorktreePreview>>({});
  const [confirmation, setConfirmation] = useState<WorkspaceConfirmation>();
  useFocusTrap(panelRef, open && !pickerOpen);

  const ordered = useMemo(
    () => [...workspaces].sort((a, b) => a.sortOrder - b.sortOrder || a.createdAt - b.createdAt),
    [workspaces],
  );
  const projectRoots = useMemo(() => {
    const known = new Set(workspaces.map((workspace) => workspace.id));
    return ordered.filter((workspace) => {
      const projectId = workspace.projectId ?? workspace.id;
      return projectId === workspace.id || !known.has(projectId);
    });
  }, [ordered, workspaces]);

  useEffect(() => setHostDraft(host.label), [host.label]);
  useEffect(() => {
    setDrafts(Object.fromEntries(workspaces.map((workspace) => [workspace.id, workspace.label])));
  }, [workspaces]);
  useEffect(() => {
    if (!open) return;
    const fallback = projectRoots[0]?.id ?? "";
    setSelectedProjectId((current) =>
      projectRoots.some((project) => project.id === (initialProjectId ?? current))
        ? (initialProjectId ?? current)
        : fallback,
    );
    if (initialProjectId) setNewKind("new-worktree");
  }, [initialProjectId, open, projectRoots]);
  useEffect(() => {
    if (!open || pickerOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, open, pickerOpen]);

  if (!open) return null;

  const run = async (key: string, operation: () => Promise<void>) => {
    if (busy) return;
    setBusy(key);
    setError(undefined);
    try {
      await operation();
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : "The host couldn't apply that workspace change.");
    } finally {
      setBusy(undefined);
    }
  };

  const renameWorkspace = (workspace: WorkspaceRecord) => {
    const label = drafts[workspace.id]?.trim();
    if (!label || label === workspace.label) return;
    void run(`rename:${workspace.id}`, async () => {
      await api.updateWorkspace(workspace.id, { label });
      await onWorkspacesChanged();
    });
  };

  const move = (index: number, direction: -1 | 1) => {
    const workspace = ordered[index];
    const neighbor = ordered[index + direction];
    if (!workspace || !neighbor) return;
    void run(`move:${workspace.id}`, async () => {
      await Promise.all([
        api.updateWorkspace(workspace.id, { sortOrder: neighbor.sortOrder }),
        api.updateWorkspace(neighbor.id, { sortOrder: workspace.sortOrder }),
      ]);
      await onWorkspacesChanged();
    });
  };

  const prepareWorktreeRemoval = async (workspace: WorkspaceRecord) => {
    if (busy) return;
    setBusy(`inspect-remove:${workspace.id}`);
    setError(undefined);
    try {
      const result = await api.getWorktreeStatus(workspace.id);
      const status = { ...result.worktree, runningSessions: result.runningSessions };
      setWorktreeStatus((current) => ({ ...current, [workspace.id]: status }));
      const branchLabel = status.branch ? `Branch ${status.branch}. ` : "Detached worktree. ";
      const dirtyCopy = status.dirty
        ? `${status.changedFiles} uncommitted file(s) will be permanently discarded. `
        : "The checkout is clean. ";
      const sessionCopy =
        status.runningSessions > 0
          ? `${status.runningSessions} running session(s) will be stopped. `
          : "No running sessions. ";
      setConfirmation({
        kind: "remove",
        workspaceId: workspace.id,
        label: workspace.label,
        force: status.dirty,
        message: `${branchLabel}${dirtyCopy}${sessionCopy}The Git branch and commits remain.`,
      });
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : "The host couldn't inspect that worktree.");
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <div className="rc-workspaces" role="dialog" aria-modal="true" aria-labelledby="rc-workspaces-title">
      <button type="button" className="rc-workspaces__scrim" aria-label="Close workspaces" onClick={onClose} />
      <div className="rc-workspaces__panel" ref={panelRef}>
        <header className="rc-workspaces__head">
          <span className="rc-workspaces__mark" aria-hidden="true">
            <Icon name="folder" size={17} />
          </span>
          <span>
            <strong id="rc-workspaces-title">Host &amp; workspaces</strong>
            <small>Durable structure shared by every device</small>
          </span>
          <button type="button" className="rc-workspaces__close" aria-label="Close" onClick={onClose}>
            <Icon name="x" size={18} />
          </button>
        </header>

        <div className="rc-workspaces__body">
          {error && (
            <div className="rc-workspaces__error" role="status">
              <Icon name="alert" size={14} />
              <span>{error}</span>
            </div>
          )}

          <section className="rc-workspaces__section" aria-labelledby="rc-host-label">
            <div className="rc-workspaces__section-head">
              <span id="rc-host-label">Host name</span>
            </div>
            <form
              className="rc-workspaces__host-form"
              onSubmit={(event) => {
                event.preventDefault();
                const label = hostDraft.trim();
                if (!label || label === host.label) return;
                void run("host", async () => onHostChanged(await api.renameCommandHost(label)));
              }}
            >
              <input
                value={hostDraft}
                onChange={(event) => setHostDraft(event.target.value)}
                aria-label="Host name"
                maxLength={80}
              />
              <button type="submit" disabled={busy === "host" || !hostDraft.trim() || hostDraft.trim() === host.label}>
                Save
              </button>
            </form>
            <p>This is a friendly label only; RoamCode does not expose the machine hostname.</p>
          </section>

          <section className="rc-workspaces__section" aria-labelledby="rc-workspace-list-label">
            <div className="rc-workspaces__section-head">
              <span id="rc-workspace-list-label">Workspaces</span>
              <span>{ordered.length}</span>
            </div>
            <ul className="rc-workspaces__list">
              {ordered.map((workspace, index) => {
                const pending = confirmation?.workspaceId === workspace.id ? confirmation : undefined;
                const isProjectRoot = (workspace.projectId ?? workspace.id) === workspace.id;
                return (
                  <li
                    key={workspace.id}
                    className={`rc-workspaces__item${isProjectRoot ? " rc-workspaces__item--project" : " rc-workspaces__item--checkout"}`}
                  >
                    <div className="rc-workspaces__row-head">
                      <span className="rc-workspaces__kind">{isProjectRoot ? "Project" : "Worktree"}</span>
                      <span>{workspace.agentCount ?? 0} agents</span>
                      {(workspace.attentionCount ?? 0) > 0 && (
                        <span className="rc-workspaces__needs">{workspace.attentionCount} new</span>
                      )}
                    </div>
                    <form
                      className="rc-workspaces__rename"
                      onSubmit={(event) => {
                        event.preventDefault();
                        renameWorkspace(workspace);
                      }}
                    >
                      <input
                        value={drafts[workspace.id] ?? workspace.label}
                        onChange={(event) =>
                          setDrafts((current) => ({ ...current, [workspace.id]: event.target.value }))
                        }
                        aria-label={`Name for ${workspace.label}`}
                        maxLength={80}
                      />
                      <button type="submit" aria-label={`Save ${workspace.label}`} disabled={busy !== undefined}>
                        <Icon name="check" size={14} />
                      </button>
                    </form>
                    <code title={workspace.cwd}>{workspace.cwd}</code>
                    {workspace.kind === "worktree" && worktreeStatus[workspace.id] && (
                      <p className={worktreeStatus[workspace.id]!.dirty ? "rc-workspaces__dirty" : undefined}>
                        {worktreeStatus[workspace.id]!.dirty
                          ? `${worktreeStatus[workspace.id]!.changedFiles} uncommitted file(s)`
                          : "Clean worktree"}
                        {worktreeStatus[workspace.id]!.branch
                          ? ` · ${worktreeStatus[workspace.id]!.branch}`
                          : " · detached"}
                      </p>
                    )}
                    <div className="rc-workspaces__actions">
                      <button type="button" onClick={() => onStartSession(workspace.cwd)}>
                        <Icon name="plus" size={13} /> New session
                      </button>
                      <button
                        type="button"
                        aria-label={`Move ${workspace.label} up`}
                        disabled={index === 0 || !!busy}
                        onClick={() => move(index, -1)}
                      >
                        <Icon name="arrow-up" size={13} />
                      </button>
                      <button
                        type="button"
                        aria-label={`Move ${workspace.label} down`}
                        disabled={index === ordered.length - 1 || !!busy}
                        onClick={() => move(index, 1)}
                      >
                        <Icon name="arrow-up" size={13} style={{ transform: "rotate(180deg)" }} />
                      </button>
                      {workspace.kind === "worktree" && (
                        <>
                          <button
                            type="button"
                            disabled={!!busy}
                            onClick={() =>
                              void run(`status:${workspace.id}`, async () => {
                                const status = await api.getWorktreeStatus(workspace.id);
                                setWorktreeStatus((current) => ({
                                  ...current,
                                  [workspace.id]: {
                                    ...status.worktree,
                                    runningSessions: status.runningSessions,
                                  },
                                }));
                              })
                            }
                          >
                            Status
                          </button>
                          <button
                            type="button"
                            className="rc-workspaces__archive"
                            disabled={!!busy}
                            aria-expanded={pending?.kind === "remove"}
                            onClick={() => void prepareWorktreeRemoval(workspace)}
                          >
                            Remove worktree
                          </button>
                        </>
                      )}
                      <button
                        type="button"
                        className="rc-workspaces__archive"
                        disabled={!!busy}
                        aria-expanded={pending?.kind === "archive"}
                        onClick={() =>
                          setConfirmation({ kind: "archive", workspaceId: workspace.id, label: workspace.label })
                        }
                      >
                        <Icon name="archive" size={13} /> Archive
                      </button>
                    </div>
                    {pending && (
                      <InlineConfirm
                        className="rc-workspaces__confirm"
                        message={
                          pending.kind === "remove"
                            ? pending.message
                            : `Archive ${pending.label}${(workspace.projectId ?? workspace.id) === workspace.id ? " and its worktree checkouts" : ""}? Running sessions are not stopped.`
                        }
                        confirmLabel={pending.kind === "remove" ? "Remove worktree now" : "Archive workspace"}
                        busy={busy === `${pending.kind}:${workspace.id}`}
                        onCancel={() => setConfirmation(undefined)}
                        onConfirm={() =>
                          void run(`${pending.kind}:${workspace.id}`, async () => {
                            if (pending.kind === "remove") {
                              await api.removeWorktree(pending.workspaceId, pending.force, true);
                            } else {
                              const target = workspaces.find((candidate) => candidate.id === pending.workspaceId);
                              const related =
                                target && (target.projectId ?? target.id) === target.id
                                  ? workspaces.filter(
                                      (candidate) =>
                                        candidate.id === target.id ||
                                        (candidate.projectId ?? candidate.id) === target.id,
                                    )
                                  : target
                                    ? [target]
                                    : [];
                              await Promise.all(
                                related.map((candidate) => api.updateWorkspace(candidate.id, { archived: true })),
                              );
                            }
                            await onWorkspacesChanged();
                            setConfirmation(undefined);
                          })
                        }
                      />
                    )}
                  </li>
                );
              })}
              {ordered.length === 0 && <li className="rc-workspaces__empty">No durable workspaces yet.</li>}
            </ul>
          </section>
        </div>

        {newKind === "new-worktree" && (
          <form
            className="rc-workspaces__new-worktree"
            onSubmit={(event) => {
              event.preventDefault();
              void run("create-worktree", async () => {
                await api.createWorktree({
                  projectId: selectedProjectId,
                  branch: branch.trim(),
                  ...(baseRef.trim() ? { baseRef: baseRef.trim() } : {}),
                });
                setBranch("");
                setBaseRef("");
                await onWorkspacesChanged();
              });
            }}
          >
            <label>
              Project
              <select value={selectedProjectId} onChange={(event) => setSelectedProjectId(event.target.value)} required>
                {projectRoots.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Branch
              <input value={branch} onChange={(event) => setBranch(event.target.value)} placeholder="feature/name" />
            </label>
            <label>
              Base ref (optional)
              <input value={baseRef} onChange={(event) => setBaseRef(event.target.value)} placeholder="HEAD" />
            </label>
            <button type="submit" disabled={!!busy || !selectedProjectId || !branch.trim()}>
              Create worktree
            </button>
            <small>
              RoamCode chooses a stable path beside the repository. Base defaults to the project's current HEAD.
            </small>
          </form>
        )}

        <footer className="rc-workspaces__foot">
          <label>
            Add as
            <select value={newKind} onChange={(event) => setNewKind(event.target.value as typeof newKind)}>
              <option value="directory">Directory</option>
              <option value="worktree">Existing worktree</option>
              <option value="new-worktree">New worktree</option>
            </select>
          </label>
          {newKind === "worktree" && (
            <label>
              Project
              <select value={selectedProjectId} onChange={(event) => setSelectedProjectId(event.target.value)}>
                {projectRoots.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.label}
                  </option>
                ))}
              </select>
            </label>
          )}
          <button
            type="button"
            className="rc-workspaces__add"
            onClick={() => newKind !== "new-worktree" && setPickerOpen(true)}
            disabled={newKind === "new-worktree" || (newKind === "worktree" && !selectedProjectId)}
          >
            <Icon name="plus" size={15} /> Add workspace
          </button>
        </footer>
      </div>

      {pickerOpen && (
        <DirectoryPicker
          listDir={(path) => api.listDir(path)}
          mkdir={(path) => api.mkdir(path)}
          searchDirs={(query, base) => api.searchDirs(query, base)}
          recents={loadRecentDirs()}
          onCancel={() => setPickerOpen(false)}
          onPick={(cwd) => {
            setPickerOpen(false);
            void run("create", async () => {
              if (newKind === "worktree") await api.openWorktree(cwd, undefined, selectedProjectId);
              else await api.createWorkspace(cwd, undefined, "directory");
              await onWorkspacesChanged();
            });
          }}
        />
      )}
      <style>{css}</style>
    </div>
  );
}

const css = `
.rc-workspaces { position: absolute; inset: 0; z-index: 35; }
.rc-workspaces__scrim { position: absolute; inset: 0; border: 0; background: rgba(0,0,0,.52); cursor: pointer; }
.rc-workspaces__panel { position: absolute; inset: auto 0 0; max-height: 90%; display: flex; flex-direction: column; overflow: hidden; background: var(--surface); border-top: 1px solid var(--border-strong); border-radius: 15px 15px 0 0; box-shadow: 0 -16px 48px rgba(0,0,0,.5); }
.rc-workspaces__head { flex: none; display: flex; align-items: center; gap: 10px; padding: 13px 14px; border-bottom: 1px solid var(--border); }
.rc-workspaces__mark { width: 34px; height: 34px; flex: none; display: grid; place-items: center; border: 1px solid var(--accent-line); border-radius: 9px; color: var(--accent-2); background: var(--accent-soft); }
.rc-workspaces__head > span:nth-child(2) { min-width: 0; display: grid; gap: 2px; }
.rc-workspaces__head strong { color: var(--text); font: 650 15px/1.2 var(--font-display); }
.rc-workspaces__head small { color: var(--text-faint); font: 500 9px/1.2 var(--font-mono); }
.rc-workspaces__close { margin-left: auto; width: var(--tap-min); height: var(--tap-min); display: grid; place-items: center; border: 0; border-radius: 8px; background: transparent; color: var(--text-muted); cursor: pointer; }
.rc-workspaces__body { flex: 1; min-height: 0; overflow: auto; padding: 12px; }
.rc-workspaces__error { display: flex; align-items: center; gap: 7px; margin-bottom: 10px; padding: 9px; border: 1px solid var(--err-line); border-radius: 9px; color: var(--err); background: var(--err-soft); font-size: var(--fs-xs); }
.rc-workspaces__section + .rc-workspaces__section { margin-top: 18px; }
.rc-workspaces__section-head { display: flex; justify-content: space-between; margin-bottom: 7px; color: var(--text-faint); font: 700 10px/1 var(--font-mono); text-transform: uppercase; letter-spacing: .06em; }
.rc-workspaces__host-form, .rc-workspaces__rename { display: flex; gap: 6px; }
.rc-workspaces input, .rc-workspaces select { min-width: 0; min-height: var(--tap-min); border: 1px solid var(--border); border-radius: 8px; background: var(--surface-2); color: var(--text); font: 500 12px/1 var(--font-mono); }
.rc-workspaces input { flex: 1; padding: 0 10px; }
.rc-workspaces select { padding: 0 8px; }
.rc-workspaces button { font: inherit; }
.rc-workspaces__host-form button, .rc-workspaces__rename button, .rc-workspaces__actions button { min-height: var(--tap-min); border: 1px solid var(--border); border-radius: 8px; background: transparent; color: var(--text-muted); cursor: pointer; }
.rc-workspaces button:disabled { opacity: .45; cursor: default; }
.rc-workspaces__host-form button { padding: 0 12px; }
.rc-workspaces__section p { margin: 6px 0 0; color: var(--text-faint); font-size: 10px; }
.rc-workspaces__list { list-style: none; display: grid; gap: 8px; margin: 0; padding: 0; }
.rc-workspaces__item { padding: 10px; border: 1px solid var(--border); border-radius: 10px; background: var(--surface-2); }
.rc-workspaces__row-head { display: flex; align-items: center; gap: 7px; margin-bottom: 7px; color: var(--text-faint); font: 550 9px/1 var(--font-mono); }
.rc-workspaces__kind { color: var(--accent-2); text-transform: uppercase; letter-spacing: .05em; }
.rc-workspaces__needs { margin-left: auto; color: var(--awaiting); }
.rc-workspaces__rename button { width: var(--tap-min); display: grid; place-items: center; }
.rc-workspaces__item code { display: block; margin-top: 6px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-faint); font: 500 9px/1.25 var(--font-mono); }
.rc-workspaces__actions { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 9px; }
.rc-workspaces__confirm { margin-top: 9px; }
.rc-workspaces__actions button { display: inline-flex; align-items: center; justify-content: center; gap: 5px; padding: 0 8px; font-size: 9px; }
.rc-workspaces__actions .rc-workspaces__archive { margin-left: auto; }
.rc-workspaces__dirty { color: var(--warn) !important; }
.rc-workspaces__new-worktree { flex: none; display: grid; grid-template-columns: 1fr 1fr; gap: 7px; padding: 10px 12px; border-top: 1px solid var(--border); }
.rc-workspaces__new-worktree label { display: grid; gap: 4px; color: var(--text-faint); font: 600 9px/1 var(--font-mono); }
.rc-workspaces__new-worktree button, .rc-workspaces__new-worktree small { grid-column: 1 / -1; }
.rc-workspaces__new-worktree button { min-height: var(--tap-min); border: 0; border-radius: 8px; background: var(--coral); color: var(--on-accent); }
.rc-workspaces__new-worktree small { color: var(--text-muted); }
.rc-workspaces__empty { padding: 28px 10px; text-align: center; color: var(--text-muted); font-size: var(--fs-xs); }
.rc-workspaces__foot { flex: none; display: flex; align-items: end; gap: 8px; padding: 10px 12px calc(10px + env(safe-area-inset-bottom, 0px)); border-top: 1px solid var(--border); }
.rc-workspaces__foot label { display: grid; gap: 4px; color: var(--text-faint); font: 600 9px/1 var(--font-mono); }
.rc-workspaces__add { align-self: end; min-height: var(--tap-min); display: inline-flex; align-items: center; justify-content: center; gap: 6px; margin-left: auto; padding: 0 12px; border: 0; border-radius: 8px; background: var(--coral); color: var(--on-accent); cursor: pointer; }
@media (min-width: 768px) { .rc-workspaces__panel { inset: 0 0 0 auto; width: min(500px, 94vw); max-height: none; border: 0; border-left: 1px solid var(--border-strong); border-radius: 0; box-shadow: -16px 0 48px rgba(0,0,0,.5); } }
`;
