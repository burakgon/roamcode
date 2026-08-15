import { describe, expect, it, vi } from "vitest";
import {
  MAX_TERMINAL_CLIPBOARD_BYTES,
  parseItermClipboard,
  parseOsc52Clipboard,
  registerTerminalClipboardHandlers,
} from "./terminal-clipboard";

describe("terminal clipboard protocol", () => {
  it("decodes OSC 52 UTF-8 writes and supports the empty clear operation", () => {
    expect(parseOsc52Clipboard("c;aGVsbG8g8J+MjQ==")).toEqual({ handled: true, text: "hello 🌍" });
    expect(parseOsc52Clipboard(";")).toEqual({ handled: true, text: "" });
  });

  it("swallows clipboard reads, invalid selectors, malformed base64, and invalid UTF-8", () => {
    expect(parseOsc52Clipboard("c;?")).toEqual({ handled: true });
    expect(parseOsc52Clipboard("x;aGVsbG8=")).toEqual({ handled: true });
    expect(parseOsc52Clipboard("c;%%%=")).toEqual({ handled: true });
    expect(parseOsc52Clipboard("c;wyg=")).toEqual({ handled: true });
  });

  it("enforces the decoded 512 KiB limit before writing", () => {
    const accepted = globalThis.btoa("a".repeat(MAX_TERMINAL_CLIPBOARD_BYTES));
    const rejected = globalThis.btoa("a".repeat(MAX_TERMINAL_CLIPBOARD_BYTES + 1));
    expect(parseOsc52Clipboard(`c;${accepted}`).text).toHaveLength(MAX_TERMINAL_CLIPBOARD_BYTES);
    expect(parseOsc52Clipboard(`c;${rejected}`)).toEqual({ handled: true });
  });

  it("accepts only the iTerm2 Copy=: form and leaves unrelated OSC 1337 commands alone", () => {
    expect(parseItermClipboard("Copy=:aVRlcm0=")).toEqual({ handled: true, text: "iTerm" });
    expect(parseItermClipboard("Copy=:?")).toEqual({ handled: true });
    expect(parseItermClipboard("Copy=YWJjMTIz")).toEqual({ handled: true });
    expect(parseItermClipboard("Copy=:")).toEqual({ handled: true });
    expect(parseItermClipboard("CurrentDir=/tmp")).toEqual({ handled: false });
  });

  it("registers write-only handlers and disposes both registrations", () => {
    const handlers = new Map<number, (data: string) => boolean | Promise<boolean>>();
    const disposals = [vi.fn(), vi.fn()];
    let index = 0;
    const parser = {
      registerOscHandler(ident: number, callback: (data: string) => boolean | Promise<boolean>) {
        handlers.set(ident, callback);
        return { dispose: disposals[index++]! };
      },
    };
    const write = vi.fn();
    const registration = registerTerminalClipboardHandlers(parser, write);

    expect(handlers.get(52)?.("c;c2FmZQ==")).toBe(true);
    expect(handlers.get(52)?.("c;?")).toBe(true);
    expect(handlers.get(1337)?.("CurrentDir=/tmp")).toBe(false);
    expect(write).toHaveBeenCalledOnce();
    expect(write).toHaveBeenCalledWith("safe");

    registration.dispose();
    expect(disposals.every((dispose) => dispose.mock.calls.length === 1)).toBe(true);
  });
});
