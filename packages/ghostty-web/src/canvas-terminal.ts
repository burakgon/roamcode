import {
  GhosttyKey,
  KeyAction,
  Mods,
  MouseAction,
  MouseButton,
  type GhosttyBufferSnapshot,
  type GhosttyFrame,
  type GhosttyGridPoint,
  type GhosttyMouseInput,
  type GhosttyTerminalTheme,
} from "./types";
import type { GhosttyRuntime, GhosttyTerminalCore } from "./runtime";
import type { GhosttySelectionInput } from "./runtime";
import { drawBoxDrawingGlyph } from "./box-drawing";

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

function ghosttyKeyForText(text: string): GhosttyKey {
  if (text.length !== 1) return GhosttyKey.Unidentified;
  const codepoint = text.toLowerCase().codePointAt(0);
  if (codepoint !== undefined && codepoint >= 97 && codepoint <= 122) return GhosttyKey.A + codepoint - 97;
  const digits = "0123456789";
  const digit = digits.indexOf(text);
  if (digit >= 0) return GhosttyKey.Digit0 + digit;
  return (
    {
      "`": GhosttyKey.Backquote,
      "\\": GhosttyKey.Backslash,
      "[": GhosttyKey.BracketLeft,
      "]": GhosttyKey.BracketRight,
      ",": GhosttyKey.Comma,
      "=": GhosttyKey.Equal,
      "-": GhosttyKey.Minus,
      ".": GhosttyKey.Period,
      "'": GhosttyKey.Quote,
      ";": GhosttyKey.Semicolon,
      "/": GhosttyKey.Slash,
      " ": GhosttyKey.Space,
    }[text] ?? GhosttyKey.Unidentified
  );
}

const graphemeSegmenter =
  typeof Intl.Segmenter === "function" ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : undefined;

function splitGraphemes(text: string): string[] {
  return graphemeSegmenter ? Array.from(graphemeSegmenter.segment(text), ({ segment }) => segment) : Array.from(text);
}

const LABEL_KEYS: Readonly<Record<string, GhosttyKey>> = {
  Esc: GhosttyKey.Escape,
  Tab: GhosttyKey.Tab,
  Enter: GhosttyKey.Enter,
  Backspace: GhosttyKey.Backspace,
  Delete: GhosttyKey.Delete,
  PageUp: GhosttyKey.PageUp,
  PageDown: GhosttyKey.PageDown,
  Home: GhosttyKey.Home,
  End: GhosttyKey.End,
  ArrowUp: GhosttyKey.ArrowUp,
  ArrowDown: GhosttyKey.ArrowDown,
  ArrowLeft: GhosttyKey.ArrowLeft,
  ArrowRight: GhosttyKey.ArrowRight,
};

export interface GhosttyDisposable {
  dispose(): void;
}

export interface GhosttyCanvasOptions {
  fontSize: number;
  disableStdin: boolean;
  theme: GhosttyTerminalTheme;
  wordSeparator: string;
}

export interface GhosttyBufferCellView {
  getWidth(): number;
  getChars(): string;
  getHyperlink(): string | undefined;
}

export interface GhosttyBufferLineView {
  readonly isWrapped: boolean;
  readonly length: number;
  getCell(column: number): GhosttyBufferCellView | undefined;
  translateToString(trimRight?: boolean): string;
}

export interface GhosttyActiveBufferView {
  readonly type: "normal" | "alternate";
  readonly viewportY: number;
  readonly baseY: number;
  readonly length: number;
  getLine(row: number): GhosttyBufferLineView | undefined;
}

export interface GhosttyCanvasTerminalOptions {
  onInput?(data: string): void;
  onResize?(cols: number, rows: number): void;
  onLink?(uri: string, event: MouseEvent): void;
  onCopy?(text: string): void;
  onError?(error: Error): void;
  fontSize?: number;
  fontFamily?: string;
  theme?: GhosttyTerminalTheme;
  scrollback?: number;
  allowPageScroll?: boolean;
  /** Back the normal-buffer viewport with a real overflow scroller. Touch/trackpad momentum then comes from
   *  the browser while Ghostty remains the source of truth for terminal rows. Alternate-screen applications
   *  keep owning their own mouse/pager input. */
  nativeScroll?: boolean;
  cursorBlink?: boolean;
}

