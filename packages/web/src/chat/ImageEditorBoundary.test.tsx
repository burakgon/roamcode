import { fireEvent, render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { ImageEditorBoundary } from "./ImageEditorBoundary";

function BrokenEditor(): never {
  throw new Error("missing canvas shape");
}

test("contains an editor render failure and lets the original image continue without reloading the chat", () => {
  const onCancel = vi.fn();
  const onSendOriginal = vi.fn();
  vi.spyOn(console, "error").mockImplementation(() => {});

  render(
    <ImageEditorBoundary onCancel={onCancel} onSendOriginal={onSendOriginal}>
      <BrokenEditor />
    </ImageEditorBoundary>,
  );

  expect(screen.getByText("Image editor couldn't open")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /reload/i })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Send original" }));
  expect(onSendOriginal).toHaveBeenCalledTimes(1);
  expect(onCancel).not.toHaveBeenCalled();
});
