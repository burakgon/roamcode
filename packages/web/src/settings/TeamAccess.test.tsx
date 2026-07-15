import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiClient, TeamEnvelope, TeamMember, TeamRoleBinding } from "../api/client";
import { TeamAccess } from "./TeamAccess";

const team = {
  id: "team-1",
  name: "Engineering",
  authorizationEnabled: false,
  revision: 3,
  createdAt: 1,
  updatedAt: 2,
};

const owner: TeamMember = {
  id: "member-owner",
  displayName: "Owner",
  kind: "person",
  status: "active",
  revision: 1,
  createdAt: 1,
  updatedAt: 1,
};

const reviewer: TeamMember = {
  id: "member-reviewer",
  displayName: "Reviewer",
  kind: "person",
  status: "active",
  revision: 2,
  createdAt: 1,
  updatedAt: 2,
};

const viewerRole: TeamRoleBinding = {
  id: "role-viewer",
  memberId: reviewer.id,
  role: "viewer",
  scopeType: "team",
  createdAt: 1,
};

function teamEnvelope(overrides: Partial<TeamEnvelope> = {}): TeamEnvelope {
  return {
    team,
    currentMember: owner,
    roles: [],
    permissions: ["members:manage", "policy:manage"],
    authorization: { enabled: false, localBreakGlass: false },
    ...overrides,
  };
}

function apiMock(overrides: Partial<ApiClient> = {}): ApiClient {
  return {
    getTeam: vi.fn().mockResolvedValue(teamEnvelope()),
    createTeam: vi.fn().mockResolvedValue(teamEnvelope()),
    updateTeam: vi.fn().mockResolvedValue(team),
    listTeamMembers: vi.fn().mockResolvedValue([
      { ...owner, roles: [] },
      { ...reviewer, roles: [viewerRole] },
    ]),
    createTeamMember: vi.fn().mockResolvedValue({ ...reviewer, roles: [viewerRole] }),
    updateTeamMember: vi.fn().mockResolvedValue(reviewer),
    grantTeamRole: vi.fn().mockResolvedValue(viewerRole),
    revokeTeamRole: vi.fn().mockResolvedValue(undefined),
    listDevices: vi.fn().mockResolvedValue({
      devices: [{ id: "device-1", name: "Laptop", createdAt: 1, lastSeenAt: 2 }],
      currentDeviceId: "device-1",
    }),
    listTeamPrincipalBindings: vi.fn().mockResolvedValue([]),
    bindTeamPrincipal: vi.fn().mockResolvedValue(undefined),
    unbindTeamPrincipal: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as ApiClient;
}

describe("TeamAccess", () => {
  afterEach(() => vi.restoreAllMocks());

  it("keeps accountless self-hosting primary and creates a team only on request", async () => {
    const createTeam = vi.fn().mockResolvedValue(teamEnvelope());
    const api = apiMock({
      getTeam: vi.fn().mockResolvedValue(
        teamEnvelope({
          team: null,
          currentMember: null,
          permissions: [],
          authorization: { enabled: false, localBreakGlass: true },
        }),
      ),
      createTeam,
    });

    render(<TeamAccess api={api} />);

    expect(await screen.findByText(/works fully without an account/i)).toBeVisible();
    const name = screen.getByLabelText("Team name");
    await userEvent.clear(name);
    await userEvent.type(name, "Platform");
    await userEvent.click(screen.getByRole("button", { name: "Create team workspace" }));

    await waitFor(() => expect(createTeam).toHaveBeenCalledWith("Platform"));
  });

  it("shows staged roles and requires confirmation before server-side enforcement", async () => {
    const updateTeam = vi.fn().mockResolvedValue({ ...team, authorizationEnabled: true, revision: 4 });
    const api = apiMock({ updateTeam });

    render(<TeamAccess api={api} />);

    expect(await screen.findByText(/roles are staged, not enforced/i)).toBeVisible();
    expect(screen.getByText("1 unassigned")).toBeVisible();
    await userEvent.click(screen.getByRole("checkbox", { name: /enforce roles on every connection/i }));

    expect(updateTeam).not.toHaveBeenCalled();
    expect(screen.getByText(/paired device.*lose access/i)).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Enable role enforcement" }));
    await waitFor(() =>
      expect(updateTeam).toHaveBeenCalledWith({
        authorizationEnabled: true,
        expectedRevision: 3,
        confirm: true,
      }),
    );
  });

  it("binds a paired device to a member identity before enforcement", async () => {
    const bindTeamPrincipal = vi.fn().mockResolvedValue(undefined);
    const api = apiMock({ bindTeamPrincipal });

    render(<TeamAccess api={api} />);

    const assignment = await screen.findByLabelText("Member for Laptop");
    await userEvent.selectOptions(assignment, reviewer.id);

    await waitFor(() =>
      expect(bindTeamPrincipal).toHaveBeenCalledWith({
        memberId: reviewer.id,
        actorType: "device",
        actorId: "device-1",
      }),
    );
  });

  it("guards member suspension and role removal with contextual inline confirmation", async () => {
    const updateTeamMember = vi.fn().mockResolvedValue({ ...reviewer, status: "suspended", revision: 3 });
    const revokeTeamRole = vi.fn().mockResolvedValue(undefined);
    const api = apiMock({ updateTeamMember, revokeTeamRole });

    render(<TeamAccess api={api} />);
    await userEvent.click(await screen.findByRole("button", { name: "Suspend" }));
    expect(updateTeamMember).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Suspend Reviewer" }));
    await waitFor(() =>
      expect(updateTeamMember).toHaveBeenCalledWith(reviewer.id, {
        status: "suspended",
        expectedRevision: reviewer.revision,
      }),
    );

    await userEvent.click(screen.getByRole("button", { name: "Remove Viewer from Reviewer" }));
    expect(revokeTeamRole).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Remove role" }));
    await waitFor(() => expect(revokeTeamRole).toHaveBeenCalledWith(viewerRole.id));
  });

  it("keeps membership and device inventory hidden from a read-only member", async () => {
    const listDevices = vi.fn();
    const listTeamPrincipalBindings = vi.fn();
    const api = apiMock({
      getTeam: vi.fn().mockResolvedValue(
        teamEnvelope({
          currentMember: reviewer,
          permissions: ["team:read", "sessions:read"],
        }),
      ),
      listDevices,
      listTeamPrincipalBindings,
    });

    render(<TeamAccess api={api} />);

    expect(await screen.findByText("Reviewer")).toBeVisible();
    expect(screen.queryByText("Device assignments")).not.toBeInTheDocument();
    expect(screen.queryByText("Add a member")).not.toBeInTheDocument();
    expect(listDevices).not.toHaveBeenCalled();
    expect(listTeamPrincipalBindings).not.toHaveBeenCalled();
  });
});