export class GhosttyCanvasTerminal {
  private readonly host: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly context: CanvasRenderingContext2D;
  private readonly input: HTMLTextAreaElement;
  private readonly accessibility: HTMLPreElement;
  private readonly core: GhosttyTerminalCore;
  private readonly callbacks: GhosttyCanvasTerminalOptions;
  private readonly nativeScroll: boolean;
  private readonly scrollSpacer?: HTMLDivElement;
  readonly options: GhosttyCanvasOptions;
  readonly buffer: {
    readonly active: GhosttyActiveBufferView;
    onBufferChange(listener: () => void): GhosttyDisposable;
  };
  readonly modes: {
    readonly applicationCursorKeysMode: boolean;
    readonly mouseTrackingMode: "none" | "any";
  };
  private fontSize: number;
  private terminalTheme: GhosttyTerminalTheme;
  private readonly fontFamily: string;
  private readonly allowPageScroll: boolean;
  private readonly resizeObserver: ResizeObserver;
  private cellWidth = 8;
  private cellHeight = 17;
  private textBaseline = 14;
  private padding = 6;
  private readOnly = false;
  private frameRequest = 0;
  private blinkTimer = 0;
  private blinkOn = true;
  private blinkActive = false;
  private disposed = false;
  private composing = false;
  private compositionText = "";
  private streamComposition = false;
  private buttons = new Set<number>();
  private selecting = false;
  private suppressContextMenu = false;
  private modifierLocks = 0;
  private customKeyHandler?: (event: KeyboardEvent) => boolean;
  private cachedBuffer?: GhosttyBufferSnapshot;
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly scrollListeners = new Set<() => void>();
  private readonly selectionListeners = new Set<() => void>();
  private readonly bufferListeners = new Set<() => void>();
  private lastScreen: "normal" | "alternate" = "normal";
  private lastViewportOffset = 0;
  private lastSelectionText = "";
  private primaryGesture?: {
    down: MouseEvent;
    moved: boolean;
  };
  private listeners: Array<() => void> = [];

  constructor(runtime: GhosttyRuntime, host: HTMLElement, options: GhosttyCanvasTerminalOptions) {
    this.host = host;
    this.callbacks = options;
    this.nativeScroll = options.nativeScroll === true;
    this.fontSize = options.fontSize ?? 13;
    this.terminalTheme = options.theme ?? {};
    this.fontFamily =
      options.fontFamily ?? '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace';
    this.allowPageScroll = options.allowPageScroll === true;
    this.canvas = document.createElement("canvas");
    this.canvas.className = "rc-ghostty-canvas";
    this.canvas.setAttribute("role", "img");
    this.canvas.setAttribute("aria-label", "Terminal screen");
    const context = this.canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("Canvas 2D is unavailable");
    this.context = context;

    this.input = document.createElement("textarea");
    this.input.className = "rc-ghostty-input";
    this.input.setAttribute("aria-label", "Terminal input");
    this.input.setAttribute("autocapitalize", "off");
    this.input.setAttribute("autocorrect", "off");
    this.input.setAttribute("autocomplete", "off");
    this.input.setAttribute("spellcheck", "false");
    this.input.tabIndex = 0;
    this.accessibility = document.createElement("pre");
    this.accessibility.className = "rc-ghostty-accessibility";
    this.accessibility.setAttribute("role", "log");
    this.accessibility.setAttribute("aria-label", "Terminal output");
    this.accessibility.setAttribute("aria-live", "off");
    if (this.nativeScroll) {
      this.scrollSpacer = document.createElement("div");
      this.scrollSpacer.className = "rc-ghostty-scroll-spacer";
      this.scrollSpacer.setAttribute("aria-hidden", "true");
      this.host.classList.add("rc-ghostty-native-scroll");
      this.host.append(this.canvas, this.input, this.accessibility, this.scrollSpacer);
    } else {
      this.host.append(this.canvas, this.input, this.accessibility);
    }
    this.measureFont();
    const initial = this.measureGrid();
    this.core = runtime.createTerminal(initial.cols, initial.rows, options.scrollback ?? 1000);
    this.core.resize(initial.cols, initial.rows, this.cellWidth, this.cellHeight);
    this.core.setDefaultCursorBlink(options.cursorBlink ?? true);
    this.options = {
      fontSize: this.fontSize,
      disableStdin: false,
      theme: this.terminalTheme,
      wordSeparator: " ()[]{}',\"`",
    };
    Object.defineProperties(this.options, {
      fontSize: {
        enumerable: true,
        get: () => this.fontSize,
        set: (value: number) => this.setFontSize(value),
      },
      disableStdin: {
        enumerable: true,
        get: () => this.readOnly,
        set: (value: boolean) => this.setReadOnly(value),
      },
      theme: {
        enumerable: true,
        get: () => this.terminalTheme,
        set: (value: GhosttyTerminalTheme) => this.setTheme(value),
      },
    });
    const viewportSnapshot = () => this.core.viewportSnapshot();
    const bufferSnapshot = () => this.bufferSnapshot();
    const activeBuffer: GhosttyActiveBufferView = {
      get type() {
        return viewportSnapshot().screen;
      },
      get viewportY() {
        return viewportSnapshot().offset;
      },
      get baseY() {
        const viewport = viewportSnapshot();
        return Math.max(0, viewport.total - viewport.length);
      },
      get length() {
        return viewportSnapshot().total;
      },
      getLine(row: number) {
        const line = bufferSnapshot().lines[row];
        if (!line) return undefined;
        return {
          isWrapped: line.isWrapped,
          length: line.cells.length,
          getCell(column: number) {
            const cell = line.cells[column];
            if (!cell) return undefined;
            return {
              getWidth: () => cell.width,
              getChars: () => cell.text,
              getHyperlink: () => cell.hyperlink,
            };
          },
          translateToString(trimRight = false) {
            const text = line.cells.map((cell) => (cell.width === 0 ? "" : cell.text)).join("");
            return trimRight ? text.replace(/\s+$/u, "") : text;
          },
        };
      },
    };
    this.buffer = {
      active: activeBuffer,
      onBufferChange: (listener) => this.addListener(this.bufferListeners, listener),
    };
    this.modes = {
      applicationCursorKeysMode: false,
      mouseTrackingMode: "none",
    };
    Object.defineProperties(this.modes, {
      applicationCursorKeysMode: {
        enumerable: true,
        get: () => this.core.mode(1),
      },
      mouseTrackingMode: {
        enumerable: true,
        get: () => (this.core.mouseTracking() ? "any" : "none"),
      },
    });
    if (options.theme) this.core.setTheme(options.theme);
    const viewport = this.core.viewportSnapshot();
    this.lastScreen = viewport.screen;
    this.lastViewportOffset = viewport.offset;
    this.resizeCanvas();
    this.attachInput();
    this.attachNativeScroll();
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

  private addListener<T>(listeners: Set<(value: T) => void>, listener: (value: T) => void): GhosttyDisposable {
    listeners.add(listener);
    return { dispose: () => listeners.delete(listener) };
  }

  private bufferSnapshot(): GhosttyBufferSnapshot {
    return (this.cachedBuffer ??= this.core.bufferSnapshot());
  }

  private invalidateBuffer(): void {
    this.cachedBuffer = undefined;
  }

  onData(listener: (data: string) => void): GhosttyDisposable {
    return this.addListener(this.dataListeners, listener);
  }

  onScroll(listener: () => void): GhosttyDisposable {
    return this.addListener(this.scrollListeners, listener);
  }

  onSelectionChange(listener: () => void): GhosttyDisposable {
    return this.addListener(this.selectionListeners, listener);
  }

  attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean): void {
    this.customKeyHandler = handler;
  }

