import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { AttentionItem } from "../types/server";
import { AttentionInbox } from "./AttentionInbox";

const blocked: AttentionItem = {
  id: "a1",
  workspaceId: "w1",
  sessionId: "s1",
  agentId: "agent_s1",
  kind: "blocked",
  state: "open",
  title: "Checkout needs a decision",
  detail: "Review the provider prompt.",
  urgency: 100,
  occurrenceCount: 2,
  createdAt: 1,
  updatedAt: 1,
};

function renderInbox(overrides: Partial<React.ComponentProps<typeof AttentionInbox>> = {}) {
  const props: React.ComponentProps<typeof AttentionInbox> = {
    open: true,
    response: { items: [blocked], unreadCount: 1 },
    workspaces: [
      {
        id: "w1",
        label: "Storefront",
        cwd: "/work/store",
        kind: "directory",
        sortOrder: 0,
        createdAt: 1,
        updatedAt: 1,
      },
    ],
    now: 61_000,
    onClose: vi.fn(),
    onOpenSession: vi.fn(),
    onAction: vi.fn(),
    ...overrides,
  };
  return { props, ...render(<AttentionInbox {...props} />) };
}

describe("AttentionInbox", () => {
  it("shows durable context and opens the exact session", async () => {
    const { props } = renderInbox();
    expect(screen.getByRole("dialog", { name: "Attention" })).toBeVisible();
    expect(screen.getByText("Checkout needs a decision")).toBeVisible();
    expect(screen.getByText("Storefront")).toBeVisible();
    expect(screen.getByText("· 2 updates")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Open session" }));
    expect(props.onOpenSession).toHaveBeenCalledWith("s1");
  });

  it("supports acknowledge, one-hour snooze, and resolve", async () => {
    const { props } = renderInbox();
    await userEvent.click(screen.getByRole("button", { name: "Mark seen" }));
    await userEvent.click(screen.getByRole("button", { name: "Snooze 1h" }));
    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(props.onAction).toHaveBeenNthCalledWith(1, blocked, "acknowledge");
    expect(props.onAction).toHaveBeenNthCalledWith(2, blocked, "snooze", 3_661_000);
    expect(props.onAction).toHaveBeenNthCalledWith(3, blocked, "resolve");
  });

  it("has a useful empty state and closes with Escape", () => {
    const { props } = renderInbox({ response: { items: [], unreadCount: 0 } });
    expect(screen.getByText("Nothing needs you")).toBeVisible();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it("renders nothing while closed", () => {
    renderInbox({ open: false });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
