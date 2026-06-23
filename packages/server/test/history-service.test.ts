import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { HistoryService } from "../src/index.js";
import { encodeProjectDir } from "@remote-coder/protocol";

let claudeHome: string;
beforeEach(async () => {
  claudeHome = await mkdtemp(join(tmpdir(), "rc-home-"));
});
afterEach(async () => {
  await rm(claudeHome, { recursive: true, force: true });
});

test("read() resolves the jsonl from cwd+id and returns parsed turns", async () => {
  const cwd = "/work/proj";
  const dir = join(claudeHome, ".claude", "projects", encodeProjectDir(cwd));
  await mkdir(dir, { recursive: true });
  const lines = [
    JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: "q" }] } }),
    JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "a" }] } }),
  ].join("\n");
  await writeFile(join(dir, "sid-1.jsonl"), lines);

  const svc = new HistoryService({ claudeHome });
  const turns = await svc.read(cwd, "sid-1");
  expect(turns.map((t) => t.type)).toEqual(["user", "assistant"]);
});

test("read() returns [] when the transcript file is missing (no throw)", async () => {
  const svc = new HistoryService({ claudeHome });
  expect(await svc.read("/nope", "missing")).toEqual([]);
});

test("the default claudeHome is the OS home dir", () => {
  const svc = new HistoryService();
  expect(svc.claudeHome).toBe(homedir());
});
