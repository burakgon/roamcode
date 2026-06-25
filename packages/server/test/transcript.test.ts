import { fileURLToPath } from "node:url";
import { mkdtemp, mkdir, writeFile, rm, utimes } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  parseTranscript,
  transcriptToFrames,
  listResumable,
  findTranscriptFile,
  defaultProjectsDir,
} from "../src/index.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/transcript-sample.jsonl", import.meta.url));
const SAMPLE = readFileSync(FIXTURE, "utf8");

// --- parseTranscript -------------------------------------------------------

test("parseTranscript keeps user+assistant in order INCLUDING sidechain, skipping noise + a bad line", () => {
  const parsed = parseTranscript(SAMPLE);
  // user(1), assistant(tool_use), user(tool_result), assistant(SIDECHAIN), assistant(final) — the
  // queue-operation + summary + the malformed line are dropped, but the sidechain (subagent) turn is
  // now KEPT so a resumed session can show its historical subagents.
  expect(parsed.messageCount).toBe(5);
  expect(parsed.messages.map((m) => m.type)).toEqual(["user", "assistant", "user", "assistant", "assistant"]);
  // The sidechain assistant turn IS kept now...
  expect(JSON.stringify(parsed.messages)).toContain("sub-agent chatter");
  // ...but it carries a parent linkage so the reducer routes it into a subagent thread, never the main
  // chat. (This fixture's sidechain line has no parent_tool_use_id/agentId → the "sidechain" bucket.)
  const side = parsed.messages.find((m) => (m.raw as { isSidechain?: boolean }).isSidechain === true);
  expect((side?.raw as { parent_tool_use_id?: string }).parent_tool_use_id).toBe("sidechain");
});

test("parseTranscript extracts cwd, gitBranch, summary, lastActivityTs", () => {
  const parsed = parseTranscript(SAMPLE);
  expect(parsed.cwd).toBe("/work/proj");
  expect(parsed.gitBranch).toBe("main");
  expect(parsed.summary).toBe("Create a file called spike.txt with the word hello");
  // lastActivityTs is the latest timestamp (the final assistant turn at 10:00:05Z).
  expect(parsed.lastActivityTs).toBe(Date.parse("2026-06-20T10:00:05.000Z"));
});

test("parseTranscript truncates a long summary to ~100 chars and trims it", () => {
  const long = "x".repeat(200);
  const line = JSON.stringify({
    type: "user",
    message: { role: "user", content: [{ type: "text", text: `   ${long}   ` }] },
  });
  const parsed = parseTranscript(line);
  expect(parsed.summary.length).toBe(100);
  expect(parsed.summary).toBe("x".repeat(100));
});

test("parseTranscript never throws on a fully-malformed transcript", () => {
  expect(() => parseTranscript("garbage\n{bad\n\n")).not.toThrow();
  expect(parseTranscript("garbage\n{bad").messageCount).toBe(0);
});

test("parseTranscript drops the synthetic --resume warm-up pair", () => {
  const lines = [
    JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: "Continue from where you left off." }] } }),
    JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "No response requested." }] } }),
    JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: "real question" }] } }),
  ].join("\n");
  const parsed = parseTranscript(lines);
  expect(parsed.messageCount).toBe(1);
  expect(parsed.summary).toBe("real question");
});

// --- transcriptToFrames ----------------------------------------------------

