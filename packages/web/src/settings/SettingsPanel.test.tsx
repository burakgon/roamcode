import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SettingsPanel } from "./SettingsPanel";
import type { ModelInfo, SessionMeta, UsageInfo } from "../types/server";
import type { SessionDefaults } from "./defaults";
import type { ApiClient } from "../api/client";

// Account models from GET /models — passed so the model control is the real dropdown (ModelSelect falls
// back to a free-text input when this is empty).
const models: ModelInfo[] = [
  { value: "opus", displayName: "Opus" },
  { value: "sonnet", displayName: "Sonnet" },
  { value: "haiku", displayName: "Haiku" },
];

const session: SessionMeta = {
  id: "s1",
  cwd: "/p",
  model: "opus",
  effort: "high",
  dangerouslySkip: false,
  status: "running",
  createdAt: 1,
};
const defaults: SessionDefaults = { effort: "medium", dangerouslySkip: false };

describe("SettingsPanel", () => {
  it("shows the active session's fixed settings read-only", () => {
    render(
      <SettingsPanel
        session={session}
        defaults={defaults}
        onSaveDefaults={vi.fn()}
        onStopSession={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText("opus")).toBeInTheDocument();
    // The read-only summary shows the effort as text; "high" also appears as a default-effort option,
    // so assert at least one occurrence.
    expect(screen.getAllByText("high").length).toBeGreaterThan(0);
  });

  it("stops the session after a confirm", async () => {
    const onStop = vi.fn();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(
      <SettingsPanel
        session={session}
        defaults={defaults}
        onSaveDefaults={vi.fn()}
        onStopSession={onStop}
        onClose={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /close session/i }));
    expect(onStop).toHaveBeenCalledWith("s1");
    vi.restoreAllMocks();
  });

  it("saves edited defaults", async () => {
    const onSave = vi.fn();
    render(<SettingsPanel session={undefined} defaults={defaults} onSaveDefaults={onSave} onClose={vi.fn()} />);
    await userEvent.selectOptions(screen.getByLabelText(/default effort/i), "high");
    await userEvent.click(screen.getByRole("button", { name: /save defaults/i }));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ effort: "high" }));
  });

  it("shows an inline 'Saved' confirmation after saving (the panel stays open)", async () => {
    const onSave = vi.fn();
    const onClose = vi.fn();
    render(<SettingsPanel session={undefined} defaults={defaults} onSaveDefaults={onSave} onClose={onClose} />);
    await userEvent.click(screen.getByRole("button", { name: /save defaults/i }));
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Saved")).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("gates enabling dangerously-skip behind an INLINE confirm (no window.confirm — iOS suppresses it)", async () => {
    const onSave = vi.fn();
    render(<SettingsPanel session={undefined} defaults={defaults} onSaveDefaults={onSave} onClose={vi.fn()} />);
    const box = screen.getByLabelText(/dangerously skip permissions/i);
    // First tap does NOT flip the value — it arms the inline confirm row instead.
    await userEvent.click(box);
    expect(box).not.toBeChecked();
    expect(screen.getByRole("alert")).toHaveTextContent(/remote code execution/i);
    // Confirming enables it; saving then persists it.
    await userEvent.click(screen.getByRole("button", { name: /yes, enable dangerously skip/i }));
    expect(box).toBeChecked();
    await userEvent.click(screen.getByRole("button", { name: /save defaults/i }));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ dangerouslySkip: true }));
  });

  it("cancelling the inline danger confirm leaves the toggle off", async () => {
    render(<SettingsPanel session={undefined} defaults={defaults} onSaveDefaults={vi.fn()} onClose={vi.fn()} />);
    const box = screen.getByLabelText(/dangerously skip permissions/i);
    await userEvent.click(box);
    await userEvent.click(screen.getByRole("button", { name: /cancel enabling/i }));
    expect(box).not.toBeChecked();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("is a trapping modal: aria-modal, focus moves in, and Tab cycles within the dialog", async () => {
    render(
      <SettingsPanel
        session={session}
        defaults={defaults}
        onSaveDefaults={vi.fn()}
        onStopSession={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    // On mount focus is pulled into the dialog (first focusable element).
    expect(dialog.contains(document.activeElement)).toBe(true);
    // Tab repeatedly and assert focus never escapes the dialog.
    for (let i = 0; i < 12; i++) {
      await userEvent.tab();
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
    // Shift+Tab also stays inside.
    await userEvent.tab({ shift: true });
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it("closes on Escape", async () => {
    const onClose = vi.fn();
    render(<SettingsPanel session={undefined} defaults={defaults} onSaveDefaults={vi.fn()} onClose={onClose} />);
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
  });

  it("changes session order immediately from Appearance", async () => {
    const onSessionOrderChange = vi.fn();
    render(
      <SettingsPanel
        session={undefined}
        defaults={defaults}
        sessionOrder="activity"
        onSessionOrderChange={onSessionOrderChange}
        onSaveDefaults={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByLabelText(/session order/i)).toHaveValue("activity");
    await userEvent.selectOptions(screen.getByLabelText(/session order/i), "created");
    expect(onSessionOrderChange).toHaveBeenCalledWith("created");
    expect(screen.getByText(/need you.*always stay on top/i)).toBeVisible();
  });

  it("saves a default permission mode for new sessions", async () => {
    const onSave = vi.fn();
    render(<SettingsPanel session={undefined} defaults={defaults} onSaveDefaults={onSave} onClose={vi.fn()} />);
    await userEvent.selectOptions(screen.getByLabelText(/default permission mode/i), "plan");
    await userEvent.click(screen.getByRole("button", { name: /save defaults/i }));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ permissionMode: "plan" }));
  });

  it("starts a fresh session in this folder passing ONLY the cwd (the wizard seeds from saved defaults)", async () => {
    // The per-launch model/effort/danger controls that used to live here silently overrode the user's SAVED
    // defaults in the wizard ("my settings aren't remembered") — so the block is now just the button.
    const onNewSessionHere = vi.fn();
    render(
      <SettingsPanel
        session={session}
        defaults={defaults}
        models={models}
        onSaveDefaults={vi.fn()}
        onNewSessionHere={onNewSessionHere}
        onClose={vi.fn()}
      />,
    );
    // No duplicated per-launch controls remain — one place (the wizard) chooses new-session settings.
    expect(screen.queryByLabelText(/new session model/i)).toBeNull();
    expect(screen.queryByLabelText(/new session effort/i)).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /new session in this folder/i }));
    expect(onNewSessionHere).toHaveBeenCalledTimes(1);
    expect(onNewSessionHere).toHaveBeenCalledWith({ cwd: "/p" });
  });

  it("keeps the dangerously-skip toggle VISIBLE in the defaults section", () => {
    // CRITICAL (user requirement): the danger toggle must never be hidden/buried — present and enabled,
    // gated only by the inline confirm.
    render(<SettingsPanel session={session} defaults={defaults} onSaveDefaults={vi.fn()} onClose={vi.fn()} />);
    const danger = screen.getByLabelText(/dangerously skip permissions/i);
    expect(danger).toBeInTheDocument();
    expect(danger).toBeEnabled();
  });

  it("without onNewSessionHere the active session block stays read-only (no new-session action)", () => {
    render(<SettingsPanel session={session} defaults={defaults} onSaveDefaults={vi.fn()} onClose={vi.fn()} />);
    expect(screen.queryByRole("button", { name: /new session in this folder/i })).toBeNull();
    // Read-only summary still shows the fixed model/effort. ("high" also appears as a default-effort
    // option, so assert at least one occurrence.)
    expect(screen.getByText("opus")).toBeInTheDocument();
    expect(screen.getAllByText("high").length).toBeGreaterThan(0);
  });

  it("shows an opt-in button when push is unsubscribed and fires onEnablePush", async () => {
    const onEnablePush = vi.fn();
    render(
      <SettingsPanel
        session={session}
        defaults={defaults}
        onSaveDefaults={vi.fn()}
        onStopSession={vi.fn()}
        onClose={vi.fn()}
        pushState="unsubscribed"
        onEnablePush={onEnablePush}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Enable notifications" }));
    expect(onEnablePush).toHaveBeenCalledTimes(1);
  });

  it("shows a disable control when already subscribed", () => {
    render(
      <SettingsPanel
        session={session}
        defaults={defaults}
        onSaveDefaults={vi.fn()}
        onStopSession={vi.fn()}
        onClose={vi.fn()}
        pushState="subscribed"
        onDisablePush={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "Disable notifications" })).toBeInTheDocument();
  });

  it("warns when a usage bar is near its limit and renders the Sonnet-only weekly bar", () => {
    const usage: UsageInfo = {
      session: { percent: 95, resets: "Jul 2 at 11:30pm (Europe/Istanbul)" },
      week: { percent: 40, resets: "Jul 5 at 10pm (Europe/Istanbul)" },
      // weekSonnet is fetched by the app but the rail's UsageBars never shows it — the panel does.
      weekSonnet: { percent: 60, resets: "Jul 5 at 10pm (Europe/Istanbul)" },
      fetchedAt: 0,
    };
    render(
      <SettingsPanel
        session={undefined}
        defaults={defaults}
        usage={usage}
        onSaveDefaults={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent(/near a claude usage limit/i);
    expect(screen.getByText(/weekly · sonnet/i)).toBeInTheDocument();
  });

  it("hides the usage readout (and its warning) when usage is null", () => {
    render(
      <SettingsPanel session={undefined} defaults={defaults} usage={null} onSaveDefaults={vi.fn()} onClose={vi.fn()} />,
    );
    expect(screen.queryByText(/near a claude usage limit/i)).toBeNull();
    expect(screen.queryByText(/weekly · sonnet/i)).toBeNull();
  });

  it("embeds independent Claude Code and Codex account cards", async () => {
    const api = {
      getUsage: vi.fn().mockResolvedValue(null),
      getAuthStatus: vi.fn().mockResolvedValue({ available: true, loggedIn: false }),
      getProviderAuthStatus: vi.fn().mockResolvedValue({ available: true, authenticated: false }),
      getProviderUsage: vi.fn().mockResolvedValue(null),
      getProviderVersion: vi.fn().mockResolvedValue({ installed: null, latest: null }),
    } as unknown as ApiClient;
    render(
      <SettingsPanel
        session={undefined}
        defaults={defaults}
        api={api}
        usage={null}
        onSaveDefaults={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(await screen.findByRole("region", { name: /claude code account/i })).toBeVisible();
    expect(screen.getByRole("region", { name: /codex account/i })).toBeVisible();
    expect(screen.queryByRole("button", { name: /claude sign-in \/ re-authenticate/i })).not.toBeInTheDocument();
  });

  it("reuses the supplied Claude usage in its account card without duplicate fetch or display", async () => {
    const usage: UsageInfo = {
      session: { percent: 95, resets: "in 1h" },
      week: { percent: 20, resets: "in 2d" },
      fetchedAt: 1,
    };
    const getProviderUsage = vi.fn().mockResolvedValue(null);
    const api = {
      getAuthStatus: vi.fn().mockResolvedValue({ available: true, loggedIn: true }),
      getProviderAuthStatus: vi.fn().mockResolvedValue({ available: true, authenticated: false }),
      getProviderUsage,
      getProviderVersion: vi.fn().mockResolvedValue({ installed: null, latest: null }),
    } as unknown as ApiClient;
    render(
      <SettingsPanel
        session={undefined}
        defaults={defaults}
        api={api}
        usage={usage}
        onSaveDefaults={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(await screen.findByLabelText("Claude usage limits")).toBeVisible();
    expect(screen.getAllByRole("progressbar", { name: /session \(5h\) limit 95% used/i })).toHaveLength(1);
    expect(screen.getByRole("status")).toHaveTextContent(/near a claude usage limit/i);
    await waitFor(() => expect(getProviderUsage).toHaveBeenCalled());
    expect(getProviderUsage).not.toHaveBeenCalledWith("claude");
    expect(getProviderUsage).toHaveBeenCalledWith("codex");
  });
});