  setModifierLocks(locks: { ctrl?: boolean; alt?: boolean }): void {
    this.modifierLocks = (locks.ctrl ? Mods.Control : 0) | (locks.alt ? Mods.Alt : 0);
  }

  setTheme(theme: GhosttyTerminalTheme): void {
    this.terminalTheme = theme;
    this.core.setTheme(theme);
    this.invalidateBuffer();
    this.scheduleRender();
  }

  setFontSize(value: number): void {
    if (!Number.isFinite(value)) return;
    const next = Math.max(1, value);
    if (next === this.fontSize) return;
    this.fontSize = next;
    this.measureFont();
    this.fit();
  }

  blur(): void {
    this.input.blur();
  }

  hasSelection(): boolean {
    return this.getSelection().length > 0;
  }

  getSelection(): string {
    return this.core.selectionText();
  }

  getSelectionPosition(): { start: { x: number; y: number }; end: { x: number; y: number } } | undefined {
    const selection = this.core.selectionSnapshot();
    if (!selection) return undefined;
    const firstIndex = selection.start.row * this.cols + selection.start.col;
    const secondIndex = selection.end.row * this.cols + selection.end.col;
    const startIndex = Math.min(firstIndex, secondIndex);
    const endCellIndex = Math.max(firstIndex, secondIndex);
    const endRow = Math.floor(endCellIndex / this.cols);
    const endColumn = endCellIndex % this.cols;
    const endCellWidth = Math.max(1, this.bufferSnapshot().lines[endRow]?.cells[endColumn]?.width ?? 1);
    const endIndex = endCellIndex + endCellWidth;
    return {
      start: { x: startIndex % this.cols, y: Math.floor(startIndex / this.cols) },
      end: { x: endIndex % this.cols, y: Math.floor(endIndex / this.cols) },
    };
  }

  select(column: number, row: number, length: number): void {
    if (length <= 0) {
      this.clearSelection();
      return;
    }
    const startIndex = Math.max(0, Math.floor(row) * this.cols + Math.floor(column));
    const endIndex = startIndex + Math.max(1, Math.floor(length)) - 1;
    if (
      this.core.selectRange(
        { col: startIndex % this.cols, row: Math.floor(startIndex / this.cols) },
        { col: endIndex % this.cols, row: Math.floor(endIndex / this.cols) },
      )
    ) {
      this.selectionChanged();
      this.scheduleRender();
    }
  }

