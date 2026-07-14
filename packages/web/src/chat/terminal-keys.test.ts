import { expect, test } from "vitest";
import {
  KEY_SEQUENCES,
  CURSOR_SEQUENCES,
  cursorSeq,
  keySequence,
  ctrlSeq,
  keyboardEventSequence,
  modifiedDataSequence,
} from "./terminal-keys";

test("mode-independent keys emit fixed sequences", () => {
  expect(KEY_SEQUENCES.Esc).toBe("\x1b");
  expect(KEY_SEQUENCES.Tab).toBe("\t");
  expect(KEY_SEQUENCES.PageUp).toBe("\x1b[5~");
  expect(KEY_SEQUENCES.PageDown).toBe("\x1b[6~");
  expect(KEY_SEQUENCES.ShiftTab).toBe("\x1b[Z"); // back-tab
  expect(KEY_SEQUENCES.Delete).toBe("\x1b[3~"); // forward-delete
  // punctuation a phone keyboard hides passes through unchanged
  expect(KEY_SEQUENCES["|"]).toBe("|");
  expect(KEY_SEQUENCES["~"]).toBe("~");
});

test("cursor keys are CSI in normal mode and SS3 in application-cursor mode (DECCKM)", () => {
  // normal mode → CSI `\x1b[`
  expect(CURSOR_SEQUENCES.ArrowUp![0]).toBe("\x1b[A");
  expect(cursorSeq("ArrowUp", false)).toBe("\x1b[A");
  expect(cursorSeq("ArrowDown", false)).toBe("\x1b[B");
  expect(cursorSeq("ArrowRight", false)).toBe("\x1b[C");
  expect(cursorSeq("ArrowLeft", false)).toBe("\x1b[D");
  expect(cursorSeq("Home", false)).toBe("\x1b[H");
  expect(cursorSeq("End", false)).toBe("\x1b[F");
  // application mode → SS3 `\x1bO` (what claude's full-screen TUI expects)
  expect(cursorSeq("ArrowUp", true)).toBe("\x1bOA");
  expect(cursorSeq("ArrowDown", true)).toBe("\x1bOB");
  expect(cursorSeq("ArrowRight", true)).toBe("\x1bOC");
  expect(cursorSeq("ArrowLeft", true)).toBe("\x1bOD");
  expect(cursorSeq("Home", true)).toBe("\x1bOH");
  expect(cursorSeq("End", true)).toBe("\x1bOF");
  // non-cursor labels → undefined
  expect(cursorSeq("Tab", true)).toBeUndefined();
});

test("keySequence routes cursor keys by mode and falls back to fixed/raw", () => {
  expect(keySequence("ArrowUp", false)).toBe("\x1b[A");
  expect(keySequence("ArrowUp", true)).toBe("\x1bOA");
  expect(keySequence("Esc", true)).toBe("\x1b"); // fixed, mode-independent
  expect(keySequence("/", false)).toBe("/"); // raw passthrough
});

test("ctrl maps a-z and the useful control chars to control bytes", () => {
  expect(ctrlSeq("c")).toBe("\x03");
  expect(ctrlSeq("C")).toBe("\x03");
  expect(ctrlSeq("d")).toBe("\x04");
  expect(ctrlSeq("a")).toBe("\x01");
  expect(ctrlSeq("z")).toBe("\x1a");
  expect(ctrlSeq(" ")).toBe("\x00");
  expect(ctrlSeq("@")).toBe("\x00");
  expect(ctrlSeq("[")).toBe("\x1b");
  expect(ctrlSeq("\\")).toBe("\x1c");
  expect(ctrlSeq("]")).toBe("\x1d");
  expect(ctrlSeq("^")).toBe("\x1e");
  expect(ctrlSeq("/")).toBe("\x1f");
  expect(ctrlSeq("_")).toBe("\x1f");
  // non-single-char input is returned unchanged
  expect(ctrlSeq("")).toBe("");
  expect(ctrlSeq("ab")).toBe("ab");
});

test("persistent Ctrl/Alt locks encode text and Backspace independently or together", () => {
  expect(keySequence("c", false, { ctrl: true, alt: false })).toBe("\x03");
  expect(keySequence("b", false, { ctrl: false, alt: true })).toBe("\x1bb");
  expect(keySequence("c", false, { ctrl: true, alt: true })).toBe("\x1b\x03");
  expect(keySequence("Backspace", false, { ctrl: false, alt: false })).toBe("\x7f");
  expect(keySequence("Backspace", false, { ctrl: true, alt: false })).toBe("\x08");
  expect(keySequence("Backspace", false, { ctrl: false, alt: true })).toBe("\x1b\x7f");
  expect(keySequence("Backspace", false, { ctrl: true, alt: true })).toBe("\x1b\x08");
  expect(modifiedDataSequence("\x7f", { ctrl: false, alt: true })).toBe("\x1b\x7f");
  expect(modifiedDataSequence("pasted text", { ctrl: true, alt: true })).toBe("pasted text");
});

test("modifier locks use standard CSI parameters for navigation keys", () => {
  expect(keySequence("ArrowLeft", false, { ctrl: false, alt: true })).toBe("\x1b[1;3D");
  expect(keySequence("ArrowLeft", true, { ctrl: true, alt: false })).toBe("\x1b[1;5D");
  expect(keySequence("End", true, { ctrl: true, alt: true })).toBe("\x1b[1;7F");
  expect(keySequence("PageUp", false, { ctrl: true, alt: true })).toBe("\x1b[5;7~");
  expect(keySequence("Delete", false, { ctrl: false, alt: true })).toBe("\x1b[3;3~");
  expect(keySequence("Tab", false, { ctrl: false, alt: true })).toBe("\x1b\t");
  expect(keySequence("Tab", false, { ctrl: true, alt: true, shift: true })).toBe("\x1b\x1b[Z");
});

test("DOM keyboard events share the modifier-aware encoder", () => {
  const event = (key: string, over: Partial<KeyboardEvent> = {}) => ({
    key,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...over,
  });
  expect(keyboardEventSequence(event("Backspace"), false, { ctrl: false, alt: true })).toBe("\x1b\x7f");
  expect(keyboardEventSequence(event("ArrowRight", { shiftKey: true }), true, { ctrl: true, alt: true })).toBe(
    "\x1b[1;8C",
  );
  expect(keyboardEventSequence(event("R"), false, { ctrl: true, alt: false })).toBe("\x12");
  expect(keyboardEventSequence(event("c", { metaKey: true }), false, { ctrl: true, alt: false })).toBeUndefined();
});
