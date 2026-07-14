import { fireEvent, render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { ImageEditorModal } from "./ImageEditorModal";

test("an unsupported image is never silently converted and can be sent only as the original", () => {
  const file = new File(["animated"], "animation.gif", { type: "image/gif" });
  const onSend = vi.fn();
  const onCancel = vi.fn();
  render(
    <ImageEditorModal
      file={file}
      index={0}
      total={1}
      maxBytes={25 * 1024 * 1024}
      onSend={onSend}
      onCancel={onCancel}
    />,
  );

  expect(screen.getByText("This format can't be edited safely")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Send original" }));
  expect(onSend).toHaveBeenCalledWith(file);
  expect(onCancel).not.toHaveBeenCalled();
});

test("Cancel abandons the remaining image batch without uploading", () => {
  const file = new File(["modern"], "photo.heic", { type: "image/heic" });
  const onSend = vi.fn();
  const onCancel = vi.fn();
  render(
    <ImageEditorModal
      file={file}
      index={1}
      total={3}
      maxBytes={25 * 1024 * 1024}
      onSend={onSend}
      onCancel={onCancel}
    />,
  );

  expect(screen.getByText(/2 \/ 3/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(onCancel).toHaveBeenCalledTimes(1);
  expect(onSend).not.toHaveBeenCalled();
});
