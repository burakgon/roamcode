import {
  GhosttyKey,
  KeyAction,
  Mods,
  MouseAction,
  MouseButton,
  type GhosttyFrame,
  type GhosttyMouseInput,
} from "./types";
import type { GhosttyRuntime, GhosttyTerminalCore } from "./runtime";
import type { GhosttySelectionInput } from "./runtime";

const KEY_MAP: Readonly<Record<string, GhosttyKey>> = {
  Backquote: GhosttyKey.Backquote,
  Backslash: GhosttyKey.Backslash,
  BracketLeft: GhosttyKey.BracketLeft,
  BracketRight: GhosttyKey.BracketRight,
  Comma: GhosttyKey.Comma,
  Digit0: GhosttyKey.Digit0,
  Digit1: GhosttyKey.Digit1,
  Digit2: GhosttyKey.Digit2,
  Digit3: GhosttyKey.Digit3,
  Digit4: GhosttyKey.Digit4,
  Digit5: GhosttyKey.Digit5,
  Digit6: GhosttyKey.Digit6,
  Digit7: GhosttyKey.Digit7,
  Digit8: GhosttyKey.Digit8,
  Digit9: GhosttyKey.Digit9,
  Equal: GhosttyKey.Equal,
  IntlBackslash: GhosttyKey.IntlBackslash,
  IntlRo: GhosttyKey.IntlRo,
  IntlYen: GhosttyKey.IntlYen,
  Minus: GhosttyKey.Minus,
  Period: GhosttyKey.Period,
  Quote: GhosttyKey.Quote,
  Semicolon: GhosttyKey.Semicolon,
  Slash: GhosttyKey.Slash,
  AltLeft: GhosttyKey.AltLeft,
  AltRight: GhosttyKey.AltRight,
  Backspace: GhosttyKey.Backspace,
  CapsLock: GhosttyKey.CapsLock,
  ContextMenu: GhosttyKey.ContextMenu,
  ControlLeft: GhosttyKey.ControlLeft,
  ControlRight: GhosttyKey.ControlRight,
  Enter: GhosttyKey.Enter,
  MetaLeft: GhosttyKey.MetaLeft,
  MetaRight: GhosttyKey.MetaRight,
  ShiftLeft: GhosttyKey.ShiftLeft,
  ShiftRight: GhosttyKey.ShiftRight,
  Space: GhosttyKey.Space,
  Tab: GhosttyKey.Tab,
  Delete: GhosttyKey.Delete,
  End: GhosttyKey.End,
  Help: GhosttyKey.Help,
  Home: GhosttyKey.Home,
  Insert: GhosttyKey.Insert,
  PageDown: GhosttyKey.PageDown,
  PageUp: GhosttyKey.PageUp,
  ArrowDown: GhosttyKey.ArrowDown,
  ArrowLeft: GhosttyKey.ArrowLeft,
  ArrowRight: GhosttyKey.ArrowRight,
  ArrowUp: GhosttyKey.ArrowUp,
  NumLock: GhosttyKey.NumLock,
  Numpad0: GhosttyKey.Numpad0,
  Numpad1: GhosttyKey.Numpad1,
  Numpad2: GhosttyKey.Numpad2,
  Numpad3: GhosttyKey.Numpad3,
  Numpad4: GhosttyKey.Numpad4,
  Numpad5: GhosttyKey.Numpad5,
  Numpad6: GhosttyKey.Numpad6,
  Numpad7: GhosttyKey.Numpad7,
  Numpad8: GhosttyKey.Numpad8,
  Numpad9: GhosttyKey.Numpad9,
  NumpadAdd: GhosttyKey.NumpadAdd,
  NumpadDecimal: GhosttyKey.NumpadDecimal,
  NumpadDivide: GhosttyKey.NumpadDivide,
  NumpadEnter: GhosttyKey.NumpadEnter,
  NumpadMultiply: GhosttyKey.NumpadMultiply,
  NumpadSubtract: GhosttyKey.NumpadSubtract,
  Escape: GhosttyKey.Escape,
  PrintScreen: GhosttyKey.PrintScreen,
  ScrollLock: GhosttyKey.ScrollLock,
  Pause: GhosttyKey.Pause,
};

