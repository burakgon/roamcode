import { describe, expect, it, vi } from "vitest";
import { openTerminalWebLink, terminalWebUrl } from "./terminal-links";

describe("terminalWebUrl", () => {
  it.each([
    ["https://example.com/a?b=1#c", "https://example.com/a?b=1#c"],
    ["HTTP://EXAMPLE.COM/path", "http://example.com/path"],
    ["http://127.0.0.1:3000/status", "http://127.0.0.1:3000/status"],
  ])("accepts and canonicalizes %s", (raw, expected) => {
    expect(terminalWebUrl(raw)).toBe(expected);
  });

  it.each([
    "javascript:alert(1)",
    "data:text/html,hello",
    "file:///etc/passwd",
    "mailto:user@example.com",
    "www.example.com",
    "https://example.com/line\nbreak",
    "not a URL",
  ])("rejects unsafe or ambiguous target %s", (raw) => {
    expect(terminalWebUrl(raw)).toBeUndefined();
  });
});

describe("openTerminalWebLink", () => {
  it("severs opener before navigating the new window", () => {
    const popup = {
      opener: { unsafe: true },
      location: { href: "about:blank" },
      close: vi.fn(),
    } as unknown as Window;
    const openWindow = vi.fn(() => popup);

    expect(openTerminalWebLink("https://example.com/docs", openWindow)).toBe(true);
    expect(openWindow).toHaveBeenCalledOnce();
    expect(popup.opener).toBeNull();
    expect(popup.location.href).toBe("https://example.com/docs");
  });

  it("does not open invalid protocols and reports a blocked popup", () => {
    const openWindow = vi.fn(() => null);

    expect(openTerminalWebLink("javascript:alert(1)", openWindow)).toBe(false);
    expect(openWindow).not.toHaveBeenCalled();
    expect(openTerminalWebLink("https://example.com", openWindow)).toBe(false);
    expect(openWindow).toHaveBeenCalledOnce();
  });
});
