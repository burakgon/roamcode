import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SettingsPanel } from "./SettingsPanel";
import type { ModelInfo, SessionMeta, UsageInfo } from "../types/server";
import type { SessionDefaults } from "./defaults";
import type { ApiClient } from "../api/client";
import type { CodexModel } from "../providers/types";

// Account models from GET /models — passed so the model control is the real dropdown (ModelSelect falls
// back to a free-text input when this is empty).
const models: ModelInfo[] = [
  { value: "opus", displayName: "Opus", supportedEffortLevels: ["high", "xhigh"] },
  { value: "sonnet", displayName: "Sonnet", isDefault: true, supportedEffortLevels: ["low", "medium"] },
  { value: "haiku", displayName: "Haiku" },
];

const codexModels: CodexModel[] = [
  {
    value: "gpt-balanced",
    id: "gpt-balanced",
    displayName: "GPT Balanced",
    description: "Balanced model.",
    isDefault: true,
    supportedReasoningEfforts: ["low", "medium"],
    defaultReasoningEffort: "medium",
  },
  {
    value: "gpt-deep",
    id: "gpt-deep",
    displayName: "GPT Deep",
    description: "Deep model.",
    isDefault: false,
    supportedReasoningEfforts: ["high", "xhigh"],
    defaultReasoningEffort: "high",
  },
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

async function openClaudeDefaults() {
  const summary = screen.getByText("Claude Code");
  if (!summary.closest("details")?.hasAttribute("open")) await userEvent.click(summary);
}

describe("SettingsPanel", () => {
  it("has an explicit Done action that closes the full-screen mobile panel", async () => {
    const onClose = vi.fn();
    render(<SettingsPanel defaults={defaults} onSaveDefaults={vi.fn()} onClose={onClose} />);

    const close = screen.getByRole("button", { name: "Close settings" });
    expect(close).toHaveTextContent("Done");
    await userEvent.click(close);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("organizes settings into task-based navigation", async () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;

    render(
      <SettingsPanel
        session={session}
        defaults={defaults}
        pushState="unsubscribed"
        onEnablePush={vi.fn()}
        onSignOut={vi.fn()}
        onSaveDefaults={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    const navigation = screen.getByRole("navigation", { name: /settings categories/i });
    expect(navigation).toHaveTextContent("Current session");
    expect(navigation).toHaveTextContent("Appearance");
    expect(navigation).toHaveTextContent("New sessions");
    expect(navigation).toHaveTextContent("This device");
    expect(navigation).toHaveTextContent("Notifications");

    const newSessions = screen.getByRole("button", { name: "New sessions" });
    await userEvent.click(newSessions);
    expect(newSessions).toHaveAttribute("aria-current", "page");
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "start" });
  });

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
    await openClaudeDefaults();
    await userEvent.selectOptions(screen.getByLabelText(/default effort/i), "high");
    await userEvent.click(screen.getByRole("button", { name: /save defaults/i }));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ effort: "high" }));
  });

  it("keeps the panel open after invoking save", async () => {
    const onSave = vi.fn();
    const onClose = vi.fn();
    render(<SettingsPanel session={undefined} defaults={defaults} onSaveDefaults={onSave} onClose={onClose} />);
    await userEvent.click(screen.getByRole("button", { name: /save defaults/i }));
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("renders explicit saving and saved states from the App", () => {
    const view = render(
      <SettingsPanel
        session={undefined}
        defaults={defaults}
        defaultsSaveState="saving"
        onSaveDefaults={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: /saving defaults/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /saving defaults/i })).toHaveTextContent("Saving…");
    expect(screen.queryByText("Saved")).not.toBeInTheDocument();

    view.rerender(
      <SettingsPanel
        session={undefined}
        defaults={defaults}
        defaultsSaveState="saved"
        onSaveDefaults={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText("Saved")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /defaults saved/i })).toBeInTheDocument();
  });

  it("shows Saving while the save promise is pending and blocks duplicate submissions", async () => {
    let resolveSave!: () => void;
    const onSave = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveSave = resolve;
        }),
    );
    render(<SettingsPanel defaults={defaults} onSaveDefaults={onSave} onClose={vi.fn()} />);

    const save = screen.getByRole("button", { name: /save defaults/i });
    await userEvent.click(save);
    expect(save).toBeDisabled();
    expect(save).toHaveTextContent("Saving…");
    await userEvent.click(save);
    expect(onSave).toHaveBeenCalledTimes(1);

    resolveSave();
    await waitFor(() => expect(save).toBeEnabled());
    expect(save).toHaveTextContent("Save defaults");
  });

  it("keeps a newer draft dirty when an older submitted snapshot resolves", async () => {
    let resolveSave!: () => void;
    const onSave = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveSave = resolve;
        }),
    );
    const view = render(
      <SettingsPanel defaults={defaults} models={models} onSaveDefaults={onSave} onClose={vi.fn()} />,
    );
    await openClaudeDefaults();
    await userEvent.selectOptions(screen.getByLabelText(/default effort/i), "low");
    await userEvent.click(screen.getByRole("button", { name: /save defaults/i }));
    await userEvent.selectOptions(screen.getByLabelText(/default effort/i), "medium");

    view.rerender(
      <SettingsPanel
        defaults={{ effort: "low", dangerouslySkip: false }}
        defaultsSaveState="saved"
        models={models}
        onSaveDefaults={onSave}
        onClose={vi.fn()}
      />,
    );
    resolveSave();

    await waitFor(() => expect(screen.getByRole("button", { name: /save defaults/i })).toBeEnabled());
    expect(screen.getByLabelText(/default effort/i)).toHaveValue("medium");
    expect(screen.queryByText("Saved")).not.toBeInTheDocument();
  });

  it("unlocks after an actual rejected save promise without discarding the newer draft", async () => {
    let rejectSave!: (reason: Error) => void;
    const onSave = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectSave = reject;
        }),
    );
    render(<SettingsPanel defaults={defaults} models={models} onSaveDefaults={onSave} onClose={vi.fn()} />);
    await openClaudeDefaults();
    await userEvent.selectOptions(screen.getByLabelText(/default effort/i), "low");
    await userEvent.click(screen.getByRole("button", { name: /save defaults/i }));
    await userEvent.selectOptions(screen.getByLabelText(/default effort/i), "medium");

    rejectSave(new Error("offline"));

    await waitFor(() => expect(screen.getByRole("button", { name: /save defaults/i })).toBeEnabled());
    expect(screen.getByLabelText(/default effort/i)).toHaveValue("medium");
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it("clears a stale Saved confirmation as soon as the draft changes", async () => {
    render(
      <SettingsPanel
        defaults={defaults}
        defaultsSaveState="saved"
        onSaveDefaults={vi.fn()}
        onClose={vi.fn()}
        models={models}
      />,
    );
    expect(screen.getByText("Saved")).toBeInTheDocument();

    await openClaudeDefaults();
    await userEvent.selectOptions(screen.getByLabelText(/default effort/i), "low");

    expect(screen.queryByText("Saved")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /save defaults/i })).toHaveTextContent("Save defaults");
  });

  it("edits compact provider-labelled Claude and Codex defaults without persisting a provider choice", async () => {
    const onSave = vi.fn<(saved: SessionDefaults) => Promise<void>>().mockResolvedValue(undefined);
    render(
      <SettingsPanel
        defaults={defaults}
        models={models}
        codexModels={codexModels}
        codexProfiles={["work"]}
        onSaveDefaults={onSave}
        onClose={vi.fn()}
      />,
    );

    const claude = screen.getByText("Claude Code").closest("details");
    const codex = screen.getByText("Codex").closest("details");
    expect(claude).not.toHaveAttribute("open");
    expect(codex).not.toHaveAttribute("open");

    await openClaudeDefaults();
    await userEvent.selectOptions(screen.getByRole("combobox", { name: /^claude model$/i }), "opus");
    await waitFor(() => expect(screen.getByLabelText(/default effort/i)).toHaveValue("high"));
    await userEvent.click(screen.getByText("Claude Code"));

    await userEvent.click(screen.getByText("Codex"));
    await userEvent.selectOptions(screen.getByRole("combobox", { name: /^codex model$/i }), "gpt-deep");
    await waitFor(() => expect(screen.getByLabelText(/reasoning effort/i)).toHaveValue("high"));
    await userEvent.click(screen.getByRole("button", { name: /save defaults/i }));

    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "opus",
        effort: "high",
        codex: expect.objectContaining({ model: "gpt-deep", reasoningEffort: "high" }),
      }),
    );
    expect(onSave.mock.calls[0]?.[0]).not.toHaveProperty("provider");
  });

  it("keeps provider sections collapsible when an unsafe default is enabled", async () => {
    render(
      <SettingsPanel
        defaults={{
          effort: "medium",
          dangerouslySkip: true,
          codex: { dangerouslyBypassApprovalsAndSandbox: true },
        }}
        onSaveDefaults={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    const claude = screen.getByText("Claude Code").closest("details");
    const codex = screen.getByText("Codex").closest("details");
    expect(claude).not.toHaveAttribute("open");
    expect(codex).not.toHaveAttribute("open");
    expect(claude).toHaveTextContent("Unsafe mode on");
    expect(codex).toHaveTextContent("Unsafe mode on");

    await userEvent.click(screen.getByText("Claude Code"));
    expect(claude).toHaveAttribute("open");
    await userEvent.click(screen.getByText("Claude Code"));
    expect(claude).not.toHaveAttribute("open");
  });

  it("preserves an advertised future Claude effort through the settings save round-trip", async () => {
    const onSave = vi.fn<(saved: SessionDefaults) => Promise<void>>().mockResolvedValue(undefined);
    const futureModel: ModelInfo = {
      value: "claude-future",
      displayName: "Claude Future",
      supportedEffortLevels: ["medium", "future-depth_2"],
      isDefault: true,
    };
    render(
      <SettingsPanel
        defaults={{ effort: "future-depth_2", model: "claude-future", dangerouslySkip: false }}
        models={[futureModel]}
        onSaveDefaults={onSave}
        onClose={vi.fn()}
      />,
    );

    await openClaudeDefaults();
    expect(screen.getByLabelText(/default effort/i)).toHaveValue("future-depth_2");
    await userEvent.selectOptions(screen.getByLabelText(/default permission mode/i), "plan");
    await userEvent.click(screen.getByRole("button", { name: /save defaults/i }));

    expect(onSave).toHaveBeenCalledWith({
      effort: "future-depth_2",
      model: "claude-future",
      dangerouslySkip: false,
      permissionMode: "plan",
    });
  });

  it("keeps retryable local fallback status visible until defaults are synchronized", () => {
    const view = render(
      <SettingsPanel defaults={defaults} defaultsSyncState="loading" onSaveDefaults={vi.fn()} onClose={vi.fn()} />,
    );
    expect(screen.getByRole("status")).toHaveTextContent(/local fallback.*not yet saved to the server/i);

    view.rerender(
      <SettingsPanel defaults={defaults} defaultsSyncState="unsynced" onSaveDefaults={vi.fn()} onClose={vi.fn()} />,
    );
    expect(screen.getByRole("status")).toHaveTextContent(/couldn.t synchronize.*save defaults to retry/i);
  });

  it("reseeds a clean open draft when authoritative hydration arrives and saves that server value", async () => {
    const onSave = vi.fn(async () => {});
    const view = render(
      <SettingsPanel
        defaults={{ effort: "low", dangerouslySkip: false }}
        defaultsSyncState="loading"
        defaultsSaveState="idle"
        models={models}
        onSaveDefaults={onSave}
        onClose={vi.fn()}
      />,
    );
    await openClaudeDefaults();
    expect(screen.getByLabelText(/default effort/i)).toHaveValue("low");

    view.rerender(
      <SettingsPanel
        defaults={{ effort: "high", dangerouslySkip: false }}
        defaultsSyncState="synced"
        defaultsSaveState="idle"
        models={models}
        onSaveDefaults={onSave}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByLabelText(/default effort/i)).toHaveValue("high");
    await userEvent.click(screen.getByRole("button", { name: /save defaults/i }));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ effort: "high" }));
  });

  it("does not overwrite a dirty draft when authoritative hydration arrives", async () => {
    const view = render(
      <SettingsPanel
        defaults={{ effort: "low", dangerouslySkip: false }}
        defaultsSyncState="loading"
        defaultsSaveState="idle"
        models={models}
        onSaveDefaults={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    await openClaudeDefaults();
    await userEvent.selectOptions(screen.getByLabelText(/default effort/i), "medium");

    view.rerender(
      <SettingsPanel
        defaults={{ effort: "high", dangerouslySkip: false }}
        defaultsSyncState="synced"
        defaultsSaveState="idle"
        models={models}
        onSaveDefaults={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByLabelText(/default effort/i)).toHaveValue("medium");
  });

  it("does not render Claude additional directories that defaults cannot persist", async () => {
    render(<SettingsPanel defaults={defaults} models={models} onSaveDefaults={vi.fn()} onClose={vi.fn()} />);
    await openClaudeDefaults();
    await userEvent.click(screen.getByText("Advanced"));

    expect(screen.queryByLabelText(/additional directory path/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/additional directories/i)).not.toBeInTheDocument();
  });

  it("shows a conflict message and reseeds the draft from new authoritative defaults", async () => {
    const view = render(
      <SettingsPanel
        session={undefined}
        defaults={{ effort: "low", dangerouslySkip: false }}
        defaultsSaveState="idle"
        onSaveDefaults={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    await openClaudeDefaults();
    await userEvent.selectOptions(screen.getByLabelText(/default effort/i), "high");

    view.rerender(
      <SettingsPanel
        session={undefined}
        defaults={{ effort: "xhigh", dangerouslySkip: false }}
        defaultsSaveState="conflict"
        defaultsSaveError="Settings changed on another device. Loaded the latest server defaults."
        onSaveDefaults={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent(/changed on another device/i);
    expect(screen.getByLabelText(/default effort/i)).toHaveValue("xhigh");
    expect(screen.queryByText("Saved")).not.toBeInTheDocument();
  });

  it("shows a generic save error without discarding the edited draft", async () => {
    const view = render(
      <SettingsPanel
        session={undefined}
        defaults={defaults}
        defaultsSaveState="idle"
        onSaveDefaults={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    await openClaudeDefaults();
    await userEvent.selectOptions(screen.getByLabelText(/default effort/i), "high");

    view.rerender(
      <SettingsPanel
        session={undefined}
        defaults={{ effort: "low", dangerouslySkip: false }}
        defaultsSaveState="error"
        defaultsSaveError="Couldn't save defaults to the server."
        onSaveDefaults={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent(/couldn.t save defaults/i);
    expect(screen.getByLabelText(/default effort/i)).toHaveValue("high");
  });

  it("gates enabling dangerously-skip behind an INLINE confirm (no window.confirm — iOS suppresses it)", async () => {
    const onSave = vi.fn();
    render(<SettingsPanel session={undefined} defaults={defaults} onSaveDefaults={onSave} onClose={vi.fn()} />);
    await openClaudeDefaults();
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
    await openClaudeDefaults();
    const box = screen.getByLabelText(/dangerously skip permissions/i);
    await userEvent.click(box);
    await userEvent.click(screen.getByRole("button", { name: /cancel enabling/i }));
    expect(box).not.toBeChecked();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("gates the Codex dangerous default behind confirmation and keeps its subsection open once enabled", async () => {
    const onSave = vi.fn(async () => {});
    render(<SettingsPanel defaults={defaults} codexModels={codexModels} onSaveDefaults={onSave} onClose={vi.fn()} />);
    await userEvent.click(screen.getByText("Codex"));
    const box = screen.getByRole("checkbox", { name: /bypass approvals and sandbox/i });
    await userEvent.click(box);
    expect(box).not.toBeChecked();
    expect(screen.getByRole("alert")).toHaveTextContent(/without approval or sandbox protection/i);

    await userEvent.click(screen.getByRole("button", { name: /yes, enable bypass/i }));
    expect(box).toBeChecked();
    expect(screen.getByText("Codex").closest("details")).toHaveAttribute("open");
    await userEvent.click(screen.getByRole("button", { name: /save defaults/i }));
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        codex: expect.objectContaining({ dangerouslyBypassApprovalsAndSandbox: true }),
      }),
    );
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
    await openClaudeDefaults();
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

  it("keeps the dangerously-skip toggle visible whenever its provider defaults are expanded", async () => {
    // CRITICAL (user requirement): the danger toggle must never be hidden/buried — present and enabled,
    // gated only by the inline confirm.
    render(<SettingsPanel session={session} defaults={defaults} onSaveDefaults={vi.fn()} onClose={vi.fn()} />);
    await openClaudeDefaults();
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