for (let i = 0; i < 26; i++) {
  (KEY_MAP as Record<string, GhosttyKey>)[`Key${String.fromCharCode(65 + i)}`] = GhosttyKey.A + i;
}
for (let i = 1; i <= 24; i++) {
  (KEY_MAP as Record<string, GhosttyKey>)[`F${i}`] = GhosttyKey.F1 + i - 1;
}

function modifiers(event: KeyboardEvent | MouseEvent): number {
  let value = 0;
  if (event.shiftKey) value |= Mods.Shift;
  if (event.ctrlKey) value |= Mods.Control;
  if (event.altKey) value |= Mods.Alt;
  if (event.metaKey) value |= Mods.Super;
  if (event instanceof KeyboardEvent && event.getModifierState("CapsLock")) value |= Mods.CapsLock;
  if (event instanceof KeyboardEvent && event.getModifierState("NumLock")) value |= Mods.NumLock;
  return value;
}

export interface GhosttyCanvasTerminalOptions {
  onInput(data: string): void;
  onResize(cols: number, rows: number): void;
  onContextMenu?(request: GhosttyContextMenuRequest): void;
  onError?(error: Error): void;
  fontSize?: number;
  fontFamily?: string;
}

export interface GhosttyContextMenuRequest {
  clientX: number;
  clientY: number;
  selection: string;
}

export class GhosttyCanvasTerminal {
  private readonly host: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly context: CanvasRenderingContext2D;
  private readonly input: HTMLTextAreaElement;
  private readonly core: GhosttyTerminalCore;
  private readonly options: GhosttyCanvasTerminalOptions;
  private readonly fontSize: number;
  private readonly fontFamily: string;
  private readonly resizeObserver: ResizeObserver;
  private cellWidth = 8;
  private cellHeight = 17;
  private padding = 6;
  private readOnly = false;
  private frameRequest = 0;
  private disposed = false;
  private composing = false;
  private buttons = new Set<number>();
  private selecting = false;
  private listeners: Array<() => void> = [];

  constructor(runtime: GhosttyRuntime, host: HTMLElement, options: GhosttyCanvasTerminalOptions) {
    this.host = host;
    this.options = options;
    this.fontSize = options.fontSize ?? 13;
    this.fontFamily =
      options.fontFamily ?? '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace';
    this.canvas = document.createElement("canvas");
    this.canvas.className = "rc-ghostty-canvas";
    this.canvas.setAttribute("role", "img");
    this.canvas.setAttribute("aria-label", "Ghostty experimental terminal screen");
    const context = this.canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("Canvas 2D is unavailable");
    this.context = context;

    this.input = document.createElement("textarea");
    this.input.className = "rc-ghostty-input";
    this.input.setAttribute("aria-label", "Ghostty experimental terminal input");
    this.input.setAttribute("autocapitalize", "off");
    this.input.setAttribute("autocorrect", "off");
    this.input.setAttribute("autocomplete", "off");
    this.input.setAttribute("spellcheck", "false");
    this.input.tabIndex = 0;
    this.host.append(this.canvas, this.input);
    this.measureFont();
    const initial = this.measureGrid();
    this.core = runtime.createTerminal(initial.cols, initial.rows, 1000);
    this.core.resize(initial.cols, initial.rows, this.cellWidth, this.cellHeight);
    this.resizeCanvas();
    this.attachInput();
    this.resizeObserver = new ResizeObserver(() => this.fit());
    this.resizeObserver.observe(this.host);
    void document.fonts?.ready.then(() => {
      if (this.disposed) return;
      this.measureFont();
      this.fit();
    });
    this.render();
  }