test("transcriptToFrames produces contiguous event frames matching the live InboundEvent shape", () => {
  const parsed = parseTranscript(SAMPLE);
  const frames = transcriptToFrames(parsed);
  expect(frames).toHaveLength(5); // includes the kept sidechain turn
  // Contiguous 1-based seqs, all `event` kind (the same kind the live claude-process pipeline emits).
  expect(frames.map((f) => f.seq)).toEqual([1, 2, 3, 4, 5]);
  expect(frames.every((f) => f.kind === "event")).toBe(true);

  // The kept sidechain turn carries its parent linkage lifted by parseLine (routes to a subagent thread).
  expect((frames[3]?.payload as { parentToolUseId?: string }).parentToolUseId).toBe("sidechain");

  // Each payload is the parsed InboundEvent: { type, message, sessionId, raw } — exactly what a live
  // `user`/`assistant` stream-json line yields, so the frame-reducer renders these identically.
  const types = frames.map((f) => (f.payload as { type: string }).type);
  expect(types).toEqual(["user", "assistant", "user", "assistant", "assistant"]);

  // The assistant tool_use turn carries the Anthropic content blocks the reducer reads.
  const assistantToolUse = frames[1].payload as { message: { content: Array<{ type: string; name?: string }> } };
  const blockTypes = assistantToolUse.message.content.map((b) => b.type);
  expect(blockTypes).toEqual(["thinking", "text", "tool_use"]);
  expect(assistantToolUse.message.content.find((b) => b.type === "tool_use")?.name).toBe("Write");

  // The user tool_result turn (this is what the reducer turns into a tool-result item).
  const toolResult = frames[2].payload as { message: { content: Array<{ type: string; tool_use_id?: string }> } };
  expect(toolResult.message.content[0]).toMatchObject({ type: "tool_result", tool_use_id: "toolu_001" });
});

// --- listResumable + findTranscriptFile ------------------------------------

let projectsDir: string;
beforeEach(async () => {
  projectsDir = await mkdtemp(join(tmpdir(), "rc-projects-"));
});
afterEach(async () => {
  await rm(projectsDir, { recursive: true, force: true });
});

async function writeTranscript(dir: string, id: string, lines: string, mtimeSeconds?: number): Promise<string> {
  const full = join(projectsDir, dir);
  await mkdir(full, { recursive: true });
  const file = join(full, `${id}.jsonl`);
  await writeFile(file, lines);
  if (mtimeSeconds !== undefined) await utimes(file, mtimeSeconds, mtimeSeconds);
  return file;
}

function userLine(text: string, cwd = "/work/proj"): string {
  return JSON.stringify({ type: "user", cwd, message: { role: "user", content: [{ type: "text", text }] } });
}

test("listResumable returns recent-first rows with summary, cwd, and messageCount", async () => {
  await writeTranscript("-work-projA", "old-id", userLine("older convo", "/work/projA"), 1000);
  await writeTranscript("-work-projB", "new-id", userLine("newer convo", "/work/projB"), 2000);

  const rows = await listResumable(projectsDir);
  expect(rows.map((r) => r.sessionId)).toEqual(["new-id", "old-id"]); // recency DESC
  expect(rows[0]).toMatchObject({
    sessionId: "new-id",
    cwd: "/work/projB",
    summary: "newer convo",
    messageCount: 1,
  });
});

test("listResumable filters by cwd", async () => {
  await writeTranscript("-a", "a-id", userLine("in A", "/work/projA"), 1000);
  await writeTranscript("-b", "b-id", userLine("in B", "/work/projB"), 2000);

  const rows = await listResumable(projectsDir, { cwd: "/work/projA" });
  expect(rows.map((r) => r.sessionId)).toEqual(["a-id"]);
});

test("listResumable honors the limit and skips empty/zero-message transcripts", async () => {
  await writeTranscript("-a", "id-1", userLine("one"), 1000);
  await writeTranscript("-a", "id-2", userLine("two"), 2000);
  await writeTranscript("-a", "id-3", userLine("three"), 3000);
  await writeTranscript("-a", "empty", "", 9000); // no messages → skipped despite newest mtime

  const rows = await listResumable(projectsDir, { limit: 2 });
  expect(rows.map((r) => r.sessionId)).toEqual(["id-3", "id-2"]);
  expect(rows.some((r) => r.sessionId === "empty")).toBe(false);
});

test("listResumable returns [] when the projects dir is missing", async () => {
  expect(await listResumable(join(projectsDir, "does-not-exist"))).toEqual([]);
});

test("findTranscriptFile locates a transcript across project dirs; undefined when absent", async () => {
  const written = await writeTranscript("-some-proj", "find-me", userLine("hi"));
  expect(await findTranscriptFile(projectsDir, "find-me")).toBe(written);
  expect(await findTranscriptFile(projectsDir, "nope")).toBeUndefined();
});

test("defaultProjectsDir points at ~/.claude/projects", () => {
  expect(defaultProjectsDir()).toBe(join(homedir(), ".claude", "projects"));
});
