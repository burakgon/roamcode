import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Composer } from "./Composer";
import * as imageUtil from "./image-util";

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

  it("attaches a picked image as a base64 image block in the outbound user frame", async () => {
    const onSend = vi.fn();
    const { container } = render(<Composer onSend={onSend} onUploadFile={vi.fn()} />);
    const file = new File(["png-bytes"], "shot.png", { type: "image/png" });
    const imageInput = container.querySelector('input[accept="image/*"]') as HTMLInputElement;
    await userEvent.upload(imageInput, file);
    // The thumbnail/chip with a remove control appears once the image is read.
    await screen.findByLabelText(/remove shot\.png/i);

    const box = screen.getByLabelText(/message claude/i);
    await userEvent.type(box, "look at this");
    await userEvent.click(screen.getByLabelText(/^send$/i));

    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledWith({
      type: "user",
      text: "look at this",
      images: [{ mediaType: "image/png", dataBase64: btoa("png-bytes") }],
    });
  });

  it("surfaces an error and stays usable when reading the image fails", async () => {
    const onSend = vi.fn();
    vi.spyOn(imageUtil, "fileToBase64").mockRejectedValue(new Error("failed to read file"));
    const { container } = render(<Composer onSend={onSend} onUploadFile={vi.fn()} />);
    const file = new File(["png-bytes"], "broken.png", { type: "image/png" });
    const imageInput = container.querySelector('input[accept="image/*"]') as HTMLInputElement;
    await userEvent.upload(imageInput, file);

    // An error is surfaced...
    expect(await screen.findByRole("alert")).toHaveTextContent(/failed to read/i);
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
