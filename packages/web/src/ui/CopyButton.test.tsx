import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CopyButton } from "./CopyButton";

// jsdom has no navigator.clipboard — install a writable mock per test.
let writeText: ReturnType<typeof vi.fn>;
beforeEach(() => {
  writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
});
afterEach(() => vi.restoreAllMocks());

describe("CopyButton", () => {
  it("writes the given text to the clipboard on tap", async () => {
    render(<CopyButton text="hello world" label="Copy message" />);
    await userEvent.click(screen.getByRole("button", { name: /copy message/i }));
    expect(writeText).toHaveBeenCalledWith("hello world");
  });

  it("toggles to a 'Copied' state after copying", async () => {
    render(<CopyButton text="x" label="Copy output" />);
    const btn = screen.getByRole("button", { name: /copy output/i });
    await userEvent.click(btn);
    // The accessible name flips to "Copied" once the write resolves.
    expect(await screen.findByRole("button", { name: /^copied$/i })).toBeInTheDocument();
  });

  it("does not throw when the clipboard is unavailable", async () => {
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
      configurable: true,
    });
    render(<CopyButton text="x" label="Copy path" />);
    // A rejected write is swallowed — the button stays in its idle state, no error.
    await userEvent.click(screen.getByRole("button", { name: /copy path/i }));
    expect(screen.getByRole("button", { name: /copy path/i })).toBeInTheDocument();
  });
});
