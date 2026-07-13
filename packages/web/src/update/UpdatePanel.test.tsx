import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { UpdatePanel } from "./UpdatePanel";
import { createApiClient } from "../api/client";
import type { ChangelogEntry, VersionInfo } from "../types/server";

function info(changelog: ChangelogEntry[] = []): VersionInfo {
  return {
    current: "v1.0.0",
    latest: "v1.1.0",
    behind: changelog.length || 2,
    releaseCount: changelog.length || 2,
    updatable: true,
    updateAvailable: true,
    updateAction: "update",
    installation: "managed",
    changelog,
    runningVersion: "1.0.0",
    activeVersion: "1.0.0",
    installDrift: false,
    checkStatus: "fresh",
    runningBuild: "1.0.0",
    buildDrift: false,
  };
}

const sampleChangelog: ChangelogEntry[] = [
  { id: "1.1.0:0", version: "1.1.0", subject: "update banner", group: "new", when: "2h", date: "2026-06-25T10:00:00Z" },
  {
    id: "1.1.0:1",
    version: "1.1.0",
    subject: "fix offline fetch",
    group: "fixes",
    when: "1d",
    date: "2026-06-24T10:00:00Z",
  },
  {
    id: "1.1.0:2",
    version: "1.1.0",
    subject: "memoize reducer",
    group: "improvements",
    when: "2d",
    date: "2026-06-23T10:00:00Z",
  },
];

