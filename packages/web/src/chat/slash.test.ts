import { describe, expect, it } from "vitest";
import { isSlashCommand, matchSlash, sessionCommands } from "./slash";

describe("session-driven slash menu (real per-session commands from init)", () => {
  it("builds the menu from the session's real commands, prefixing `/` and merging /resume", () => {
    const names = sessionCommands(["deep-research", "code-review", "firecrawl:scrape", "compact"]).map((c) => c.name);
    expect(names).toContain("/deep-research");
    expect(names).toContain("/firecrawl:scrape");
    expect(names).toContain("/compact");
    expect(names).toContain("/resume"); // the client-only action is always available
  });
  it("matchSlash filters the SESSION list by prefix (not the hardcoded 6)", () => {
    const names = matchSlash("/fire", ["firecrawl:scrape", "firecrawl:search", "compact"]).map((c) => c.name);
    expect(names).toEqual(["/firecrawl:scrape", "/firecrawl:search"]);
  });
  it("falls back to the static list before init has arrived (no commands)", () => {
    expect(matchSlash("/comp").map((c) => c.name)).toContain("/compact");
  });
  it("keeps /resume a client action even when built from the session list", () => {
    expect(sessionCommands(["compact"]).find((c) => c.name === "/resume")?.clientAction).toBe(true);
  });
});

describe("isSlashCommand", () => {
  it("is true for a slash command (even with leading whitespace or args)", () => {
    expect(isSlashCommand("/compact")).toBe(true);
    expect(isSlashCommand("  /model opus")).toBe(true);
  });
  it("is false for ordinary prose, empty, or undefined", () => {
    expect(isSlashCommand("hello /not-a-command")).toBe(false);
    expect(isSlashCommand("")).toBe(false);
    expect(isSlashCommand(undefined)).toBe(false);
  });
});

describe("matchSlash", () => {
  it("returns nothing when the text isn't a slash command", () => {
    expect(matchSlash("hello")).toEqual([]);
  });
  it("matches by prefix", () => {
    const names = matchSlash("/c").map((c) => c.name);
    expect(names).toContain("/clear");
    expect(names).toContain("/compact");
    expect(names).toContain("/cost");
    expect(names).not.toContain("/help");
  });
  it("lists all commands for a bare slash", () => {
    expect(matchSlash("/").length).toBeGreaterThanOrEqual(5);
  });
  it("closes once the command token is complete (a space → typing arguments, not choosing a command)", () => {
    // "/model opus" must NOT keep the menu open showing "/model" — the user has moved on to the argument.
    expect(matchSlash("/model opus", ["model", "compact"])).toEqual([]);
    expect(matchSlash("/model ", ["model", "compact"])).toEqual([]);
    // Still typing the command token (no space yet) → still matches.
    expect(matchSlash("/mod", ["model", "compact"]).map((c) => c.name)).toEqual(["/model"]);
  });
  it("matches /resume by prefix and marks it a client action (others are not)", () => {
    const resume = matchSlash("/r").find((c) => c.name === "/resume");
    expect(resume).toBeDefined();
    expect(resume?.clientAction).toBe(true);
    // A claude command (sent as text) is not a client action.
    expect(matchSlash("/clear")[0]?.clientAction).toBeFalsy();
  });
});
