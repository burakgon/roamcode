import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SplitWorkspace } from "./SplitWorkspace";
import { makeLeaf, splitLeaf, type SplitTree } from "./layout";
import type { SessionMeta } from "../types/server";

const sessions: SessionMeta[] = [
  { id: "s1", cwd: "/u/alpha", dangerouslySkip: false, status: "running", createdAt: 1 },
  { id: "s2", cwd: "/u/beta", dangerouslySkip: false, status: "running", createdAt: 2 },
];

function twoPanes(): { tree: SplitTree; a: string; b: string } {
  const a = makeLeaf("s1");
  const b = makeLeaf();
  return { tree: splitLeaf(a, a.id, "right", b), a: a.id, b: b.id };
}

const noop = () => {};

describe("SplitWorkspace", () => {
  it("renders a terminal per session pane and a picker in the empty pane", () => {
    const { tree, a } = twoPanes();
    render(
      <SplitWorkspace
        tree={tree}
        focusedLeafId={a}
        sessions={sessions}
        onFocusPane={noop}
        onTreeChange={noop}
        onPickSession={noop}
        onNewSessionInPane={noop}
        renderTerminal={(s) => <div data-testid={`term-${s.id}`} />}
      />,
    );
    expect(screen.getByTestId("term-s1")).toBeInTheDocument();
    // The empty pane offers only sessions NOT already on screen (s1 is visible → only beta is pickable).
    expect(screen.getByText("beta")).toBeInTheDocument();
    expect(screen.queryByText("alpha")).toBeNull();
    // A divider exists for the split, exposed as a separator for a11y.
    expect(screen.getByRole("separator", { name: /resize panes/i })).toBeInTheDocument();
  });

  it("picking a session in the empty pane reports the leaf + session", async () => {
    const { tree, a, b } = twoPanes();
    const onPickSession = vi.fn();
    render(
      <SplitWorkspace
        tree={tree}
        focusedLeafId={a}
        sessions={sessions}
        onFocusPane={noop}
        onTreeChange={noop}
        onPickSession={onPickSession}
        onNewSessionInPane={noop}
        renderTerminal={() => <div />}
      />,
    );
    await userEvent.click(screen.getByText("beta"));
    expect(onPickSession).toHaveBeenCalledWith(b, "s2");
  });

  it("the empty pane's + New session targets that pane", async () => {
    const { tree, a, b } = twoPanes();
    const onNew = vi.fn();
    render(
      <SplitWorkspace
        tree={tree}
        focusedLeafId={a}
        sessions={sessions}
        onFocusPane={noop}
        onTreeChange={noop}
        onPickSession={noop}
        onNewSessionInPane={onNew}
        renderTerminal={() => <div />}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /new session/i }));
    expect(onNew).toHaveBeenCalledWith(b);
  });

  it("marks the focused pane (multi-pane only) and reports focus on pointer-down", () => {
    const { tree, a } = twoPanes();
    const onFocusPane = vi.fn();
    const { container } = render(
      <SplitWorkspace
        tree={tree}
        focusedLeafId={a}
        sessions={sessions}
        onFocusPane={onFocusPane}
        onTreeChange={noop}
        onPickSession={noop}
        onNewSessionInPane={noop}
        renderTerminal={(s) => <div data-testid={`term-${s.id}`} />}
      />,
    );
    const focusedPane = container.querySelector(".rc-split__pane--focused");
    expect(focusedPane?.getAttribute("data-leaf")).toBe(a);
  });

  it("a single-leaf tree renders one terminal with NO divider and no focus ring (the classic view)", () => {
    const solo = makeLeaf("s1");
    const { container } = render(
      <SplitWorkspace
        tree={solo}
        focusedLeafId={solo.id}
        sessions={sessions}
        onFocusPane={noop}
        onTreeChange={noop}
        onPickSession={noop}
        onNewSessionInPane={noop}
        renderTerminal={(s) => <div data-testid={`term-${s.id}`} />}
      />,
    );
    expect(screen.getByTestId("term-s1")).toBeInTheDocument();
    expect(screen.queryByRole("separator")).toBeNull();
    expect(container.querySelector(".rc-split__pane--focused")).toBeNull();
  });
});
