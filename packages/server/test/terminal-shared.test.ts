import { join, sep } from "node:path";
import { expect, test } from "vitest";
import { TERMINAL_SHARED_DIRNAME, terminalSharedBase, terminalSharedDir } from "../src/terminal-shared.js";

test("shared base sits under the DATA dir, never inside the session's project cwd", () => {
  const dataDir = "/home/u/.config/roamcode";
  const fsRoot = "/home/u";
  const base = terminalSharedBase({ dataDir, fsRoot });
  expect(base).toBe(join(dataDir, TERMINAL_SHARED_DIRNAME));
  // The whole point of the fix: it is NOT under the project the terminal was opened in.
  const projectCwd = "/home/u/Developer/roamcode";
  expect(base.startsWith(projectCwd + sep)).toBe(false);
});

test("per-session dir is a child of the base keyed by session id", () => {
  const opts = { dataDir: "/home/u/.config/roamcode", fsRoot: "/home/u", sessionId: "abc-123" };
  expect(terminalSharedDir(opts)).toBe(join(terminalSharedBase(opts), "abc-123"));
});

test("stays within fsRoot when the data dir is inside it (so /fs/download can serve it)", () => {
  const fsRoot = "/home/u";
  const base = terminalSharedBase({ dataDir: "/home/u/.config/roamcode", fsRoot });
  expect(base === fsRoot || base.startsWith(fsRoot + sep)).toBe(true);
});

test("falls back to a hidden dir INSIDE fsRoot when the data dir is outside a narrower FS_ROOT", () => {
  const fsRoot = "/home/u/project"; // operator narrowed FS_ROOT to a single project
  const dataDir = "/home/u/.config/roamcode"; // outside that narrower root
  const base = terminalSharedBase({ dataDir, fsRoot });
  expect(base).toBe(join(fsRoot, ".roamcode", TERMINAL_SHARED_DIRNAME));
  expect(base.startsWith(fsRoot + sep)).toBe(true); // still within fsRoot → download keeps working
});

test("falls back to a fsRoot dir when the data dir is unset", () => {
  const fsRoot = "/home/u";
  const base = terminalSharedBase({ fsRoot });
  expect(base).toBe(join(fsRoot, ".roamcode", TERMINAL_SHARED_DIRNAME));
});
