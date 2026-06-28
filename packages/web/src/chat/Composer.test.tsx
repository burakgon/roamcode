import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Composer } from "./Composer";

// jsdom has no URL.createObjectURL/revokeObjectURL — the composer uses them for the inline image
// thumbnail preview, so stub them for the test environment.
beforeEach(() => {
  (URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL = vi.fn(() => "blob:mock");
  (URL as unknown as { revokeObjectURL: (u: string) => void }).revokeObjectURL = vi.fn();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Composer", () => {
  it("sends a text message on Enter and clears the field", async () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} onUploadFile={vi.fn()} />);
    const box = screen.getByLabelText(/message claude/i);
    await userEvent.type(box, "hello there{Enter}");
    expect(onSend).toHaveBeenCalledWith({ type: "user", text: "hello there" });
    expect(box.textContent).toBe("");
  });

  it("does not send on Shift+Enter (newline)", async () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} onUploadFile={vi.fn()} />);
    const box = screen.getByLabelText(/message claude/i);
    await userEvent.type(box, "line1{Shift>}{Enter}{/Shift}line2");
    expect(onSend).not.toHaveBeenCalled();
    expect(box.textContent).toContain("line1");
    expect(box.textContent).toContain("line2");
  });

  it("shows the slash menu when the text starts with /", async () => {
    render(<Composer onSend={vi.fn()} onUploadFile={vi.fn()} />);
    await userEvent.type(screen.getByLabelText(/message claude/i), "/co");
    expect(screen.getByText("/compact")).toBeInTheDocument();
    expect(screen.getByText("/cost")).toBeInTheDocument();
  });

  it("does not send when empty (no text, no images)", async () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} onUploadFile={vi.fn()} />);
    const box = screen.getByLabelText(/message claude/i);
    // Enter on an empty field is a no-op.
    await userEvent.type(box, "{Enter}");
    // Clicking Send with an empty field is a no-op too.
    await userEvent.click(screen.getByLabelText(/^send$/i));
    expect(onSend).not.toHaveBeenCalled();
  });

  it("offers Send ALONGSIDE Stop while a turn is running, and queues the message", async () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} onUploadFile={vi.fn()} running onStop={vi.fn()} />);
    const box = screen.getByLabelText(/message claude/i);
    await userEvent.type(box, "do this next");
    // With text + running, BOTH Stop (interrupt) and Send (queue the next message) are reachable.
    expect(screen.getByLabelText(/^stop$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^send$/i)).toBeInTheDocument();
    await userEvent.click(screen.getByLabelText(/^send$/i));
    expect(onSend).toHaveBeenCalledWith({ type: "user", text: "do this next" });
  });

  it("shows only Stop (no Send) while running with an empty field", () => {
    render(<Composer onSend={vi.fn()} onUploadFile={vi.fn()} running onStop={vi.fn()} />);
    expect(screen.getByLabelText(/^stop$/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/^send$/i)).not.toBeInTheDocument();
  });

  it("uploads a picked image to the store and sends its ref (no base64) in the outbound user frame", async () => {
    const onSend = vi.fn();
    const onUploadImage = vi.fn().mockResolvedValue({ ref: "deadbeef.png" });
    const { container } = render(<Composer onSend={onSend} onUploadFile={vi.fn()} onUploadImage={onUploadImage} />);
    const file = new File(["png-bytes"], "shot.png", { type: "image/png" });
    const imageInput = container.querySelector('input[accept="image/*"]') as HTMLInputElement;
    await userEvent.upload(imageInput, file);
    // The thumbnail/chip with a remove control appears once the image is uploaded.
    await screen.findByLabelText(/remove shot\.png/i);
    expect(onUploadImage).toHaveBeenCalledWith(file);

    const box = screen.getByLabelText(/message claude/i);
    await userEvent.type(box, "look at this");
    await userEvent.click(screen.getByLabelText(/^send$/i));

    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledWith({ type: "user", text: "look at this", imageRefs: ["deadbeef.png"] });
  });

  it("surfaces an error and stays usable when the image upload fails", async () => {
    const onSend = vi.fn();
    const onUploadImage = vi.fn().mockRejectedValue(new Error("upload failed (413)"));
    const { container } = render(<Composer onSend={onSend} onUploadFile={vi.fn()} onUploadImage={onUploadImage} />);
    const file = new File(["png-bytes"], "broken.png", { type: "image/png" });
    const imageInput = container.querySelector('input[accept="image/*"]') as HTMLInputElement;
    await userEvent.upload(imageInput, file);

    // An error is surfaced...
    expect(await screen.findByRole("alert")).toHaveTextContent(/upload failed/i);
    // ...no image chip is attached...
    expect(screen.queryByLabelText(/remove broken\.png/i)).not.toBeInTheDocument();
    // ...and the composer is still usable: a plain text message still sends.
    const box = screen.getByLabelText(/message claude/i);
    await userEvent.type(box, "still works");
    await userEvent.click(screen.getByLabelText(/^send$/i));
    expect(onSend).toHaveBeenCalledWith({ type: "user", text: "still works" });
  });

  it("rejects an unsupported image type and does not attach it", async () => {
    const onSend = vi.fn();
    const { container } = render(<Composer onSend={onSend} onUploadFile={vi.fn()} />);
    const file = new File(["x"], "bad.bmp", { type: "image/bmp" });
    const imageInput = container.querySelector('input[accept="image/*"]') as HTMLInputElement;
    await userEvent.upload(imageInput, file);
    expect(await screen.findByRole("alert")).toHaveTextContent(/unsupported/i);
    expect(screen.queryByLabelText(/remove bad\.bmp/i)).not.toBeInTheDocument();
  });

  it("uploads a general file via onUploadFile", async () => {
    const onUploadFile = vi.fn().mockResolvedValue(undefined);
    const { container } = render(<Composer onSend={vi.fn()} onUploadFile={onUploadFile} />);
    const file = new File(["data"], "notes.txt", { type: "text/plain" });
    // The general file input has no accept filter (distinguishes it from the image input).
    const fileInput = container.querySelector('input[type="file"]:not([accept])') as HTMLInputElement;
    await userEvent.upload(fileInput, file);
    await waitFor(() => expect(onUploadFile).toHaveBeenCalledWith(file));
  });

  it("surfaces a 413/400 upload error from onUploadFile", async () => {
    const onUploadFile = vi.fn().mockRejectedValue(new Error("file too large (413)"));
    const { container } = render(<Composer onSend={vi.fn()} onUploadFile={onUploadFile} />);
    const file = new File(["data"], "big.bin", { type: "application/octet-stream" });
    const fileInput = container.querySelector('input[type="file"]:not([accept])') as HTMLInputElement;
    await userEvent.upload(fileInput, file);
    expect(await screen.findByRole("alert")).toHaveTextContent(/413/);
  });

  it("fills the field when a slash command is selected from the menu", async () => {
    render(<Composer onSend={vi.fn()} onUploadFile={vi.fn()} />);
    const box = screen.getByLabelText(/message claude/i);
    await userEvent.type(box, "/cl");
    await userEvent.click(screen.getByText("/clear"));
    expect(box.textContent).toBe("/clear ");
  });

  it("shows /resume in the slash menu when typing /r and /resume", async () => {
    // The menu row carries the command's hint — a stable, unique handle for the /resume entry. Two
    // fresh mounts rather than clearing the contentEditable between (userEvent.clear is input-only).
    const { unmount } = render(<Composer onSend={vi.fn()} onUploadFile={vi.fn()} />);
    await userEvent.type(screen.getByLabelText(/message claude/i), "/r");
    expect(screen.getByText(/resume a past session/i)).toBeInTheDocument();
    unmount();
    render(<Composer onSend={vi.fn()} onUploadFile={vi.fn()} />);
    await userEvent.type(screen.getByLabelText(/message claude/i), "/resume");
    expect(screen.getByText(/resume a past session/i)).toBeInTheDocument();
  });

  it("clicking /resume runs the client action and clears the input (does NOT setText, does NOT send)", async () => {
    const onSend = vi.fn();
    const onSlashCommand = vi.fn();
    render(<Composer onSend={onSend} onUploadFile={vi.fn()} onSlashCommand={onSlashCommand} />);
    const box = screen.getByLabelText(/message claude/i);
    await userEvent.type(box, "/res");
    await userEvent.click(screen.getByText("/resume"));
    expect(onSlashCommand).toHaveBeenCalledWith("/resume");
    // The input is cleared (not filled with "/resume ") and nothing was sent to claude.
    expect(box.textContent).toBe("");
    expect(onSend).not.toHaveBeenCalled();
  });

  it("Enter on the sole /resume match runs the client action and clears the input (does not send)", async () => {
    const onSend = vi.fn();
    const onSlashCommand = vi.fn();
    render(<Composer onSend={onSend} onUploadFile={vi.fn()} onSlashCommand={onSlashCommand} />);
    const box = screen.getByLabelText(/message claude/i);
    await userEvent.type(box, "/resume{Enter}");
    expect(onSlashCommand).toHaveBeenCalledWith("/resume");
    expect(box.textContent).toBe("");
    expect(onSend).not.toHaveBeenCalled();
  });

  it("shows Send (not Stop) when idle and Stop (not Send) while running", () => {
    const { rerender } = render(<Composer onSend={vi.fn()} onUploadFile={vi.fn()} />);
    // Idle: Send is present, Stop is not.
    expect(screen.getByRole("button", { name: /^send$/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^stop$/i })).not.toBeInTheDocument();

    // Running: the primary control becomes Stop, and Send is gone.
    rerender(<Composer onSend={vi.fn()} onUploadFile={vi.fn()} running onStop={vi.fn()} />);
    expect(screen.getByRole("button", { name: /^stop$/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^send$/i })).not.toBeInTheDocument();
  });

  it("tapping Stop while running calls onStop and reflects 'stopping' immediately", async () => {
    const onStop = vi.fn();
    render(<Composer onSend={vi.fn()} onUploadFile={vi.fn()} running onStop={onStop} />);
    const stop = screen.getByRole("button", { name: /^stop$/i });
    await userEvent.click(stop);
    expect(onStop).toHaveBeenCalledTimes(1);
    // Immediately reflects "stopping": the button relabels and disables (no double-send).
    const stopping = screen.getByRole("button", { name: /stopping/i });
    expect(stopping).toBeDisabled();
    await userEvent.click(stopping);
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it("closes the slash menu once a space begins the arguments (no lingering /model over '/model opus')", async () => {
    render(<Composer onSend={vi.fn()} onUploadFile={vi.fn()} />);
    const box = screen.getByLabelText(/message claude/i);
    // A prefix ("/comp") that differs from the full command, so the only "/compact" on screen is the menu
    // row (the input shows "/comp", not "/compact").
    await userEvent.type(box, "/comp");
    expect(screen.getByText("/compact")).toBeInTheDocument();
    await userEvent.type(box, " now");
    expect(screen.queryByText("/compact")).not.toBeInTheDocument();
  });

  it("dismisses the slash menu on Escape without clearing the text, and typing re-opens it", async () => {
    render(<Composer onSend={vi.fn()} onUploadFile={vi.fn()} />);
    const box = screen.getByLabelText(/message claude/i);
    await userEvent.type(box, "/co");
    expect(screen.getByText("/compact")).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByText("/compact")).not.toBeInTheDocument();
    expect(box.textContent).toBe("/co");
    await userEvent.type(box, "m");
    expect(screen.getByText("/compact")).toBeInTheDocument();
  });

  it("recalls previously-sent messages with ↑/↓ from an empty field (REPL history)", async () => {
    render(<Composer onSend={vi.fn()} onUploadFile={vi.fn()} />);
    const box = screen.getByLabelText(/message claude/i);
    await userEvent.type(box, "first{Enter}");
    await userEvent.type(box, "second{Enter}");
    // Empty field → ↑ recalls the newest, then older.
    await userEvent.type(box, "{ArrowUp}");
    expect(box.textContent).toBe("second");
    await userEvent.type(box, "{ArrowUp}");
    expect(box.textContent).toBe("first");
    // ↓ walks back toward the newest, then past it to the empty draft.
    await userEvent.type(box, "{ArrowDown}");
    expect(box.textContent).toBe("second");
    await userEvent.type(box, "{ArrowDown}");
    expect(box.textContent).toBe("");
  });

  it("exposes the image / file / send controls as icon BUTTONS reachable by their aria-labels", () => {
    // Phase 2 replaced the text Image/File/Send buttons with icon buttons. They must stay real
    // <button>s named by aria-label (a11y + so screen readers and these tests can reach them).
    render(<Composer onSend={vi.fn()} onUploadFile={vi.fn()} />);
    const image = screen.getByRole("button", { name: /add image/i });
    const file = screen.getByRole("button", { name: /upload file/i });
    const send = screen.getByRole("button", { name: /^send$/i });
    for (const btn of [image, file, send]) {
      expect(btn.tagName).toBe("BUTTON");
      // The label text is NOT a visible string — it lives on the icon button as aria-label only.
      expect(btn).toHaveAttribute("aria-label");
      expect(btn.querySelector("svg")).toBeInTheDocument();
    }
  });
});
