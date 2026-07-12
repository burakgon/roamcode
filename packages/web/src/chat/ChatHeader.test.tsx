import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ChatHeader } from "./ChatHeader";
import type { SessionMeta } from "../types/server";

const session: SessionMeta = {
  id: "s1",
  cwd: "/Users/me/Developer/some/very/long/project/path/that/would/overrun",
  dangerouslySkip: false,
  status: "running",
  createdAt: 1,
};

describe("ChatHeader", () => {
  it("shows Codex-native reasoning and exact ordinary safety settings", () => {
    render(
      <ChatHeader
        session={
          {
            ...session,
            provider: "codex",
            model: "gpt-5.2-codex",
            effort: "high",
            sandbox: "workspace-write",
            approvalPolicy: "on-request",
          } as SessionMeta
        }
      />,
    );
    expect(screen.getByText("Codex")).toBeVisible();
    expect(screen.getByText("high reasoning")).toBeVisible();
    expect(screen.getByText("workspace-write sandbox")).toBeVisible();
    expect(screen.getByText("on-request approvals")).toBeVisible();
    expect(screen.getByText("Codex").closest(".rc-hdr-flags")).toHaveTextContent(
      /Codex.*gpt-5\.2-codex.*high reasoning.*workspace-write sandbox.*on-request approvals/,
    );
    expect(screen.getByText("Codex").closest(".rc-hdr-meta")).not.toBeNull();
  });

  it("shows exact dangerous Codex safety and treats a missing provider as Claude", () => {
    const { rerender } = render(
      <ChatHeader session={{ ...session, provider: "codex", dangerouslySkip: true, effort: "xhigh" }} />,
    );
    expect(screen.getByText(/bypass approvals and sandbox/i)).toBeVisible();
    rerender(<ChatHeader session={session} />);
    expect(screen.getByText("Claude")).toBeVisible();
    expect(screen.getByText("default permissions")).toBeVisible();
  });

  it("shows explicit provider-default safety when older Codex metadata has no concrete controls", () => {
    render(<ChatHeader session={{ ...session, provider: "codex" }} />);
    expect(screen.getByText("provider-default safety")).toBeVisible();
  });

  it("renders the cwd basename and the full path", () => {
    render(<ChatHeader session={session} />);
    expect(screen.getByText("overrun")).toBeInTheDocument();
    expect(screen.getByText(session.cwd)).toBeInTheDocument();
  });

  it("truncates the cwd so a long path cannot overprint the right-side group", () => {
    render(<ChatHeader session={session} />);
    // The cwd is the flexible element — it ellipsises so the pinned runtime flags (model/effort/
    // skip-permissions) are never clipped on a narrow screen.
    const cwd = screen.getByText(session.cwd);
    expect(cwd.style.overflow).toBe("hidden");
    expect(cwd.style.textOverflow).toBe("ellipsis");
    expect(cwd.style.whiteSpace).toBe("nowrap");
    expect(cwd.style.flex).toBe("1 1 auto");
  });

  it("surfaces the active model/effort and clearly flags skip-permissions", () => {
    render(
      <ChatHeader session={{ ...session, model: "opus", effort: "xhigh", permissionMode: "bypassPermissions" }} />,
    );
    expect(screen.getByText("opus")).toBeInTheDocument();
    expect(screen.getByText(/xhigh/)).toBeInTheDocument();
    expect(screen.getByText(/skip-permissions/)).toBeInTheDocument();
  });

  it("gives the right-side (settings) group flex:none so it is never squeezed/overlapped", () => {
    // The live model state moved to the composer telemetry strip; the header's right group now holds
    // just Settings and must keep its intrinsic width.
    render(<ChatHeader session={session} onOpenSettings={() => {}} />);
    const settings = screen.getByRole("button", { name: "Session settings" });
    // Walk up to the direct child of <header> that contains the button — that's the right-side group.
    let group = settings as HTMLElement;
    while (group.parentElement && group.parentElement.tagName !== "HEADER") {
      group = group.parentElement;
    }
    // `flex: none` is stored by the DOM as the expanded longhand.
    expect(group.style.flex).toBe("0 0 auto");
  });

  it("shows the RENAMED session label (the shared names map), not the stale cwd basename", () => {
    localStorage.setItem("rc-session-names", JSON.stringify({ s1: "api işleri" }));
    try {
      render(<ChatHeader session={session} />);
      expect(screen.getByText("api işleri")).toBeInTheDocument();
      expect(screen.queryByText("overrun")).toBeNull(); // the basename is replaced, not duplicated
    } finally {
      localStorage.removeItem("rc-session-names");
    }
  });

  it("ONE split button asks the direction: side-by-side vs stacked", async () => {
    const onSplitRight = vi.fn();
    const onSplitDown = vi.fn();
    render(<ChatHeader session={session} onSplitRight={onSplitRight} onSplitDown={onSplitDown} />);
    // No direction menu until pressed; a single "Split pane" button carries the feature.
    expect(screen.queryByRole("menu")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Split pane" }));
    await userEvent.click(screen.getByRole("menuitem", { name: /side by side/i }));
    expect(onSplitRight).toHaveBeenCalledTimes(1);
    expect(onSplitDown).not.toHaveBeenCalled();
    // The menu closed after choosing; picking stacked works the same way.
    expect(screen.queryByRole("menu")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Split pane" }));
    await userEvent.click(screen.getByRole("menuitem", { name: /stacked/i }));
    expect(onSplitDown).toHaveBeenCalledTimes(1);
  });
});
