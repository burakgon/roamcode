import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ProductApiV2Error, type ProductApiV2Client } from "../api/v2/client";
import type {
  AgentRuntimeRecord,
  NodeRecord,
  SessionAutomationDefinition,
  SessionAutomationRun,
  V2Session,
} from "../api/v2/types";
import { AutomationsPage } from "./AutomationsPage";

const node: NodeRecord = {
  id: "node-1",
  owner: { type: "person", id: "owner-1" },
  name: "Studio Mac",
  status: "online",
  platform: "darwin arm64",
  lastSeenAt: 100,
  aliases: [],
};

const runtime: AgentRuntimeRecord = {
  id: "runtime_abcdefghijklmnopqrstuvwx",
  nodeId: node.id,
  provider: "codex",
  displayName: "Codex",
  availability: "available",
  authState: "ready",
  capabilities: ["launch", "task-bootstrap"],
  activeSessionCount: 0,
  observedAt: 100,
};

const automation: SessionAutomationDefinition = {
  id: "automation-1",
  owner: { type: "person", id: "owner-1" },
  name: "Release notes",
  enabled: true,
  nodeId: node.id,
  agentRuntimeId: runtime.id,
  provider: "codex",
  cwd: "/repo",
  instruction: "Prepare release notes from merged work.",
  runtimeOptions: { model: "gpt-work", sandbox: "read-only", approvalPolicy: "on-request" },
  trigger: { type: "manual" },
  triggers: [],
  revision: 2,
  createdAt: 100,
  updatedAt: 200,
};

const session: V2Session = {
  id: "session-1",
  nodeId: node.id,
  agentRuntimeId: runtime.id,
  provider: "codex",
  cwd: "/repo",
  mode: "terminal",
  status: "running",
  dangerouslySkip: false,
  createdAt: 300,
  lastActivityAt: 300,
};

const run: SessionAutomationRun = {
  id: "run-1",
  automationId: automation.id,
  definitionRevision: automation.revision,
  invocationId: "invocation-1",
  sessionId: session.id,
  nodeId: node.id,
  agentRuntimeId: runtime.id,
  cwd: "/repo",
  status: "running",
  createdAt: 300,
  updatedAt: 300,
};

function client(items: SessionAutomationDefinition[] = [automation]): ProductApiV2Client {
  return {
    listAutomations: vi.fn().mockResolvedValue(items),
    listNodes: vi.fn().mockResolvedValue([node]),
    listNodeRuntimes: vi.fn().mockResolvedValue([runtime]),
    createAutomation: vi.fn(async (input) => ({
      automation: { ...automation, ...input, id: "created", revision: 1 },
      webhookSecrets: [],
    })),
    updateAutomation: vi.fn(async (_id, input) => ({
      automation: { ...automation, ...input, revision: automation.revision + 1 },
      webhookSecrets: [],
    })),
    deleteAutomation: vi.fn().mockResolvedValue(undefined),
    runAutomation: vi.fn().mockResolvedValue({ run, session }),
    listAutomationRuns: vi.fn().mockResolvedValue([run]),
    listAutomationActivity: vi.fn().mockResolvedValue([]),
    rotateAutomationWebhookSecret: vi.fn(),
  } as unknown as ProductApiV2Client;
}