  selectAll(): void {
    if (this.core.selectAll()) {
      this.selectionChanged();
      this.scheduleRender();
    }
  }

  clearSelection(): void {
    this.core.clearSelection();
    this.selectionChanged();
    this.scheduleRender();
  }

  scrollLines(amount: number): void {
    this.core.scrollViewport(amount);
    this.viewportChanged();
    this.scheduleRender();
  }

  scrollToLine(row: number): void {
    this.core.scrollToRow(row);
    this.viewportChanged();
    this.scheduleRender();
  }

  scrollToTop(): void {
    this.core.scrollToTop();
    this.viewportChanged();
    this.scheduleRender();
  }

  scrollToBottom(): void {
    this.core.scrollToBottom();
    this.viewportChanged();
    this.scheduleRender();
  }

  paste(text: string): void {
    this.emit(this.core.encodePaste(text));
  }

  keySequence(label: string, locks: { ctrl?: boolean; alt?: boolean } = {}): string {
    const key = LABEL_KEYS[label] ?? ghosttyKeyForText(label);
    const utf8 = label.length === 1 ? label : undefined;
    return new TextDecoder().decode(
      this.core.encodeKey({
        action: KeyAction.Press,
        key,
        mods: (locks.ctrl ? Mods.Control : 0) | (locks.alt ? Mods.Alt : 0),
        utf8,
        unshiftedCodepoint: utf8?.toLowerCase().codePointAt(0),
      }),
    );
  }

  sendKey(label: string, locks: { ctrl?: boolean; alt?: boolean } = {}): void {
    const sequence = this.keySequence(label, locks);
    if (sequence) this.emit(new TextEncoder().encode(sequence));
  }

  sendMouseWheel(up: boolean, count = 1, clientX?: number, clientY?: number): void {
    const rect = this.canvas.getBoundingClientRect();
    const x = Math.max(0, (clientX ?? rect.left + rect.width / 2) - rect.left - this.padding);
    const y = Math.max(0, (clientY ?? rect.top + rect.height / 2) - rect.top - this.padding);
    for (let index = 0; index < count; index++) {
      this.emit(
        this.core.encodeMouse({
          action: MouseAction.Press,
          button: up ? MouseButton.WheelUp : MouseButton.WheelDown,
          mods: this.modifierLocks,
          x,
          y,
          anyButtonPressed: false,
          screenWidth: Math.max(1, rect.width - this.padding * 2),
          screenHeight: Math.max(1, rect.height - this.padding * 2),
          cellWidth: this.cellWidth,
          cellHeight: this.cellHeight,
        }),
      );
    }
  }

