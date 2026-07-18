import { describe, expect, test } from "vitest";
import { openTeamStore, TeamRevisionConflictError, type OpenTeamStoreOptions } from "../src/team-store.js";

function deterministicOptions(memory: boolean): OpenTeamStoreOptions {
  let member = 0;
  let role = 0;
  return {
    dbPath: ":memory:",
    generateTeamId: () => "team-1",
    generateMemberId: () => `member-${++member}`,
    generateRoleId: () => `role-${++role}`,
    ...(memory
      ? {
          loadDatabase: () => {
            throw new Error("native module unavailable");
          },
        }
      : {}),
  };
}

describe.each([
  ["memory fallback", true],
  ["sqlite", false],
] as const)("team store: %s", (_label, memory) => {
  test("enforces explicit role and scope bindings while preserving local break-glass", () => {
    const store = openTeamStore(deterministicOptions(memory));
    const created = store.createTeam(
      {
        name: "Acme Engineering",
        ownerName: "Owner",
        ownerPrincipal: { actorType: "host", actorId: "host-1" },
      },
      100,
    );
    expect(created.team).toMatchObject({ id: "team-1", authorizationEnabled: false, revision: 1 });
    expect(store.authorize("device", "unbound", "sessions:operate").allowed).toBe(true);

    const enabled = store.updateTeam({ authorizationEnabled: true }, 1, 110);
    expect(enabled).toMatchObject({ authorizationEnabled: true, revision: 2 });
    expect(store.authorize("device", "unbound", "sessions:read")).toMatchObject({
      allowed: false,
      reason: "unbound",
    });
    expect(store.authorize("host", "host-recovery", "members:manage")).toMatchObject({
      allowed: true,
      reason: "local-break-glass",
    });

    const member = store.createMember({ displayName: "Reviewer" }, 120);
    store.bindPrincipal({ memberId: member.id, actorType: "device", actorId: "review-device" }, 121);
    store.grantRole({ memberId: member.id, role: "viewer" }, 122);
    expect(store.authorize("device", "review-device", "sessions:read").allowed).toBe(true);
    expect(store.authorize("device", "review-device", "sessions:operate")).toMatchObject({
      allowed: false,
      reason: "missing-permission",
    });

    store.grantRole({ memberId: member.id, role: "operator", scopeType: "workspace", scopeId: "workspace-a" }, 123);
    expect(store.authorize("device", "review-device", "sessions:operate", { workspaceId: "workspace-a" }).allowed).toBe(
      true,
    );
    expect(store.authorize("device", "review-device", "sessions:operate", { workspaceId: "workspace-b" }).allowed).toBe(
      false,
    );

    const suspended = store.updateMember(member.id, { status: "suspended" }, member.revision, 130);
    expect(suspended?.status).toBe("suspended");
    expect(store.authorize("device", "review-device", "sessions:read")).toMatchObject({
      allowed: false,
      reason: "inactive",
    });
    store.close();
  });

  test("uses revision conflicts and idempotent role grants instead of last-write-wins", () => {
    const store = openTeamStore(deterministicOptions(memory));
    const { team } = store.createTeam(
      {
        name: "Studio",
        ownerName: "Owner",
        ownerPrincipal: { actorType: "host", actorId: "host-1" },
      },
      10,
    );
    const renamed = store.updateTeam({ name: "Studio Two" }, team.revision, 11);
    expect(() => store.updateTeam({ name: "Stale write" }, team.revision, 12)).toThrow(TeamRevisionConflictError);
    expect(store.getTeam()).toEqual(renamed);

    const service = store.createMember({ displayName: "Release bot", kind: "service" }, 20);
    const first = store.grantRole({ memberId: service.id, role: "operator" }, 21);
    const replay = store.grantRole({ memberId: service.id, role: "operator" }, 22);
    expect(replay.id).toBe(first.id);
    expect(store.listRoleBindings(service.id)).toHaveLength(1);
    expect(store.revokeRole(first.id, 23)).toBe(true);
    expect(store.revokeRole(first.id, 24)).toBe(false);
    store.close();
  });

  test("replaces one Node access role atomically without granting organization administration", () => {
    const store = openTeamStore(deterministicOptions(memory));
    store.createTeam(
      {
        name: "Studio",
        ownerName: "Owner",
        ownerPrincipal: { actorType: "host", actorId: "host-1" },
      },
      10,
    );
    const member = store.createMember({ displayName: "Node operator" }, 11);
    store.bindPrincipal({ memberId: member.id, actorType: "device", actorId: "device-1" }, 12);
    store.updateTeam({ authorizationEnabled: true }, store.getTeam()!.revision, 12);

    const admin = store.setNodeAccessRole({ memberId: member.id, nodeId: "node-1", role: "node-admin" }, 13);
    expect(store.authorize("device", "device-1", "node-access:manage", { hostId: "node-1" }).allowed).toBe(true);
    expect(store.authorize("device", "device-1", "members:manage", { hostId: "node-1" }).allowed).toBe(false);
    expect(store.authorize("device", "device-1", "policy:manage", { hostId: "node-1" }).allowed).toBe(false);

    const viewer = store.setNodeAccessRole({ memberId: member.id, nodeId: "node-1", role: "viewer" }, 14);
    expect(viewer.id).not.toBe(admin.id);
    expect(
      store
        .listRoleBindings(member.id)
        .filter((binding) => binding.scopeType === "host" && binding.scopeId === "node-1"),
    ).toEqual([viewer]);
    expect(store.authorize("device", "device-1", "sessions:read", { hostId: "node-1" }).allowed).toBe(true);
    expect(store.authorize("device", "device-1", "sessions:operate", { hostId: "node-1" }).allowed).toBe(false);
    store.close();
  });

  test("never replaces a host-scoped organization administrator through the Node role helper", () => {
    const store = openTeamStore(deterministicOptions(memory));
    store.createTeam(
      {
        name: "Studio",
        ownerName: "Owner",
        ownerPrincipal: { actorType: "host", actorId: "host-1" },
      },
      10,
    );
    const member = store.createMember({ displayName: "Protected administrator" }, 11);
    const organizationAdmin = store.grantRole(
      { memberId: member.id, role: "organization-admin", scopeType: "host", scopeId: "node-1" },
      12,
    );

    const viewer = store.setNodeAccessRole({ memberId: member.id, nodeId: "node-1", role: "viewer" }, 13);

    expect(store.listRoleBindings(member.id)).toEqual(expect.arrayContaining([organizationAdmin, viewer]));
    expect(store.listRoleBindings(member.id)).toHaveLength(2);
    store.close();
  });
});
