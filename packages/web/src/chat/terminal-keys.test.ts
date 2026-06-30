import { expect, test } from "vitest";
import { KEY_SEQUENCES, ctrlSeq } from "./terminal-keys";

test("escape sequences are correct", () => {
  expect(KEY_SEQUENCES.Esc).toBe("\x1b");
  expect(KEY_SEQUENCES.Tab).toBe("\t");
  expect(KEY_SEQUENCES.ArrowUp).toBe("\x1b[A");
  expect(KEY_SEQUENCES.ArrowDown).toBe("\x1b[B");
  expect(KEY_SEQUENCES.ArrowRight).toBe("\x1b[C");
  expect(KEY_SEQUENCES.ArrowLeft).toBe("\x1b[D");
});

test("navigation keys (Home/End/PgUp/PgDn) emit the right sequences", () => {
  expect(KEY_SEQUENCES.Home).toBe("\x1b[H");
  expect(KEY_SEQUENCES.End).toBe("\x1b[F");
  expect(KEY_SEQUENCES.PageUp).toBe("\x1b[5~");
  expect(KEY_SEQUENCES.PageDown).toBe("\x1b[6~");
});

test("ctrl maps a-z to control bytes", () => {
  expect(ctrlSeq("c")).toBe("\x03");
  expect(ctrlSeq("C")).toBe("\x03");
  expect(ctrlSeq("d")).toBe("\x04");
});
