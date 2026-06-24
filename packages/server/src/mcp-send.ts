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

/** One multiple-choice question Claude wants to ask the user (mirrors protocol's QuestionSpec). */
export interface AskQuestion {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: { label: string; description?: string; preview?: string }[];
}

export interface AskArgs {
  questions: AskQuestion[];
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

/**
 * Pure, unit-testable core of the `ask_user` tool: POST the multiple-choice questions to remote-coder
 * and BLOCK until the user answers (the server long-polls — it holds the request open until the web UI
 * replies, the prompt is dismissed, or it times out). The server's JSON response is mapped to a clear
 * text tool-result so Claude learns the user's selection(s). NEVER throws — a down server, a network
 * error, a non-OK status, a dismissal or a timeout all return a graceful (non-error) tool-result telling
 * Claude the user did not answer, so the conversation can continue. `fetchImpl` is injectable for tests.
 */
export async function askDeliver(env: McpEnv, args: AskArgs, fetchImpl: typeof fetch = fetch): Promise<ToolResult> {
  const { RC_BASE_URL, RC_SESSION_ID, RC_TOKEN } = env;
  if (!RC_BASE_URL || !RC_SESSION_ID || !RC_TOKEN) {
    return textResult("Asking the user is not configured (RC_BASE_URL / RC_SESSION_ID / RC_TOKEN missing).", true);
  }
  const url = `${RC_BASE_URL}/sessions/${RC_SESSION_ID}/ask`;
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: { authorization: `Bearer ${RC_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ questions: args.questions }),
    });
  } catch {
    // The session ended / the server went away while waiting — the user didn't answer. Not an error
    // result: Claude should simply proceed without the answer rather than treat this as a tool failure.
    return textResult("The user did not answer (the question was dismissed or the session ended).");
  }
  if (!res.ok) {
    return textResult("The user did not answer (the question was dismissed or timed out).");
  }
  let body: { answers?: Record<string, string | string[]>; cancelled?: boolean };
  try {
    body = (await res.json()) as typeof body;
  } catch {
    return textResult("The user did not answer (the question was dismissed or timed out).");
  }
  if (body.cancelled || !body.answers) {
    return textResult("The user did not answer (the question was dismissed or timed out).");
  }
  return textResult(formatAnswers(args.questions, body.answers));
}

/**
 * Render the user's selections into a clear text ToolResult for Claude. Each line pairs a question
 * (its `header` if present, else the question text) with the chosen label(s) or custom "Other" text;
 * a multi-select answer joins its entries with ", ". Questions the user left unanswered are omitted.
 */
function formatAnswers(questions: AskQuestion[], answers: Record<string, string | string[]>): string {
  const lines: string[] = [];
  for (const q of questions) {
    const value = answers[q.question];
    if (value === undefined) continue;
    const chosen = Array.isArray(value) ? value.join(", ") : value;
    lines.push(`- ${q.header ?? q.question}: ${chosen}`);
  }
  return lines.length > 0 ? `User answered:\n${lines.join("\n")}` : "User answered (no selection).";
}

const SEND_PARAMS = {
  path: z.string().describe("Absolute path to the file to send."),
  caption: z.string().optional().describe("Optional caption shown with the file in the chat."),
};

const ASK_PARAMS = {
  questions: z
    .array(
      z.object({
        question: z.string().describe("The question to ask the user."),
        header: z.string().optional().describe("Short header/label shown above the question."),
        multiSelect: z.boolean().optional().describe("Allow the user to pick more than one option."),
        options: z
          .array(
            z.object({
              label: z.string().describe("The option label the user can choose."),
              description: z.string().optional().describe("Optional longer description for the option."),
              preview: z
                .string()
                .optional()
                .describe(
                  "Optional concrete artifact to help the user compare options — an ASCII mockup of a " +
                    "layout/UI, a code snippet, a diagram, or a config example. Shown in a monospace box " +
                    "beside the option. Use when options are best judged by SEEING them.",
                ),
            }),
          )
          .min(1)
          .describe("The choices for this question (1+)."),
      }),
    )
    .min(1)
    .describe("One or more multiple-choice questions to ask the user."),
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

  server.registerTool(
    "ask_user",
    {
      description:
        "Ask the user a single- or multiple-choice question and WAIT for their answer. Use this " +
        "whenever you need the user to choose between options (the built-in AskUserQuestion tool is " +
        "NOT available here). The call blocks until the user answers in the chat UI and returns their " +
        "selection(s); each question has 1+ `options`, set `multiSelect: true` to allow choosing several.",
      inputSchema: ASK_PARAMS,
    },
    async ({ questions }) => askDeliver(env, { questions }),
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
