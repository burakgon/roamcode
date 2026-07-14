import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";

vi.mock("react-konva/lib/ReactKonvaCore.js", async () => {
  const React = await import("react");
  const Container = ({ children }: { children?: React.ReactNode }) => <>{children}</>;
  const Stage = React.forwardRef<
    unknown,
    { width: number; height: number; children?: React.ReactNode; onMouseDown?: (event: unknown) => void }
  >(({ width, height, children, onMouseDown }, ref) => {
    const stage = React.useMemo(() => {
      const node = {
        getPointerPosition: () => ({ x: 200, y: 200 }),
        container: () => ({ getBoundingClientRect: () => ({ left: 0, top: 0 }) }),
        getStage: () => node,
      };
      return node;
    }, []);
    React.useImperativeHandle(ref, () => stage);
    return (
      <div
        data-testid="konva-stage"
        data-width={width}
        data-height={height}
        onMouseDown={() => onMouseDown?.({ target: stage })}
      >
        {children}
      </div>
    );
  });
  const Rect = React.forwardRef<unknown, { children?: React.ReactNode }>(({ children }, ref) => {
    React.useImperativeHandle(ref, () => ({}));
    return <>{children}</>;
  });
  const Transformer = React.forwardRef<unknown>((_, ref) => {
    React.useImperativeHandle(ref, () => ({ nodes: () => {}, getLayer: () => ({ batchDraw: () => {} }) }));
    return null;
  });
  const Image = () => <div data-testid="konva-image" />;
  const Text = React.forwardRef<unknown, { text: string; draggable?: boolean }>(({ text, draggable }, ref) => {
    React.useImperativeHandle(ref, () => ({ x: () => 0, y: () => 0, scaleX: () => 1, scaleY: () => 1 }));
    return (
      <span data-testid="konva-text" data-draggable={draggable ? "true" : "false"}>
        {text}
      </span>
    );
  });
  return {
    Arrow: Container,
    Group: Container,
    Image,
    Layer: Container,
    Line: Container,
    Rect,
    Stage,
    Text,
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

test("keeps inserted text selectable, editable, draggable, and removable", async () => {
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
    await screen.findByTestId("konva-image");
    fireEvent.click(screen.getByRole("button", { name: "Text" }));
    fireEvent.mouseDown(screen.getByTestId("konva-stage"));
    const input = screen.getByRole("textbox", { name: "Image text" });
    expect(input).toHaveClass("rc-ie__textentry");
    expect(input).toHaveAttribute("size", "4");
    expect(input).toHaveStyle({ "--rc-ie-text-size": "28px" });
    expect(screen.queryByRole("button", { name: "1:1" })).toBeNull();
    expect(screen.queryByLabelText("Crop options")).toBeNull();
    fireEvent.change(input, { target: { value: "Move me" } });
    expect(input).toHaveAttribute("size", "7");
    fireEvent.blur(input);

    expect(await screen.findByTestId("konva-text")).toHaveAttribute("data-draggable", "true");
    fireEvent.click(screen.getByRole("button", { name: "Edit text" }));
    const editor = screen.getByRole("textbox", { name: "Image text" });
    expect(editor).toHaveValue("Move me");
    fireEvent.change(editor, { target: { value: "Updated" } });
    fireEvent.blur(editor);
    expect(screen.getByTestId("konva-text")).toHaveTextContent("Updated");

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(screen.queryByTestId("konva-text")).toBeNull();

    fireEvent.mouseDown(screen.getByTestId("konva-stage"));
    const cancelled = screen.getByRole("textbox", { name: "Image text" });
    fireEvent.change(cancelled, { target: { value: "Do not save" } });
    fireEvent.keyDown(cancelled, { key: "Escape" });
    expect(screen.queryByTestId("konva-text")).toBeNull();
  } finally {
    Object.defineProperty(window, "Image", { configurable: true, value: originalImage });
    width.mockRestore();
    height.mockRestore();
  }
});
