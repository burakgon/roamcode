import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
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
  it("renders the cwd basename and the full path", () => {
    render(<ChatHeader session={session} wireState="idle" />);
    expect(screen.getByText("overrun")).toBeInTheDocument();
    expect(screen.getByText(session.cwd)).toBeInTheDocument();
  });

  it("truncates the cwd so a long path cannot overprint the status group", () => {
    render(<ChatHeader session={session} wireState="idle" />);
    // The cwd lives inside a wrapper that clips with an ellipsis (mobile 390px overlap fix).
    const cwd = screen.getByText(session.cwd);
    const wrapper = cwd.parentElement as HTMLElement;
    expect(wrapper.style.overflow).toBe("hidden");
    expect(wrapper.style.textOverflow).toBe("ellipsis");
    expect(wrapper.style.whiteSpace).toBe("nowrap");
  });

  it("surfaces the active model/effort and clearly flags skip-permissions", () => {
    render(
      <ChatHeader
        session={{ ...session, model: "opus", effort: "xhigh", permissionMode: "bypassPermissions" }}
        wireState="idle"
      />,
    );
    expect(screen.getByText("opus")).toBeInTheDocument();
    expect(screen.getByText(/xhigh/)).toBeInTheDocument();
    expect(screen.getByText(/skip-permissions/)).toBeInTheDocument();
  });

  it("gives the status group flex:none so it is never squeezed/overlapped", () => {
    render(<ChatHeader session={session} wireState="awaiting" onOpenSettings={() => {}} />);
    const status = screen.getByRole("status");
    // Walk up to the direct child of <header> that contains the status — that's the status group.
    let group = status as HTMLElement;
    while (group.parentElement && group.parentElement.tagName !== "HEADER") {
      group = group.parentElement;
    }
    // `flex: none` is stored by the DOM as the expanded longhand.
    expect(group.style.flex).toBe("0 0 auto");
  });
});
