import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  ApiClient,
  TeamEnvelope,
  TeamMember,
  TeamPrincipalBinding,
  TeamRole,
  TeamRoleBinding,
} from "../api/client";
import type { DeviceInfo } from "../types/server";
import { InlineConfirm } from "../ui/InlineConfirm";

const ROLES: Array<{ id: TeamRole; label: string; detail: string }> = [
  { id: "viewer", label: "Viewer", detail: "Can observe agents, attention, and presence." },
  { id: "operator", label: "Operator", detail: "Can send input and operate agents." },
  { id: "workspace-manager", label: "Workspace manager", detail: "Can also create and manage workspaces." },
  { id: "extension-manager", label: "Extension manager", detail: "Can install and manage verified extensions." },
  { id: "policy-admin", label: "Policy admin", detail: "Can change policy and inspect fleet audit." },
  { id: "organization-admin", label: "Organization admin", detail: "Can manage membership and every team setting." },
];

type MemberWithRoles = TeamMember & { roles: TeamRoleBinding[] };

type TeamConfirmation =
  | { kind: "policy"; enabled: boolean; message: string }
  | { kind: "member"; memberId: string; memberName: string; status: "active" | "suspended"; revision: number }
  | { kind: "role"; bindingId: string; memberId: string; memberName: string; role: TeamRole };

function roleLabel(role: TeamRole): string {
  return ROLES.find((candidate) => candidate.id === role)?.label ?? role;
}

