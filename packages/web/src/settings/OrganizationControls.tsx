import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ApiError,
  type ApiClient,
  type AuditPage,
  type AuditVerification,
  type EnterprisePolicy,
  type EnterprisePolicyUpdate,
  type FleetInventory,
  type TeamEnvelope,
} from "../api/client";
import type { WorkspaceRecord } from "../types/server";
import { Icon } from "../ui/Icon";
import { PeerConnections } from "./PeerConnections";

type PolicyDraft = Omit<EnterprisePolicy, "revision" | "createdAt" | "updatedAt">;
type ConfirmationMode = "enable" | "disable";

function toDraft(policy: EnterprisePolicy): PolicyDraft {
  return {
    enforcementEnabled: policy.enforcementEnabled,
    allowedHostIds: policy.allowedHostIds ? [...policy.allowedHostIds] : null,
    allowedWorkspaceIds: policy.allowedWorkspaceIds ? [...policy.allowedWorkspaceIds] : null,
    allowedProviderIds: policy.allowedProviderIds ? [...policy.allowedProviderIds] : null,
    allowDangerousProviderModes: policy.allowDangerousProviderModes,
    allowFileTransfer: policy.allowFileTransfer,
    extensionMode: policy.extensionMode,
    allowRelay: policy.allowRelay,
    updateMode: policy.updateMode,
  };
}

function humanTime(value: number): string {
  try {
    return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
  } catch {
    return "Unknown time";
  }
}

function messageFor(reason: unknown, fallback: string): string {
  return reason instanceof Error && reason.message ? reason.message : fallback;
}

