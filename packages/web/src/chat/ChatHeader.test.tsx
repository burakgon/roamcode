import { fireEvent, render, screen } from "@testing-library/react";
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
  it("uses one compact fine-pointer row without decorative vertical padding", () => {
    render(<ChatHeader session={session} onClose={() => {}} />);
    const header = screen.getByLabelText("Session overrun");
    expect(header).toHaveClass("rc-chat-header");
    expect(header).toHaveStyle({
      gap: "6px",
      paddingRight: "8px",
      paddingBottom: "0px",
      paddingLeft: "8px",
    });
    expect(screen.getByRole("button", { name: "Close session" })).toHaveStyle({
      width: "var(--control-h)",
      height: "var(--control-h)",
    });
  });

  it("keeps close visible beside the compact terminal action menu", async () => {
    const onShowSessions = vi.fn();
    const onClose = vi.fn();
    render(
      <ChatHeader
        session={session}
        titleOnly
        onShowSessions={onShowSessions}
        needsYou={2}
        onOpenFiles={() => {}}
        onClose={onClose}
      />,
    );

    const header = screen.getByLabelText("Session overrun");
    expect(header).toHaveClass("rc-chat-header--title-only");
    expect(screen.getByText("overrun")).toBeVisible();
    screen.getByLabelText("Show sessions, 2 need you").click();
    expect(onShowSessions).toHaveBeenCalledOnce();
    const close = screen.getByRole("button", { name: "Close session" });
    expect(close).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: "Open session actions" }));
    expect(screen.getByRole("menu", { name: "Session actions" })).toBeVisible();
    expect(screen.queryByRole("menuitem", { name: /sessions/i })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "Close session" })).toBeNull();
    await userEvent.click(close);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("shows the mobile session position and swipes the title bar in both directions", () => {
    const onPreviousSession = vi.fn();
    const onNextSession = vi.fn();
    render(
      <ChatHeader
        session={session}
        titleOnly
        sessionPosition={{ current: 2, total: 5 }}
        onPreviousSession={onPreviousSession}
        onNextSession={onNextSession}
      />,
    );
    const header = screen.getByLabelText("Session overrun");
    expect(screen.getByLabelText("Session 2 of 5")).toHaveTextContent("2/5");

    fireEvent.touchStart(header, { touches: [{ clientX: 100, clientY: 18 }] });
    fireEvent.touchMove(header, { touches: [{ clientX: 38, clientY: 20 }] });
    fireEvent.touchEnd(header, { touches: [], changedTouches: [{ clientX: 38, clientY: 20 }] });
    expect(onNextSession).toHaveBeenCalledOnce();

    fireEvent.touchStart(header, { touches: [{ clientX: 40, clientY: 18 }] });
    fireEvent.touchMove(header, { touches: [{ clientX: 106, clientY: 17 }] });
    fireEvent.touchEnd(header, { touches: [], changedTouches: [{ clientX: 106, clientY: 17 }] });
    expect(onPreviousSession).toHaveBeenCalledOnce();
  });

  it("keeps Codex runtime concise without the old session-details disclosure", () => {
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
    const providerIcon = screen.getByRole("img", { name: "Codex" });
    expect(providerIcon).toBeVisible();
    expect(screen.getByText("gpt-5.2-codex")).toBeVisible();
    expect(screen.getByText("high")).toBeVisible();
    expect(screen.queryByText("Codex")).not.toBeInTheDocument();
    expect(screen.queryByText("workspace-write sandbox")).not.toBeInTheDocument();
    expect(providerIcon.closest(".rc-hdr-runtime")).toHaveTextContent(/gpt-5\.2-codex.*high/);
    expect(providerIcon.closest(".rc-hdr-meta")).not.toBeNull();
    expect(screen.queryByRole("button", { name: /session details/i })).toBeNull();
  });

  it("does not add a second safety/details control for dangerous Codex sessions", () => {
    render(<ChatHeader session={{ ...session, provider: "codex", dangerouslySkip: true, effort: "xhigh" }} />);
    expect(screen.queryByRole("button", { name: /session details/i })).toBeNull();
    expect(screen.queryByText(/bypass approvals and sandbox/i)).toBeNull();
  });

  it("treats a missing provider as a neutral terminal", () => {
    render(<ChatHeader session={session} />);
    expect(screen.getByRole("img", { name: "Terminal" })).toBeVisible();
    expect(screen.queryByText("Claude")).not.toBeInTheDocument();
    expect(screen.queryByText("plain shell")).not.toBeInTheDocument();
  });

  it("does not surface provider-default safety as header chrome", () => {
    render(<ChatHeader session={{ ...session, provider: "codex" }} />);
    expect(screen.queryByText("provider-default safety")).not.toBeInTheDocument();
  });

  it("renders the cwd basename without duplicating the full path in a details card", () => {
    render(<ChatHeader session={session} />);
    expect(screen.getByText("overrun")).toBeInTheDocument();
    expect(screen.queryByText(session.cwd)).not.toBeInTheDocument();
  });

  it("truncates concise runtime so metadata cannot overprint the right-side group", () => {
    render(<ChatHeader session={session} />);
    const runtime = screen.getByRole("img", { name: "Terminal" }).closest(".rc-hdr-runtime") as HTMLElement;
    expect(runtime.style.overflow).toBe("hidden");
    expect(runtime.style.textOverflow).toBe("ellipsis");
    expect(runtime.style.whiteSpace).toBe("nowrap");
    expect(runtime.style.flex).toBe("1 1 auto");
  });

  it("surfaces an observed agent without inventing shell safety settings", () => {
    render(
      <ChatHeader
        session={{
          ...session,
          launch: { kind: "shell" },
          agent: {
            provider: "claude",
            source: "process",
            activity: "working",
            model: "opus",
            effort: "xhigh",
          },
          permissionMode: "bypassPermissions",
        }}
      />,
    );
    expect(screen.getByText("opus")).toBeInTheDocument();
    expect(screen.getByText(/xhigh/)).toBeInTheDocument();
    expect(screen.queryByText(/skip-permissions/)).not.toBeInTheDocument();
    expect(screen.queryByText(/skip-permissions/)).not.toBeInTheDocument();
  });

  it("opens terminal find and text sizing from one compact header menu", async () => {
    const onToggleSearch = vi.fn();
    const onSmallerText = vi.fn();
    const onLargerText = vi.fn();
    render(
      <ChatHeader
        session={session}
        titleOnly
        terminalTools={{
          searchOpen: false,
          fontSize: 13,
          onToggleSearch,
          onSmallerText,
          onLargerText,
        }}
      />,
    );

    expect(screen.queryByRole("menu", { name: "Session actions" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Open session actions" }));
    expect(screen.getByRole("menu", { name: "Session actions" })).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Smaller text" }));
    await userEvent.click(screen.getByRole("button", { name: "Larger text" }));
    expect(onSmallerText).toHaveBeenCalledOnce();
    expect(onLargerText).toHaveBeenCalledOnce();
    await userEvent.click(screen.getByRole("menuitem", { name: /find in terminal/i }));
    expect(onToggleSearch).toHaveBeenCalledOnce();
    expect(screen.queryByRole("menu", { name: "Session actions" })).toBeNull();
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
