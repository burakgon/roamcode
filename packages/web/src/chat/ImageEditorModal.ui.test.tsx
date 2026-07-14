import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";

vi.mock("react-konva/lib/ReactKonvaCore.js", async () => {
  const React = await import("react");
  const Container = ({ children }: { children?: React.ReactNode }) => <>{children}</>;
  const Stage = React.forwardRef<unknown, { width: number; height: number; children?: React.ReactNode }>(
    ({ width, height, children }, ref) => {
      React.useImperativeHandle(ref, () => ({ getPointerPosition: () => undefined }));
      return (
        <div data-testid="konva-stage" data-width={width} data-height={height}>
          {children}
        </div>
      );
    },
  );
  const Rect = React.forwardRef<unknown, { children?: React.ReactNode }>(({ children }, ref) => {
    React.useImperativeHandle(ref, () => ({}));
    return <>{children}</>;
  });
  const Transformer = React.forwardRef<unknown>((_, ref) => {
    React.useImperativeHandle(ref, () => ({ nodes: () => {}, getLayer: () => ({ batchDraw: () => {} }) }));
    return null;
  });
  const Image = () => <div data-testid="konva-image" />;
  return {
    Arrow: Container,
    Group: Container,
    Image,
    Layer: Container,
    Line: Container,
    Rect,
    Stage,
    Text: Container,
    Transformer,
  };
});
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

test("measures the canvas after a supported image loads instead of leaving a one-pixel black stage", async () => {
  const originalImage = window.Image;
  const width = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(640);
  const height = vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(480);
  class LoadedImage {
    decoding = "";
    naturalWidth = 1200;
    naturalHeight = 800;
    onload?: () => void;
    onerror?: () => void;
    set src(_value: string) {
      queueMicrotask(() => this.onload?.());
    }
  }
  Object.defineProperty(window, "Image", { configurable: true, value: LoadedImage });

  try {
    render(
      <ImageEditorModal
        file={new File(["png"], "photo.png", { type: "image/png" })}
        index={0}
        total={1}
        maxBytes={25 * 1024 * 1024}
        onSend={() => {}}
        onCancel={() => {}}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("konva-stage")).toHaveAttribute("data-width", "640");
      expect(screen.getByTestId("konva-stage")).toHaveAttribute("data-height", "480");
    });
    expect(screen.getByTestId("konva-image")).toBeInTheDocument();
  } finally {
    Object.defineProperty(window, "Image", { configurable: true, value: originalImage });
    width.mockRestore();
    height.mockRestore();
  }
});