  private measureFont(): void {
    const probe = document.createElement("canvas").getContext("2d");
    if (!probe) return;
    probe.font = `${this.fontSize}px ${this.fontFamily}`;
    const metrics = probe.measureText("M");
    // Keep the measured fractional advance. Rounding every 7.8px JetBrains Mono cell up to 8px creates a
    // growing inter-cell drift that is especially visible on a 3× iPhone canvas.
    this.cellWidth = Math.max(1, metrics.width || this.fontSize * 0.62);
    const ascent = metrics.actualBoundingBoxAscent || this.fontSize * 0.8;
    const descent = metrics.actualBoundingBoxDescent || this.fontSize * 0.2;
    this.cellHeight = Math.max(1, Math.ceil(ascent + descent) + 2);
    const leading = Math.max(0, this.cellHeight - ascent - descent);
    this.textBaseline = leading / 2 + ascent;
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
      this.invalidateBuffer();
      this.callbacks.onResize?.(grid.cols, grid.rows);
    }
    this.scheduleRender();
  }

  write(bytes: Uint8Array): void {
    this.core.write(bytes);
    this.invalidateBuffer();
    this.selectionChanged();
    this.resetBlink();
    this.scheduleRender();
  }

  reset(): void {
    this.core.reset();
    this.invalidateBuffer();
    for (const listener of this.bufferListeners) listener();
    this.selectionChanged();
    this.scheduleRender();
  }

  setReadOnly(value: boolean): void {
    this.readOnly = value;
    this.input.disabled = value;
  }

  focus(): void {
    if (!this.readOnly) this.input.focus({ preventScroll: true });
  }

  private emit(bytes: Uint8Array): void {
    if (this.readOnly || bytes.length === 0) return;
    this.resetBlink();
    const data = new TextDecoder().decode(bytes);
    this.callbacks.onInput?.(data);
    for (const listener of this.dataListeners) listener(data);
  }

  private encodeKeyboard(event: KeyboardEvent, action: KeyAction): Uint8Array {
    const key = KEY_MAP[event.code] ?? GhosttyKey.Unidentified;
    const printable = event.key.length === 1 ? event.key : undefined;
    return this.core.encodeKey({
      action,
      key,
      mods: modifiers(event) | this.modifierLocks,
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

  /** A normal terminal's scrollback is a viewport over fixed-height rows, but the gesture that drives it
   *  should still be the platform's native overflow gesture. The invisible spacer gives the browser the
   *  exact scroll range; its scrollTop is translated back to Ghostty rows without snapping away fractional
   *  movement while momentum is active. */
  private attachNativeScroll(): void {
    if (!this.nativeScroll || !this.scrollSpacer) return;
    this.listen(
      this.host,
      "scroll",
      () => {
        const viewport = this.core.viewportSnapshot();
        if (viewport.screen !== "normal") return;
        const lastRow = Math.max(0, viewport.total - viewport.length);
        const row = Math.max(0, Math.min(lastRow, Math.round(this.host.scrollTop / this.cellHeight)));
        if (row === viewport.offset) return;
        this.core.scrollToRow(row);
        this.viewportChanged();
        this.scheduleRender();
      },
      { passive: true },
    );
    this.syncNativeScroll(this.core.viewportSnapshot(), true);
  }

  private syncNativeScroll(
    viewport: { screen: "normal" | "alternate"; total: number; offset: number; length: number },
    force = false,
  ): void {
    if (!this.nativeScroll || !this.scrollSpacer) return;
    this.host.classList.toggle("rc-ghostty-alt-screen", viewport.screen === "alternate");
    const historyRows = viewport.screen === "normal" ? Math.max(0, viewport.total - viewport.length) : 0;
    const spacerHeight = historyRows * this.cellHeight;
    if (this.scrollSpacer.style.height !== `${spacerHeight}px`) {
      this.scrollSpacer.style.height = `${spacerHeight}px`;
    }
    const target = viewport.screen === "normal" ? viewport.offset * this.cellHeight : 0;
    // During native momentum scrollTop carries a fractional row while the Ghostty viewport is integral. Keep
    // that fraction alive; only reposition for a real terminal-side jump/output change or initial mount.
    if (force || Math.abs(this.host.scrollTop - target) > this.cellHeight * 0.75) {
      this.host.scrollTop = target;
    }
  }

  private selectionChanged(): void {
    let next = "";
    try {
      next = this.core.selectionText();
    } catch {
      next = "";
    }
    if (next === this.lastSelectionText) return;
    this.lastSelectionText = next;
    for (const listener of this.selectionListeners) listener();
  }

  private viewportChanged(): void {
    const viewport = this.core.viewportSnapshot();
    this.syncNativeScroll(viewport);
    if (viewport.screen !== this.lastScreen || viewport.offset !== this.lastViewportOffset) {
      this.invalidateBuffer();
    }
    if (viewport.screen !== this.lastScreen) {
      this.lastScreen = viewport.screen;
      for (const listener of this.bufferListeners) listener();
    }
    if (viewport.offset !== this.lastViewportOffset) {
      this.lastViewportOffset = viewport.offset;
      for (const listener of this.scrollListeners) listener();
    }
  }

  screenRect(): DOMRect {
    return this.canvas.getBoundingClientRect();
  }

  selectionBoundaryAt(point: GhosttyGridPoint, edge: "start" | "end"): { x: number; y: number } | undefined {
    if (this.cols <= 0 || this.rows <= 0) return undefined;
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return undefined;

    let col = Math.max(0, Math.min(this.cols, Math.floor(point.col)));
    let row = Math.max(0, Math.floor(point.row));
    // Selection ends are end-exclusive. A boundary at column 0 belongs to the right/bottom corner of the
    // previous row, not the left edge of the next one.
    if (edge === "end" && col === 0 && row > 0) {
      col = this.cols;
      row--;
    }

    const viewport = this.core.viewportSnapshot();
    const viewportRow = row - viewport.offset;
    if (viewportRow < 0 || viewportRow >= this.rows) return undefined;
    return {
      x: rect.left + this.padding + col * this.cellWidth,
      y: rect.top + this.padding + (viewportRow + (edge === "end" ? 1 : 0)) * this.cellHeight,
    };
  }

  cellAtPoint(clientX: number, clientY: number): GhosttyGridPoint | undefined {
    const rect = this.canvas.getBoundingClientRect();
    if (
      rect.width <= 0 ||
      rect.height <= 0 ||
      clientX < rect.left ||
      clientX >= rect.right ||
      clientY < rect.top ||
      clientY >= rect.bottom
    ) {
      return undefined;
    }
    const viewport = this.core.viewportSnapshot();
    const col = Math.max(0, Math.min(this.cols - 1, Math.floor((clientX - rect.left - this.padding) / this.cellWidth)));
    const viewportRow = Math.max(
      0,
      Math.min(this.rows - 1, Math.floor((clientY - rect.top - this.padding) / this.cellHeight)),
    );
    const row = viewport.offset + viewportRow;
    const line = this.bufferSnapshot().lines[row];
    let anchoredCol = col;
    while (anchoredCol > 0 && line?.cells[anchoredCol]?.width === 0) anchoredCol--;
    return { col: anchoredCol, row };
  }

  selectWordAtPoint(clientX: number, clientY: number): string {
    const point = this.cellAtPoint(clientX, clientY);
    if (!point) return "";
    const viewport = this.core.viewportSnapshot();
    const viewportRow = point.row - viewport.offset;
    const selected = this.core.selectWordAt({
      column: point.col,
      row: viewportRow,
    });
    if (!selected) return "";
    this.selectionChanged();
    this.scheduleRender();
    return this.core.selectionText();
  }

  private linkAtPoint(clientX: number, clientY: number): string | undefined {
    const point = this.cellAtPoint(clientX, clientY);
    if (!point) return undefined;
    const snapshot = this.bufferSnapshot();
    const direct = snapshot.lines[point.row]?.cells[point.col]?.hyperlink;
    if (direct) return direct;

    let firstRow = point.row;
    while (firstRow > 0 && snapshot.lines[firstRow]?.isWrapped) firstRow--;
    let lastRow = point.row;
    while (lastRow + 1 < snapshot.lines.length && snapshot.lines[lastRow + 1]?.isWrapped) lastRow++;

    let text = "";
    let targetOffset = -1;
    for (let row = firstRow; row <= lastRow; row++) {
      const line = snapshot.lines[row];
      if (!line) continue;
      for (let col = 0; col < line.cells.length; col++) {
        const cell = line.cells[col]!;
        if (row === point.row && col === point.col) targetOffset = text.length;
        if (cell.width !== 0) text += cell.text || " ";
      }
    }
    if (targetOffset < 0) return undefined;
    const matcher = /https?:\/\/[^\s<>"'`]+/giu;
    for (const match of text.matchAll(matcher)) {
      const start = match.index;
      let uri = match[0];
      while (/[),.;:!?\]}]$/u.test(uri)) uri = uri.slice(0, -1);
      const end = start + uri.length;
      if (targetOffset >= start && targetOffset < end) return uri;
    }
    return undefined;
  }

  /** Mobile keyboards keep an editable candidate string until Space/Enter commits it. A terminal cannot
   * render that hidden DOM composition, so mirror each candidate revision into the real PTY: retain the
   * shared prefix, erase only the changed suffix, then append the replacement. This gives the terminal
   * immediate input without disabling IME language/character support. */
  private emitCompositionDelta(nextText: string): void {
    if (nextText === this.compositionText) return;
    const previous = splitGraphemes(this.compositionText);
    const next = splitGraphemes(nextText);
    let prefix = 0;
    while (prefix < previous.length && prefix < next.length && previous[prefix] === next[prefix]) prefix++;

    for (let index = prefix; index < previous.length; index++) {
      this.emit(
        this.core.encodeKey({
          action: KeyAction.Press,
          key: GhosttyKey.Backspace,
          mods: 0,
        }),
      );
    }
    const suffix = next.slice(prefix).join("");
    if (suffix) {
      this.emit(
        this.core.encodeKey({
          action: KeyAction.Press,
          key: GhosttyKey.Unidentified,
          mods: 0,
          utf8: suffix,
        }),
      );
    }
    this.compositionText = nextText;
  }

  activateLinkAtPoint(clientX: number, clientY: number, source?: MouseEvent): boolean {
    const uri = this.linkAtPoint(clientX, clientY);
    if (!uri) return false;
    this.callbacks.onLink?.(
      uri,
      source ??
        new MouseEvent("click", {
          clientX,
          clientY,
          button: 0,
          bubbles: false,
          cancelable: true,
        }),
    );
    return this.callbacks.onLink !== undefined;
  }

  private attachInput(): void {
    this.listen(this.input, "keydown", (event) => {
      if (this.readOnly) return;
      if (this.customKeyHandler?.(event) === false) return;
      if (this.composing || event.isComposing || event.keyCode === 229) return;
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
      if (this.readOnly) return;
      if (this.customKeyHandler?.(event) === false) return;
      if (this.composing || event.isComposing || event.keyCode === 229) return;
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
      if (event.defaultPrevented || this.readOnly || this.composing || event.isComposing) return;
      const data = event.data ?? "";
      try {
        let encoded: Uint8Array | undefined;
        if (event.inputType === "insertText" || event.inputType === "insertReplacementText") {
          if (data) {
            encoded = this.core.encodeKey({
              action: KeyAction.Press,
              key: ghosttyKeyForText(data),
              mods: data.length === 1 ? this.modifierLocks : 0,
              utf8: data,
              unshiftedCodepoint: data.length === 1 ? data.toLowerCase().codePointAt(0) : undefined,
            });
          }
        } else if (event.inputType === "insertLineBreak" || event.inputType === "insertParagraph") {
          encoded = this.core.encodeKey({
            action: KeyAction.Press,
            key: GhosttyKey.Enter,
            mods: this.modifierLocks,
          });
        } else if (event.inputType === "deleteContentBackward") {
          encoded = this.core.encodeKey({
            action: KeyAction.Press,
            key: GhosttyKey.Backspace,
            mods: this.modifierLocks,
          });
        } else if (event.inputType === "deleteContentForward") {
          encoded = this.core.encodeKey({
            action: KeyAction.Press,
            key: GhosttyKey.Delete,
            mods: this.modifierLocks,
          });
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
      this.compositionText = "";
      // Sticky Ctrl/Alt must retain shortcut semantics. Those rare modified compositions keep the previous
      // commit-time behavior; ordinary phone typing streams immediately.
      this.streamComposition = this.modifierLocks === 0;
    });
    this.listen(this.input, "compositionupdate", (event) => {
      if (this.readOnly || !this.streamComposition) return;
      try {
        this.emitCompositionDelta(event.data);
      } catch (error) {
        this.fail(error);
      }
    });
    this.listen(this.input, "compositionend", (event) => {
      try {
        if (!this.readOnly) {
          if (this.streamComposition) {
            // The final candidate can differ from the last update (autocorrect/candidate selection).
            this.emitCompositionDelta(event.data);
          } else if (event.data) {
            this.emit(
              this.core.encodeKey({
                action: KeyAction.Press,
                key: GhosttyKey.Unidentified,
                mods: event.data.length === 1 ? this.modifierLocks : 0,
                utf8: event.data,
              }),
            );
          }
        }
      } catch (error) {
        this.fail(error);
      } finally {
        this.composing = false;
        this.compositionText = "";
        this.streamComposition = false;
        this.input.value = "";
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
    this.listen(this.host, "copy", (event) => {
      const text = this.getSelection();
      if (!text) return;
      event.preventDefault();
      event.clipboardData?.setData("text/plain", text);
      this.callbacks.onCopy?.(text);
    });

    this.listen(this.canvas, "mousedown", (event) => {
      this.focus();
      if (event.button === 2) this.suppressContextMenu = false;

      // Match Ghostty Surface.mouseButtonCallback: terminal mouse reporting gets first refusal. Only an
      // unhandled right-click becomes terminal-owned word selection plus the platform context menu.
      if (event.button === 2) {
        this.buttons.add(event.button);
        const handled = this.emitMouse(event, MouseAction.Press, MouseButton.Right);
        if (handled) {
          this.suppressContextMenu = true;
          this.core.cancelSelection();
          this.selectionChanged();
          this.scheduleRender();
          event.preventDefault();
          return;
        }
        this.buttons.delete(event.button);
        try {
          this.core.selectWordAt(this.selectionInput(event));
          this.selectionChanged();
          this.scheduleRender();
        } catch (error) {
          this.fail(error);
        }
        return;
      }

      if (event.button === 0) {
        // Match Ghostty Surface.mouseButtonCallback: an application mouse mode owns unmodified clicks
        // immediately. Shift is Ghostty's standard override for terminal-owned selection.
        if (!event.shiftKey) {
          this.buttons.add(event.button);
          if (this.emitMouse(event, MouseAction.Press, MouseButton.Left)) {
            this.core.cancelSelection();
            this.selectionChanged();
            this.scheduleRender();
            event.preventDefault();
            return;
          }
          this.buttons.delete(event.button);
        }
        this.primaryGesture = {
          down: event,
          moved: false,
        };
        this.startSelection(event);
        event.preventDefault();
        return;
      }

      this.buttons.add(event.button);
      if (this.emitMouse(event, MouseAction.Press, this.mouseButton(event.button))) {
        event.preventDefault();
      } else {
        this.buttons.delete(event.button);
      }
    });
    this.listen(window, "mouseup", (event) => {
      if (event.button === 0 && this.primaryGesture) {
        const gesture = this.primaryGesture;
        this.primaryGesture = undefined;
        try {
          if (this.selecting) {
            this.selecting = false;
            this.core.endSelection(this.selectionInput(event));
            this.selectionChanged();
          }
          if (!gesture.moved && this.activateLinkAtPoint(event.clientX, event.clientY, event)) {
            event.preventDefault();
          }
          this.scheduleRender();
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
    this.listen(window, "mousemove", (event) => {
      const primary = this.primaryGesture;
      if (primary) {
        if (
          !primary.moved &&
          Math.hypot(event.clientX - primary.down.clientX, event.clientY - primary.down.clientY) >= 4
        ) {
          primary.moved = true;
        }
        if (primary.moved && this.selecting) {
          try {
            this.core.updateSelection(this.selectionInput(event));
            this.selectionChanged();
            this.scheduleRender();
            event.preventDefault();
          } catch (error) {
            this.fail(error);
          }
        }
        return;
      }
      if (this.selecting) {
        try {
          this.core.updateSelection(this.selectionInput(event));
          this.selectionChanged();
          this.scheduleRender();
          event.preventDefault();
        } catch (error) {
          this.fail(error);
        }
        return;
      }
      if (event.target !== this.canvas) return;
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
        // On the normal screen the browser-owned overflow surface provides real high-resolution trackpad
        // and touch momentum. Do not turn it into a synthetic tmux mouse event or a fixed three-line jump.
        if (this.nativeScroll && this.core.viewportSnapshot().screen === "normal") return;
        if (this.emitMouse(event, MouseAction.Press, button)) {
          event.preventDefault();
          return;
        }
        if (this.allowPageScroll) return;
        this.core.scrollViewport(event.deltaY < 0 ? -3 : 3);
        this.viewportChanged();
        this.scheduleRender();
        event.preventDefault();
      },
      { passive: false },
    );
    this.listen(this.canvas, "contextmenu", (event) => {
      if (!this.suppressContextMenu) return;
      this.suppressContextMenu = false;
      event.preventDefault();
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
      this.selectionChanged();
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
      mods: modifiers(event) | this.modifierLocks,
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

  private resetBlink(): void {
    this.blinkOn = true;
    if (this.blinkTimer) {
      window.clearTimeout(this.blinkTimer);
      this.blinkTimer = 0;
    }
    this.scheduleBlink();
  }

  private scheduleBlink(): void {
    if (this.disposed || !this.blinkActive || this.blinkTimer) return;
    this.blinkTimer = window.setTimeout(() => {
      this.blinkTimer = 0;
      if (this.disposed || !this.blinkActive) return;
      this.blinkOn = !this.blinkOn;
      this.scheduleRender();
    }, 600);
  }

  private render(): void {
    if (this.disposed) return;
    try {
      const frame = this.core.snapshot();
      this.blinkActive = frame.cursor.blinking || frame.cells.some((line) => line.some((cell) => cell.blink));
      if (!this.blinkActive) {
        this.blinkOn = true;
        if (this.blinkTimer) window.clearTimeout(this.blinkTimer);
        this.blinkTimer = 0;
      }
      this.draw(frame);
      this.accessibility.textContent = frame.cells
        .map((line) =>
          line
            .map((cell) => (cell.width === 0 ? "" : cell.text))
            .join("")
            .replace(/\s+$/u, ""),
        )
        .join("\n");
      this.viewportChanged();
      this.scheduleBlink();
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
    const baseline = this.textBaseline;

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
        if (cell.selected) {
          foreground = this.terminalTheme.selectionForeground ?? frame.background;
          background = this.terminalTheme.selectionBackground ?? frame.foreground;
        }
        if (background !== frame.background) {
          ctx.fillStyle = background;
          ctx.fillRect(x, y, this.cellWidth * Math.max(1, cell.width), this.cellHeight);
        }
        if (cell.width === 0 || cell.invisible || (cell.blink && !this.blinkOn) || cell.text === " ") continue;
        ctx.globalAlpha = cell.faint ? 0.6 : 1;
        ctx.font = `${cell.italic ? "italic " : ""}${cell.bold ? "700 " : ""}${this.fontSize}px ${this.fontFamily}`;
        ctx.fillStyle = foreground;
        if (!drawBoxDrawingGlyph(ctx, cell.text, x, y, this.cellWidth, this.cellHeight, foreground)) {
          ctx.fillText(cell.text, x, y + baseline);
        }
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

    if (frame.cursor.visible && (!frame.cursor.blinking || this.blinkOn)) {
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
    this.callbacks.onError?.(error instanceof Error ? error : new Error(String(error)));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.frameRequest) cancelAnimationFrame(this.frameRequest);
    this.frameRequest = 0;
    if (this.blinkTimer) window.clearTimeout(this.blinkTimer);
    this.blinkTimer = 0;
    this.resizeObserver.disconnect();
    for (const dispose of this.listeners.splice(0)) dispose();
    this.core.dispose();
    this.canvas.remove();
    this.input.remove();
    this.accessibility.remove();
    this.scrollSpacer?.remove();
    this.host.classList.remove("rc-ghostty-native-scroll");
    this.host.classList.remove("rc-ghostty-alt-screen");
    this.dataListeners.clear();
    this.scrollListeners.clear();
    this.selectionListeners.clear();
    this.bufferListeners.clear();
  }
}