  get cols(): number {
    return this.core.cols;
  }

  get rows(): number {
    return this.core.rows;
  }

  private measureFont(): void {
    const probe = document.createElement("canvas").getContext("2d");
    if (!probe) return;
    probe.font = `${this.fontSize}px ${this.fontFamily}`;
    const metrics = probe.measureText("M");
    this.cellWidth = Math.max(1, Math.ceil(metrics.width || this.fontSize * 0.62));
    const ascent = metrics.actualBoundingBoxAscent || this.fontSize * 0.8;
    const descent = metrics.actualBoundingBoxDescent || this.fontSize * 0.2;
    this.cellHeight = Math.max(1, Math.ceil(ascent + descent) + 2);
  }

  private measureGrid(): { cols: number; rows: number } {
    const width = Math.max(this.cellWidth, this.host.clientWidth - this.padding * 2);
    const height = Math.max(this.cellHeight, this.host.clientHeight - this.padding * 2);
    return {
      cols: Math.max(1, Math.floor(width / this.cellWidth)),
      rows: Math.max(1, Math.floor(height / this.cellHeight)),
    };
  }

  private resizeCanvas(): void {
    const ratio = window.devicePixelRatio || 1;
    const width = Math.max(1, this.host.clientWidth);
    const height = Math.max(1, this.host.clientHeight);
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
    this.canvas.width = Math.round(width * ratio);
    this.canvas.height = Math.round(height * ratio);
    this.context.setTransform(ratio, 0, 0, ratio, 0, 0);
  }

  fit(): void {
    if (this.disposed || this.host.clientHeight === 0 || this.host.clientWidth === 0) return;
    const grid = this.measureGrid();
    this.resizeCanvas();
    if (grid.cols !== this.core.cols || grid.rows !== this.core.rows) {
      this.core.resize(grid.cols, grid.rows, this.cellWidth, this.cellHeight);
      this.options.onResize(grid.cols, grid.rows);
    }
    this.scheduleRender();
  }

  write(bytes: Uint8Array): void {
    this.core.write(bytes);
    this.scheduleRender();
  }

  reset(): void {
    this.core.reset();
    this.scheduleRender();
  }

  setReadOnly(value: boolean): void {
    this.readOnly = value;
    this.input.disabled = value;
  }

  focus(): void {
    if (!this.readOnly) this.input.focus({ preventScroll: true });
  }

  paste(text: string): void {
    try {
      this.emit(this.core.encodePaste(text));
    } catch (error) {
      this.fail(error);
    }
  }

  selectAll(): string {
    try {
      if (!this.core.selectAll()) return "";
      this.scheduleRender();
      return this.core.selectionText();
    } catch (error) {
      this.fail(error);
      return "";
    }
  }

  private emit(bytes: Uint8Array): void {
    if (this.readOnly || bytes.length === 0) return;
    this.options.onInput(new TextDecoder().decode(bytes));
  }

  private encodeKeyboard(event: KeyboardEvent, action: KeyAction): Uint8Array {
    const key = KEY_MAP[event.code] ?? GhosttyKey.Unidentified;
    const printable = event.key.length === 1 ? event.key : undefined;
    return this.core.encodeKey({
      action,
      key,
      mods: modifiers(event),
      utf8: printable,
      composing: event.isComposing,
      unshiftedCodepoint: printable ? printable.toLowerCase().codePointAt(0) : undefined,
    });
  }

  private listen<K extends keyof HTMLElementEventMap>(
    target: HTMLElement | Window,
    type: K,
    listener: (event: HTMLElementEventMap[K]) => void,
    options?: AddEventListenerOptions,
  ): void {
    target.addEventListener(type, listener as EventListener, options);
    this.listeners.push(() => target.removeEventListener(type, listener as EventListener, options));
  }

