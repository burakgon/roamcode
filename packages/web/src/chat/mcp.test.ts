import { describe, expect, it } from "vitest";
import { deriveMcpServers, parseMcpToolName } from "./mcp";

describe("parseMcpToolName", () => {
  it("splits mcp__<server>__<tool>", () => {
    expect(parseMcpToolName("mcp__github__search")).toEqual({ server: "github", tool: "search" });
  });
  it("keeps a tool segment that itself contains __", () => {
    expect(parseMcpToolName("mcp__remote-coder__ask_user")).toEqual({ server: "remote-coder", tool: "ask_user" });
    expect(parseMcpToolName("mcp__linear__list__issues")).toEqual({ server: "linear", tool: "list__issues" });
  });
  it("returns undefined for a non-MCP (built-in) tool", () => {
    expect(parseMcpToolName("Bash")).toBeUndefined();
    expect(parseMcpToolName("Read")).toBeUndefined();
  });
  it("returns undefined for a bare server entry (no tool segment)", () => {
    expect(parseMcpToolName("mcp__github")).toBeUndefined();
  });
});

describe("deriveMcpServers", () => {
  it("groups mcp tools by server, sorted, with sorted tools", () => {
    const servers = deriveMcpServers([
      "Bash", // built-in — ignored
      "mcp__github__search",
      "mcp__github__issues",
      "mcp__linear__create_issue",
      "mcp__linear__list_issues",
      "Read", // built-in — ignored
    ]);
    expect(servers).toEqual([
      { name: "github", tools: ["issues", "search"] },
      { name: "linear", tools: ["create_issue", "list_issues"] },
    ]);
  });

  it("includes the built-in remote-coder server's tools", () => {
    const servers = deriveMcpServers([
      "mcp__remote-coder__ask_user",
      "mcp__remote-coder__send_image",
      "mcp__remote-coder__send_file",
    ]);
    expect(servers).toEqual([{ name: "remote-coder", tools: ["ask_user", "send_file", "send_image"] }]);
  });

  it("returns an empty list when there are no MCP tools (empty state)", () => {
    expect(deriveMcpServers(["Bash", "Read", "Edit"])).toEqual([]);
    expect(deriveMcpServers([])).toEqual([]);
    expect(deriveMcpServers(undefined)).toEqual([]);
  });

  it("de-duplicates a repeated tool", () => {
    const servers = deriveMcpServers(["mcp__github__search", "mcp__github__search"]);
    expect(servers).toEqual([{ name: "github", tools: ["search"] }]);
  });
});
