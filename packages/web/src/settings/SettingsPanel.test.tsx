import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SettingsPanel } from "./SettingsPanel";
import type { ModelInfo, SessionMeta, UsageInfo } from "../types/server";
import type { SessionDefaults } from "./defaults";

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

  it("confirms before enabling dangerously-skip in defaults", async () => {
    const onSave = vi.fn();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<SettingsPanel session={undefined} defaults={defaults} onSaveDefaults={onSave} onClose={vi.fn()} />);
    await userEvent.click(screen.getByLabelText(/dangerously skip permissions/i));
    expect(window.confirm).toHaveBeenCalled();
    vi.restoreAllMocks();
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

  it("saves a default permission mode for new sessions", async () => {
    const onSave = vi.fn();
    render(<SettingsPanel session={undefined} defaults={defaults} onSaveDefaults={onSave} onClose={vi.fn()} />);
    await userEvent.selectOptions(screen.getByLabelText(/default permission mode/i), "plan");
    await userEvent.click(screen.getByRole("button", { name: /save defaults/i }));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ permissionMode: "plan" }));
  });

  it("starts a fresh session in this folder with the chosen settings (never a mid-session change)", async () => {
    // A running claude's model/permission are fixed at spawn, so the block spawns a NEW session in the
    // same cwd with the chosen options rather than faking a live change.
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
    // Seeded from the running session; tweak the model, then start.
    await userEvent.selectOptions(screen.getByLabelText(/new session model/i), "sonnet");
    await userEvent.click(screen.getByRole("button", { name: /new session in this folder with these settings/i }));
    expect(onNewSessionHere).toHaveBeenCalledTimes(1);
    expect(onNewSessionHere).toHaveBeenCalledWith({
      cwd: "/p",
      model: "sonnet",
      effort: "high",
      permissionMode: "default",
      dangerouslySkip: false,
    });
  });

  it("seeds the new-session controls from the running session's settings", () => {
    render(
      <SettingsPanel
        session={session}
        defaults={defaults}
        models={models}
        onSaveDefaults={vi.fn()}
        onNewSessionHere={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByLabelText(/new session model/i)).toHaveValue("opus");
    expect(screen.getByLabelText(/new session effort/i)).toHaveValue("high");
  });

  it("keeps the dangerously-skip toggle visible and easy to enable for the new session", async () => {
    // CRITICAL: the danger toggle must never be hidden/buried. Confirm it's present and, on enable,
    // gated by a confirm rather than removed.
    vi.spyOn(window, "confirm").mockReturnValue(true);
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
    const danger = screen.getByLabelText(/new session dangerously skip permissions/i);
    expect(danger).toBeInTheDocument();
    await userEvent.click(danger);
    expect(window.confirm).toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: /new session in this folder with these settings/i }));
    expect(onNewSessionHere).toHaveBeenCalledWith(expect.objectContaining({ dangerouslySkip: true }));
    vi.restoreAllMocks();
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
});
