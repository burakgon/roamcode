import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SubagentTray } from "./SubagentTray";
import type { SubagentThread } from "../store/frame-reducer";

function thread(id: string, partial: Partial<SubagentThread>): SubagentThread {
  return { id, status: "running", turns: [], liveText: "", thinkingText: "", wireState: "running-tool", ...partial };
}

describe("SubagentTray", () => {
  it("renders NOTHING when there are no subagents", () => {
    const { container } = render(<SubagentTray subagents={{}} subagentOrder={[]} onOpen={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows a count + a chip per TOP-LEVEL subagent (nested children are excluded)", () => {
    const subagents = {
      a: thread("a", { type: "general-purpose", status: "running", activity: "Running Echo" }),
      b: thread("b", { type: "Explore", status: "completed" }),
      inner: thread("inner", { type: "general-purpose", status: "completed", parentId: "a" }),
    };
    render(<SubagentTray subagents={subagents} subagentOrder={["a", "b", "inner"]} onOpen={vi.fn()} />);
    // Two top-level agents (a, b) — the nested "inner" is not in the tray.
    expect(screen.getByText("2 agents")).toBeInTheDocument();
    expect(screen.getAllByText("general-purpose")).toHaveLength(1); // only the top-level one
    expect(screen.getByText("Explore")).toBeInTheDocument();
    // The running chip surfaces its activity.
    expect(screen.getByText("Running Echo")).toBeInTheDocument();
  });

  it("singular label for one agent", () => {
    render(
      <SubagentTray subagents={{ a: thread("a", { type: "Plan" }) }} subagentOrder={["a"]} onOpen={vi.fn()} />,
    );
    expect(screen.getByText("1 agent")).toBeInTheDocument();
  });

  it("tapping a chip opens that subagent", async () => {
    const onOpen = vi.fn();
    render(
      <SubagentTray subagents={{ a: thread("a", { type: "general-purpose" }) }} subagentOrder={["a"]} onOpen={onOpen} />,
    );
    await userEvent.click(screen.getByRole("button", { name: /open general-purpose subagent/i }));
    expect(onOpen).toHaveBeenCalledWith("a");
  });
});