describe("UpdatePanel", () => {
  it("shows current → new version and the grouped changelog (New / Fixes / Improvements)", () => {
    render(<UpdatePanel info={info(sampleChangelog)} state="idle" onUpdate={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText("v1.0.0")).toBeInTheDocument();
    expect(screen.getByText("v1.1.0")).toBeInTheDocument();
    expect(screen.getByText("New")).toBeInTheDocument();
    expect(screen.getByText("Fixes")).toBeInTheDocument();
    expect(screen.getByText("Improvements")).toBeInTheDocument();
    expect(screen.getByText("update banner")).toBeInTheDocument();
    expect(screen.getByText("fix offline fetch")).toBeInTheDocument();
    // relative dates surfaced
    expect(screen.getByText("2h")).toBeInTheDocument();
  });

  it("explains the verified release activation + restart + interrupted turns", () => {
    render(<UpdatePanel info={info(sampleChangelog)} state="idle" onUpdate={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByRole("dialog")).toHaveTextContent(/verifies and activates.*restarts the server/i);
    expect(screen.getByRole("dialog")).toHaveTextContent(/interrupted and resume/i);
  });

  it("Update now confirms, Later dismisses", async () => {
    const onUpdate = vi.fn();
    const onClose = vi.fn();
    render(<UpdatePanel info={info(sampleChangelog)} state="idle" onUpdate={onUpdate} onClose={onClose} />);
    await userEvent.click(screen.getByRole("button", { name: /update now/i }));
    await userEvent.click(screen.getByRole("button", { name: /later/i }));
    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("the updating state shows a live progress phase and no Update/Later buttons", () => {
    render(
      <UpdatePanel
        info={info(sampleChangelog)}
        state="updating"
        status={{ state: "verifying", phase: "boot smoke" }}
        onUpdate={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent(/verifying/i);
    expect(screen.getByText(/reconnects automatically/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /update now/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /later/i })).not.toBeInTheDocument();
  });

  it("keeps the changelog visible WHILE updating (pressing Update doesn't hide what's being installed)", () => {
    render(
      <UpdatePanel
        info={info(sampleChangelog)}
        state="updating"
        status={{ state: "verifying", phase: "boot smoke" }}
        onUpdate={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    // The progress is shown AND the changelog stays below it (grouped entries + a contextual heading).
    expect(screen.getByRole("status")).toHaveTextContent(/verifying/i);
    expect(screen.getByText("update banner")).toBeInTheDocument();
    expect(screen.getByText("fix offline fetch")).toBeInTheDocument();
    expect(screen.getByText(/what's new in/i)).toBeInTheDocument();
  });

  it("the failed state shows the error + a Retry button", async () => {
    const onUpdate = vi.fn();
    render(
      <UpdatePanel
        info={info(sampleChangelog)}
        state="failed"
        status={{ state: "failed", error: "pnpm -r build failed", log: "some build log" }}
        onUpdate={onUpdate}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText(/pnpm -r build failed/)).toBeInTheDocument();
    expect(screen.getByText("some build log")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(onUpdate).toHaveBeenCalledTimes(1);
  });

  it("Escape closes the panel when not updating", async () => {
    const onClose = vi.fn();
    render(<UpdatePanel info={info(sampleChangelog)} state="idle" onUpdate={vi.fn()} onClose={onClose} />);
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
  });

  it("with NO turn in flight, Update now applies immediately (no drain warning)", async () => {
    const onUpdate = vi.fn();
    render(
      <UpdatePanel
        info={info(sampleChangelog)}
        state="idle"
        onUpdate={onUpdate}
        onClose={vi.fn()}
        turnInProgress={false}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /update now/i }));
    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("OTA drain warning: with a turn in flight, the first tap WARNS (no update); a second confirms", async () => {
    const onUpdate = vi.fn();
    render(
      <UpdatePanel info={info(sampleChangelog)} state="idle" onUpdate={onUpdate} onClose={vi.fn()} turnInProgress />,
    );
    // First tap of "Update now": it does NOT apply — it surfaces the warning and re-labels the button.
    await userEvent.click(screen.getByRole("button", { name: /update now/i }));
    expect(onUpdate).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(/turn is in progress.*interrupt it.*update anyway/i);
    // Second tap ("Update anyway") confirms.
    await userEvent.click(screen.getByRole("button", { name: /update anyway/i }));
    expect(onUpdate).toHaveBeenCalledTimes(1);
  });

  it("IDLE panel offers a quiet 'Roll back to previous version'; hidden while updating", () => {
    const { unmount } = render(
      <UpdatePanel
        info={info(sampleChangelog)}
        state="idle"
        onUpdate={vi.fn()}
        onRollback={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: /roll back to previous version/i })).toBeInTheDocument();
    unmount();
    // Mid-update there's nothing settled to roll back to → no affordance.
    render(
      <UpdatePanel
        info={info(sampleChangelog)}
        state="updating"
        status={{ state: "verifying" }}
        onUpdate={vi.fn()}
        onRollback={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button", { name: /roll back to previous version/i })).not.toBeInTheDocument();
  });

  it("rollback is TWO-step: arm inline (no window.confirm), then 'Yes, roll back' fires the POST", async () => {
    // Wire onRollback the way App does — through the api client — with fetch mocked, so this asserts the
    // REAL request shape (POST /update/rollback {confirm:true}), not just a callback.
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const api = createApiClient({ baseUrl: "http://127.0.0.1:4280", getToken: () => "tok" });
      render(
        <UpdatePanel
          info={info(sampleChangelog)}
          state="idle"
          onUpdate={vi.fn()}
          onRollback={() => void api.rollbackUpdate()}
          onClose={vi.fn()}
        />,
      );
      // First tap only ARMS: the inline confirm appears, nothing is POSTed yet.
      await userEvent.click(screen.getByRole("button", { name: /roll back to previous version/i }));
      expect(fetchMock).not.toHaveBeenCalled();
      expect(screen.getByRole("alert")).toHaveTextContent(/previous verified version.*roll back\?/i);
      // Cancel disarms without firing…
      await userEvent.click(screen.getByRole("button", { name: /cancel rollback/i }));
      expect(fetchMock).not.toHaveBeenCalled();
      // …and the full arm → confirm path fires exactly one POST /update/rollback {confirm:true}.
      await userEvent.click(screen.getByRole("button", { name: /roll back to previous version/i }));
      await userEvent.click(screen.getByRole("button", { name: /yes, roll back/i }));
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
      expect(url).toBe("http://127.0.0.1:4280/update/rollback");
      expect(init.method).toBe("POST");
      expect(JSON.parse(init.body as string)).toEqual({ confirm: true });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