describe("AutomationsPage", () => {
  it("shows a real exact target without placement or Attention concepts", async () => {
    render(<AutomationsPage client={client()} onOpenSession={() => {}} />);

    expect(await screen.findByText("Release notes")).toBeVisible();
    expect(screen.getByText("Studio Mac")).toBeVisible();
    expect(screen.getByText("Codex")).toBeVisible();
    expect(screen.getByText("/repo")).toBeVisible();
    expect(screen.queryByText(/placement|pool|workspace|attention/i)).not.toBeInTheDocument();
  });

  it("creates a coding automation with an exact Node, runtime, directory and instruction", async () => {
    const api = client([]);
    render(<AutomationsPage client={api} onOpenSession={() => {}} />);
    await userEvent.click(await screen.findByRole("button", { name: "New automation" }));
    const dialog = screen.getByRole("dialog", { name: "Create automation" });
    const name = within(dialog).getByLabelText("Automation name");
    expect(name).toHaveFocus();
    await userEvent.type(name, "Daily review");
    await userEvent.type(within(dialog).getByLabelText("Automation instruction"), "Review the pending changes.");
    await userEvent.type(within(dialog).getByLabelText("Automation working directory"), "/repo");
    await userEvent.click(within(dialog).getByRole("button", { name: "Create automation" }));

    await waitFor(() => expect(api.createAutomation).toHaveBeenCalledOnce());
    expect(api.createAutomation).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Daily review",
        nodeId: node.id,
        agentRuntimeId: runtime.id,
        cwd: "/repo",
        instruction: "Review the pending changes.",
        runtimeOptions: {},
        trigger: { type: "manual" },
        triggers: [],
      }),
    );
  });

  it("adds schedule and webhook triggers without removing Run now", async () => {
    const api = client([]);
    render(<AutomationsPage client={api} onOpenSession={() => {}} />);
    await userEvent.click(await screen.findByRole("button", { name: "New automation" }));
    const dialog = screen.getByRole("dialog", { name: "Create automation" });

    await userEvent.click(within(dialog).getByRole("button", { name: "Add schedule" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Add webhook" }));
    expect(within(dialog).getByLabelText("Schedule cron")).toHaveValue("0 9 * * 1-5");
    expect(within(dialog).getByLabelText("Schedule timezone")).toHaveValue(
      Intl.DateTimeFormat().resolvedOptions().timeZone,
    );
    expect(within(dialog).getByText(/request bodies are discarded/i)).toBeVisible();

    await userEvent.type(within(dialog).getByLabelText("Automation name"), "Daily review");
    await userEvent.type(within(dialog).getByLabelText("Automation instruction"), "Review pending changes.");
    await userEvent.type(within(dialog).getByLabelText("Automation working directory"), "/repo");
    await userEvent.click(within(dialog).getByRole("button", { name: "Create automation" }));

    await waitFor(() => expect(api.createAutomation).toHaveBeenCalledOnce());
    expect(api.createAutomation).toHaveBeenCalledWith(
      expect.objectContaining({
        trigger: { type: "manual" },
        triggers: [
          expect.objectContaining({
            type: "schedule",
            cron: "0 9 * * 1-5",
            timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          }),
          expect.objectContaining({ type: "webhook", enabled: true }),
        ],
      }),
    );
  });

  it("preserves provider-native runtime options through edit", async () => {
    const api = client();
    render(<AutomationsPage client={api} onOpenSession={() => {}} />);
    await userEvent.click(await screen.findByRole("button", { name: "Edit" }));
    const dialog = screen.getByRole("dialog", { name: "Edit automation" });
    expect(within(dialog).queryByLabelText(/runtime options/i)).not.toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(api.updateAutomation).toHaveBeenCalledOnce());
    expect(api.updateAutomation).toHaveBeenCalledWith(
      automation.id,
      expect.objectContaining({ runtimeOptions: automation.runtimeOptions, expectedRevision: automation.revision }),
    );
  });

  it("keeps automations visible when one Node runtime inventory cannot be reached", async () => {
    const api = client();
    vi.mocked(api.listNodeRuntimes).mockRejectedValueOnce(new Error("Node offline"));

    render(<AutomationsPage client={api} onOpenSession={() => {}} />);

    expect(await screen.findByText("Release notes")).toBeVisible();
    expect(screen.getByText(/runtime inventory is unavailable for one node/i)).toBeVisible();
    expect(screen.getByText("Runtime inventory unavailable")).toBeVisible();
    expect(screen.getByRole("button", { name: "Run now" })).toBeDisabled();
  });

  it("shows an honest loading state while run history is in flight", async () => {
    const api = client();
    let resolveHistory!: (runs: SessionAutomationRun[]) => void;
    vi.mocked(api.listAutomationRuns).mockImplementationOnce(
      () =>
        new Promise<SessionAutomationRun[]>((resolve) => {
          resolveHistory = resolve;
        }),
    );
    render(<AutomationsPage client={api} onOpenSession={() => {}} />);

    const historyButton = await screen.findByRole("button", { name: "Show history for Release notes" });
    await userEvent.click(historyButton);
    expect(historyButton).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Loading run history…")).toHaveAttribute("role", "status");
    expect(screen.queryByText("No runs yet.")).not.toBeInTheDocument();

    await act(async () => resolveHistory([]));
    expect(await screen.findByText("No runs yet.")).toBeVisible();
  });

  it("opens the real Session returned by a manual run", async () => {
    const onOpenSession = vi.fn();
    render(<AutomationsPage client={client()} onOpenSession={onOpenSession} />);
    await userEvent.click(await screen.findByRole("button", { name: "Run now" }));
    await waitFor(() => expect(onOpenSession).toHaveBeenCalledWith(session));
  });

  it("keeps a bootstrap-failed Session recoverable", async () => {
    const api = client();
    const failedRun = { ...run, status: "failed" as const, failureCode: "BOOTSTRAP_FAILED" };
    vi.mocked(api.runAutomation).mockRejectedValueOnce(
      new ProductApiV2Error(503, "The runtime started but task bootstrap failed.", "BOOTSTRAP_FAILED", {
        code: "BOOTSTRAP_FAILED",
        error: "The runtime started but task bootstrap failed.",
        run: failedRun,
        session,
      }),
    );
    const onOpenSession = vi.fn();
    render(<AutomationsPage client={api} onOpenSession={onOpenSession} />);
    await userEvent.click(await screen.findByRole("button", { name: "Run now" }));
    await userEvent.click(await screen.findByRole("button", { name: "Open started session" }));
    expect(onOpenSession).toHaveBeenCalledWith(session);
  });

  it("deletes only after inline confirmation", async () => {
    const api = client();
    render(<AutomationsPage client={api} onOpenSession={() => {}} />);
    await userEvent.click(await screen.findByRole("button", { name: "Delete" }));
    expect(screen.getByText(/past runs and their sessions stay available/i)).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Delete automation" }));
    await waitFor(() => expect(api.deleteAutomation).toHaveBeenCalledWith(automation.id));
  });
});