export function TeamAccess({ api }: { api: ApiClient }) {
  const [envelope, setEnvelope] = useState<TeamEnvelope>();
  const [members, setMembers] = useState<MemberWithRoles[]>([]);
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const [principals, setPrincipals] = useState<TeamPrincipalBinding[]>([]);
  const [teamName, setTeamName] = useState("My team");
  const [memberName, setMemberName] = useState("");
  const [memberKind, setMemberKind] = useState<"person" | "service">("person");
  const [memberRole, setMemberRole] = useState<TeamRole>("viewer");
  const [roleDrafts, setRoleDrafts] = useState<Record<string, TeamRole>>({});
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [confirmation, setConfirmation] = useState<TeamConfirmation>();

  const canManageMembers =
    envelope?.authorization.localBreakGlass === true || envelope?.permissions.includes("members:manage") === true;
  const canManagePolicy =
    envelope?.authorization.localBreakGlass === true || envelope?.permissions.includes("policy:manage") === true;

  const refresh = useCallback(async () => {
    setError(undefined);
    try {
      const next = await api.getTeam();
      setEnvelope(next);
      if (!next.team) {
        setMembers([]);
        setDevices([]);
        setPrincipals([]);
        return;
      }
      setTeamName(next.team.name);
      const nextMembers = await api.listTeamMembers();
      setMembers(nextMembers);
      const manager = next.authorization.localBreakGlass || next.permissions.includes("members:manage");
      if (manager) {
        const [deviceInventory, bindings] = await Promise.all([api.listDevices(), api.listTeamPrincipalBindings()]);
        setDevices(deviceInventory.devices);
        setPrincipals(bindings);
      } else {
        setDevices([]);
        setPrincipals([]);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Team settings could not be loaded");
    }
  }, [api]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const run = async (key: string, action: () => Promise<unknown>) => {
    setBusy(key);
    setError(undefined);
    try {
      await action();
      await refresh();
      return true;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Team change failed");
      return false;
    } finally {
      setBusy(undefined);
    }
  };

  const unboundDevices = useMemo(
    () =>
      devices.filter(
        (device) => !principals.some((binding) => binding.actorType === "device" && binding.actorId === device.id),
      ),
    [devices, principals],
  );

  if (!envelope) return <p className="rc-team__muted">Loading team workspace…</p>;

  if (!envelope.team) {
    return (
      <div className="rc-team">
        <p className="rc-team__muted">
          RoamCode works fully without an account. Create a team only when people or agents on separate devices need
          shared roles and presence.
        </p>
        <div className="rc-team__create">
          <label>
            <span>Team name</span>
            <input value={teamName} maxLength={80} onChange={(event) => setTeamName(event.target.value)} />
          </label>
          <button
            type="button"
            disabled={busy !== undefined || teamName.trim() === ""}
            onClick={() => void run("create", () => api.createTeam(teamName.trim()))}
          >
            {busy === "create" ? "Creating…" : "Create team workspace"}
          </button>
        </div>
        {error && (
          <p className="rc-team__error" role="alert">
            {error}
          </p>
        )}
        <style>{teamCss}</style>
      </div>
    );
  }

  const team = envelope.team;
  return (
    <div className="rc-team">
      <div className="rc-team__summary">
        <span>
          <strong>{team.name}</strong>
          <small>
            {team.authorizationEnabled ? "Role enforcement is on" : "Roles are staged, not enforced"}
            {envelope.currentMember ? ` · Signed in as ${envelope.currentMember.displayName}` : ""}
          </small>
        </span>
        <span className={`rc-team__status${team.authorizationEnabled ? " is-on" : ""}`}>
          {team.authorizationEnabled ? "Enforced" : "Open"}
        </span>
      </div>

      {canManagePolicy && (
        <div className="rc-team__policy">
          <label>
            <span>Team name</span>
            <input value={teamName} maxLength={80} onChange={(event) => setTeamName(event.target.value)} />
          </label>
          <button
            type="button"
            disabled={busy !== undefined || teamName.trim() === team.name || teamName.trim() === ""}
            onClick={() =>
              void run("rename", () => api.updateTeam({ name: teamName.trim(), expectedRevision: team.revision }))
            }
          >
            Save name
          </button>
          <label className="rc-team__enforce">
            <input
              type="checkbox"
              checked={team.authorizationEnabled}
              disabled={busy !== undefined}
              onChange={(event) => {
                const enabled = event.target.checked;
                const warning = enabled
                  ? `${unboundDevices.length > 0 ? `${unboundDevices.length} paired device(s) are not assigned and will lose access. ` : ""}Enable server-side role enforcement? The host recovery credential remains available.`
                  : "Disable team role enforcement? Every valid paired device will regain the local host's normal access.";
                setConfirmation({ kind: "policy", enabled, message: warning });
              }}
            />
            <span>
              <strong>Enforce roles on every connection</strong>
              <small>Applies to the UI, CLI, API, and terminal sockets.</small>
            </span>
          </label>
          {confirmation?.kind === "policy" && (
            <InlineConfirm
              className="rc-team__confirm"
              message={confirmation.message}
              confirmLabel={confirmation.enabled ? "Enable role enforcement" : "Disable role enforcement"}
              busy={busy === "policy"}
              onCancel={() => setConfirmation(undefined)}
              onConfirm={() => {
                const pending = confirmation;
                void run("policy", () =>
                  api.updateTeam({
                    authorizationEnabled: pending.enabled,
                    expectedRevision: team.revision,
                    confirm: pending.enabled,
                  }),
                ).then((changed) => {
                  if (changed) setConfirmation(undefined);
                });
              }}
            />
          )}
        </div>
      )}

      <div className="rc-team__heading">
        <strong>Members</strong>
        <span>{members.filter((member) => member.status === "active").length} active</span>
      </div>
      <div className="rc-team__members">
        {members.map((member) => {
          const memberConfirmation =
            confirmation?.kind !== "policy" && confirmation?.memberId === member.id ? confirmation : undefined;
          return (
            <article className="rc-team__member" key={member.id}>
              <div className="rc-team__member-main">
                <span>
                  <strong>{member.displayName}</strong>
                  <small>
                    {member.kind === "service" ? "Agent/service identity" : "Person"} · {member.status}
                  </small>
                </span>
                {canManageMembers && member.id !== envelope.currentMember?.id && (
                  <button
                    type="button"
                    className="rc-team__quiet"
                    disabled={busy !== undefined}
                    onClick={() => {
                      const next = member.status === "active" ? "suspended" : "active";
                      if (next === "active") {
                        void run(`member-${member.id}`, () =>
                          api.updateTeamMember(member.id, { status: next, expectedRevision: member.revision }),
                        );
                        return;
                      }
                      setConfirmation({
                        kind: "member",
                        memberId: member.id,
                        memberName: member.displayName,
                        status: next,
                        revision: member.revision,
                      });
                    }}
                  >
                    {member.status === "active" ? "Suspend" : "Restore"}
                  </button>
                )}
              </div>
              {memberConfirmation?.kind === "member" && (
                <InlineConfirm
                  message={`Suspend ${memberConfirmation.memberName}? Their live input and connections will be revoked.`}
                  confirmLabel={`Suspend ${memberConfirmation.memberName}`}
                  busy={busy === `member-${member.id}`}
                  onCancel={() => setConfirmation(undefined)}
                  onConfirm={() => {
                    const pending = memberConfirmation;
                    void run(`member-${member.id}`, () =>
                      api.updateTeamMember(pending.memberId, {
                        status: pending.status,
                        expectedRevision: pending.revision,
                      }),
                    ).then((changed) => {
                      if (changed) setConfirmation(undefined);
                    });
                  }}
                />
              )}
              <div className="rc-team__roles" aria-label={`${member.displayName} roles`}>
                {member.roles.map((binding) => (
                  <span className="rc-team__role" key={binding.id} title={binding.scopeId ?? "Whole team"}>
                    {roleLabel(binding.role)}
                    {canManageMembers && member.id !== envelope.currentMember?.id && (
                      <button
                        type="button"
                        aria-label={`Remove ${roleLabel(binding.role)} from ${member.displayName}`}
                        disabled={busy !== undefined}
                        onClick={() =>
                          setConfirmation({
                            kind: "role",
                            bindingId: binding.id,
                            memberId: member.id,
                            memberName: member.displayName,
                            role: binding.role,
                          })
                        }
                      >
                        ×
                      </button>
                    )}
                  </span>
                ))}
                {member.roles.length === 0 && <span className="rc-team__muted">No access role</span>}
              </div>
              {memberConfirmation?.kind === "role" && (
                <InlineConfirm
                  message={`Remove ${roleLabel(memberConfirmation.role)} from ${memberConfirmation.memberName}?`}
                  confirmLabel="Remove role"
                  busy={busy === `role-${memberConfirmation.bindingId}`}
                  onCancel={() => setConfirmation(undefined)}
                  onConfirm={() => {
                    const pending = memberConfirmation;
                    void run(`role-${pending.bindingId}`, () => api.revokeTeamRole(pending.bindingId)).then(
                      (changed) => {
                        if (changed) setConfirmation(undefined);
                      },
                    );
                  }}
                />
              )}
              {canManageMembers && member.status === "active" && (
                <div className="rc-team__add-role">
                  <select
                    aria-label={`New role for ${member.displayName}`}
                    value={roleDrafts[member.id] ?? "viewer"}
                    onChange={(event) =>
                      setRoleDrafts((current) => ({ ...current, [member.id]: event.target.value as TeamRole }))
                    }
                  >
                    {ROLES.map((role) => (
                      <option value={role.id} key={role.id}>
                        {role.label}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    disabled={busy !== undefined}
                    onClick={() =>
                      void run(`add-role-${member.id}`, () =>
                        api.grantTeamRole({ memberId: member.id, role: roleDrafts[member.id] ?? "viewer" }),
                      )
                    }
                  >
                    Add team role
                  </button>
                </div>
              )}
            </article>
          );
        })}
      </div>

      {canManageMembers && (
        <div className="rc-team__new-member">
          <strong>Add a member</strong>
          <input
            aria-label="New member name"
            placeholder="Name"
            value={memberName}
            maxLength={120}
            onChange={(event) => setMemberName(event.target.value)}
          />
          <select
            aria-label="New member kind"
            value={memberKind}
            onChange={(event) => setMemberKind(event.target.value as typeof memberKind)}
          >
            <option value="person">Person</option>
            <option value="service">Agent or service</option>
          </select>
          <select
            aria-label="Initial role"
            value={memberRole}
            onChange={(event) => setMemberRole(event.target.value as TeamRole)}
          >
            {ROLES.map((role) => (
              <option value={role.id} key={role.id}>
                {role.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            disabled={busy !== undefined || memberName.trim() === ""}
            onClick={() =>
              void run("new-member", async () => {
                await api.createTeamMember({ displayName: memberName.trim(), kind: memberKind, role: memberRole });
                setMemberName("");
              })
            }
          >
            Add
          </button>
        </div>
      )}

      {canManageMembers && devices.length > 0 && (
        <div className="rc-team__devices">
          <div className="rc-team__heading">
            <strong>Device assignments</strong>
            <span>{unboundDevices.length} unassigned</span>
          </div>
          {devices.map((device) => {
            const binding = principals.find(
              (candidate) => candidate.actorType === "device" && candidate.actorId === device.id,
            );
            return (
              <label key={device.id}>
                <span>
                  <strong>{device.name}</strong>
                  <small>{binding ? "Role identity assigned" : "Will be blocked when roles are enforced"}</small>
                </span>
                <select
                  aria-label={`Member for ${device.name}`}
                  value={binding?.memberId ?? ""}
                  disabled={busy !== undefined}
                  onChange={(event) => {
                    const memberId = event.target.value;
                    void run(`device-${device.id}`, () =>
                      memberId
                        ? api.bindTeamPrincipal({ memberId, actorType: "device", actorId: device.id })
                        : api.unbindTeamPrincipal("device", device.id),
                    );
                  }}
                >
                  <option value="">Unassigned</option>
                  {members
                    .filter((member) => member.status === "active")
                    .map((member) => (
                      <option value={member.id} key={member.id}>
                        {member.displayName}
                      </option>
                    ))}
                </select>
              </label>
            );
          })}
        </div>
      )}

      {error && (
        <p className="rc-team__error" role="alert">
          {error}
        </p>
      )}
      <style>{teamCss}</style>
    </div>
  );
}

const teamCss = `
.rc-team { display:grid; gap:12px; }
.rc-team button,.rc-team input,.rc-team select { font:600 12px/1.2 var(--font-body); }
.rc-team button { min-height:var(--tap-min); padding:0 11px; border:1px solid var(--border-strong); border-radius:8px; background:var(--surface-3); color:var(--text); cursor:pointer; }
.rc-team button:disabled { opacity:.45; cursor:default; }
.rc-team input,.rc-team select { min-height:var(--tap-min); min-width:0; padding:0 10px; border:1px solid var(--border); border-radius:8px; background:var(--surface-2); color:var(--text); }
.rc-team__muted { margin:0; color:var(--text-muted); font-size:12px; line-height:1.5; }
.rc-team__error { margin:0; padding:8px 10px; border:1px solid var(--danger); border-radius:8px; color:var(--danger); font-size:12px; }
.rc-team__create { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:8px; align-items:end; }
.rc-team__create label,.rc-team__policy>label:not(.rc-team__enforce) { display:grid; gap:5px; color:var(--text-muted); font-size:11px; }
.rc-team__summary,.rc-team__heading,.rc-team__member-main { display:flex; align-items:center; justify-content:space-between; gap:10px; }
.rc-team__summary { padding:10px; border:1px solid var(--border); border-radius:10px; background:var(--surface-2); }
.rc-team__summary>span:first-child,.rc-team__member-main>span,.rc-team__devices label>span { min-width:0; display:grid; gap:3px; }
.rc-team__summary small,.rc-team__member small,.rc-team__devices small { color:var(--text-muted); font-size:10.5px; line-height:1.35; }
.rc-team__status { padding:4px 7px; border-radius:999px; background:var(--surface-3); color:var(--text-muted); font:700 10px/1 var(--font-mono); }
.rc-team__status.is-on { background:color-mix(in srgb,var(--success) 14%,transparent); color:var(--success); }
.rc-team__policy { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:8px; align-items:end; }
.rc-team__confirm { grid-column:1/-1; }
.rc-team__enforce { grid-column:1/-1; display:flex; align-items:flex-start; gap:9px; padding:10px; border:1px solid var(--border); border-radius:9px; }
.rc-team__enforce input { min-height:0; margin-top:2px; accent-color:var(--coral); }
.rc-team__enforce span { display:grid; gap:3px; }
.rc-team__enforce small { color:var(--text-muted); font-size:10.5px; line-height:1.4; }
.rc-team__heading { color:var(--text); font-size:12px; }
.rc-team__heading span { color:var(--text-faint); font:600 10px/1 var(--font-mono); }
.rc-team__members { display:grid; gap:7px; }
.rc-team__member { display:grid; gap:8px; padding:10px; border:1px solid var(--border); border-radius:10px; }
.rc-team__quiet { background:transparent!important; color:var(--text-muted)!important; }
.rc-team__roles { display:flex; flex-wrap:wrap; gap:5px; }
.rc-team__role { display:inline-flex; align-items:center; gap:4px; padding:4px 7px; border:1px solid var(--border); border-radius:999px; color:var(--text-muted); font:600 10px/1 var(--font-mono); }
.rc-team__role button { min-height:24px; width:24px; height:24px; margin:-6px -5px -6px 0; padding:0; border:0; background:transparent; color:var(--text-faint); }
.rc-team__add-role { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:6px; }
.rc-team__new-member { display:grid; grid-template-columns:minmax(110px,1fr) auto auto auto; gap:6px; align-items:center; padding-top:10px; border-top:1px solid var(--border); }
.rc-team__new-member strong { grid-column:1/-1; font-size:12px; }
.rc-team__devices { display:grid; gap:7px; padding-top:10px; border-top:1px solid var(--border); }
.rc-team__devices label { display:grid; grid-template-columns:minmax(0,1fr) minmax(130px,180px); align-items:center; gap:8px; }
@media(max-width:560px){.rc-team__new-member{grid-template-columns:1fr 1fr}.rc-team__new-member input{grid-column:1/-1}.rc-team__devices label{grid-template-columns:1fr}.rc-team__create{grid-template-columns:1fr}.rc-team__policy{grid-template-columns:1fr}.rc-team__policy .rc-team__enforce{grid-column:1}.rc-team__add-role{grid-template-columns:1fr}}
`;