  private attachInput(): void {
    this.listen(this.input, "keydown", (event) => {
      if (this.readOnly || this.composing || event.isComposing || event.keyCode === 229) return;
      if ((event.metaKey || event.ctrlKey) && event.code === "KeyV") return;
      try {
        const encoded = this.encodeKeyboard(event, event.repeat ? KeyAction.Repeat : KeyAction.Press);
        if (encoded.length === 0) return;
        event.preventDefault();
        event.stopPropagation();
        this.emit(encoded);
      } catch (error) {
        this.fail(error);
      }
    });
    this.listen(this.input, "keyup", (event) => {
      if (this.readOnly || this.composing || event.isComposing || event.keyCode === 229) return;
      try {
        const encoded = this.encodeKeyboard(event, KeyAction.Release);
        if (encoded.length === 0) return;
        event.preventDefault();
        this.emit(encoded);
      } catch (error) {
        this.fail(error);
      }
    });
    this.listen(this.input, "beforeinput", (event) => {
      if (this.readOnly || this.composing || event.isComposing) return;
      const data = event.data ?? "";
      try {
        let encoded: Uint8Array | undefined;
        if (event.inputType === "insertText" || event.inputType === "insertReplacementText") {
          if (data) {
            encoded = this.core.encodeKey({
              action: KeyAction.Press,
              key: GhosttyKey.Unidentified,
              mods: 0,
              utf8: data,
            });
          }
        } else if (event.inputType === "insertLineBreak" || event.inputType === "insertParagraph") {
          encoded = this.core.encodeKey({ action: KeyAction.Press, key: GhosttyKey.Enter, mods: 0 });
        } else if (event.inputType === "deleteContentBackward") {
          encoded = this.core.encodeKey({ action: KeyAction.Press, key: GhosttyKey.Backspace, mods: 0 });
        } else if (event.inputType === "deleteContentForward") {
          encoded = this.core.encodeKey({ action: KeyAction.Press, key: GhosttyKey.Delete, mods: 0 });
        } else if (event.inputType === "insertFromPaste" && data) {
          encoded = this.core.encodePaste(data);
        }
        if (!encoded) return;
        event.preventDefault();
        this.emit(encoded);
        this.input.value = "";
      } catch (error) {
        this.fail(error);
      }
    });
    this.listen(this.input, "compositionstart", () => {
      this.composing = true;
    });
    this.listen(this.input, "compositionend", (event) => {
      this.composing = false;
      if (!event.data || this.readOnly) return;
      try {
        this.emit(
          this.core.encodeKey({
            action: KeyAction.Press,
            key: GhosttyKey.Unidentified,
            mods: 0,
            utf8: event.data,
          }),
        );
        this.input.value = "";
      } catch (error) {
        this.fail(error);
      }
    });
    this.listen(this.input, "paste", (event) => {
      if (this.readOnly) return;
      const text = event.clipboardData?.getData("text/plain") ?? "";
      if (!text) return;
      event.preventDefault();
      try {
        this.emit(this.core.encodePaste(text));
      } catch (error) {
        this.fail(error);
      }
    });

    this.listen(this.canvas, "mousedown", (event) => {
      if (event.button === 2) return;
      this.focus();

      if (event.button === 0 && event.shiftKey) {
        this.startSelection(event);
        event.preventDefault();
        return;
      }

      this.buttons.add(event.button);
      const handled = this.emitMouse(event, MouseAction.Press, this.mouseButton(event.button));
      if (handled) {
        this.core.cancelSelection();
        this.scheduleRender();
        event.preventDefault();
        return;
      }

      this.buttons.delete(event.button);
      if (event.button === 0) {
        this.startSelection(event);
        event.preventDefault();
      }
    });
    this.listen(window, "mouseup", (event) => {
      if (event.button === 0 && this.selecting) {
        this.selecting = false;
        try {
          this.core.endSelection(this.selectionInput(event));
          this.scheduleRender();
          event.preventDefault();
        } catch (error) {
          this.fail(error);
        }
        return;
      }
      if (!this.buttons.has(event.button)) return;
      const button = this.mouseButton(event.button);
      this.buttons.delete(event.button);
      const handled = this.emitMouse(event, MouseAction.Release, button);
      if (handled) event.preventDefault();
    });
    this.listen(this.canvas, "mousemove", (event) => {
      if (this.selecting) {
        try {
          this.core.updateSelection(this.selectionInput(event));
          this.scheduleRender();
          event.preventDefault();
        } catch (error) {
          this.fail(error);
        }
        return;
      }
      const active = [...this.buttons][0];
      const handled = this.emitMouse(
        event,
        MouseAction.Motion,
        active === undefined ? undefined : this.mouseButton(active),
      );
      if (handled) event.preventDefault();
    });
    this.listen(
      this.canvas,
      "wheel",
      (event) => {
        const button = event.deltaY < 0 ? MouseButton.WheelUp : MouseButton.WheelDown;
        if (this.emitMouse(event, MouseAction.Press, button)) {
          event.preventDefault();
          return;
        }
        this.core.scrollViewport(event.deltaY < 0 ? -3 : 3);
        this.scheduleRender();
        event.preventDefault();
      },
      { passive: false },
    );
    this.listen(this.canvas, "contextmenu", (event) => {
      if (!this.options.onContextMenu) return;
      event.preventDefault();
      event.stopPropagation();
      try {
        this.core.selectWordAt(this.selectionInput(event));
        this.scheduleRender();
        this.options.onContextMenu({
          clientX: event.clientX,
          clientY: event.clientY,
          selection: this.core.selectionText(),
        });
      } catch (error) {
        this.fail(error);
      }
    });
  }

