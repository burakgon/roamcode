/**
 * mcp-send — a stdio MCP server that lets Claude proactively SEND a file or image to the user's chat.
 *
 * remote-coder spawns this as `claude`'s MCP subprocess (via --mcp-config). It exposes two tools
 * (send_image / send_file); on a call it POSTs the file PATH to remote-coder's
 * `POST /sessions/:id/attach`, which validates the path (fsRoot+realpath) and pushes an `attachment`
 * frame over the session's WebSocket so the web renders it (image inline, file as a download).
 *
 * The connection params arrive via env (RC_BASE_URL, RC_SESSION_ID, RC_TOKEN), injected by the
 * spawning server. No ANTHROPIC_API_KEY, no @anthropic-ai dependency — only the MCP SDK + zod.
 */
import { basename } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

export interface McpEnv {
  RC_BASE_URL?: string;
  RC_SESSION_ID?: string;
  RC_TOKEN?: string;
}

export interface DeliverArgs {
  path: string;
  caption?: string;
  kind: "image" | "file";
}

/**
 * A minimal MCP tool-result shape (content blocks + optional isError), enough for our two tools. The
 * index signature keeps it assignable to the SDK's `Result` (`{ [x: string]: unknown }`) tool-callback
 * return type without casting at the call sites.
 */
export interface ToolResult {
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

function textResult(text: string, isError = false): ToolResult {
  return isError ? { content: [{ type: "text", text }], isError: true } : { content: [{ type: "text", text }] };
}

/**
 * Pure, unit-testable core: POST the attachment to remote-coder and map the response to a tool-result.
 * NEVER throws — a bad path, a down server, or a network error all return an `isError` tool-result so
 * Claude learns it failed and can tell the user. `fetchImpl` is injectable for tests (defaults to fetch).
 */
export async function deliver(env: McpEnv, args: DeliverArgs, fetchImpl: typeof fetch = fetch): Promise<ToolResult> {
  const { RC_BASE_URL, RC_SESSION_ID, RC_TOKEN } = env;
  if (!RC_BASE_URL || !RC_SESSION_ID || !RC_TOKEN) {
    return textResult("Attachment delivery is not configured (RC_BASE_URL / RC_SESSION_ID / RC_TOKEN missing).", true);
  }
  const url = `${RC_BASE_URL}/sessions/${RC_SESSION_ID}/attach`;
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: { authorization: `Bearer ${RC_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ path: args.path, caption: args.caption, kind: args.kind }),
    });
  } catch (err) {
    return textResult(`Could not reach remote-coder to send the file: ${(err as Error).message}`, true);
  }
  if (!res.ok) {
    // Surface the server's error body (e.g. "path is outside the allowed root") so Claude can explain it.
    let detail = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: unknown };
      if (typeof body.error === "string") detail = body.error;
    } catch {
      // non-JSON error body — keep the status code detail
    }
    return textResult(`Failed to send ${basename(args.path)}: ${detail}`, true);
  }
  return textResult(`Sent ${basename(args.path)} to the user.`);
}

const SEND_PARAMS = {
  path: z.string().describe("Absolute path to the file to send."),
  caption: z.string().optional().describe("Optional caption shown with the file in the chat."),
};

/** Build the MCP server with the two send tools wired to `deliver`. Reads env lazily per call. */
export function createMcpSendServer(env: McpEnv = process.env): McpServer {
  const server = new McpServer({ name: "remote-coder-send", version: "0.0.0" });

  server.registerTool(
    "send_image",
    {
      description:
        "Send an IMAGE to the user's chat so they can see it inline. Use when the user asks you to " +
        "show/send an image, or to deliver a generated image. `path` must be an absolute path to the file.",
      inputSchema: SEND_PARAMS,
    },
    async ({ path, caption }) => deliver(env, { path, caption, kind: "image" }),
  );

  server.registerTool(
    "send_file",
    {
      description:
        "Send a FILE to the user's chat as a download. Use when the user asks you to send/deliver a " +
        "file. `path` must be an absolute path.",
      inputSchema: SEND_PARAMS,
    },
    async ({ path, caption }) => deliver(env, { path, caption, kind: "file" }),
  );

  return server;
}

/** Run the stdio server when executed directly (node dist/mcp-send.js). */
async function main(): Promise<void> {
  const server = createMcpSendServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Only run when invoked as the entry script, not when imported by a test.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((err: unknown) => {
    // A stdio MCP server must keep stdout clean (it is the JSON-RPC channel) — log to stderr.
    process.stderr.write(`mcp-send failed to start: ${(err as Error).message}\n`);
    process.exit(1);
  });
}
