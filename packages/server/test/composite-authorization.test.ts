import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { openCloudAuthorizationStore } from "../src/cloud-authorization-store.js";
import { createCompositeAuthorizer } from "../src/composite-authorization.js";
import { openTeamStore, type OpenTeamStoreOptions } from "../src/team-store.js";
import {
  cloudAuthorizationSnapshot,
  cloudSigningFixture,
  signCloudAuthorizationSnapshot,
} from "./helpers/cloud-authorization.js";

const directories: string[] = [];

afterEach(async () => {
  while (directories.length > 0) await rm(directories.pop()!, { recursive: true, force: true });
});

async function dataDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "roamcode-composite-authorization-"));
  directories.push(directory);
  return directory;
}

function teamOptions(): OpenTeamStoreOptions {
  let member = 0;
  let role = 0;
  return {
    dbPath: ":memory:",
    generateTeamId: () => "team-1",
    generateMemberId: () => `member-${++member}`,
    generateRoleId: () => `role-${++role}`,
    loadDatabase: () => {
      throw new Error("use the deterministic memory store");
    },
  };
}

describe("composite authorization", () => {
  test("preserves TeamStore decisions exactly when cloud management is absent", () => {
    const teamStore = openTeamStore(teamOptions());
    const authorizer = createCompositeAuthorizer({ teamStore });
    expect(authorizer.authorize("device", "device-1", "sessions:read")).toMatchObject({
      allowed: true,
      reason: "not-enforced",
      source: "team",
      roles: [],
    });

    const { team } = teamStore.createTeam(
      {
        name: "Local team",
        ownerName: "Owner",
        ownerPrincipal: { actorType: "host", actorId: "host-1" },
      },
      100,
    );
    teamStore.updateTeam({ authorizationEnabled: true }, team.revision, 101);
    expect(authorizer.authorize("device", "device-1", "sessions:read")).toMatchObject({
      allowed: false,
      reason: "unbound",
      source: "team",
    });
    teamStore.close();
  });

  test("fails cloud-managed remote actors closed while retaining local and host break-glass", async () => {
    const directory = await dataDir();
    const key = cloudSigningFixture();
    const teamStore = openTeamStore(teamOptions());
    const cloudStore = openCloudAuthorizationStore({
      dataDir: directory,
      organizationId: "organization-1",
      hostId: "host-1",
      trustedKeys: [key.trustedKey],
    });
    const authorizer = createCompositeAuthorizer({ teamStore, cloudStore, now: () => 1_000 });
    expect(authorizer.authorize("device", "device-1", "sessions:read")).toMatchObject({
      allowed: false,
      reason: "cloud-authorization-unavailable",
      source: "cloud",
    });
    expect(authorizer.authorize("host", "host-recovery", "members:manage")).toEqual({
      allowed: true,
      reason: "local-break-glass",
      source: "local",
      roles: ["organization-admin"],
    });
    expect(authorizer.authorize("local", "loopback", "policy:manage").allowed).toBe(true);
    teamStore.close();
  });

  test("requires a signed cloud grant with the matching principal, permission, host, and workspace scope", async () => {
    const directory = await dataDir();
    const key = cloudSigningFixture();
    const teamStore = openTeamStore(teamOptions());
    const cloudStore = openCloudAuthorizationStore({
      dataDir: directory,
      organizationId: "organization-1",
      hostId: "host-1",
      trustedKeys: [key.trustedKey],
    });
    cloudStore.apply(
      signCloudAuthorizationSnapshot(
        cloudAuthorizationSnapshot({
          grants: [
            {
              principalType: "device",
              principalId: "device-1",
              permissions: ["sessions:read"],
              scope: { type: "organization" },
            },
            {
              principalType: "device",
              principalId: "device-1",
              permissions: ["sessions:operate"],
              scope: { type: "workspace", id: "workspace-a" },
            },
            {
              principalType: "device",
              principalId: "relay-1",
              permissions: ["sessions:read"],
              scope: { type: "host", id: "host-1" },
            },
            {
              principalType: "relay",
              principalId: "legacy-relay-shape",
              permissions: ["sessions:read"],
              scope: { type: "host", id: "host-1" },
            },
          ],
        }),
        key,
      ),
      1_000,
    );
    const authorizer = createCompositeAuthorizer({ teamStore, cloudStore, now: () => 1_100 });
    expect(authorizer.authorize("device", "device-1", "sessions:read")).toMatchObject({
      allowed: true,
      reason: "cloud-grant",
      cloudRevision: 1,
    });
    expect(authorizer.authorize("device", "device-1", "sessions:operate", { workspaceId: "workspace-a" }).allowed).toBe(
      true,
    );
    expect(
      authorizer.authorize("device", "device-1", "sessions:operate", { workspaceId: "workspace-b" }),
    ).toMatchObject({ allowed: false, reason: "cloud-missing-permission" });
    expect(authorizer.authorize("device", "device-2", "sessions:read")).toMatchObject({
      allowed: false,
      reason: "cloud-principal-unbound",
    });
    expect(authorizer.authorize("device", "device-1", "sessions:read", { hostId: "host-2" })).toMatchObject({
      allowed: false,
      reason: "cloud-host-mismatch",
    });
    expect(authorizer.authorize("relay", "relay-1", "sessions:read", { hostId: "host-1" })).toMatchObject({
      allowed: true,
      reason: "cloud-grant",
      source: "cloud",
    });
    expect(authorizer.authorize("relay", "legacy-relay-shape", "sessions:read", { hostId: "host-1" })).toMatchObject({
      allowed: false,
      reason: "cloud-principal-unbound",
      source: "cloud",
    });
    expect(authorizer.authorize("relay", "relay-1", "sessions:read", { hostId: "host-2" })).toMatchObject({
      allowed: false,
      reason: "cloud-host-mismatch",
    });
    teamStore.close();
  });

  test("keeps the local Node id for TeamStore while translating the managed cloud Host alias", async () => {
    const directory = await dataDir();
    const key = cloudSigningFixture();
    const teamStore = openTeamStore(teamOptions());
    const { team } = teamStore.createTeam(
      {
        name: "Managed team",
        ownerName: "Owner",
        ownerPrincipal: { actorType: "host", actorId: "local-node" },
      },
      100,
    );
    teamStore.updateTeam({ authorizationEnabled: true }, team.revision, 101);
    const member = teamStore.createMember({ displayName: "Viewer" }, 102);
    teamStore.bindPrincipal({ memberId: member.id, actorType: "device", actorId: "device-1" }, 103);
    teamStore.grantRole({ memberId: member.id, role: "viewer", scopeType: "host", scopeId: "local-node" }, 104);

    const cloudStore = openCloudAuthorizationStore({
      dataDir: directory,
      organizationId: "organization-1",
      hostId: "managed-host",
      trustedKeys: [key.trustedKey],
    });
    cloudStore.apply(
      signCloudAuthorizationSnapshot(
        cloudAuthorizationSnapshot({
          hostId: "managed-host",
          grants: [
            {
              principalType: "device",
              principalId: "device-1",
              permissions: ["sessions:read"],
              scope: { type: "host", id: "managed-host" },
            },
          ],
        }),
        key,
      ),
      1_000,
    );

    const authorizer = createCompositeAuthorizer({
      teamStore,
      cloudStore,
      cloudHostId: "managed-host",
      now: () => 1_100,
    });
    expect(authorizer.authorize("device", "device-1", "sessions:read", { hostId: "local-node" })).toMatchObject({
      allowed: true,
      reason: "cloud-grant",
      source: "cloud",
    });
    expect(authorizer.authorize("device", "device-1", "sessions:read", { hostId: "another-local-node" })).toMatchObject(
      { allowed: false, reason: "missing-permission", source: "team" },
    );
    teamStore.close();
  });

  test("keeps stricter local TeamStore policy additive and expires cloud access without locking out recovery", async () => {
    const directory = await dataDir();
    const key = cloudSigningFixture();
    const teamStore = openTeamStore(teamOptions());
    const { team } = teamStore.createTeam(
      {
        name: "Hybrid team",
        ownerName: "Owner",
        ownerPrincipal: { actorType: "host", actorId: "host-1" },
      },
      100,
    );
    teamStore.updateTeam({ authorizationEnabled: true }, team.revision, 101);
    const member = teamStore.createMember({ displayName: "Operator" }, 102);
    teamStore.bindPrincipal({ memberId: member.id, actorType: "device", actorId: "device-1" }, 103);
    teamStore.grantRole({ memberId: member.id, role: "viewer" }, 104);

    const cloudStore = openCloudAuthorizationStore({
      dataDir: directory,
      organizationId: "organization-1",
      hostId: "host-1",
      trustedKeys: [key.trustedKey],
    });
    cloudStore.apply(signCloudAuthorizationSnapshot(cloudAuthorizationSnapshot({ expiresAt: 1_500 }), key), 1_000);
    let now = 1_100;
    const authorizer = createCompositeAuthorizer({ teamStore, cloudStore, now: () => now });
    expect(authorizer.authorize("device", "device-1", "sessions:read").allowed).toBe(true);
    expect(authorizer.authorize("device", "device-1", "sessions:operate")).toMatchObject({
      allowed: false,
      reason: "missing-permission",
      source: "team",
    });

    now = 1_500;
    expect(authorizer.authorize("device", "device-1", "sessions:read")).toMatchObject({
      allowed: false,
      reason: "cloud-authorization-expired",
      source: "cloud",
    });
    expect(authorizer.authorize("host", "host-recovery", "members:manage").allowed).toBe(true);
    teamStore.close();
  });

  test("keeps persisted managed ownership fail-closed when cloud configuration is unavailable", () => {
    const teamStore = openTeamStore(teamOptions());
    const { team } = teamStore.createTeam(
      {
        name: "Managed team",
        ownerName: "Owner",
        ownerPrincipal: { actorType: "host", actorId: "host-1" },
      },
      100,
    );
    const member = teamStore.createMember({ displayName: "Operator" }, 101);
    teamStore.bindPrincipal({ memberId: member.id, actorType: "device", actorId: "device-1" }, 102);
    teamStore.grantRole({ memberId: member.id, role: "operator" }, 103);
    teamStore.updateTeam({ authorizationEnabled: true }, teamStore.getTeam()!.revision, 104);

    const authorizer = createCompositeAuthorizer({ teamStore, requireCloud: true });
    expect(authorizer.authorize("device", "device-1", "sessions:read")).toMatchObject({
      allowed: false,
      reason: "cloud-authorization-unavailable",
      source: "cloud",
    });
    expect(authorizer.authorize("host", "host-1", "members:manage")).toMatchObject({
      allowed: true,
      reason: "local-break-glass",
      source: "local",
    });
    expect(team.id).toBe("team-1");
    teamStore.close();
  });
});