export function OrganizationControls({ api }: { api: ApiClient }) {
  const [policy, setPolicy] = useState<EnterprisePolicy>();
  const [draft, setDraft] = useState<PolicyDraft>();
  const [fleet, setFleet] = useState<FleetInventory>();
  const [team, setTeam] = useState<TeamEnvelope>();
  const [workspaces, setWorkspaces] = useState<WorkspaceRecord[]>([]);
  const [audit, setAudit] = useState<AuditPage>();
  const [verification, setVerification] = useState<AuditVerification>();
  const [auditError, setAuditError] = useState<string>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [busy, setBusy] = useState<"load" | "policy" | "fleet" | "audit" | "export" | undefined>("load");
  const [confirmation, setConfirmation] = useState<ConfirmationMode>();

  const canManagePolicy =
    team?.authorization.localBreakGlass === true || team?.permissions.includes("policy:manage") === true;
  const canReadAudit = team?.authorization.localBreakGlass === true;

  const loadAudit = useCallback(async () => {
    setAuditError(undefined);
    try {
      const [nextVerification, nextAudit] = await Promise.all([api.verifyAudit(), api.listLatestAudit(20)]);
      setVerification(nextVerification);
      setAudit(nextAudit);
    } catch (reason) {
      setVerification(undefined);
      setAudit(undefined);
      setAuditError(messageFor(reason, "Audit history could not be loaded"));
    }
  }, [api]);

  const refresh = useCallback(async () => {
    setBusy("load");
    setError(undefined);
    setNotice(undefined);
    try {
      const [nextPolicy, nextFleet, nextTeam, nextWorkspaces] = await Promise.all([
        api.getEnterprisePolicy(),
        api.getFleetInventory(),
        api.getTeam(),
        api.listWorkspaces(),
      ]);
      setPolicy(nextPolicy);
      setDraft(toDraft(nextPolicy));
      setFleet(nextFleet);
      setTeam(nextTeam);
      setWorkspaces(nextWorkspaces);
      setConfirmation(undefined);
      if (nextTeam.authorization.localBreakGlass) await loadAudit();
      else {
        setAudit(undefined);
        setVerification(undefined);
        setAuditError("Use the current host recovery credential to verify or export the audit chain.");
      }
    } catch (reason) {
      setError(messageFor(reason, "Organization controls could not be loaded"));
    } finally {
      setBusy((current) => (current === "load" ? undefined : current));
    }
  }, [api, loadAudit]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const availableHosts = useMemo(
    () => (fleet?.hosts ?? []).map((host) => ({ id: host.id, label: host.label, detail: `RoamCode ${host.version}` })),
    [fleet],
  );
  const availableProviders = useMemo(() => {
    const providers = new Map<string, { id: string; label: string; detail: string }>();
    for (const host of fleet?.hosts ?? []) {
      for (const adapter of host.adapters) {
        if (!providers.has(adapter.id)) {
          providers.set(adapter.id, {
            id: adapter.id,
            label: adapter.id,
            detail: adapter.enabled ? "Available" : "Disabled on this fleet",
          });
        }
      }
    }
    return [...providers.values()].sort((left, right) => left.label.localeCompare(right.label));
  }, [fleet]);
  const availableWorkspaces = useMemo(
    () =>
      workspaces
        .filter((workspace) => workspace.archivedAt === undefined)
        .map((workspace) => ({ id: workspace.id, label: workspace.label })),
    [workspaces],
  );

  const dirty = Boolean(policy && draft && JSON.stringify(toDraft(policy)) !== JSON.stringify(draft));
  const transition =
    policy && draft && policy.enforcementEnabled !== draft.enforcementEnabled
      ? draft.enforcementEnabled
        ? "enable"
        : "disable"
      : undefined;

  function changeDraft(update: Partial<PolicyDraft>) {
    setDraft((current) => (current ? { ...current, ...update } : current));
    setNotice(undefined);
    setConfirmation(undefined);
  }

  async function savePolicy(confirmTransition = false) {
    if (!policy || !draft || !canManagePolicy) return;
    if (transition && !confirmTransition) {
      setConfirmation(transition);
      return;
    }
    setBusy("policy");
    setError(undefined);
    setNotice(undefined);
    try {
      const update: EnterprisePolicyUpdate = {
        ...draft,
        expectedRevision: policy.revision,
        ...(transition === "enable" ? { confirm: true } : {}),
      };
      const next = await api.updateEnterprisePolicy(update);
      setPolicy(next);
      setDraft(toDraft(next));
      setConfirmation(undefined);
      setFleet(await api.getFleetInventory());
      setNotice(`Policy revision ${next.revision} is active on this host.`);
    } catch (reason) {
      if (reason instanceof ApiError && reason.code === "ENTERPRISE_POLICY_REVISION_CONFLICT") {
        try {
          const current = await api.getEnterprisePolicy();
          setPolicy(current);
          setDraft(toDraft(current));
          setConfirmation(undefined);
          setError(
            "Policy changed on another device. The current revision has been reloaded; review it before saving.",
          );
        } catch {
          setError("Policy changed on another device. Reload organization controls before saving again.");
        }
      } else {
        setError(messageFor(reason, "Policy could not be saved"));
      }
    } finally {
      setBusy((current) => (current === "policy" ? undefined : current));
    }
  }

  async function refreshFleet() {
    setBusy("fleet");
    setError(undefined);
    try {
      setFleet(await api.getFleetInventory());
      setNotice("Fleet posture refreshed.");
    } catch (reason) {
      setError(messageFor(reason, "Fleet posture could not be refreshed"));
    } finally {
      setBusy((current) => (current === "fleet" ? undefined : current));
    }
  }

  async function verifyAudit() {
    if (!canReadAudit) return;
    setBusy("audit");
    await loadAudit();
    setBusy((current) => (current === "audit" ? undefined : current));
  }

  async function exportAudit() {
    if (!canReadAudit) return;
    setBusy("export");
    setError(undefined);
    try {
      const content = await api.exportAudit(0, 1000);
      const url = URL.createObjectURL(new Blob([content], { type: "application/x-ndjson" }));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "roamcode-audit.ndjson";
      anchor.hidden = true;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      setNotice("Audit export prepared. Exports are capped at 1,000 records per integrity manifest.");
    } catch (reason) {
      setError(messageFor(reason, "Audit export could not be prepared"));
    } finally {
      setBusy((current) => (current === "export" ? undefined : current));
    }
  }

  const compliantHosts = fleet?.hosts.filter((host) => host.policyPosture.compliant).length ?? 0;
  const loading = busy === "load" && !policy && !fleet;

  return (
    <div className="rc-org" aria-busy={loading}>
      {loading && <p className="rc-org__muted">Loading organization posture…</p>}

      {(policy || fleet) && (
        <div className="rc-org__summary" aria-label="Organization posture summary">
          <SummaryMetric
            label="Policy"
            value={policy?.enforcementEnabled ? "Enforced" : "Staged"}
            tone={policy?.enforcementEnabled ? "good" : "neutral"}
          />
          <SummaryMetric
            label="Fleet"
            value={fleet ? `${compliantHosts}/${fleet.hosts.length} compliant` : "Unavailable"}
            tone={fleet && compliantHosts === fleet.hosts.length ? "good" : "warn"}
          />
          <SummaryMetric
            label="Audit"
            value={verification ? (verification.valid ? "Verified" : "Integrity issue") : "Host credential"}
            tone={verification?.valid ? "good" : verification ? "bad" : "neutral"}
          />
        </div>
      )}

      {policy && draft && (
        <section className="rc-org__panel" aria-labelledby="rc-org-policy-title">
          <div className="rc-org__panel-head">
            <span>
              <strong id="rc-org-policy-title">Organization policy</strong>
              <small>Revision {policy.revision} · applied uniformly to direct, API, socket, and relay access</small>
            </span>
            <span className={`rc-org__badge${policy.enforcementEnabled ? " is-good" : ""}`}>
              {policy.enforcementEnabled ? "Enforced" : "Staged"}
            </span>
          </div>

          {!canManagePolicy && (
            <p className="rc-org__notice">
              You can inspect this policy. A policy administrator or the host recovery credential is required to edit
              it.
            </p>
          )}

          <PolicyToggle
            label="Enforce organization policy"
            detail="When off, these controls remain staged and do not block current access."
            checked={draft.enforcementEnabled}
            disabled={!canManagePolicy || busy !== undefined}
            onChange={(checked) => changeDraft({ enforcementEnabled: checked })}
          />

          <div className="rc-org__scope-grid">
            <ScopeSelector
              legend="Hosts"
              detail="Limit access to selected fleet hosts."
              candidates={availableHosts}
              selected={draft.allowedHostIds}
              disabled={!canManagePolicy || busy !== undefined}
              onChange={(allowedHostIds) => changeDraft({ allowedHostIds })}
            />
            <ScopeSelector
              legend="Workspaces"
              detail="Limit new agents to selected workspaces."
              candidates={availableWorkspaces}
              selected={draft.allowedWorkspaceIds}
              disabled={!canManagePolicy || busy !== undefined}
              onChange={(allowedWorkspaceIds) => changeDraft({ allowedWorkspaceIds })}
            />
            <ScopeSelector
              legend="Providers"
              detail="Limit new agents to selected adapters."
              candidates={availableProviders}
              selected={draft.allowedProviderIds}
              disabled={!canManagePolicy || busy !== undefined}
              onChange={(allowedProviderIds) => changeDraft({ allowedProviderIds })}
            />
          </div>

          <div className="rc-org__rules">
            <PolicyToggle
              label="Allow file transfer"
              detail="Uploads and downloads remain subject to filesystem boundaries."
              checked={draft.allowFileTransfer}
              disabled={!canManagePolicy || busy !== undefined}
              onChange={(allowFileTransfer) => changeDraft({ allowFileTransfer })}
            />
            <PolicyToggle
              label="Allow encrypted relay access"
              detail="Controls remote relay traffic without changing direct local access."
              checked={draft.allowRelay}
              disabled={!canManagePolicy || busy !== undefined}
              onChange={(allowRelay) => changeDraft({ allowRelay })}
            />
            <PolicyToggle
              label="Allow dangerous provider modes"
              detail="Permits provider options that bypass normal approval or sandbox boundaries."
              checked={draft.allowDangerousProviderModes}
              danger
              disabled={!canManagePolicy || busy !== undefined}
              onChange={(allowDangerousProviderModes) => changeDraft({ allowDangerousProviderModes })}
            />
            <label className="rc-org__field">
              <span>
                <strong>Extensions</strong>
                <small>Choose the minimum package trust accepted by this host.</small>
              </span>
              <select
                aria-label="Extension policy"
                value={draft.extensionMode}
                disabled={!canManagePolicy || busy !== undefined}
                onChange={(event) => changeDraft({ extensionMode: event.target.value as PolicyDraft["extensionMode"] })}
              >
                <option value="allow-integrity">Verified integrity</option>
                <option value="signed-only">Signed packages only</option>
                <option value="deny">Block extension changes</option>
              </select>
            </label>
            <label className="rc-org__field">
              <span>
                <strong>Updates</strong>
                <small>Enterprise policy never permits mutable branch or checkout updates.</small>
              </span>
              <select
                aria-label="Update policy"
                value={draft.updateMode}
                disabled={!canManagePolicy || busy !== undefined}
                onChange={(event) => changeDraft({ updateMode: event.target.value as PolicyDraft["updateMode"] })}
              >
                <option value="stable-only">Stable releases only</option>
                <option value="deny">Block updates</option>
              </select>
            </label>
          </div>

          {transition && confirmation === transition && (
            <div className="rc-org__confirm" role="alert">
              <Icon name="alert" size={16} />
              <span>
                <strong>{transition === "enable" ? "Enable enforcement now?" : "Disable enforcement now?"}</strong>
                <small>
                  {transition === "enable"
                    ? "Remote clients and input leases are revoked immediately, then must reconnect through the new policy."
                    : "Organization restrictions stop applying immediately; valid paired devices regain their role-permitted access."}
                </small>
              </span>
              <div className="rc-org__confirm-actions">
                <button type="button" className="is-danger" onClick={() => void savePolicy(true)}>
                  {transition === "enable" ? "Enable and apply" : "Disable and apply"}
                </button>
                <button type="button" onClick={() => setConfirmation(undefined)}>
                  Review again
                </button>
              </div>
            </div>
          )}

          <div className="rc-org__actions">
            <button
              type="button"
              className="is-primary"
              disabled={!canManagePolicy || !dirty || busy !== undefined || confirmation !== undefined}
              onClick={() => void savePolicy()}
            >
              {busy === "policy" ? "Applying…" : transition ? "Review policy change" : "Apply policy"}
            </button>
            <button
              type="button"
              disabled={!dirty || busy !== undefined}
              onClick={() => {
                setDraft(toDraft(policy));
                setConfirmation(undefined);
                setNotice(undefined);
              }}
            >
              Discard changes
            </button>
          </div>
        </section>
      )}

      {fleet && (
        <section className="rc-org__panel" aria-labelledby="rc-org-fleet-title">
          <div className="rc-org__panel-head">
            <span>
              <strong id="rc-org-fleet-title">Fleet posture</strong>
              <small>Privacy-bounded health, durability, adapters, and policy compliance</small>
            </span>
            <button type="button" disabled={busy !== undefined} onClick={() => void refreshFleet()}>
              {busy === "fleet" ? "Refreshing…" : "Refresh"}
            </button>
          </div>
          <div className="rc-org__hosts">
            {fleet.hosts.map((host) => (
              <article className="rc-org__host" key={host.id}>
                <div className="rc-org__host-head">
                  <span>
                    <strong>{host.label}</strong>
                    <small>RoamCode {host.version}</small>
                  </span>
                  <span className={`rc-org__badge${host.policyPosture.compliant ? " is-good" : " is-bad"}`}>
                    {host.policyPosture.compliant ? "Compliant" : "Needs attention"}
                  </span>
                </div>
                <dl className="rc-org__facts">
                  <div>
                    <dt>Health</dt>
                    <dd>{host.health}</dd>
                  </div>
                  <div>
                    <dt>Active agents</dt>
                    <dd>{host.activeSessions}</dd>
                  </div>
                  <div>
                    <dt>Durable data</dt>
                    <dd>{host.dataDurable ? "Yes" : "Fallback"}</dd>
                  </div>
                  <div>
                    <dt>Relay</dt>
                    <dd>{host.relayConfigured ? "Configured" : "Direct only"}</dd>
                  </div>
                </dl>
                {host.policyPosture.violations.length > 0 && (
                  <p className="rc-org__violation" role="status">
                    <Icon name="alert" size={14} /> {host.policyPosture.violations.join(", ")}
                  </p>
                )}
                <div className="rc-org__chips" aria-label={`${host.label} adapters`}>
                  {host.adapters.map((adapter) => (
                    <span className={adapter.enabled ? "" : "is-muted"} key={adapter.id}>
                      {adapter.id}
                      {adapter.version ? ` ${adapter.version}` : ""}
                    </span>
                  ))}
                </div>
                <small className="rc-org__timestamp">Updated {humanTime(host.updatedAt)}</small>
              </article>
            ))}
          </div>
        </section>
      )}

      <PeerConnections api={api} canManage={canManagePolicy} />

      <section className="rc-org__panel" aria-labelledby="rc-org-audit-title">
        <div className="rc-org__panel-head">
          <span>
            <strong id="rc-org-audit-title">Integrity audit</strong>
            <small>Append-only, privacy-safe mutation records protected by a SHA-256 hash chain</small>
          </span>
          {verification && (
            <span className={`rc-org__badge${verification.valid ? " is-good" : " is-bad"}`}>
              {verification.valid ? "Verified" : "Invalid"}
            </span>
          )}
        </div>

        {verification && (
          <div className="rc-org__audit-proof" role="status">
            <Icon name={verification.valid ? "check" : "alert"} size={16} />
            <span>
              <strong>{verification.count.toLocaleString()} chained records</strong>
              <small>Head {verification.head.slice(0, 12)}…</small>
            </span>
          </div>
        )}

        {auditError && <p className="rc-org__notice">{auditError}</p>}

        {audit && audit.records.length > 0 && (
          <ol className="rc-org__audit-list" aria-label="Latest audit records">
            {audit.records.map((record) => (
              <li key={record.id}>
                <span className={`rc-org__result is-${record.result}`}>{record.result}</span>
                <span>
                  <strong>{record.action}</strong>
                  <small>
                    {record.actorType} · {record.targetType}
                    {record.targetId ? ` · ${record.targetId}` : ""} · {humanTime(record.createdAt)}
                  </small>
                </span>
              </li>
            ))}
          </ol>
        )}

        {canReadAudit && (
          <div className="rc-org__actions">
            <button type="button" disabled={busy !== undefined} onClick={() => void verifyAudit()}>
              {busy === "audit" ? "Verifying…" : "Verify chain"}
            </button>
            <button type="button" disabled={busy !== undefined} onClick={() => void exportAudit()}>
              <Icon name="download" size={14} />
              {busy === "export" ? "Preparing…" : "Export NDJSON"}
            </button>
          </div>
        )}
      </section>

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
      <style>{organizationCss}</style>
    </div>
  );
}

function SummaryMetric({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: "neutral" | "good" | "warn" | "bad";
}) {
  return (
    <span className={`rc-org__metric is-${tone}`}>
      <small>{label}</small>
      <strong>{value}</strong>
    </span>
  );
}

function PolicyToggle({
  label,
  detail,
  checked,
  disabled,
  danger = false,
  onChange,
}: {
  label: string;
  detail: string;
  checked: boolean;
  disabled: boolean;
  danger?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className={`rc-org__toggle${danger && checked ? " is-danger" : ""}`}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>
        <strong>{label}</strong>
        <small>{detail}</small>
      </span>
    </label>
  );
}

function ScopeSelector({
  legend,
  detail,
  candidates,
  selected,
  disabled,
  onChange,
}: {
  legend: string;
  detail: string;
  candidates: Array<{ id: string; label: string; detail?: string }>;
  selected: string[] | null;
  disabled: boolean;
  onChange: (selected: string[] | null) => void;
}) {
  const restricted = selected !== null;
  const selectedIds = selected ?? [];
  return (
    <fieldset className="rc-org__scope" disabled={disabled}>
      <legend>{legend}</legend>
      <small>{detail}</small>
      <label className="rc-org__scope-limit">
        <input
          type="checkbox"
          checked={restricted}
          disabled={disabled || candidates.length === 0}
          onChange={(event) => onChange(event.target.checked ? candidates.map((candidate) => candidate.id) : null)}
        />
        <span>Only selected</span>
      </label>
      {restricted && (
        <div className="rc-org__scope-options">
          {candidates.map((candidate) => (
            <label key={candidate.id}>
              <input
                type="checkbox"
                checked={selectedIds.includes(candidate.id)}
                onChange={(event) => {
                  const next = event.target.checked
                    ? [...selectedIds, candidate.id]
                    : selectedIds.filter((id) => id !== candidate.id);
                  onChange([...new Set(next)].sort());
                }}
              />
              <span>
                <strong>{candidate.label}</strong>
                {candidate.detail && <small>{candidate.detail}</small>}
              </span>
            </label>
          ))}
          {selectedIds.length === 0 && (
            <p className="rc-org__scope-empty">Nothing selected — this scope will be denied.</p>
          )}
        </div>
      )}
      {!restricted && <span className="rc-org__all">All available</span>}
    </fieldset>
  );
}

const organizationCss = `
.rc-org { display:grid; gap:12px; }
.rc-org button,.rc-org input,.rc-org select { font:600 12px/1.2 var(--font-body); }
.rc-org button { min-height:var(--tap-min); padding:0 12px; display:inline-flex; align-items:center; justify-content:center; gap:6px; border:1px solid var(--border-strong); border-radius:8px; background:var(--surface-3); color:var(--text); cursor:pointer; }
.rc-org button:hover:not(:disabled) { border-color:var(--text-faint); }
.rc-org button:focus-visible,.rc-org input:focus-visible,.rc-org select:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
.rc-org button:disabled,.rc-org input:disabled,.rc-org select:disabled { opacity:.5; cursor:default; }
.rc-org button.is-primary { background:var(--accent-grad); border-color:transparent; color:var(--on-accent); }
.rc-org button.is-danger { background:var(--err-bg); border-color:var(--err-border); color:var(--err); }
.rc-org__muted,.rc-org__notice { margin:0; color:var(--text-muted); font-size:12px; line-height:1.5; }
.rc-org__notice { padding:9px 10px; border:1px solid var(--border); border-radius:8px; background:var(--surface-2); }
.rc-org__summary { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:7px; }
.rc-org__metric { min-width:0; display:grid; gap:4px; padding:9px 10px; border:1px solid var(--border); border-radius:9px; background:var(--surface-2); }
.rc-org__metric small { color:var(--text-faint); font:700 9.5px/1 var(--font-mono); text-transform:uppercase; letter-spacing:.06em; }
.rc-org__metric strong { overflow:hidden; text-overflow:ellipsis; color:var(--text); font-size:12px; white-space:nowrap; }
.rc-org__metric.is-good strong { color:var(--success); }
.rc-org__metric.is-warn strong { color:var(--warn); }
.rc-org__metric.is-bad strong { color:var(--err); }
.rc-org__panel { display:grid; gap:11px; padding:11px; border:1px solid var(--border); border-radius:10px; background:color-mix(in srgb,var(--surface-2) 68%,transparent); }
.rc-org__panel-head,.rc-org__host-head { display:flex; align-items:flex-start; justify-content:space-between; gap:10px; }
.rc-org__panel-head>span:first-child,.rc-org__host-head>span:first-child { min-width:0; display:grid; gap:3px; }
.rc-org__panel-head strong,.rc-org__host-head strong { font-size:12px; }
.rc-org__panel-head small,.rc-org__host-head small { color:var(--text-muted); font-size:10.5px; line-height:1.4; }
.rc-org__badge { flex:none; padding:4px 7px; border-radius:999px; background:var(--surface-3); color:var(--text-muted); font:700 9.5px/1 var(--font-mono); }
.rc-org__badge.is-good { background:color-mix(in srgb,var(--success) 14%,transparent); color:var(--success); }
.rc-org__badge.is-bad { background:var(--err-bg); color:var(--err); }
.rc-org__toggle { min-height:var(--tap-min); display:flex; align-items:flex-start; gap:9px; padding:9px 10px; border:1px solid var(--border); border-radius:9px; background:var(--surface); }
.rc-org__toggle.is-danger { border-color:var(--err-border); background:var(--err-bg); }
.rc-org__toggle>input,.rc-org__scope input { width:18px; height:18px; flex:none; margin:1px 0 0; accent-color:var(--accent); }
.rc-org__toggle>span,.rc-org__field>span { min-width:0; display:grid; gap:3px; }
.rc-org__toggle strong,.rc-org__field strong { font-size:11.5px; }
.rc-org__toggle small,.rc-org__field small { color:var(--text-muted); font-size:10.5px; line-height:1.4; }
.rc-org__scope-grid { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:7px; }
.rc-org__scope { min-width:0; margin:0; display:grid; align-content:start; gap:7px; padding:9px; border:1px solid var(--border); border-radius:9px; }
.rc-org__scope legend { padding:0 4px; color:var(--text); font:650 11.5px/1 var(--font-body); }
.rc-org__scope>small { color:var(--text-muted); font-size:10px; line-height:1.35; }
.rc-org__scope-limit,.rc-org__scope-options label { min-height:var(--tap-min); display:flex; align-items:center; gap:7px; color:var(--text); font-size:10.5px; }
.rc-org__scope-options { display:grid; gap:3px; padding-top:5px; border-top:1px solid var(--border); }
.rc-org__scope-options label>span { min-width:0; display:grid; gap:2px; }
.rc-org__scope-options label strong { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:10.5px; }
.rc-org__scope-options label small { color:var(--text-faint); font-size:9.5px; }
.rc-org__all { color:var(--text-faint); font:600 9.5px/1 var(--font-mono); }
.rc-org__scope-empty { margin:2px 0 0; color:var(--err); font-size:10px; line-height:1.35; }
.rc-org__rules { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:7px; }
.rc-org__field { min-height:var(--tap-min); display:grid; grid-template-columns:minmax(0,1fr) minmax(130px,180px); align-items:center; gap:9px; padding:9px 10px; border:1px solid var(--border); border-radius:9px; background:var(--surface); }
.rc-org__field select { width:100%; min-height:var(--tap-min); min-width:0; padding:0 9px; border:1px solid var(--border); border-radius:8px; background:var(--surface-2); color:var(--text); }
.rc-org__confirm { display:grid; grid-template-columns:auto minmax(0,1fr); gap:8px; padding:10px; border:1px solid var(--err-border); border-radius:9px; background:var(--err-bg); }
.rc-org__confirm>svg { margin-top:1px; color:var(--err); }
.rc-org__confirm>span { display:grid; gap:3px; }
.rc-org__confirm strong { font-size:11.5px; }
.rc-org__confirm small { color:var(--text-muted); font-size:10.5px; line-height:1.45; }
.rc-org__confirm-actions { grid-column:2; display:flex; flex-wrap:wrap; gap:7px; }
.rc-org__actions { display:flex; flex-wrap:wrap; justify-content:flex-end; gap:7px; }
.rc-org__hosts { display:grid; gap:7px; }
.rc-org__host { display:grid; gap:9px; padding:10px; border:1px solid var(--border); border-radius:9px; background:var(--surface); }
.rc-org__facts { margin:0; display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:6px; }
.rc-org__facts div { min-width:0; display:grid; gap:3px; }
.rc-org__facts dt { color:var(--text-faint); font:650 9px/1 var(--font-mono); text-transform:uppercase; }
.rc-org__facts dd { margin:0; overflow:hidden; text-overflow:ellipsis; color:var(--text); font-size:10.5px; white-space:nowrap; text-transform:capitalize; }
.rc-org__violation { margin:0; display:flex; align-items:center; gap:5px; color:var(--err); font-size:10.5px; }
.rc-org__chips { display:flex; flex-wrap:wrap; gap:5px; }
.rc-org__chips span { padding:4px 7px; border:1px solid var(--border); border-radius:999px; color:var(--text-muted); font:600 9.5px/1 var(--font-mono); }
.rc-org__chips span.is-muted { opacity:.55; }
.rc-org__timestamp { color:var(--text-faint); font-size:9.5px; }
.rc-org__audit-proof { display:flex; align-items:center; gap:8px; padding:9px 10px; border:1px solid var(--border); border-radius:9px; background:var(--surface); color:var(--success); }
.rc-org__audit-proof>span { display:grid; gap:3px; }
.rc-org__audit-proof strong { font-size:11px; }
.rc-org__audit-proof small { color:var(--text-faint); font:600 9.5px/1 var(--font-mono); }
.rc-org__audit-list { max-height:260px; overflow:auto; margin:0; padding:0; display:grid; gap:5px; list-style:none; }
.rc-org__audit-list li { min-width:0; display:grid; grid-template-columns:auto minmax(0,1fr); align-items:start; gap:8px; padding:8px 9px; border:1px solid var(--border); border-radius:8px; background:var(--surface); }
.rc-org__audit-list li>span:last-child { min-width:0; display:grid; gap:3px; }
.rc-org__audit-list strong { overflow:hidden; text-overflow:ellipsis; font:600 10.5px/1.3 var(--font-mono); white-space:nowrap; }
.rc-org__audit-list small { overflow:hidden; text-overflow:ellipsis; color:var(--text-muted); font-size:9.5px; white-space:nowrap; }
.rc-org__result { margin-top:1px; padding:3px 5px; border-radius:999px; background:var(--surface-3); color:var(--text-muted); font:700 8.5px/1 var(--font-mono); text-transform:uppercase; }
.rc-org__result.is-success { color:var(--success); }
.rc-org__result.is-denied,.rc-org__result.is-error { color:var(--err); background:var(--err-bg); }
.rc-org__success,.rc-org__error { margin:0; padding:9px 10px; border-radius:8px; font-size:11px; line-height:1.45; }
.rc-org__success { border:1px solid color-mix(in srgb,var(--success) 35%,var(--border)); color:var(--success); background:color-mix(in srgb,var(--success) 8%,transparent); }
.rc-org__error { border:1px solid var(--err-border); color:var(--err); background:var(--err-bg); }
@media(max-width:680px){
  .rc-org__summary { grid-template-columns:1fr; }
  .rc-org__scope-grid,.rc-org__rules { grid-template-columns:1fr; }
  .rc-org__field { grid-template-columns:1fr; }
  .rc-org__facts { grid-template-columns:1fr 1fr; }
  .rc-org__panel-head { align-items:flex-start; }
  .rc-org__actions { display:grid; grid-template-columns:1fr; }
  .rc-org__confirm-actions { grid-column:1/-1; display:grid; grid-template-columns:1fr; }
}
@media(prefers-reduced-motion:reduce){.rc-org *{scroll-behavior:auto!important}}
`;
