import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TerminalFiles, type TermFile } from "./TerminalFiles";

const imageFile: TermFile = {
  id: "f1",
  name: "shot.png",
  path: "/data/terminal-shared/s1/shot.png",
  isImage: true,
  source: "received",
};

function renderPanel(overrides: Partial<React.ComponentProps<typeof TerminalFiles>> = {}) {
  return render(
    <TerminalFiles
      files={[imageFile]}
      open
      onClose={vi.fn()}
      onUpload={vi.fn()}
      downloadUrl={(p) => `/fs/download?path=${encodeURIComponent(p)}`}
      {...overrides}
    />,
  );
}

afterEach(() => {
  // Reset history state the lightbox pushes, so tests don't bleed into each other.
  vi.restoreAllMocks();
});

describe("TerminalFiles image viewer — dismissible", () => {
  it("opens a fullscreen preview with a visible Close button when a thumbnail is tapped", () => {
    renderPanel();
    // No preview initially.
    expect(screen.queryByRole("dialog", { name: "Image preview" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "shot.png" }));
    // Preview is open AND there is an obvious way out (the previous version had none).
    expect(screen.getByRole("dialog", { name: "Image preview" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close image" })).toBeInTheDocument();
  });

  it("closes the preview when the Close (X) button is pressed", () => {
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "shot.png" }));
    fireEvent.click(screen.getByRole("button", { name: "Close image" }));
    expect(screen.queryByRole("dialog", { name: "Image preview" })).not.toBeInTheDocument();
  });

  it("closes the preview on Escape", () => {
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "shot.png" }));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Image preview" })).not.toBeInTheDocument();
  });

  it("closes the preview on a browser BACK press (popstate)", () => {
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "shot.png" }));
    expect(screen.getByRole("dialog", { name: "Image preview" })).toBeInTheDocument();
    // A real back gesture fires popstate → the viewer closes instead of the app navigating away.
    fireEvent.popState(window);
    expect(screen.queryByRole("dialog", { name: "Image preview" })).not.toBeInTheDocument();
  });
});

describe("TerminalFiles transfer center", () => {
  it("keeps received and sent history in separate tabs and marks received files seen", () => {
    const seen = vi.fn();
    const sent: TermFile = { ...imageFile, id: "sent", source: "sent", name: "sent.png", storage: "managed" };
    renderPanel({ files: [imageFile, sent], unreadReceived: 1, onMarkReceivedSeen: seen });

    expect(screen.getByRole("button", { name: "shot.png" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "sent.png" })).not.toBeInTheDocument();
    expect(seen).toHaveBeenCalled();

    fireEvent.click(screen.getByRole("tab", { name: /Sent 1/ }));
    expect(screen.getByRole("button", { name: "sent.png" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "shot.png" })).not.toBeInTheDocument();
  });

  it("shows byte progress, cancellation, and automatically opens the Sent tab", () => {
    const cancel = vi.fn();
    const uploading: TermFile = {
      ...imageFile,
      id: "upload",
      source: "sent",
      name: "upload.png",
      uploading: true,
      progress: 0.42,
    };
    renderPanel({ files: [uploading], onCancel: cancel });

    expect(screen.getByRole("progressbar", { name: "Uploading upload.png" })).toHaveAttribute("aria-valuenow", "42");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(cancel).toHaveBeenCalledWith(uploading);
  });

  it("uses the standard multi-file input and passes every selected file to the upload flow", () => {
    const onUpload = vi.fn();
    const view = renderPanel({ files: [], onUpload });
    const input = view.container.querySelector<HTMLInputElement>('input[type="file"]')!;
    const files = [new File(["a"], "a.txt", { type: "text/plain" }), new File(["b"], "b.txt", { type: "text/plain" })];

    fireEvent.change(input, { target: { files } });
    expect(input.multiple).toBe(true);
    expect(onUpload).toHaveBeenCalledTimes(1);
    expect(Array.from(onUpload.mock.calls[0]![0] as FileList).map((file) => file.name)).toEqual(["a.txt", "b.txt"]);
  });

  it("removes a file from the list with an undo action", () => {
    const hide = vi.fn();
    const restore = vi.fn();
    renderPanel({ onHide: hide, onRestore: restore });

    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(hide).toHaveBeenCalledWith(imageFile);
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(restore).toHaveBeenCalledWith(imageFile);
  });

  it("keeps permanent deletion behind an explicit confirmation for managed sent files", () => {
    const sent: TermFile = { ...imageFile, source: "sent", storage: "managed" };
    const onDelete = vi.fn();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    renderPanel({ files: [sent], onDelete });

    fireEvent.click(screen.getByRole("tab", { name: /Sent 1/ }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(window.confirm).toHaveBeenCalled();
    expect(onDelete).toHaveBeenCalledWith(sent);
  });
});
