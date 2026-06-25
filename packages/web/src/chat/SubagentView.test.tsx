import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SubagentView } from "./SubagentView";
import type { SubagentThread } from "../store/frame-reducer";

function thread(partial: Partial<SubagentThread>): SubagentThread {
  return {
    id: "agent-1",
    status: "completed",
    turns: [],
    liveText: "",
    thinkingText: "",
    wireState: "success",
    ...partial,
  };
}

describe("SubagentView", () => {
  it("renders the type, description, status, the Task prompt, and the Result", () => {
    const t = thread({
      type: "general-purpose",
      description: "Run echo command",
      prompt: "Run the bash command echo hello-from-subagent.",
      usage: { tokens: 11401, toolUses: 1, durationMs: 4112 },
      turns: [
        { kind: "tool-use", id: "b1", name: "Bash", input: { command: "echo hello-from-subagent" } },
        { kind: "tool-result", toolUseId: "b1", content: "hello-from-subagent" },
      ],
      result: { content: [{ type: "text", text: "The command output was hello-from-subagent." }], isError: false },
    });
    render(<SubagentView thread={t} subagents={{ "agent-1": t }} onOpenSubagent={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByRole("dialog", { name: /general-purpose subagent/i })).toBeInTheDocument();
    expect(screen.getByText("Run echo command")).toBeInTheDocument();
    expect(screen.getByText("Done")).toBeInTheDocument();
    expect(screen.getByText("Task")).toBeInTheDocument();
    expect(screen.getByText(/echo hello-from-subagent/i)).toBeInTheDocument();
    expect(screen.getByText("Result")).toBeInTheDocument();
    expect(screen.getByText(/The command output was hello-from-subagent\./)).toBeInTheDocument();
    expect(screen.getByText(/11\.4k tok · 1 tool · 4\.1s/)).toBeInTheDocument();
    // The transcript reuses MessageList: a "Worked" cluster wraps the subagent's Bash plumbing.
    expect(screen.getByText("Transcript")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /expand worked steps/i })).toBeInTheDocument();
  });

  it("a depth-2 subagent (no inline turns) shows the Task + Result + a 'nested' note, no transcript", () => {
    const t = thread({
      type: "general-purpose",
      description: "Run nested echo command",
      prompt: "Run echo NESTED-OK and report it.",
      parentId: "outer-1",
      turns: [],
      result: { content: [{ type: "text", text: "NESTED-OK" }], isError: false },
    });
    render(<SubagentView thread={t} subagents={{ "agent-1": t }} onOpenSubagent={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText(/nested — its internal steps run inside its parent/i)).toBeInTheDocument();
    expect(screen.queryByText("Transcript")).not.toBeInTheDocument();
    expect(screen.getByText("NESTED-OK")).toBeInTheDocument();
  });

  it("the back button and Escape both close the sheet", async () => {
    const onClose = vi.fn();
    render(
      <SubagentView thread={thread({ type: "Plan", prompt: "x" })} subagents={{ "agent-1": thread({}) }} onOpenSubagent={vi.fn()} onClose={onClose} />,
    );
    await userEvent.click(screen.getByRole("button", { name: /back/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
