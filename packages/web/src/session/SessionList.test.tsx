import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SessionList } from "./SessionList";
import type { SessionListProps } from "./SessionList";
import type { SessionMeta } from "../types/server";

const sessions: SessionMeta[] = [
  { id: "s1", cwd: "/home/u/remote-coder", model: "opus", effort: "high", dangerouslySkip: false, status: "running", createdAt: 1 },
  { id: "s2", cwd: "/home/u/notes", dangerouslySkip: false, status: "stopped", createdAt: 2 },
];

// A render helper that fills in the required props with calm defaults so each test only states what
// it cares about. `lastActiveAt`/`now` default to a fixed clock for deterministic relative-time.
function renderList(overrides: Partial<SessionListProps> = {}) {
  const props: SessionListProps = {
    sessions,
    lastActiveAt: { s1: 1, s2: 2 },
    now: 1000,
    onSelect: vi.fn(),
    onNew: vi.fn(),
    onClose: vi.fn(),
    viewWireState: () => "idle",
    ...overrides,
  };
  return { ...render(<SessionList {...props} />), props };
}

describe("SessionList", () => {
  it("renders a row per session with its cwd basename and mono path", () => {
    renderList();
    expect(screen.getByText("remote-coder")).toBeInTheDocument();
    expect(screen.getByText("notes")).toBeInTheDocument();
    expect(screen.getByText("/home/u/remote-coder")).toBeInTheDocument();
  });

  it("surfaces the model·effort meta and the live status for a row", () => {
    renderList({ viewWireState: (id) => (id === "s1" ? "running-tool" : "idle") });
    // The card shows the session's model + effort so it's scannable at a glance.
    expect(screen.getByText("opus")).toBeInTheDocument();
    expect(screen.getByText("high")).toBeInTheDocument();
    // The LiveWire status reads its label out (color is never the sole signal).
    expect(screen.getByText("Running tool")).toBeInTheDocument();
  });

  it("shows the session count in the header (Sessions · N)", () => {
    renderList();
    // The count is muted next to the title; "2" sessions are present.
    expect(screen.getByText("Sessions")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
  });

  it("renders a compact relative time per row with an absolute-time title", () => {
    // s1 active 1ms after epoch, viewed at now=1000ms → under 45s → "now".
    renderList({ lastActiveAt: { s1: 1, s2: 2 }, now: 1 });
    const times = screen.getAllByText("now");
    expect(times.length).toBeGreaterThan(0);
    const t = times[0]!;
    expect(t.tagName.toLowerCase()).toBe("time");
    expect(t).toHaveAttribute("title");
  });

  it("orders sessions most-recently-active first (chat-app style)", () => {
    // s2 has the newer activity stamp → it must render above s1, even though s1 is first in the array.
    renderList({ lastActiveAt: { s1: 10, s2: 999 } });
    const names = screen.getAllByRole("button", { name: /close session/i });
    // Close buttons are labelled by basename; their DOM order reflects row order.
    expect(names[0]).toHaveAccessibleName("Close session notes");
    expect(names[1]).toHaveAccessibleName("Close session remote-coder");
  });

  it("marks the active row with aria-current for a clear selected state", () => {
    renderList({ activeId: "s1" });
    const active = screen.getByRole("button", { name: /^remote-coder/i });
    expect(active).toHaveAttribute("aria-current", "true");
  });

  it("calls onSelect when a row is activated", async () => {
    const onSelect = vi.fn();
    renderList({ onSelect });
    await userEvent.click(screen.getByText("remote-coder"));
    expect(onSelect).toHaveBeenCalledWith("s1");
  });

  it("calls onClose from the row's ✕ without selecting the row", async () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    renderList({ onSelect, onClose });
    await userEvent.click(screen.getByRole("button", { name: "Close session remote-coder" }));
    expect(onClose).toHaveBeenCalledWith("s1");
    // Tapping ✕ must NOT trigger a row select (separate tap target, stops propagation).
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("gives each row a labelled ✕ close button as a separate tap target", () => {
    renderList();
    expect(screen.getByRole("button", { name: "Close session remote-coder" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close session notes" })).toBeInTheDocument();
  });

  it("calls onNew from the New session icon button (reachable by aria-label)", async () => {
    const onNew = vi.fn();
    renderList({ onNew });
    // The affordance is an icon button, not a text button — it's reached by its accessible name.
    await userEvent.click(screen.getByRole("button", { name: "New session" }));
    expect(onNew).toHaveBeenCalled();
  });

  it("renders an empty state with a single New session affordance and no row buttons", () => {
    renderList({ sessions: [], lastActiveAt: {} });
    expect(screen.getByText(/no sessions yet/i)).toBeInTheDocument();
    // The empty state must not duplicate a second "New session" button (the header has the only one).
    expect(screen.getAllByRole("button", { name: "New session" })).toHaveLength(1);
    // No close buttons when there are no sessions.
    expect(screen.queryByRole("button", { name: /close session/i })).not.toBeInTheDocument();
  });

  it("uses a real plus icon for New session (not a bolt-with-plus glyph)", () => {
    renderList();
    const btn = screen.getByRole("button", { name: "New session" });
    // The plus icon path lives inside the button; assert there's an svg and no stray "+" text node
    // (the old bolt affordance rendered a literal '+' badge).
    expect(within(btn).queryByText("+")).not.toBeInTheDocument();
    expect(btn.querySelector("svg")).toBeTruthy();
  });
});
