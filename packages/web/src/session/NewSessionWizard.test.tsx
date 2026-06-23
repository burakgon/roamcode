import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NewSessionWizard } from "./NewSessionWizard";
import { loadRecentDirs } from "../picker/recents";
import type { CreateSessionBody } from "../api/client";
import type { DirListing, SessionMeta } from "../types/server";

afterEach(() => localStorage.clear());

const listing: DirListing = {
  path: "/home/u",
  entries: [{ name: "proj", path: "/home/u/proj", isDirectory: true, isGitRepo: true, gitBranch: "main" }],
};

const created: SessionMeta = { id: "new-1", cwd: "/home/u", dangerouslySkip: false, status: "running", createdAt: 1 };

function makeCreate() {
  return vi.fn<(body: CreateSessionBody) => Promise<SessionMeta>>(() => Promise.resolve(created));
}

describe("NewSessionWizard", () => {
  it("picks a directory then creates a session with the chosen settings", async () => {
    const createSession = makeCreate();
    const onCreated = vi.fn();
    render(
      <NewSessionWizard
        api={{ listDir: () => Promise.resolve(listing), createSession }}
        recents={[]}
        onCreated={onCreated}
        onClose={vi.fn()}
      />,
    );
    // Step 1: confirm the current directory.
    await waitFor(() => screen.getByRole("button", { name: /use this directory/i }));
    await userEvent.click(screen.getByRole("button", { name: /use this directory/i }));
    // Step 2: settings → start.
    await waitFor(() => screen.getByRole("button", { name: /start session/i }));
    await userEvent.click(screen.getByRole("button", { name: /start session/i }));
    await waitFor(() => expect(createSession).toHaveBeenCalled());
    expect(createSession.mock.calls[0]![0]).toMatchObject({ cwd: "/home/u" });
    expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ id: "new-1" }));
    // The chosen cwd is remembered for next time.
    expect(loadRecentDirs()).toEqual(["/home/u"]);
  });

  it("passes the dangerously-skip flag and effort when chosen", async () => {
    const createSession = makeCreate();
    render(
      <NewSessionWizard
        api={{ listDir: () => Promise.resolve(listing), createSession }}
        recents={[]}
        onCreated={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    await waitFor(() => screen.getByRole("button", { name: /use this directory/i }));
    await userEvent.click(screen.getByRole("button", { name: /use this directory/i }));
    await waitFor(() => screen.getByRole("button", { name: /start session/i }));
    await userEvent.selectOptions(screen.getByLabelText(/effort/i), "high");
    await userEvent.click(screen.getByLabelText(/dangerously skip/i));
    await userEvent.click(screen.getByRole("button", { name: /start session/i }));
    await waitFor(() => expect(createSession).toHaveBeenCalled());
    expect(createSession.mock.calls[0]![0]).toMatchObject({
      cwd: "/home/u",
      effort: "high",
      dangerouslySkip: true,
    });
  });

  it("lets the user go back to change the directory", async () => {
    render(
      <NewSessionWizard
        api={{ listDir: () => Promise.resolve(listing), createSession: makeCreate() }}
        recents={[]}
        onCreated={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    await waitFor(() => screen.getByRole("button", { name: /use this directory/i }));
    await userEvent.click(screen.getByRole("button", { name: /use this directory/i }));
    await waitFor(() => screen.getByRole("button", { name: /change directory/i }));
    await userEvent.click(screen.getByRole("button", { name: /change directory/i }));
    // Back on the picker.
    expect(await screen.findByRole("button", { name: /use this directory/i })).toBeInTheDocument();
  });

  /** Drive the wizard to its settings step (step 2) and return the supplied onClose spy. */
  async function reachSettingsStep(onClose = vi.fn()) {
    render(
      <NewSessionWizard
        api={{ listDir: () => Promise.resolve(listing), createSession: makeCreate() }}
        recents={[]}
        onCreated={vi.fn()}
        onClose={onClose}
      />,
    );
    await waitFor(() => screen.getByRole("button", { name: /use this directory/i }));
    await userEvent.click(screen.getByRole("button", { name: /use this directory/i }));
    await waitFor(() => screen.getByRole("button", { name: /start session/i }));
    return onClose;
  }

  it("closes the settings step on the Escape key", async () => {
    const onClose = await reachSettingsStep();
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
  });

  it("focuses the first control of the settings step on entry", async () => {
    await reachSettingsStep();
    // The first focusable in the step is the "Change" directory button.
    expect(screen.getByRole("button", { name: /change directory/i })).toHaveFocus();
  });

  it("closes when the backdrop scrim is clicked", async () => {
    const onClose = await reachSettingsStep();
    // Click the dialog root (the scrim) itself, not its inner content.
    await userEvent.click(screen.getByRole("dialog"));
    expect(onClose).toHaveBeenCalled();
  });

  it("does not close when a click originates inside the content", async () => {
    const onClose = await reachSettingsStep();
    // Clicking the heading inside the surface must not bubble into a dismiss.
    await userEvent.click(screen.getByText(/start a session/i));
    expect(onClose).not.toHaveBeenCalled();
  });
});
