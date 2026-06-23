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
    expect((box as HTMLTextAreaElement).value).toBe("");
  });

  it("does not send on Shift+Enter (newline)", async () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} onUploadFile={vi.fn()} />);
    const box = screen.getByLabelText(/message claude/i);
    await userEvent.type(box, "line1{Shift>}{Enter}{/Shift}line2");
    expect(onSend).not.toHaveBeenCalled();
    expect((box as HTMLTextAreaElement).value).toContain("line1");
    expect((box as HTMLTextAreaElement).value).toContain("line2");
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

  it("fills the textarea when a slash command is selected from the menu", async () => {
    render(<Composer onSend={vi.fn()} onUploadFile={vi.fn()} />);
    const box = screen.getByLabelText(/message claude/i) as HTMLTextAreaElement;
    await userEvent.type(box, "/cl");
    await userEvent.click(screen.getByText("/clear"));
    expect(box.value).toBe("/clear ");
  });
});
