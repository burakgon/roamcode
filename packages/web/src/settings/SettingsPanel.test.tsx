import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SettingsPanel } from "./SettingsPanel";
import type { ModelInfo, SessionMeta } from "../types/server";
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
    // Read-only branch (no onApplyLiveSettings) shows the effort as text; "high" also appears as a
    // default-effort option now that both selects are lowercase, so assert at least one occurrence.
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

  it("changing ONLY the model sends model but OMITS permissionMode/effort (no silent downgrade)", async () => {
    // The bug: always sending permissionMode (seeded to "default") would reset an acceptEdits/plan
    // session to default when the user only edited the model. Untouched controls must be omitted.
    const onApply = vi.fn();
    render(
      <SettingsPanel
        session={session}
        defaults={defaults}
        models={models}
        onSaveDefaults={vi.fn()}
        onApplyLiveSettings={onApply}
        onClose={vi.fn()}
      />,
    );
    // The model is a dropdown of the account's models (ModelSelect); pick a different one.
    await userEvent.selectOptions(screen.getByLabelText(/active session model/i), "sonnet");
    await userEvent.click(screen.getByRole("button", { name: /apply to session/i }));
    expect(onApply).toHaveBeenCalledTimes(1);
    const sent = onApply.mock.calls[0]![0] as Record<string, unknown>;
    expect(sent).toEqual({ model: "sonnet" });
    expect(sent).not.toHaveProperty("permissionMode");
    expect(sent).not.toHaveProperty("effort");
  });

  it("sends only the CHANGED controls: changing effort+permission omits the untouched model", async () => {
    const onApply = vi.fn();
    render(
      <SettingsPanel
        session={session}
        defaults={defaults}
        onSaveDefaults={vi.fn()}
        onApplyLiveSettings={onApply}
        onClose={vi.fn()}
      />,
    );
    await userEvent.selectOptions(screen.getByLabelText(/active session effort/i), "max");
    await userEvent.selectOptions(screen.getByLabelText(/active session permission mode/i), "plan");
    await userEvent.click(screen.getByRole("button", { name: /apply to session/i }));
    expect(onApply).toHaveBeenCalledTimes(1);
    const sent = onApply.mock.calls[0]![0] as Record<string, unknown>;
    expect(sent).toEqual({ effort: "max", permissionMode: "plan" });
    expect(sent).not.toHaveProperty("model");
  });

  it("disables Apply when nothing changed (no pointless empty-update frame)", () => {
    const onApply = vi.fn();
    render(
      <SettingsPanel
        session={session}
        defaults={defaults}
        onSaveDefaults={vi.fn()}
        onApplyLiveSettings={onApply}
        onClose={vi.fn()}
      />,
    );
    // With no edits, every control still matches the frozen baseline → Apply is disabled, so an empty
    // {} update (and any no-op respawn it could cause) can never be sent.
    expect(screen.getByRole("button", { name: /apply to session/i })).toBeDisabled();
    expect(onApply).not.toHaveBeenCalled();
  });

  it("reflects the active session's model/effort into the editable controls", () => {
    render(
      <SettingsPanel
        session={session}
        defaults={defaults}
        onSaveDefaults={vi.fn()}
        onApplyLiveSettings={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByLabelText(/active session model/i)).toHaveValue("opus");
    expect(screen.getByLabelText(/active session effort/i)).toHaveValue("high");
  });

  it("without onApplyLiveSettings the active session block stays read-only (no apply button)", () => {
    render(<SettingsPanel session={session} defaults={defaults} onSaveDefaults={vi.fn()} onClose={vi.fn()} />);
    expect(screen.queryByRole("button", { name: /apply to session/i })).toBeNull();
    // Read-only branch still shows the fixed model/effort. ("high" also appears as a default-effort
    // option now that both selects are lowercase, so assert at least one occurrence.)
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
});
