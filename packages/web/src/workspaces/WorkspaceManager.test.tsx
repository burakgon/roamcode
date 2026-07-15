import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../api/client";
import type { WorkspaceRecord } from "../types/server";
import { WorkspaceManager } from "./WorkspaceManager";

const workspaces: WorkspaceRecord[] = [
  { id: "w1", label: "Storefront", cwd: "/work/store", kind: "directory", sortOrder: 0, createdAt: 1, updatedAt: 1 },
  { id: "w2", label: "API", cwd: "/work/api", kind: "worktree", sortOrder: 1, createdAt: 2, updatedAt: 2 },
];

function setup() {
  const api = {
    renameCommandHost: vi.fn().mockResolvedValue({ id: "h1", label: "Build host", createdAt: 1, updatedAt: 2 }),
    createWorkspace: vi.fn().mockResolvedValue(workspaces[0]),
    createWorktree: vi.fn().mockResolvedValue({ workspace: workspaces[1], worktree: {}, created: true }),
    openWorktree: vi.fn().mockResolvedValue({ workspace: workspaces[1], worktree: {} }),
    getWorktreeStatus: vi.fn().mockResolvedValue({
      workspace: workspaces[1],
      worktree: {
        path: "/work/api",
        repositoryPath: "/work/repo",
        branch: "feature/api",
        head: "abc",
        dirty: true,
        changedFiles: 2,
        isMain: false,
      },
    }),
    removeWorktree: vi.fn().mockResolvedValue({ workspace: { ...workspaces[1], archivedAt: 3 }, worktree: {} }),
    updateWorkspace: vi
      .fn()
      .mockImplementation((id: string, update: Partial<WorkspaceRecord>) =>
        Promise.resolve({ ...workspaces.find((workspace) => workspace.id === id)!, ...update }),
      ),
    listDir: vi.fn().mockResolvedValue({ path: "/work", entries: [] }),
    mkdir: vi.fn(),
    searchDirs: vi.fn().mockResolvedValue([]),
  } as unknown as ApiClient;
  const props: React.ComponentProps<typeof WorkspaceManager> = {
    open: true,
    host: { id: "h1", label: "Studio", createdAt: 1, updatedAt: 1 },
    workspaces,
    api,
    onHostChanged: vi.fn(),
    onWorkspacesChanged: vi.fn(),
    onStartSession: vi.fn(),
    onClose: vi.fn(),
  };
  return { api, props, ...render(<WorkspaceManager {...props} />) };
}

afterEach(() => vi.restoreAllMocks());

describe("WorkspaceManager", () => {
  it("renames the privacy-light host and a workspace", async () => {
    const { api, props } = setup();
    const host = screen.getByRole("textbox", { name: "Host name" });
    await userEvent.clear(host);
    await userEvent.type(host, "Build host");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.renameCommandHost).toHaveBeenCalledWith("Build host"));
    expect(props.onHostChanged).toHaveBeenCalledWith(expect.objectContaining({ label: "Build host" }));

    const workspace = screen.getByRole("textbox", { name: "Name for Storefront" });
    await userEvent.clear(workspace);
    await userEvent.type(workspace, "Web app");
    await userEvent.click(screen.getByRole("button", { name: "Save Storefront" }));
    await waitFor(() => expect(api.updateWorkspace).toHaveBeenCalledWith("w1", { label: "Web app" }));
  });

  it("reorders, starts, and safely archives workspaces", async () => {
    const { api, props } = setup();
    await userEvent.click(screen.getByRole("button", { name: "Move Storefront down" }));
    await waitFor(() => expect(api.updateWorkspace).toHaveBeenCalledWith("w1", { sortOrder: 1 }));
    expect(api.updateWorkspace).toHaveBeenCalledWith("w2", { sortOrder: 0 });

    await userEvent.click(screen.getAllByRole("button", { name: /new session/i })[0]!);
    expect(props.onStartSession).toHaveBeenCalledWith("/work/store");

    await userEvent.click(screen.getAllByRole("button", { name: /archive/i })[0]!);
    expect(api.updateWorkspace).not.toHaveBeenCalledWith("w1", { archived: true });
    await userEvent.click(screen.getByRole("button", { name: "Archive workspace" }));
    await waitFor(() => expect(api.updateWorkspace).toHaveBeenCalledWith("w1", { archived: true }));
  });

  it("adds an existing directory or worktree through the confined directory picker", async () => {
    const { api } = setup();
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Add as" }), "worktree");
    await userEvent.click(screen.getByRole("button", { name: "Add workspace" }));
    expect(await screen.findByRole("dialog", { name: "Pick a directory" })).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Use this directory" }));
    await waitFor(() => expect(api.openWorktree).toHaveBeenCalledWith("/work"));
  });

  it("creates a guarded worktree and explicitly confirms dirty removal", async () => {
    const { api } = setup();
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Add as" }), "new-worktree");
    await userEvent.type(screen.getByLabelText("Repository path"), "/work/repo");
    await userEvent.type(screen.getByLabelText("New worktree path"), "/work/feature");
    await userEvent.type(screen.getByLabelText("Branch (optional)"), "feature/api");
    await userEvent.click(screen.getByRole("button", { name: "Create guarded worktree" }));
    await waitFor(() =>
      expect(api.createWorktree).toHaveBeenCalledWith({
        repositoryPath: "/work/repo",
        path: "/work/feature",
        branch: "feature/api",
      }),
    );

    await userEvent.click(screen.getByRole("button", { name: "Remove worktree" }));
    expect(await screen.findByText(/2 uncommitted file.*permanently discards/i)).toBeVisible();
    expect(api.removeWorktree).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Remove worktree now" }));
    await waitFor(() => expect(api.removeWorktree).toHaveBeenCalledWith("w2", true));
  });
});
