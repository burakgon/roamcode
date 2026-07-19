import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ProductApiV2Client } from "../api/v2/client";
import type { AgentRuntimeRecord, NodeRecord } from "../api/v2/types";
import { AgentsPage } from "./AgentsPage";

const onlineNode: NodeRecord = {
  id: "node-1",
  owner: { type: "person", id: "owner-1" },
  name: "Studio Mac",
  status: "online",
  platform: "darwin arm64",
  lastSeenAt: 100,
  aliases: [],
};

const runtimes: AgentRuntimeRecord[] = [
  {
    id: "claude-runtime",
    nodeId: "node-1",
    provider: "claude",
    displayName: "Claude Code",
    availability: "available",
    authState: "required",
    version: "2.1.0",
    capabilities: ["launch"],
    activeSessionCount: 0,
    observedAt: 100,
  },
  {
    id: "codex-runtime",
    nodeId: "node-1",
    provider: "codex",
    displayName: "Codex",
    availability: "available",
    authState: "ready",
    version: "1.4.0",
    capabilities: ["launch", "resume"],
    activeSessionCount: 2,
    observedAt: 100,
  },
];

function client(nodes: NodeRecord[], byNode: Record<string, AgentRuntimeRecord[]>): ProductApiV2Client {
  return {
    listNodes: vi.fn().mockResolvedValue(nodes),
    listNodeRuntimes: vi.fn((nodeId: string) => Promise.resolve(byNode[nodeId] ?? [])),
  } as unknown as ProductApiV2Client;
}

describe("AgentsPage", () => {
  it("renders a flat standalone runtime catalog without computer inventory chrome", async () => {
    render(<AgentsPage client={client([onlineNode], { "node-1": runtimes })} onStartSession={() => {}} />);

    const runtimeList = await screen.findByRole("list", { name: "Agent runtimes" });
    expect(within(runtimeList).getAllByRole("listitem")).toHaveLength(2);
    expect(
      within(runtimeList)
        .getAllByRole("button", { expanded: false })
        .map((button) => button.textContent),
    ).toEqual([expect.stringContaining("Codex"), expect.stringContaining("Claude Code")]);
    expect(screen.queryByText(/studio mac|darwin|last seen|computers|nodes/i)).not.toBeInTheDocument();
  });

  it("opens runtime facts and starts only a ready runtime", async () => {
    const onStartSession = vi.fn();
    render(<AgentsPage client={client([onlineNode], { "node-1": runtimes })} onStartSession={onStartSession} />);

    await userEvent.click(await screen.findByRole("button", { name: /codex.*2 active sessions/i }));
    expect(screen.getByText("1.4.0")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Start session" }));
    expect(onStartSession).toHaveBeenCalledWith({ node: onlineNode, runtime: runtimes[1] });

    await userEvent.click(screen.getByRole("button", { name: /claude code.*0 active sessions/i }));
    expect(screen.getByRole("button", { name: "Start session" })).toBeDisabled();
    expect(screen.getByText("Sign-in required")).toBeInTheDocument();
  });

  it("keeps runtime availability honest without exposing standalone Node inventory", async () => {
    const offlineNode = { ...onlineNode, status: "offline" as const, name: "Travel Mac" };
    render(<AgentsPage client={client([offlineNode], { "node-1": [runtimes[1]!] })} onStartSession={() => {}} />);

    await userEvent.click(await screen.findByRole("button", { name: /codex/i }));
    expect(screen.getByRole("button", { name: "Start session" })).toBeDisabled();
    expect(screen.getByText("Node offline")).toBeVisible();
    expect(screen.queryByText(/travel mac|last seen|darwin/i)).not.toBeInTheDocument();
  });

  it("offers a recovery action when Node loading fails", async () => {
    const listNodes = vi.fn().mockRejectedValueOnce(new Error("Inventory unavailable")).mockResolvedValueOnce([]);
    const api = { listNodes, listNodeRuntimes: vi.fn() } as unknown as ProductApiV2Client;
    render(<AgentsPage client={api} onStartSession={() => {}} />);

    expect(await screen.findByRole("alert")).toHaveTextContent("Inventory unavailable");
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(listNodes).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("No agents available")).toBeVisible();
  });

  it("keeps an available launch-capable runtime usable when auth metadata is not reported", async () => {
    const unknown = { ...runtimes[1]!, id: "unknown-runtime", authState: "unknown" as const };
    render(<AgentsPage client={client([onlineNode], { "node-1": [unknown] })} onStartSession={() => {}} />);

    await userEvent.click(await screen.findByRole("button", { name: /codex/i }));
    expect(screen.getByText("Auth not reported")).toBeVisible();
    expect(screen.getByRole("button", { name: "Start session" })).toBeEnabled();
  });

  it("uses singular session copy for one active Session", async () => {
    const oneSession = { ...runtimes[1]!, activeSessionCount: 1 };
    render(<AgentsPage client={client([onlineNode], { "node-1": [oneSession] })} onStartSession={() => {}} />);

    expect(await screen.findByText("1 active session")).toBeVisible();
    expect(screen.queryByText("1 active sessions")).not.toBeInTheDocument();
  });
});
