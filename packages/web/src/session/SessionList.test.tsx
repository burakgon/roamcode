import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SessionList, awaitingCount } from "./SessionList";
import type { SessionListProps } from "./SessionList";
import type { SessionMeta } from "../types/server";

const sessions: SessionMeta[] = [
  {
    id: "s1",
    cwd: "/home/u/remote-coder",
    model: "opus",
    effort: "high",
    dangerouslySkip: false,
    status: "running",
    activity: "working",
    createdAt: 1,
  },
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
    ...overrides,
  };
  return { ...render(<SessionList {...props} />), props };
}

describe("SessionList", () => {
  it("shows a settings gear in the header that opens global settings (reachable without a chat)", async () => {
    const onOpenSettings = vi.fn();
    renderList({ onOpenSettings });
    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });

  it("omits the settings gear when no handler is wired", () => {
    renderList();
    expect(screen.queryByRole("button", { name: "Settings" })).not.toBeInTheDocument();
  });

  it("renders a row per session with its cwd basename", () => {
    renderList();
    expect(screen.getByText("remote-coder")).toBeInTheDocument();
    expect(screen.getByText("notes")).toBeInTheDocument();
  });

  it("surfaces the per-row status word", () => {
    renderList();
    // The status reads its word out (color is never the sole signal): s1 is running with activity="working"
    // → the "working" word (an idle session would read "idle"; awaiting → "needs you").
    expect(screen.getByText("working")).toBeInTheDocument();
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
    // Each row's ⋯ actions button is labelled by basename; their DOM order reflects row order.
    const actions = screen.getAllByRole("button", { name: /actions for/i });
    expect(actions[0]).toHaveAccessibleName("Actions for notes");
    expect(actions[1]).toHaveAccessibleName("Actions for remote-coder");
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

  it("calls onClose from the row's ⋯ → close, without selecting the row", async () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    renderList({ onSelect, onClose });
    await userEvent.click(screen.getByRole("button", { name: "Actions for remote-coder" }));
    await userEvent.click(screen.getByRole("button", { name: "Close session remote-coder" }));
    expect(onClose).toHaveBeenCalledWith("s1");
    // Opening actions + closing must NOT trigger a row select (separate tap targets, stop propagation).
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("hides row actions behind a ⋯ that reveals a labelled close per row", async () => {
    renderList();
    // Default: only the quiet ⋯ shows; the destructive close is NOT in the DOM until you open it.
    expect(screen.getByRole("button", { name: "Actions for remote-coder" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Close session remote-coder" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Actions for remote-coder" }));
    expect(screen.getByRole("button", { name: "Close session remote-coder" })).toBeInTheDocument();
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

  it("renders a loud per-row 'needs you' indicator on an awaiting session (and not on others)", () => {
    const awaitingSessions: SessionMeta[] = [
      { ...sessions[0]!, awaiting: true },
      { ...sessions[1]!, awaiting: false },
    ];
    renderList({ sessions: awaitingSessions });
    // The awaiting row shows the loud, text-labelled "needs you" chip (never color-only).
    expect(screen.getByText("needs you")).toBeInTheDocument();
    // It's labelled by the session it belongs to (the basename) for assistive tech.
    expect(screen.getByRole("status", { name: /remote-coder needs you/i })).toBeInTheDocument();
    // Exactly one awaiting indicator — the non-awaiting row does not get one.
    expect(screen.getAllByText("needs you")).toHaveLength(1);
  });

  it("shows the global 'N need you' badge in the header counting awaiting sessions", () => {
    const awaitingSessions: SessionMeta[] = [
      { ...sessions[0]!, awaiting: true },
      { ...sessions[1]!, awaiting: true },
    ];
    const { container } = renderList({ sessions: awaitingSessions });
    // The header badge counts the awaiting sessions ("2 need you"). Scope to the badge element so we
    // don't collide with the "Sessions · 2" count.
    const badge = container.querySelector(".rc-needs");
    expect(badge).not.toBeNull();
    expect(within(badge as HTMLElement).getByText("2")).toBeInTheDocument();
    expect(within(badge as HTMLElement).getByText("need you")).toBeInTheDocument();
  });

  it("does not render the global badge when no session is awaiting", () => {
    renderList(); // default sessions have no awaiting flag
    expect(screen.queryByText("need you")).not.toBeInTheDocument();
  });

  it("mounts the usage bars at the VERY TOP of the rail (before the header) when usage is present", () => {
    const { container } = renderList({
      usage: {
        session: { percent: 12, resets: "Jun 25 at 11:30pm (Europe/Istanbul)" },
        week: { percent: 72, resets: "Jun 25 at 10pm (Europe/Istanbul)" },
        fetchedAt: 1,
      },
    });
    const root = container.querySelector(".rc-sl")!;
    const usage = root.querySelector(".rc-usage");
    const head = root.querySelector(".rc-sl__head");
    expect(usage).not.toBeNull();
    // It's the FIRST thing in the rail — above the "Sessions" header / needs-you badge.
    expect(root.firstElementChild).toBe(usage);
    expect(usage!.compareDocumentPosition(head!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByRole("progressbar", { name: "Session limit 12% used" })).toBeInTheDocument();
  });

  it("renders no usage bars when usage is absent (feature unavailable)", () => {
    const { container } = renderList(); // no usage prop
    expect(container.querySelector(".rc-usage")).toBeNull();
  });

  it("shows the running version in the footer, and nothing when there's no version yet", () => {
    const { container } = renderList();
    expect(container.querySelector(".rc-sl__footer")).toBeNull();
    renderList({ version: "v2026.06.26 · ebe4bd3" });
    expect(screen.getByText("v2026.06.26 · ebe4bd3")).toBeInTheDocument();
  });

  it("offers 'Update available' (→ onShowUpdate) when an update is out", async () => {
    const onShowUpdate = vi.fn();
    renderList({ version: "v1", updateAvailable: true, onShowUpdate });
    await userEvent.click(screen.getByRole("button", { name: "Update available" }));
    expect(onShowUpdate).toHaveBeenCalled();
  });

  it("offers 'Check for updates' when up to date and confirms when none is found", async () => {
    const onCheckUpdate = vi.fn().mockResolvedValue(false);
    renderList({ version: "v1", updateAvailable: false, onCheckUpdate });
    await userEvent.click(screen.getByRole("button", { name: "Check for updates" }));
    expect(onCheckUpdate).toHaveBeenCalled();
    expect(await screen.findByText("Up to date ✓")).toBeInTheDocument();
  });

  it("advertises the split drag (desktop): draggable rows with a tooltip + a one-time coach hint", () => {
    localStorage.clear();
    vi.useFakeTimers();
    try {
      renderList({ draggableRows: true });
      // Rows are draggable and SAY so (cursor alone is invisible in a screenshotless test).
      const row = screen.getByRole("button", { name: /^remote-coder/i });
      expect(row).toHaveAttribute("draggable", "true");
      expect(row.getAttribute("title")).toMatch(/split/i);
      // The coach hint appears after its short delay…
      act(() => void vi.advanceTimersByTime(1200));
      expect(screen.getByText(/drag a session onto the terminal/i)).toBeInTheDocument();
      // …and dismissing marks it learned forever (never shown again).
      fireEvent.click(screen.getByRole("button", { name: /dismiss hint/i }));
      expect(screen.queryByText(/drag a session onto the terminal/i)).toBeNull();
      expect(localStorage.getItem("rc-split-hint-learned")).toBe("1");
    } finally {
      vi.useRealTimers();
      localStorage.clear();
    }
  });

  it("keeps rows inert (not draggable, no hint) when draggableRows is off — the mobile default", () => {
    renderList();
    const row = screen.getByRole("button", { name: /^remote-coder/i });
    expect(row).not.toHaveAttribute("draggable", "true");
    expect(screen.queryByText(/drag a session onto the terminal/i)).toBeNull();
  });
});

describe("awaitingCount", () => {
  it("counts only sessions with awaiting=true", () => {
    const list: SessionMeta[] = [
      { id: "a", cwd: "/a", dangerouslySkip: false, status: "running", createdAt: 1, awaiting: true },
      { id: "b", cwd: "/b", dangerouslySkip: false, status: "running", createdAt: 2, awaiting: false },
      { id: "c", cwd: "/c", dangerouslySkip: false, status: "running", createdAt: 3, awaiting: true },
      { id: "d", cwd: "/d", dangerouslySkip: false, status: "dormant", createdAt: 4 },
    ];
    expect(awaitingCount(list)).toBe(2);
    expect(awaitingCount([])).toBe(0);
  });
});
