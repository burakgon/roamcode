import { useCallback, useEffect, useState } from "react";
import type { ApiClient, PeerAction, PeerRecord, PeerWorkspace } from "../api/client";
import { Icon } from "../ui/Icon";

const DEFAULT_ACTIONS: PeerAction[] = ["read", "wait"];
const OPTIONAL_ACTIONS: Array<{ id: Exclude<PeerAction, "read">; label: string; detail: string }> = [
  { id: "wait", label: "Wait", detail: "Observe bounded agent state changes." },
  { id: "send", label: "Send", detail: "Acquire an input lease and send terminal input." },
  { id: "start", label: "Start", detail: "Launch agents in selected remote workspaces." },
  { id: "focus", label: "Focus", detail: "Request remote agent focus without stealing local focus." },
];

interface ScopeEditor {
  peer: PeerRecord;
  workspaces: PeerWorkspace[];
  actions: PeerAction[];
  selected: string[] | null;
}

function errorMessage(reason: unknown, fallback: string): string {
  return reason instanceof Error && reason.message ? reason.message : fallback;
}

function relativeTime(value: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - value) / 1_000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function PeerConnections({ api, canManage }: { api: ApiClient; canManage: boolean }) {
  const [peers, setPeers] = useState<PeerRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [showCreate, setShowCreate] = useState(false);
  const [reviewCreate, setReviewCreate] = useState(false);
  const [label, setLabel] = useState("");
  const [pairingLink, setPairingLink] = useState("");
  const [scopeEditor, setScopeEditor] = useState<ScopeEditor>();
  const [rotatePeerId, setRotatePeerId] = useState<string>();
  const [replacementPairingLink, setReplacementPairingLink] = useState("");
  const [reviewRotation, setReviewRotation] = useState(false);
  const [removePeerId, setRemovePeerId] = useState<string>();

  const load = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      setPeers(await api.listPeers());
    } catch (reason) {
      setError(errorMessage(reason, "Peer hosts could not be loaded"));
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  function replacePeer(next: PeerRecord) {
    setPeers((current) => current.map((peer) => (peer.id === next.id ? next : peer)));
  }

  function resetCreate() {
    setShowCreate(false);
    setReviewCreate(false);
    setLabel("");
    setPairingLink("");
  }

  async function createPeer() {
    if (pairingLink.trim().length < 32 || !canManage) return;
    setBusy("create");
    setError(undefined);
    setNotice(undefined);
    try {
      const created = await api.createPeer({
        pairingUrl: pairingLink.trim(),
        ...(label.trim() ? { label: label.trim() } : {}),
        actions: DEFAULT_ACTIONS,
      });
      setPairingLink("");
      setPeers((current) => [...current, created]);
      resetCreate();
      setNotice(`${created.label} connected with no workspace access. Select its scope to make it operational.`);
      await discover(created);
    } catch (reason) {
      setPairingLink("");
      setReviewCreate(false);
      setError(errorMessage(reason, "Peer host could not be connected"));
    } finally {
      setBusy(undefined);
    }
  }

  async function discover(peer: PeerRecord) {
    setBusy(`discover:${peer.id}`);
    setError(undefined);
    setNotice(undefined);
    try {
      const result = await api.discoverPeerWorkspaces(peer.id, peer.revision);
      replacePeer(result.peer);
      setScopeEditor({
        peer: result.peer,
        workspaces: result.workspaces,
        actions: [...result.peer.actions],
        selected: result.peer.allowedWorkspaceIds ? [...result.peer.allowedWorkspaceIds] : null,
      });
      setNotice(
        `Verified ${result.peer.label} and discovered ${result.workspaces.length} workspace${result.workspaces.length === 1 ? "" : "s"}.`,
      );
    } catch (reason) {
      const message = errorMessage(reason, "Peer workspaces could not be discovered");
      await load();
      setError(message);
    } finally {
      setBusy(undefined);
    }
  }

  async function saveScope() {
    if (!scopeEditor || !canManage) return;
    setBusy(`scope:${scopeEditor.peer.id}`);
    setError(undefined);
    setNotice(undefined);
    try {
      const peer = await api.updatePeer(scopeEditor.peer.id, {
        expectedRevision: scopeEditor.peer.revision,
        actions: scopeEditor.actions,
        allowedWorkspaceIds: scopeEditor.selected,
      });
      replacePeer(peer);
      setScopeEditor(undefined);
      setNotice(`${peer.label} scope is active at revision ${peer.revision}.`);
    } catch (reason) {
      const message = errorMessage(reason, "Peer scope could not be saved");
      await load();
      setError(message);
    } finally {
      setBusy(undefined);
    }
  }

  async function verify(peer: PeerRecord) {
    setBusy(`verify:${peer.id}`);
    setError(undefined);
    setNotice(undefined);
    try {
      const next = await api.verifyPeer(peer.id, peer.revision);
      replacePeer(next);
      setNotice(`${next.label} identity and credential were verified.`);
    } catch (reason) {
      const message = errorMessage(reason, "Peer verification failed");
      await load();
      setError(message);
    } finally {
      setBusy(undefined);
    }
  }

  async function toggleStatus(peer: PeerRecord) {
    setBusy(`status:${peer.id}`);
    setError(undefined);
    setNotice(undefined);
    try {
      const next = await api.updatePeer(peer.id, {
        expectedRevision: peer.revision,
        status: peer.status === "active" ? "suspended" : "active",
      });
      replacePeer(next);
      setNotice(`${next.label} is now ${next.status}.`);
    } catch (reason) {
      const message = errorMessage(reason, "Peer status could not be changed");
      await load();
      setError(message);
    } finally {
      setBusy(undefined);
    }
  }

  async function rotateCredential(peer: PeerRecord) {
    if (replacementPairingLink.trim().length < 32 || !canManage) return;
    setBusy(`rotate:${peer.id}`);
    setError(undefined);
    setNotice(undefined);
    try {
      const next = await api.rotatePeerCredential(
        peer.id,
        { pairingUrl: replacementPairingLink.trim() },
        peer.revision,
      );
      replacePeer(next);
      setReplacementPairingLink("");
      setRotatePeerId(undefined);
      setReviewRotation(false);
      setNotice(`${next.label} access was replaced after identity verification.`);
    } catch (reason) {
      setReplacementPairingLink("");
      setReviewRotation(false);
      const message = errorMessage(reason, "Peer access could not be replaced");
      await load();
      setError(message);
    } finally {
      setBusy(undefined);
    }
  }

  async function remove(peer: PeerRecord) {
    setBusy(`remove:${peer.id}`);
    setError(undefined);
    setNotice(undefined);
    try {
      await api.removePeer(peer.id);
      setPeers((current) => current.filter((candidate) => candidate.id !== peer.id));
      setRemovePeerId(undefined);
      setScopeEditor((current) => (current?.peer.id === peer.id ? undefined : current));
      setNotice(`${peer.label} and its stored credential were removed from this host.`);
    } catch (reason) {
      setError(errorMessage(reason, "Peer host could not be removed"));
    } finally {
      setBusy(undefined);
    }
  }

  return (
    <section className="rc-org__panel rc-peers" aria-labelledby="rc-peers-title" aria-busy={loading || Boolean(busy)}>
      <div className="rc-org__panel-head">
        <span>
          <strong id="rc-peers-title">Peer hosts</strong>
          <small>Coordinate agents across RoamCode instances without sharing provider credentials</small>
        </span>
        {canManage && !showCreate && (
          <button type="button" disabled={Boolean(busy)} onClick={() => setShowCreate(true)}>
            <Icon name="plus" size={14} /> Connect
          </button>
        )}
      </div>

      {!canManage && (
        <p className="rc-org__notice">
          Peer inventory is read-only. A policy administrator or the host recovery credential is required to connect or
          change hosts.
        </p>
      )}

      {showCreate && (
        <div className="rc-peers__setup">
          <div className="rc-peers__fields">
            <label>
              <span>Label</span>
              <input
                value={label}
                maxLength={80}
                placeholder="Build host"
                disabled={Boolean(busy)}
                onChange={(event) => {
                  setLabel(event.target.value);
                  setReviewCreate(false);
                }}
              />
            </label>
            <label>
              <span>One-use pairing link</span>
              <input
                type="password"
                name="peer-pairing-link"
                autoComplete="new-password"
                spellCheck={false}
                inputMode="url"
                value={pairingLink}
                placeholder="https://build.example/#pair=…"
                disabled={Boolean(busy)}
                onChange={(event) => {
                  setPairingLink(event.target.value);
                  setReviewCreate(false);
                }}
              />
              <small>
                Run <code>roamcode pair --url &lt;remote-origin&gt;</code> on the other host and paste its five-minute
                link. The durable credential is claimed and stored server-side, never returned to this browser.
              </small>
            </label>
          </div>
          {reviewCreate && (
            <div className="rc-org__confirm" role="alert">
              <Icon name="lock" size={16} />
              <span>
                <strong>Store cross-host access?</strong>
                <small>
                  RoamCode will pin the remote host identity. The connection starts with read/wait capability and no
                  workspace access until you explicitly select scope.
                </small>
              </span>
              <div className="rc-org__confirm-actions">
                <button type="button" className="is-primary" disabled={Boolean(busy)} onClick={() => void createPeer()}>
                  {busy === "create" ? "Connecting…" : "Connect and verify"}
                </button>
                <button type="button" disabled={Boolean(busy)} onClick={() => setReviewCreate(false)}>
                  Review again
                </button>
              </div>
            </div>
          )}
          <div className="rc-org__actions">
            {!reviewCreate && (
              <button
                type="button"
                className="is-primary"
                disabled={pairingLink.trim().length < 32 || Boolean(busy)}
                onClick={() => setReviewCreate(true)}
              >
                Review connection
              </button>
            )}
            <button type="button" disabled={Boolean(busy)} onClick={resetCreate}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {loading && <p className="rc-org__muted">Loading peer hosts…</p>}
      {!loading && peers.length === 0 && !showCreate && (
        <div className="rc-peers__empty">
          <Icon name="agent" size={20} />
          <span>
            <strong>No peer hosts connected</strong>
            <small>Connect another RoamCode instance, discover its workspaces, then grant the minimum actions.</small>
          </span>
        </div>
      )}

      <div className="rc-peers__list">
        {peers.map((peer) => {
          const editing = scopeEditor?.peer.id === peer.id ? scopeEditor : undefined;
          const rotating = rotatePeerId === peer.id;
          const removing = removePeerId === peer.id;
          return (
            <article className="rc-org__host rc-peers__card" key={peer.id}>
              <div className="rc-org__host-head">
                <span>
                  <strong>{peer.label}</strong>
                  <small>
                    RoamCode {peer.remoteVersion} · verified {relativeTime(peer.lastVerifiedAt)}
                  </small>
                </span>
                <span className={`rc-org__badge${peer.status === "active" ? " is-good" : ""}`}>{peer.status}</span>
              </div>
              <dl className="rc-org__facts">
                <div>
                  <dt>Host identity</dt>
                  <dd title={peer.remoteHostId}>{peer.remoteHostId}</dd>
                </div>
                <div>
                  <dt>Workspace scope</dt>
                  <dd>
                    {peer.allowedWorkspaceIds === null
                      ? "All by policy"
                      : peer.allowedWorkspaceIds.length === 0
                        ? "Denied"
                        : `${peer.allowedWorkspaceIds.length} selected`}
                  </dd>
                </div>
                <div>
                  <dt>Revision</dt>
                  <dd>{peer.revision}</dd>
                </div>
              </dl>
              <div className="rc-org__chips" aria-label={`${peer.label} permitted actions`}>
                {peer.actions.map((action) => (
                  <span key={action}>{action}</span>
                ))}
              </div>

              {canManage && !editing && !rotating && !removing && (
                <div className="rc-peers__card-actions">
                  <button type="button" disabled={Boolean(busy)} onClick={() => void discover(peer)}>
                    {busy === `discover:${peer.id}` ? "Discovering…" : "Scope"}
                  </button>
                  <button type="button" disabled={Boolean(busy)} onClick={() => void verify(peer)}>
                    {busy === `verify:${peer.id}` ? "Verifying…" : "Verify"}
                  </button>
                  <button type="button" disabled={Boolean(busy)} onClick={() => void toggleStatus(peer)}>
                    {peer.status === "active" ? "Suspend" : "Activate"}
                  </button>
                  <button
                    type="button"
                    disabled={Boolean(busy)}
                    onClick={() => {
                      setRotatePeerId(peer.id);
                      setReplacementPairingLink("");
                      setReviewRotation(false);
                    }}
                  >
                    Access
                  </button>
                  <button type="button" disabled={Boolean(busy)} onClick={() => setRemovePeerId(peer.id)}>
                    Remove
                  </button>
                </div>
              )}

              {editing && (
                <div className="rc-peers__editor">
                  <fieldset disabled={Boolean(busy)}>
                    <legend>Permitted actions</legend>
                    <label>
                      <input type="checkbox" checked disabled />
                      <span>
                        <strong>Read</strong>
                        <small>Required for every peer coordination action.</small>
                      </span>
                    </label>
                    {OPTIONAL_ACTIONS.map((action) => (
                      <label key={action.id}>
                        <input
                          type="checkbox"
                          checked={editing.actions.includes(action.id)}
                          onChange={(event) =>
                            setScopeEditor({
                              ...editing,
                              actions: event.target.checked
                                ? [...new Set([...editing.actions, action.id])]
                                : editing.actions.filter((candidate) => candidate !== action.id),
                            })
                          }
                        />
                        <span>
                          <strong>{action.label}</strong>
                          <small>{action.detail}</small>
                        </span>
                      </label>
                    ))}
                  </fieldset>
                  <fieldset disabled={Boolean(busy)}>
                    <legend>Remote workspaces</legend>
                    <label className={editing.selected === null ? "is-risk" : ""}>
                      <input
                        type="checkbox"
                        checked={editing.selected === null}
                        onChange={(event) => setScopeEditor({ ...editing, selected: event.target.checked ? null : [] })}
                      />
                      <span>
                        <strong>All current and future workspaces</strong>
                        <small>Still bounded by local and remote policy, but broader than an explicit allowlist.</small>
                      </span>
                    </label>
                    {editing.selected !== null &&
                      editing.workspaces.map((workspace) => (
                        <label key={workspace.id}>
                          <input
                            type="checkbox"
                            checked={editing.selected?.includes(workspace.id) === true}
                            disabled={workspace.archived || Boolean(busy)}
                            onChange={(event) => {
                              const selected = editing.selected ?? [];
                              setScopeEditor({
                                ...editing,
                                selected: event.target.checked
                                  ? [...new Set([...selected, workspace.id])].sort()
                                  : selected.filter((id) => id !== workspace.id),
                              });
                            }}
                          />
                          <span>
                            <strong>{workspace.label}</strong>
                            <small>
                              {workspace.kind}
                              {workspace.archived ? " · archived" : ""}
                            </small>
                          </span>
                        </label>
                      ))}
                    {editing.selected !== null && editing.workspaces.length === 0 && (
                      <p className="rc-org__notice">No remote workspaces were returned. Saving keeps access denied.</p>
                    )}
                  </fieldset>
                  <div className="rc-org__actions">
                    <button
                      type="button"
                      className="is-primary"
                      disabled={Boolean(busy)}
                      onClick={() => void saveScope()}
                    >
                      {busy === `scope:${peer.id}` ? "Saving…" : "Apply peer scope"}
                    </button>
                    <button type="button" disabled={Boolean(busy)} onClick={() => setScopeEditor(undefined)}>
                      Cancel
                    </button>
                  </div>
                </div>
              )}

              {rotating && (
                <div className="rc-peers__editor">
                  <label className="rc-peers__credential">
                    <span>Replacement pairing link</span>
                    <input
                      type="password"
                      autoComplete="new-password"
                      spellCheck={false}
                      inputMode="url"
                      value={replacementPairingLink}
                      disabled={Boolean(busy)}
                      onChange={(event) => {
                        setReplacementPairingLink(event.target.value);
                        setReviewRotation(false);
                      }}
                    />
                  </label>
                  {reviewRotation && (
                    <div className="rc-org__confirm" role="alert">
                      <Icon name="lock" size={16} />
                      <span>
                        <strong>Replace peer access?</strong>
                        <small>
                          The one-use link activates only if it proves the same pinned remote host identity and origin.
                        </small>
                      </span>
                    </div>
                  )}
                  <div className="rc-org__actions">
                    {reviewRotation ? (
                      <button
                        type="button"
                        className="is-primary"
                        disabled={Boolean(busy)}
                        onClick={() => void rotateCredential(peer)}
                      >
                        {busy === `rotate:${peer.id}` ? "Replacing…" : "Verify and replace"}
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="is-primary"
                        disabled={replacementPairingLink.trim().length < 32 || Boolean(busy)}
                        onClick={() => setReviewRotation(true)}
                      >
                        Review replacement
                      </button>
                    )}
                    <button
                      type="button"
                      disabled={Boolean(busy)}
                      onClick={() => {
                        setRotatePeerId(undefined);
                        setReplacementPairingLink("");
                        setReviewRotation(false);
                      }}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}

              {removing && (
                <div className="rc-org__confirm" role="alert">
                  <Icon name="alert" size={16} />
                  <span>
                    <strong>Remove {peer.label}?</strong>
                    <small>This deletes the stored credential and stops all coordination through this peer.</small>
                  </span>
                  <div className="rc-org__confirm-actions">
                    <button
                      type="button"
                      className="is-danger"
                      disabled={Boolean(busy)}
                      onClick={() => void remove(peer)}
                    >
                      {busy === `remove:${peer.id}` ? "Removing…" : "Remove peer"}
                    </button>
                    <button type="button" disabled={Boolean(busy)} onClick={() => setRemovePeerId(undefined)}>
                      Keep peer
                    </button>
                  </div>
                </div>
              )}
            </article>
          );
        })}
      </div>

      {notice && (
        <p className="rc-org__success" role="status">
          {notice}
        </p>
      )}
      {error && (
        <p className="rc-org__error" role="alert">
          {error}
        </p>
      )}
      <style>{peerCss}</style>
    </section>
  );
}

const peerCss = `
.rc-peers__setup,.rc-peers__editor { display:grid; gap:9px; padding:10px; border:1px solid var(--border); border-radius:9px; background:var(--surface); }
.rc-peers__fields { display:grid; grid-template-columns:minmax(0,.65fr) minmax(0,1.35fr); gap:8px; align-items:start; }
.rc-peers__fields label,.rc-peers__credential { min-width:0; display:grid; gap:5px; color:var(--text-muted); font-size:10.5px; }
.rc-peers__fields input,.rc-peers__credential input { width:100%; min-height:var(--tap-min); box-sizing:border-box; padding:0 10px; border:1px solid var(--border); border-radius:8px; background:var(--surface-2); color:var(--text); }
.rc-peers__fields small { color:var(--text-faint); font-size:9.5px; line-height:1.4; }
.rc-peers__empty { min-height:76px; display:flex; align-items:center; justify-content:center; gap:10px; padding:12px; border:1px dashed var(--border-strong); border-radius:9px; color:var(--text-faint); }
.rc-peers__empty>span { display:grid; gap:3px; }
.rc-peers__empty strong { color:var(--text); font-size:11.5px; }
.rc-peers__empty small { color:var(--text-muted); font-size:10.5px; line-height:1.45; }
.rc-peers__list { display:grid; gap:7px; }
.rc-peers__card-actions { display:flex; flex-wrap:wrap; gap:6px; }
.rc-peers__card-actions button { min-height:var(--tap-min); }
.rc-peers__editor fieldset { min-width:0; margin:0; display:grid; gap:5px; padding:9px; border:1px solid var(--border); border-radius:8px; }
.rc-peers__editor legend { padding:0 4px; color:var(--text); font-size:11px; font-weight:650; }
.rc-peers__editor fieldset>label { min-height:var(--tap-min); display:flex; align-items:flex-start; gap:8px; padding:6px 7px; border-radius:7px; color:var(--text); }
.rc-peers__editor fieldset>label.is-risk { background:var(--err-bg); }
.rc-peers__editor fieldset input { width:18px; height:18px; flex:none; margin:1px 0 0; accent-color:var(--accent); }
.rc-peers__editor fieldset label>span { min-width:0; display:grid; gap:2px; }
.rc-peers__editor fieldset strong { font-size:10.5px; }
.rc-peers__editor fieldset small { color:var(--text-muted); font-size:9.5px; line-height:1.4; }
@media(max-width:680px){
  .rc-peers__fields { grid-template-columns:1fr; }
  .rc-peers__card-actions { display:grid; grid-template-columns:1fr 1fr; }
  .rc-peers__card-actions button:last-child { grid-column:1/-1; }
}
`;
