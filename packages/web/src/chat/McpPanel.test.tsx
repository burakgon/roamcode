import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { McpPanel } from "./McpPanel";

describe("McpPanel (MCP visibility, the /mcp equivalent)", () => {
  it("groups mcp__server__tool entries into servers with their tools", () => {
    render(
      <McpPanel
        tools={[
          "Bash", // built-in — not listed
          "mcp__github__search",
          "mcp__github__issues",
          "mcp__linear__create_issue",
          "mcp__linear__list_issues",
        ]}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText("github")).toBeInTheDocument();
    expect(screen.getByText("linear")).toBeInTheDocument();
    // The tool basenames are shown (grouped under their server).
    expect(screen.getByText("search")).toBeInTheDocument();
    expect(screen.getByText("issues")).toBeInTheDocument();
    expect(screen.getByText("create_issue")).toBeInTheDocument();
    expect(screen.getByText("list_issues")).toBeInTheDocument();
    // A built-in tool is not listed as an MCP server.
    expect(screen.queryByText("Bash")).not.toBeInTheDocument();
  });

  it("lists the built-in remote-coder server's tools", () => {
    render(
      <McpPanel
        tools={["mcp__remote-coder__ask_user", "mcp__remote-coder__send_image", "mcp__remote-coder__send_file"]}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText("remote-coder")).toBeInTheDocument();
    expect(screen.getByText("ask_user")).toBeInTheDocument();
    expect(screen.getByText("send_image")).toBeInTheDocument();
    expect(screen.getByText("send_file")).toBeInTheDocument();
  });

  it("shows an empty state when no MCP servers are configured", () => {
    render(<McpPanel tools={["Bash", "Read", "Edit"]} onClose={vi.fn()} />);
    expect(screen.getByText(/no mcp servers are configured/i)).toBeInTheDocument();
  });

  it("shows the empty state when the tool list is undefined", () => {
    render(<McpPanel onClose={vi.fn()} />);
    expect(screen.getByText(/no mcp servers are configured/i)).toBeInTheDocument();
  });

  it("closes on the close button and on Escape", async () => {
    const onClose = vi.fn();
    const { default: userEvent } = await import("@testing-library/user-event");
    render(<McpPanel tools={["mcp__github__search"]} onClose={onClose} />);
    await userEvent.click(screen.getByRole("button", { name: /close mcp servers/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
