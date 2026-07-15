import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ApiClient, PeerRecord } from "../api/client";
import { PeerConnections } from "./PeerConnections";

const peer: PeerRecord = {
  id: "peer-1",
  label: "Build host",
  remoteHostId: "host-build",
  remoteVersion: "1.2.3",
  actions: ["read", "wait"],
  allowedWorkspaceIds: [],
  status: "active",
  revision: 1,
  createdAt: Date.now(),
  updatedAt: Date.now(),
  lastVerifiedAt: Date.now(),
};

function apiMock(overrides: Partial<ApiClient> = {}): ApiClient {
  return {
    listPeers: vi.fn().mockResolvedValue([]),
    createPeer: vi.fn().mockResolvedValue(peer),
    discoverPeerWorkspaces: vi.fn().mockResolvedValue({
      peer: { ...peer, revision: 2 },
      workspaces: [{ id: "workspace-1", label: "Project workspace", kind: "directory", archived: false }],
    }),
    updatePeer: vi.fn().mockResolvedValue({
      ...peer,
      revision: 3,
      allowedWorkspaceIds: ["workspace-1"],
    }),
    verifyPeer: vi.fn().mockResolvedValue({ ...peer, revision: 2 }),
    rotatePeerCredential: vi.fn().mockResolvedValue({ ...peer, revision: 2 }),
    removePeer: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as ApiClient;
}

describe("PeerConnections", () => {
  it("uses a reviewed, workspace-denied setup before enabling explicit scope", async () => {
    const pairingUrl = `https://build.example/#pair=rcp_${"s".repeat(43)}`;
    const createPeer = vi.fn().mockResolvedValue(peer);
    const discoverPeerWorkspaces = vi.fn().mockResolvedValue({
      peer: { ...peer, revision: 2 },
      workspaces: [{ id: "workspace-1", label: "Project workspace", kind: "directory", archived: false }],
    });
    const updatePeer = vi.fn().mockResolvedValue({
      ...peer,
      revision: 3,
      allowedWorkspaceIds: ["workspace-1"],
    });
    const api = apiMock({ createPeer, discoverPeerWorkspaces, updatePeer });
    const user = userEvent.setup();
    render(<PeerConnections api={api} canManage />);

    expect(await screen.findByText(/no peer hosts connected/i)).toBeVisible();
    await user.click(screen.getByRole("button", { name: /connect/i }));
    await user.type(screen.getByLabelText("Label"), "Build host");
    await user.type(screen.getByLabelText(/one-use pairing link/i), pairingUrl);
    await user.click(screen.getByRole("button", { name: /review connection/i }));

    expect(createPeer).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(/no workspace access/i);
    await user.click(screen.getByRole("button", { name: /connect and verify/i }));

    await waitFor(() =>
      expect(createPeer).toHaveBeenCalledWith({
        label: "Build host",
        pairingUrl,
        actions: ["read", "wait"],
      }),
    );
    await waitFor(() => expect(discoverPeerWorkspaces).toHaveBeenCalledWith("peer-1", 1));
    expect(document.body).not.toHaveTextContent(pairingUrl);

    const workspace = await screen.findByRole("checkbox", { name: /project workspace/i });
    expect(workspace).not.toBeChecked();
    await user.click(workspace);
    await user.click(screen.getByRole("button", { name: /apply peer scope/i }));
    await waitFor(() =>
      expect(updatePeer).toHaveBeenCalledWith("peer-1", {
        expectedRevision: 2,
        actions: ["read", "wait"],
        allowedWorkspaceIds: ["workspace-1"],
      }),
    );
  });

  it("requires an inline second step for access replacement and removal", async () => {
    const replacementPairingUrl = `https://build.example/#pair=rcp_${"r".repeat(43)}`;
    const rotatePeerCredential = vi.fn().mockResolvedValue({ ...peer, revision: 2 });
    const removePeer = vi.fn().mockResolvedValue(undefined);
    const api = apiMock({
      listPeers: vi.fn().mockResolvedValue([peer]),
      rotatePeerCredential,
      removePeer,
    });
    const user = userEvent.setup();
    render(<PeerConnections api={api} canManage />);

    expect(await screen.findByText("Build host")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Access" }));
    await user.type(screen.getByLabelText("Replacement pairing link"), replacementPairingUrl);
    await user.click(screen.getByRole("button", { name: /review replacement/i }));
    expect(rotatePeerCredential).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: /verify and replace/i }));
    await waitFor(() =>
      expect(rotatePeerCredential).toHaveBeenCalledWith("peer-1", { pairingUrl: replacementPairingUrl }, 1),
    );
    expect(document.body).not.toHaveTextContent(replacementPairingUrl);

    await user.click(screen.getByRole("button", { name: "Remove" }));
    expect(removePeer).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(/deletes the stored credential/i);
    await user.click(screen.getByRole("button", { name: /remove peer/i }));
    await waitFor(() => expect(removePeer).toHaveBeenCalledWith("peer-1"));
    expect(screen.queryByText("Build host")).not.toBeInTheDocument();
  });

  it("keeps peer controls read-only without policy management permission", async () => {
    render(<PeerConnections api={apiMock({ listPeers: vi.fn().mockResolvedValue([peer]) })} canManage={false} />);

    expect(await screen.findByText("Build host")).toBeVisible();
    expect(screen.getByText(/peer inventory is read-only/i)).toBeVisible();
    expect(screen.queryByRole("button", { name: /connect/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Access" })).not.toBeInTheDocument();
  });
});
