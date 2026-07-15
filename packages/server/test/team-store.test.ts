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
});