  private selectionInput(event: MouseEvent): GhosttySelectionInput {
    const rect = this.canvas.getBoundingClientRect();
    const x = Math.max(0, Math.min(rect.width, event.clientX - rect.left));
    const y = Math.max(0, Math.min(rect.height, event.clientY - rect.top));
    return {
      column: Math.max(0, Math.min(this.core.cols - 1, Math.floor((x - this.padding) / this.cellWidth))),
      row: Math.max(0, Math.min(this.core.rows - 1, Math.floor((y - this.padding) / this.cellHeight))),
      x,
      y,
      cellWidth: this.cellWidth,
      paddingLeft: this.padding,
      screenHeight: Math.max(1, rect.height),
      timeMs: event.timeStamp,
      rectangle: event.altKey,
    };
  }

  private startSelection(event: MouseEvent): void {
    try {
      this.selecting = this.core.beginSelection(this.selectionInput(event));
      this.scheduleRender();
    } catch (error) {
      this.selecting = false;
      this.fail(error);
    }
  }

  private mouseButton(button: number): MouseButton | undefined {
    return button === 0
      ? MouseButton.Left
      : button === 1
        ? MouseButton.Middle
        : button === 2
          ? MouseButton.Right
          : undefined;
  }

  private emitMouse(event: MouseEvent, action: MouseAction, button: MouseButton | undefined): boolean {
    if (this.readOnly) return false;
    const rect = this.canvas.getBoundingClientRect();
    const input: GhosttyMouseInput = {
      action,
      button,
      mods: modifiers(event),
      x: Math.max(0, event.clientX - rect.left - this.padding),
      y: Math.max(0, event.clientY - rect.top - this.padding),
      anyButtonPressed: this.buttons.size > 0,
      screenWidth: Math.max(1, rect.width - this.padding * 2),
      screenHeight: Math.max(1, rect.height - this.padding * 2),
      cellWidth: this.cellWidth,
      cellHeight: this.cellHeight,
    };
    try {
      const encoded = this.core.encodeMouse(input);
      if (encoded.length === 0) return false;
      this.emit(encoded);
      return true;
    } catch (error) {
      this.fail(error);
      return false;
    }
  }

  private scheduleRender(): void {
    if (this.disposed || this.frameRequest) return;
    this.frameRequest = requestAnimationFrame(() => {
      this.frameRequest = 0;
      this.render();
    });
  }

