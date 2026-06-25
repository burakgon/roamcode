import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SubagentCard } from "./SubagentCard";
import type { SubagentThread } from "../store/frame-reducer";

function thread(partial: Partial<SubagentThread>): SubagentThread {
  return {
    id: "agent-1",
    status: "running",
    turns: [],
    liveText: "",
    thinkingText: "",
    wireState: "running-tool",
    ...partial,
  };
}

describe("SubagentCard", () => {
  it("shows the subagent_type eyebrow, the description title, and a running status", () => {
    render(
      <SubagentCard
        thread={thread({ type: "general-purpose", description: "Run echo command", activity: "Running Echo a test string" })}
        onOpen={vi.fn()}
      />,
    );
    expect(screen.getByText("general-purpose")).toBeInTheDocument();
    expect(screen.getByText("Run echo command")).toBeInTheDocument();
    // The live activity line shows while running.
    expect(screen.getByText("Running Echo a test string")).toBeInTheDocument();
    // Status is conveyed in text (not color alone).
    expect(screen.getAllByText("Running").length).toBeGreaterThan(0);
  });

  it("on completion shows the usage chip and a 'View transcript' affordance", () => {
    render(
      <SubagentCard
        thread={thread({
          status: "completed",
          type: "general-purpose",
          description: "Run echo command",
          usage: { tokens: 11401, toolUses: 1, durationMs: 4112 },
        })}
        onOpen={vi.fn()}
      />,
    );
    expect(screen.getByText(/11\.4k tok · 1 tool · 4\.1s/)).toBeInTheDocument();
    expect(screen.getByText(/view transcript/i)).toBeInTheDocument();
    expect(screen.getByText("Done")).toBeInTheDocument();
  });

  it("a failed subagent reads 'Failed' (restrained, text + dot — never just color)", () => {
    render(<SubagentCard thread={thread({ status: "failed", type: "Explore", description: "Map the repo" })} onOpen={vi.fn()} />);
    expect(screen.getByText("Failed")).toBeInTheDocument();
  });

  it("the whole card is one tappable control that opens the drill-in", async () => {
    const onOpen = vi.fn();
    render(<SubagentCard thread={thread({ type: "general-purpose", description: "Do it" })} onOpen={onOpen} />);
    await userEvent.click(screen.getByRole("button", { name: /general-purpose subagent/i }));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});
