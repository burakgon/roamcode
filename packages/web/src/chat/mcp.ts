/**
 * MCP VISIBILITY — the phone's `/mcp` equivalent. The terminal's `/mcp` lists the configured MCP servers
 * and their tools; we DERIVE the same view from the session's available tool/command lists (from
 * `system/init`). MCP tools are named `mcp__<server>__<tool>`; MCP slash commands are `mcp__<server>` or
 * `mcp__<server>__<command>`. This pure module groups them by `<server>` so the panel can render read-only.
 */

/** One configured MCP server and the tools (and prompt-commands) it exposes, grouped from the tool list. */
export interface McpServer {
  /** The server name (the `<server>` in `mcp__<server>__<tool>`). */
  name: string;
  /** The bare tool names this server exposes (the `<tool>` part), sorted. */
  tools: string[];
}

/** Parse an `mcp__<server>__<tool>` name into its parts, or undefined when it isn't an MCP tool. The
 *  server segment never contains `__`; the tool segment is the remainder (which MAY contain `__`). */
export function parseMcpToolName(name: string): { server: string; tool: string } | undefined {
  if (!name.startsWith("mcp__")) return undefined;
  const rest = name.slice("mcp__".length);
  const sep = rest.indexOf("__");
  if (sep < 0) return undefined; // `mcp__server` alone is a server-level entry, not a tool
  const server = rest.slice(0, sep);
  const tool = rest.slice(sep + 2);
  if (!server || !tool) return undefined;
  return { server, tool };
}

/**
 * Group a session's tool names (built-ins + MCP) into the configured MCP servers and their tools. Built-in
 * (non-`mcp__`) tools are ignored. Servers are returned sorted by name; each server's tools are sorted and
 * de-duplicated. An empty/undefined list (or one with no MCP tools) returns []  — the panel's empty state.
 */
export function deriveMcpServers(tools: string[] | undefined): McpServer[] {
  const byServer = new Map<string, Set<string>>();
  for (const name of tools ?? []) {
    const parsed = parseMcpToolName(name);
    if (!parsed) continue;
    const set = byServer.get(parsed.server) ?? new Set<string>();
    set.add(parsed.tool);
    byServer.set(parsed.server, set);
  }
  return [...byServer.entries()]
    .map(([name, set]) => ({ name, tools: [...set].sort() }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
