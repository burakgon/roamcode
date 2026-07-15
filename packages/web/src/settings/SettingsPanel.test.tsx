import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SettingsPanel } from "./SettingsPanel";
import type { SessionMeta, UsageInfo } from "../types/server";
import type { ApiClient } from "../api/client";

const session: SessionMeta = {
  id: "s1",
  cwd: "/p",
  model: "opus",
  effort: "high",
  permissionMode: "plan",
  dangerouslySkip: false,
  status: "running",
  createdAt: 1,
};

describe("SettingsPanel", () => {
  it("has an explicit Done action that closes the full-screen mobile panel", async () => {
    const onClose = vi.fn();
    render(<SettingsPanel onClose={onClose} />);

    const close = screen.getByRole("button", { name: "Close settings" });
    expect(close).toHaveTextContent("Done");
    await userEvent.click(close);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("keeps navigation task-based and removes the retired New sessions settings", () => {
    render(
      <SettingsPanel
        session={session}
        pushState="unsubscribed"
        onEnablePush={vi.fn()}
        onSignOut={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    const navigation = screen.getByRole("navigation", { name: /settings categories/i });
    expect(navigation).toHaveTextContent("Current session");
    expect(navigation).toHaveTextContent("Appearance");
    expect(navigation).toHaveTextContent("This device");
    expect(navigation).toHaveTextContent("Notifications");
    expect(navigation).not.toHaveTextContent("New sessions");
    expect(screen.queryByText(/default models, reasoning and permissions/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /save defaults/i })).not.toBeInTheDocument();
  });

  it("shows the active session's fixed launch choices read-only", () => {
    render(<SettingsPanel session={session} onClose={vi.fn()} />);
    expect(screen.getByText("opus")).toBeInTheDocument();
    expect(screen.getByText("high")).toBeInTheDocument();
    expect(screen.getByText("plan")).toBeInTheDocument();
  });

  it("stops the session after a confirm", async () => {
    const onStop = vi.fn();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<SettingsPanel session={session} onStopSession={onStop} onClose={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: /close session/i }));
    expect(onStop).toHaveBeenCalledWith("s1");
  });

  it("starts a fresh session in this folder carrying only the cwd", async () => {
    const onNewSessionHere = vi.fn();
    render(<SettingsPanel session={session} onNewSessionHere={onNewSessionHere} onClose={vi.fn()} />);

    expect(screen.queryByLabelText(/new session model/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/new session effort/i)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /new session in this folder/i }));
    expect(onNewSessionHere).toHaveBeenCalledWith({ cwd: "/p" });
  });

  it("without onNewSessionHere the active session block stays read-only", () => {
    render(<SettingsPanel session={session} onClose={vi.fn()} />);
    expect(screen.queryByRole("button", { name: /new session in this folder/i })).not.toBeInTheDocument();
    expect(screen.getByText("opus")).toBeInTheDocument();
  });

  it("is a trapping modal and closes on Escape", async () => {
    const onClose = vi.fn();
    render(<SettingsPanel session={session} onStopSession={vi.fn()} onClose={onClose} />);
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog.contains(document.activeElement)).toBe(true);
    for (let index = 0; index < 8; index += 1) {
      await userEvent.tab();
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
  });

  it("changes session order immediately from Appearance", async () => {
    const onSessionOrderChange = vi.fn();
    render(<SettingsPanel sessionOrder="activity" onSessionOrderChange={onSessionOrderChange} onClose={vi.fn()} />);
    expect(screen.getByLabelText(/session order/i)).toHaveValue("activity");
    await userEvent.selectOptions(screen.getByLabelText(/session order/i), "created");
    expect(onSessionOrderChange).toHaveBeenCalledWith("created");
  });

  it("renders notification opt-in and disable states", async () => {
    const onEnablePush = vi.fn();
    const view = render(<SettingsPanel pushState="unsubscribed" onEnablePush={onEnablePush} onClose={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Enable notifications" }));
    expect(onEnablePush).toHaveBeenCalledOnce();

    view.rerender(<SettingsPanel pushState="subscribed" onDisablePush={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Disable notifications" })).toBeInTheDocument();
  });

  it("warns near a Claude usage limit and renders provider-named weekly bars", () => {
    const usage: UsageInfo = {
      session: { percent: 95, resets: "in 1h" },
      week: { percent: 40, resets: "in 2d" },
      weekModels: [{ model: "Fable", percent: 60, resets: "in 2d" }],
      fetchedAt: 0,
    };
    render(<SettingsPanel usage={usage} onClose={vi.fn()} />);
    expect(screen.getByRole("status")).toHaveTextContent(/near a claude usage limit/i);
    expect(screen.getByText(/weekly · fable/i)).toBeInTheDocument();
  });

  it("hides usage when explicitly supplied null", () => {
    render(<SettingsPanel usage={null} onClose={vi.fn()} />);
    expect(screen.queryByText(/near a claude usage limit/i)).not.toBeInTheDocument();
  });

  it("embeds independent Claude Code and Codex account cards", async () => {
    const api = {
      getUsage: vi.fn().mockResolvedValue(null),
      getAuthStatus: vi.fn().mockResolvedValue({ available: true, loggedIn: false }),
      getProviderAuthStatus: vi.fn().mockResolvedValue({ available: true, authenticated: false }),
      getProviderUsage: vi.fn().mockResolvedValue(null),
      getProviderVersion: vi.fn().mockResolvedValue({ installed: null, latest: null }),
    } as unknown as ApiClient;
    render(<SettingsPanel api={api} usage={null} onClose={vi.fn()} />);

    expect(await screen.findByRole("region", { name: /claude code account/i })).toBeVisible();
    expect(screen.getByRole("region", { name: /codex account/i })).toBeVisible();
  });

  it("reuses supplied Claude usage in the account card without duplicate display", async () => {
    const usage: UsageInfo = { session: { percent: 95, resets: "in 1h" }, fetchedAt: 1 };
    const getProviderUsage = vi.fn().mockResolvedValue(null);
    const api = {
      getAuthStatus: vi.fn().mockResolvedValue({ available: true, loggedIn: true }),
      getProviderAuthStatus: vi.fn().mockResolvedValue({ available: true, authenticated: false }),
      getProviderUsage,
      getProviderVersion: vi.fn().mockResolvedValue({ installed: null, latest: null }),
    } as unknown as ApiClient;
    render(<SettingsPanel api={api} usage={usage} onClose={vi.fn()} />);

    expect(await screen.findByLabelText("Claude usage limits")).toBeVisible();
    expect(screen.getAllByRole("progressbar", { name: /session \(5h\) limit 95% used/i })).toHaveLength(1);
    await waitFor(() => expect(getProviderUsage).toHaveBeenCalledWith("codex"));
    expect(getProviderUsage).not.toHaveBeenCalledWith("claude");
  });

  it("marks the selected navigation item when clicked", async () => {
    Element.prototype.scrollIntoView = vi.fn();
    render(<SettingsPanel session={session} onClose={vi.fn()} />);
    const navigation = screen.getByRole("navigation", { name: /settings categories/i });
    const appearance = within(navigation).getByRole("button", { name: "Appearance" });
    await userEvent.click(appearance);
    expect(appearance).toHaveAttribute("aria-current", "page");
  });
});
