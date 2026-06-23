import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SettingsPanel } from "./SettingsPanel";
import type { SessionMeta } from "../types/server";
import type { SessionDefaults } from "./defaults";

const session: SessionMeta = { id: "s1", cwd: "/p", model: "opus", effort: "high", dangerouslySkip: false, status: "running", createdAt: 1 };
const defaults: SessionDefaults = { effort: "medium", dangerouslySkip: false };

describe("SettingsPanel", () => {
  it("shows the active session's fixed settings read-only", () => {
    render(<SettingsPanel session={session} defaults={defaults} onSaveDefaults={vi.fn()} onStopSession={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText("opus")).toBeInTheDocument();
    expect(screen.getByText("high")).toBeInTheDocument();
  });

  it("stops the session after a confirm", async () => {
    const onStop = vi.fn();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<SettingsPanel session={session} defaults={defaults} onSaveDefaults={vi.fn()} onStopSession={onStop} onClose={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: /stop session/i }));
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

  it("confirms before enabling dangerously-skip in defaults", async () => {
    const onSave = vi.fn();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<SettingsPanel session={undefined} defaults={defaults} onSaveDefaults={onSave} onClose={vi.fn()} />);
    await userEvent.click(screen.getByLabelText(/dangerously skip permissions/i));
    expect(window.confirm).toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it("is a trapping modal: aria-modal, focus moves in, and Tab cycles within the dialog", async () => {
    render(<SettingsPanel session={session} defaults={defaults} onSaveDefaults={vi.fn()} onStopSession={vi.fn()} onClose={vi.fn()} />);
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

  it("no longer renders the dead permission-mode control", () => {
    render(<SettingsPanel session={undefined} defaults={defaults} onSaveDefaults={vi.fn()} onClose={vi.fn()} />);
    expect(screen.queryByLabelText(/permission mode/i)).not.toBeInTheDocument();
  });

  it("when onApplyLiveSettings is provided, changing the active session's model sends a live update", async () => {
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
    const modelInput = screen.getByLabelText(/active session model/i);
    await userEvent.clear(modelInput);
    await userEvent.type(modelInput, "claude-opus-4-8");
    await userEvent.click(screen.getByRole("button", { name: /apply to session/i }));
    expect(onApply).toHaveBeenCalledWith(expect.objectContaining({ model: "claude-opus-4-8" }));
  });

  it("sends the selected effort and permission mode in the live update", async () => {
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
    expect(onApply).toHaveBeenCalledWith(expect.objectContaining({ effort: "max", permissionMode: "plan" }));
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
    // Read-only branch still shows the fixed model/effort.
    expect(screen.getByText("opus")).toBeInTheDocument();
    expect(screen.getByText("high")).toBeInTheDocument();
  });
});