  private render(): void {
    if (this.disposed) return;
    try {
      this.draw(this.core.snapshot());
    } catch (error) {
      this.fail(error);
    }
  }

  private draw(frame: GhosttyFrame): void {
    const ratio = window.devicePixelRatio || 1;
    const width = this.canvas.width / ratio;
    const height = this.canvas.height / ratio;
    const ctx = this.context;
    ctx.fillStyle = frame.background;
    ctx.fillRect(0, 0, width, height);
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    const baseline = this.cellHeight - 3;

    for (let row = 0; row < frame.rows; row++) {
      const line = frame.cells[row];
      if (!line) continue;
      for (let col = 0; col < frame.cols; col++) {
        const cell = line[col];
        if (!cell) continue;
        const x = this.padding + col * this.cellWidth;
        const y = this.padding + row * this.cellHeight;
        let foreground = cell.foreground ?? frame.foreground;
        let background = cell.background ?? frame.background;
        if (cell.inverse) [foreground, background] = [background, foreground];
        if (cell.selected) [foreground, background] = [frame.background, frame.foreground];
        if (background !== frame.background) {
          ctx.fillStyle = background;
          ctx.fillRect(x, y, this.cellWidth * Math.max(1, cell.width), this.cellHeight);
        }
        if (cell.width === 0 || cell.invisible || cell.text === " ") continue;
        ctx.globalAlpha = cell.faint ? 0.6 : 1;
        ctx.font = `${cell.italic ? "italic " : ""}${cell.bold ? "700 " : ""}${this.fontSize}px ${this.fontFamily}`;
        ctx.fillStyle = foreground;
        ctx.fillText(cell.text, x, y + baseline);
        ctx.globalAlpha = 1;
        ctx.strokeStyle = foreground;
        ctx.lineWidth = 1;
        if (cell.underline) {
          ctx.beginPath();
          ctx.moveTo(x, y + this.cellHeight - 1.5);
          ctx.lineTo(x + this.cellWidth * Math.max(1, cell.width), y + this.cellHeight - 1.5);
          ctx.stroke();
        }
        if (cell.strikethrough) {
          ctx.beginPath();
          ctx.moveTo(x, y + this.cellHeight * 0.55);
          ctx.lineTo(x + this.cellWidth * Math.max(1, cell.width), y + this.cellHeight * 0.55);
          ctx.stroke();
        }
        if (cell.overline) {
          ctx.beginPath();
          ctx.moveTo(x, y + 1);
          ctx.lineTo(x + this.cellWidth * Math.max(1, cell.width), y + 1);
          ctx.stroke();
        }
      }
    }

    if (frame.cursor.visible) {
      const x = this.padding + frame.cursor.x * this.cellWidth;
      const y = this.padding + frame.cursor.y * this.cellHeight;
      ctx.fillStyle = frame.cursor.color;
      if (frame.cursor.style === "bar") ctx.fillRect(x, y, 2, this.cellHeight);
      else if (frame.cursor.style === "underline") ctx.fillRect(x, y + this.cellHeight - 2, this.cellWidth, 2);
      else if (frame.cursor.style === "hollow")
        ctx.strokeRect(x + 0.5, y + 0.5, this.cellWidth - 1, this.cellHeight - 1);
      else {
        ctx.globalAlpha = 0.65;
        ctx.fillRect(x, y, this.cellWidth, this.cellHeight);
        ctx.globalAlpha = 1;
      }
    }
  }

  private fail(error: unknown): void {
    this.options.onError?.(error instanceof Error ? error : new Error(String(error)));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.frameRequest) cancelAnimationFrame(this.frameRequest);
    this.frameRequest = 0;
    this.resizeObserver.disconnect();
    for (const dispose of this.listeners.splice(0)) dispose();
    this.core.dispose();
    this.canvas.remove();
    this.input.remove();
  }
}
