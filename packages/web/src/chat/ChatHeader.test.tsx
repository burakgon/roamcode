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
  it("keeps Codex runtime concise and reveals exact safety settings on demand", async () => {
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
    await userEvent.click(screen.getByRole("button", { name: "Session details" }));
    const details = screen.getByRole("group", { name: "Session runtime and safety" });
    expect(details).toHaveTextContent("Codex · gpt-5.2-codex · high reasoning");
    expect(details).toHaveTextContent("high reasoning");
    expect(details).toHaveTextContent("workspace-write sandbox");
    expect(details).toHaveTextContent("on-request approvals");
  });

  it("shows a compact Unsafe control for dangerous Codex safety", async () => {
    render(<ChatHeader session={{ ...session, provider: "codex", dangerouslySkip: true, effort: "xhigh" }} />);
    expect(screen.getByRole("button", { name: "Unsafe session details" })).toHaveTextContent("Unsafe");
    expect(screen.queryByText(/bypass approvals and sandbox/i)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Unsafe session details" }));
    expect(screen.getByText(/bypass approvals and sandbox/i)).toBeVisible();
  });

  it("treats a missing provider as Claude and puts default safety in details", async () => {
    render(<ChatHeader session={session} />);
    expect(screen.getByRole("img", { name: "Claude" })).toBeVisible();
    expect(screen.queryByText("Claude")).not.toBeInTheDocument();
    expect(screen.queryByText("default permissions")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Session details" }));
    expect(screen.getByText("default permissions")).toBeVisible();
  });

  it("shows explicit provider-default safety when older Codex metadata has no concrete controls", async () => {
    render(<ChatHeader session={{ ...session, provider: "codex" }} />);
    expect(screen.queryByText("provider-default safety")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Session details" }));
    expect(screen.getByText("provider-default safety")).toBeVisible();
  });

  it("renders the cwd basename and reveals the full path in details", async () => {
    render(<ChatHeader session={session} />);
    expect(screen.getByText("overrun")).toBeInTheDocument();
    expect(screen.queryByText(session.cwd)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Session details" }));
    expect(screen.getByText(session.cwd)).toBeInTheDocument();
  });

  it("truncates concise runtime so metadata cannot overprint the right-side group", () => {
    render(<ChatHeader session={session} />);
    const runtime = screen.getByRole("img", { name: "Claude" }).closest(".rc-hdr-runtime") as HTMLElement;
    expect(runtime.style.overflow).toBe("hidden");
    expect(runtime.style.textOverflow).toBe("ellipsis");
    expect(runtime.style.whiteSpace).toBe("nowrap");
    expect(runtime.style.flex).toBe("1 1 auto");
  });

  it("surfaces active model/effort and moves skip-permissions behind the warning control", async () => {
    render(
      <ChatHeader session={{ ...session, model: "opus", effort: "xhigh", permissionMode: "bypassPermissions" }} />,
    );
    expect(screen.getByText("opus")).toBeInTheDocument();
    expect(screen.getByText(/xhigh/)).toBeInTheDocument();
    expect(screen.queryByText(/skip-permissions/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Unsafe session details" }));
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
