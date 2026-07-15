import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ApiClient,
  AuditPage,
  AuditVerification,
  EnterprisePolicy,
  FleetInventory,
  TeamEnvelope,
} from "../api/client";
import { OrganizationControls } from "./OrganizationControls";

const policy: EnterprisePolicy = {
  enforcementEnabled: false,
  allowedHostIds: null,
  allowedWorkspaceIds: null,
  allowedProviderIds: null,
  allowDangerousProviderModes: false,
  allowFileTransfer: true,
  extensionMode: "allow-integrity",
  allowRelay: true,
  updateMode: "stable-only",
  revision: 4,
  createdAt: 1,
  updatedAt: 2,
};

const fleet: FleetInventory = {
  revision: 2,
  hosts: [
    {
      id: "host-1",
      label: "Studio host",
      version: "1.2.3",
      health: "healthy",
      activeSessions: 2,
      relayConfigured: true,
      dataDurable: true,
      policyPosture: { enforcementEnabled: false, revision: 4, compliant: true, violations: [] },
      adapters: [{ id: "claude", version: "2.1.0", enabled: true, source: "built-in", capabilities: { launch: true } }],
      updatedAt: 2,
    },
  ],
};

const hostTeam: TeamEnvelope = {
  team: null,
  currentMember: null,
  roles: [],
  permissions: [],
  authorization: { enabled: false, localBreakGlass: true },
};

const verification: AuditVerification = { valid: true, count: 1, head: "a".repeat(64) };
const audit: AuditPage = {
  records: [
    {
      id: 1,
      actorType: "host",
      actorId: "host-1",
      action: "PATCH /api/v1/policy",
      targetType: "policy",
      targetId: "enterprise",
      result: "success",
      metadata: { statusCode: 200 },
      createdAt: 2,
      previousHash: "0".repeat(64),
      hash: "a".repeat(64),
    },
  ],
  nextCursor: 1,
};

function apiMock(overrides: Partial<ApiClient> = {}): ApiClient {
  return {
    getEnterprisePolicy: vi.fn().mockResolvedValue(policy),
    updateEnterprisePolicy: vi.fn().mockResolvedValue({ ...policy, enforcementEnabled: true, revision: 5 }),
    getFleetInventory: vi.fn().mockResolvedValue(fleet),
    listPeers: vi.fn().mockResolvedValue([]),
    getTeam: vi.fn().mockResolvedValue(hostTeam),
    listWorkspaces: vi.fn().mockResolvedValue([
      {
        id: "workspace-1",
        label: "RoamCode",
        cwd: "/private/project",
        kind: "directory",
        sortOrder: 0,
        archived: false,
        createdAt: 1,
        updatedAt: 1,
      },
    ]),
    verifyAudit: vi.fn().mockResolvedValue(verification),
    listLatestAudit: vi.fn().mockResolvedValue(audit),
    exportAudit: vi.fn().mockResolvedValue('{"type":"manifest"}\n'),
    ...overrides,
  } as unknown as ApiClient;
}

describe("OrganizationControls", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("shows policy, fleet compliance, and verified audit posture without exposing workspace paths", async () => {
    render(<OrganizationControls api={apiMock()} />);

    expect(await screen.findByText("Studio host")).toBeVisible();
    expect(screen.getByText("1/1 compliant")).toBeVisible();
    expect(screen.getAllByText("Verified").length).toBeGreaterThan(0);
    expect(screen.getByText(/1 chained records/i)).toBeVisible();
    expect(screen.getByText("PATCH /api/v1/policy")).toBeVisible();
    expect(document.body).not.toHaveTextContent("/private/project");
  });

  it("requires an inline second step before enabling policy enforcement", async () => {
    const updateEnterprisePolicy = vi
      .fn()
      .mockResolvedValue({ ...policy, enforcementEnabled: true, revision: 5, updatedAt: 3 });
    render(<OrganizationControls api={apiMock({ updateEnterprisePolicy })} />);

    const enforcement = await screen.findByRole("checkbox", { name: /enforce organization policy/i });
    await userEvent.click(enforcement);
    await userEvent.click(screen.getByRole("button", { name: "Review policy change" }));

    expect(updateEnterprisePolicy).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(/remote clients and input leases are revoked immediately/i);
    await userEvent.click(screen.getByRole("button", { name: "Enable and apply" }));

    await waitFor(() =>
      expect(updateEnterprisePolicy).toHaveBeenCalledWith({
        enforcementEnabled: true,
        allowedHostIds: null,
        allowedWorkspaceIds: null,
        allowedProviderIds: null,
        allowDangerousProviderModes: false,
        allowFileTransfer: true,
        extensionMode: "allow-integrity",
        allowRelay: true,
        updateMode: "stable-only",
        expectedRevision: 4,
        confirm: true,
      }),
    );
    expect(await screen.findByText(/policy revision 5 is active/i)).toBeVisible();
  });

  it("keeps policy read-only and does not probe host-only audit data for a delegated viewer", async () => {
    const verifyAudit = vi.fn();
    const listLatestAudit = vi.fn();
    const api = apiMock({
      getTeam: vi.fn().mockResolvedValue({
        ...hostTeam,
        currentMember: {
          id: "viewer-1",
          displayName: "Viewer",
          kind: "person",
          status: "active",
          revision: 1,
          createdAt: 1,
          updatedAt: 1,
        },
        permissions: ["team:read"],
        authorization: { enabled: true, localBreakGlass: false },
      }),
      verifyAudit,
      listLatestAudit,
    });

    render(<OrganizationControls api={api} />);

    expect(await screen.findByText(/you can inspect this policy/i)).toBeVisible();
    expect(screen.getByRole("checkbox", { name: /enforce organization policy/i })).toBeDisabled();
    expect(screen.getByText(/use the current host recovery credential/i)).toBeVisible();
    expect(verifyAudit).not.toHaveBeenCalled();
    expect(listLatestAudit).not.toHaveBeenCalled();
  });

  it("downloads the bounded NDJSON export without placing credentials in a URL", async () => {
    const createObjectURL = vi.fn().mockReturnValue("blob:audit");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", { ...URL, createObjectURL, revokeObjectURL });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const exportAudit = vi.fn().mockResolvedValue('{"type":"manifest"}\n');
    render(<OrganizationControls api={apiMock({ exportAudit })} />);

    await userEvent.click(await screen.findByRole("button", { name: /export ndjson/i }));

    await waitFor(() => expect(exportAudit).toHaveBeenCalledWith(0, 1000));
    expect(createObjectURL).toHaveBeenCalled();
    expect(click).toHaveBeenCalled();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:audit");
  });
});
