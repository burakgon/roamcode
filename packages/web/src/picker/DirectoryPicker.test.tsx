import { useState } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DirectoryPicker } from "./DirectoryPicker";
import { ApiError } from "../api/client";
import type { DirListing } from "../types/server";

const home: DirListing = {
  path: "/home/u",
  parent: "/home",
  entries: [
    { name: "roamcode", path: "/home/u/roamcode", isDirectory: true, isGitRepo: true, gitBranch: "main" },
    { name: "notes", path: "/home/u/notes", isDirectory: true, isGitRepo: false },
  ],
};
const repo: DirListing = { path: "/home/u/roamcode", parent: "/home/u", entries: [] };

function listDir(path?: string): Promise<DirListing> {
  if (path === "/home/u/roamcode") return Promise.resolve(repo);
  return Promise.resolve(home);
}

describe("DirectoryPicker", () => {
  // Favorites + the branch cache live in localStorage — start each test from a clean slate.
  beforeEach(() => localStorage.clear());

  it("uses a visible subfolder directly via its per-row Use button (without entering it)", async () => {
    const onPick = vi.fn();
    render(<DirectoryPicker listDir={listDir} recents={[]} onPick={onPick} onCancel={vi.fn()} />);
    await waitFor(() => screen.getByText("roamcode"));
    await userEvent.click(screen.getByRole("button", { name: /use roamcode/i }));
    // Picked straight away — no navigation into the folder.
    expect(onPick).toHaveBeenCalledWith("/home/u/roamcode");
  });

  it("pins a folder to Favorites (shown first) and unpins it", async () => {
    render(<DirectoryPicker listDir={listDir} recents={[]} onPick={vi.fn()} onCancel={vi.fn()} />);
    await waitFor(() => screen.getByText("roamcode"));
    expect(screen.queryByText("Favorites")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /pin roamcode/i }));
    // A Favorites section appears with the pinned path.
    expect(screen.getByText("Favorites")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Use /home/u/roamcode" })).toBeInTheDocument();
    // Unpinning removes the section again.
    await userEvent.click(screen.getByRole("button", { name: "Unpin /home/u/roamcode" }));
    expect(screen.queryByText("Favorites")).toBeNull();
  });

  it("lists entries, badges git repos with a branch, and filters fuzzily", async () => {
    render(<DirectoryPicker listDir={listDir} recents={[]} onPick={vi.fn()} onCancel={vi.fn()} />);
    await waitFor(() => expect(screen.getByText("roamcode")).toBeInTheDocument());
    expect(screen.getByText(/git:main/i)).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText(/filter directories/i), "notes");
    await waitFor(() => expect(screen.queryByText("roamcode")).not.toBeInTheDocument());
    expect(screen.getByText("notes")).toBeInTheDocument();
  });

  it("shows the current path as a breadcrumb", async () => {
    render(<DirectoryPicker listDir={listDir} recents={[]} onPick={vi.fn()} onCancel={vi.fn()} />);
    await waitFor(() => expect(screen.getByText("roamcode")).toBeInTheDocument());
    // The breadcrumb renders the segments of the current path.
    expect(screen.getByLabelText(/current path/i)).toHaveTextContent("home");
    expect(screen.getByLabelText(/current path/i)).toHaveTextContent("u");
  });

  it("navigates into a directory and picks the confirmed path", async () => {
    const onPick = vi.fn();
    render(<DirectoryPicker listDir={listDir} recents={[]} onPick={onPick} onCancel={vi.fn()} />);
    await waitFor(() => screen.getByText("roamcode"));
    await userEvent.click(screen.getByText("roamcode"));
    await waitFor(() => expect(screen.getByLabelText(/current path/i)).toHaveTextContent("roamcode"));
    await userEvent.click(screen.getByRole("button", { name: /use this directory/i }));
    expect(onPick).toHaveBeenCalledWith("/home/u/roamcode");
  });

  it("shows recents and picks one directly", async () => {
    const onPick = vi.fn();
    render(<DirectoryPicker listDir={listDir} recents={["/home/u/pinned-proj"]} onPick={onPick} onCancel={vi.fn()} />);
    await userEvent.click(screen.getByText("/home/u/pinned-proj"));
    expect(onPick).toHaveBeenCalledWith("/home/u/pinned-proj");
  });

  it("surfaces an error without crashing when listing fails", async () => {
    const failing = vi.fn(() => Promise.reject(new Error("forbidden path")));
    render(<DirectoryPicker listDir={failing} recents={[]} onPick={vi.fn()} onCancel={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/forbidden path/i));
    // The sheet is still mounted and dismissible.
    expect(screen.getByRole("button", { name: /cancel/i })).toBeInTheDocument();
  });

  it("can be cancelled", async () => {
    const onCancel = vi.fn();
    render(<DirectoryPicker listDir={listDir} recents={[]} onPick={vi.fn()} onCancel={onCancel} />);
    await waitFor(() => screen.getByText("roamcode"));
    await userEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(onCancel).toHaveBeenCalled();
  });

  it("dismisses on the Escape key", async () => {
    const onCancel = vi.fn();
    render(<DirectoryPicker listDir={listDir} recents={[]} onPick={vi.fn()} onCancel={onCancel} />);
    await waitFor(() => screen.getByText("roamcode"));
    await userEvent.keyboard("{Escape}");
    expect(onCancel).toHaveBeenCalled();
  });

  it("traps Tab within the sheet — wrapping from the last focusable back to the first", async () => {
    render(<DirectoryPicker listDir={listDir} recents={[]} onPick={vi.fn()} onCancel={vi.fn()} />);
    await waitFor(() => screen.getByText("roamcode"));
    // Park focus on the last focusable (the primary action) and Tab forward → wrap to first.
    const primary = screen.getByRole("button", { name: /use this directory/i });
    primary.focus();
    expect(primary).toHaveFocus();
    await userEvent.tab();
    // Focus must remain inside the dialog (it wrapped), not escape to <body>.
    const dialog = screen.getByRole("dialog");
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(document.body);
    // Shift+Tab off the first focusable wraps back to the last (the primary action).
    const cancel = screen.getByRole("button", { name: /^cancel$/i });
    cancel.focus();
    await userEvent.tab({ shift: true });
    expect(primary).toHaveFocus();
  });

  it("creates a folder inline (New folder → name → Create) and ENTERS it", async () => {
    const mkdir = vi.fn((path: string) => Promise.resolve({ path }));
    const created: DirListing = { path: "/home/u/new-proj", parent: "/home/u", entries: [] };
    const list = (path?: string) => (path === "/home/u/new-proj" ? Promise.resolve(created) : listDir(path));
    render(<DirectoryPicker listDir={list} mkdir={mkdir} recents={[]} onPick={vi.fn()} onCancel={vi.fn()} />);
    await waitFor(() => screen.getByText("roamcode"));
    await userEvent.click(screen.getByRole("button", { name: /new folder/i }));
    await userEvent.type(screen.getByLabelText("New folder name"), "new-proj");
    await userEvent.click(screen.getByRole("button", { name: "Create folder" }));
    // mkdir got the JOINED path (current dir + name), and the picker refreshed INTO the new folder —
    // ready for "Use this directory" without another tap.
    expect(mkdir).toHaveBeenCalledWith("/home/u/new-proj");
    await waitFor(() => expect(screen.getByLabelText(/current path/i)).toHaveTextContent("new-proj"));
  });

  it("shows an inline 'already exists' when mkdir 409s (no navigation, sheet stays put)", async () => {
    const mkdir = vi.fn(() => Promise.reject(new ApiError(409, "directory exists")));
    render(<DirectoryPicker listDir={listDir} mkdir={mkdir} recents={[]} onPick={vi.fn()} onCancel={vi.fn()} />);
    await waitFor(() => screen.getByText("roamcode"));
    await userEvent.click(screen.getByRole("button", { name: /new folder/i }));
    await userEvent.type(screen.getByLabelText("New folder name"), "notes");
    await userEvent.click(screen.getByRole("button", { name: "Create folder" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("already exists"));
    // Still in the original directory (the failed create never navigates).
    expect(screen.getByLabelText(/current path/i)).toHaveTextContent("u");
  });

  it("hides the New folder affordance when no mkdir capability is passed", async () => {
    render(<DirectoryPicker listDir={listDir} recents={[]} onPick={vi.fn()} onCancel={vi.fn()} />);
    await waitFor(() => screen.getByText("roamcode"));
    expect(screen.queryByRole("button", { name: /new folder/i })).not.toBeInTheDocument();
  });

  it("with ≥3 filter chars, surfaces debounced 'Deeper matches' (path tail + git badge, Use picks)", async () => {
    const searchDirs = vi.fn(() =>
      Promise.resolve([
        { path: "/home/u/deep/nested/web-app", name: "web-app", isGitRepo: true },
        { path: "/home/u/other/webby", name: "webby", isGitRepo: false },
      ]),
    );
    const onPick = vi.fn();
    render(
      <DirectoryPicker listDir={listDir} searchDirs={searchDirs} recents={[]} onPick={onPick} onCancel={vi.fn()} />,
    );
    await waitFor(() => screen.getByText("roamcode"));
    // Two chars: below the threshold — no deep section, no request.
    await userEvent.type(screen.getByLabelText(/filter directories/i), "we");
    expect(screen.queryByText("Deeper matches")).not.toBeInTheDocument();
    await userEvent.type(screen.getByLabelText(/filter directories/i), "b");
    // The section appears with the query; the (debounced ~300ms) server call lands shortly after.
    expect(await screen.findByText("Deeper matches")).toBeInTheDocument();
    await waitFor(() => expect(searchDirs).toHaveBeenCalledWith("web", "/home/u"));
    // Only ONE call despite three keystrokes — the debounce collapsed them.
    expect(searchDirs).toHaveBeenCalledTimes(1);
    // Rows read as the path TAIL under the current dir; a repo hit carries the git badge.
    expect(await screen.findByText("deep/nested/web-app")).toBeInTheDocument();
    expect(screen.getByText("other/webby")).toBeInTheDocument();
    expect(screen.getByText("git")).toBeInTheDocument();
    // "Use" picks the deep hit directly.
    await userEvent.click(screen.getByRole("button", { name: "Use web-app" }));
    expect(onPick).toHaveBeenCalledWith("/home/u/deep/nested/web-app");
  });

  it("restores focus to the trigger after it closes", async () => {
    // A trigger that opens the picker and tears it down on cancel.
    function Host() {
      const [open, setOpen] = useState(false);
      return (
        <div>
          <button type="button" onClick={() => setOpen(true)}>
            open picker
          </button>
          {open && <DirectoryPicker listDir={listDir} recents={[]} onPick={vi.fn()} onCancel={() => setOpen(false)} />}
        </div>
      );
    }
    render(<Host />);
    const trigger = screen.getByRole("button", { name: /open picker/i });
    await userEvent.click(trigger);
    await waitFor(() => screen.getByText("roamcode"));
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(trigger).toHaveFocus());
  });
});
