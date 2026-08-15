import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import { registerTerminalClipboardHandlers } from "./terminal-clipboard";
import { compositionDelta, isCompositionCommitEcho } from "./terminal-composition";
import {
  beforeInputSequence,
  isPhysicalTextInputEcho,
  keySequence,
  keyboardEventSequence,
  modifiedDataSequence,
  type TerminalModifiers,
} from "./terminal-keys";

export interface XtermTerminalOptions {
  fontSize: number;
  fontFamily: string;
  theme: ITheme;
  scrollback?: number;
  cursorBlink?: boolean;
  onLink?(uri: string, event: MouseEvent): void;
  onCopy?(text: string): void;
  onClipboardWrite?(text: string): void;
  focusOnPointer?: boolean | ((event: MouseEvent) => boolean);
  secondaryClickSelectsWord?: boolean | ((event: MouseEvent) => boolean);
}

type PendingPrimaryMouse = {
  down: MouseEvent;
  target: EventTarget;
  selecting: boolean;
  lastX: number;
  lastY: number;
};

const DEFAULT_WORD_SEPARATORS = " ()[]{}',\"`";
const PRIMARY_DRAG_THRESHOLD = 4;

function isMacPlatform(): boolean {
  return /Mac|iPhone|iPad|iPod/iu.test(`${navigator.platform} ${navigator.userAgent}`);
}

function cellAtPoint(term: Terminal, host: HTMLElement, clientX: number, clientY: number) {
  const screen = host.querySelector<HTMLElement>(".xterm-screen");
  if (!screen || term.cols <= 0 || term.rows <= 0) return undefined;
  const rect = screen.getBoundingClientRect();
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
  let col = Math.min(term.cols - 1, Math.max(0, Math.floor(((clientX - rect.left) / rect.width) * term.cols)));
  const viewportRow = Math.min(
    term.rows - 1,
    Math.max(0, Math.floor(((clientY - rect.top) / rect.height) * term.rows)),
  );
  const row = term.buffer.active.viewportY + viewportRow;
  const line = term.buffer.active.getLine(row);
  while (col > 0 && line?.getCell(col)?.getWidth() === 0) col--;
  return { col, row };
}

/** Select a wrapped word through xterm's public buffer API while leaving the platform context menu native. */
function selectWordAtPoint(term: Terminal, host: HTMLElement, clientX: number, clientY: number): string {
  const existing = term.getSelection();
  if (existing) return existing;
  const point = cellAtPoint(term, host, clientX, clientY);
  if (!point) return "";

  const buffer = term.buffer.active;
  let firstRow = point.row;
  while (firstRow > 0 && buffer.getLine(firstRow)?.isWrapped) firstRow--;
  let lastRow = point.row;
  while (lastRow + 1 < buffer.length && buffer.getLine(lastRow + 1)?.isWrapped) lastRow++;

  const firstIndex = (point.row - firstRow) * term.cols + point.col;
  const cellCharacter = (index: number): string => {
    if (index < 0) return " ";
    const row = firstRow + Math.floor(index / term.cols);
    if (row > lastRow) return " ";
    return (
      buffer
        .getLine(row)
        ?.getCell(index % term.cols)
        ?.getChars() || " "
    );
  };
  const isWord = (index: number) =>
    !DEFAULT_WORD_SEPARATORS.includes(cellCharacter(index)) && !/\s/u.test(cellCharacter(index));
  if (!isWord(firstIndex)) return "";

  let start = firstIndex;
  let end = firstIndex + 1;
  while (start > 0 && isWord(start - 1)) start--;
  while (isWord(end)) end++;
  term.select(start % term.cols, firstRow + Math.floor(start / term.cols), end - start);
  return term.getSelection();
}

/**
 * Thin product adapter over the official xterm APIs. It keeps RoamCode-specific key, pointer, clipboard and
 * pixel-scroll contracts out of TerminalView without introducing another renderer abstraction.
 */
export class XtermTerminal {
  private readonly terminal: Terminal;
  private readonly fitAddon = new FitAddon();
  private readonly host: HTMLElement;
  private readonly disposables: Array<{ dispose(): void }> = [];
  private readonly cleanups: Array<() => void> = [];
  private readonly dataListeners = new Set<(data: string) => void>();
  private locks: TerminalModifiers = { ctrl: false, alt: false };
  private customKeyHandler?: (event: KeyboardEvent) => boolean;
  private wheelRemainder = 0;
  private physicalTextInput: { text: string; owner: "xterm" | "bridge" } | undefined;
  private physicalTextInputTimer: number | undefined;

  constructor(host: HTMLElement, options: XtermTerminalOptions) {
    this.host = host;
    let linkActivationSerial = 0;
    let primaryLinkGesture: { x: number; y: number; moved: boolean; selecting: boolean } | undefined;
    const activateLink = (event: MouseEvent, uri: string): void => {
      if (primaryLinkGesture?.moved || primaryLinkGesture?.selecting) return;
      linkActivationSerial++;
      options.onLink?.(uri, event);
    };

    this.terminal = new Terminal({
      allowProposedApi: true,
      cursorBlink: options.cursorBlink ?? true,
      fontSize: options.fontSize,
      fontFamily: options.fontFamily,
      macOptionClickForcesSelection: true,
      rightClickSelectsWord: false,
      scrollback: options.scrollback ?? 20_000,
      theme: options.theme,
      wordSeparator: DEFAULT_WORD_SEPARATORS,
      linkHandler: {
        activate: activateLink,
        allowNonHttpProtocols: false,
      },
    });
    this.terminal.loadAddon(this.fitAddon);
    this.terminal.loadAddon(new WebLinksAddon(activateLink));
    this.terminal.open(host);

    this.syncBufferState();
    this.disposables.push(this.terminal.onScroll(() => this.syncBufferState()));
    this.disposables.push(this.terminal.buffer.onBufferChange(() => this.syncBufferState()));
    this.cleanups.push(() => {
      host.classList.remove("rc-xterm-alt-screen");
      delete host.dataset.terminalBuffer;
      delete host.dataset.terminalViewportLine;
      delete host.dataset.terminalBaseLine;
    });

    this.disposables.push(
      this.terminal.onData((data) => {
        const encoded = modifiedDataSequence(data, this.locks);
        for (const listener of this.dataListeners) listener(encoded);
      }),
    );
    if (options.onClipboardWrite) {
      this.disposables.push(registerTerminalClipboardHandlers(this.terminal.parser, options.onClipboardWrite));
    }

    const helper = host.querySelector<HTMLTextAreaElement>("textarea.xterm-helper-textarea");
    if (helper) this.installInputBridge(helper);
    const onCopy = () => {
      const text = this.terminal.getSelection();
      if (text) options.onCopy?.(text);
    };
    host.addEventListener("copy", onCopy);
    this.cleanups.push(() => host.removeEventListener("copy", onCopy));

    this.installKeyboardHandler();
    this.installPointerArbitration(
      options,
      () => linkActivationSerial,
      (gesture) => {
        primaryLinkGesture = gesture;
      },
    );

    // xterm focuses its hidden textarea from mouse input. Synthetic touchpad presses must remain keyboard-neutral.
    const onPointerFocusCapture = (event: MouseEvent) => {
      const allowed =
        typeof options.focusOnPointer === "function" ? options.focusOnPointer(event) : options.focusOnPointer !== false;
      if (!allowed) queueMicrotask(() => helper?.blur());
    };
    host.addEventListener("mousedown", onPointerFocusCapture, true);
    this.cleanups.push(() => host.removeEventListener("mousedown", onPointerFocusCapture, true));
  }

  get cols(): number {
    return this.terminal.cols;
  }

  get rows(): number {
    return this.terminal.rows;
  }

  get options() {
    return this.terminal.options;
  }

  get buffer() {
    return this.terminal.buffer;
  }

  get modes() {
    return this.terminal.modes;
  }

  onData(listener: (data: string) => void): { dispose(): void } {
    this.dataListeners.add(listener);
    return { dispose: () => this.dataListeners.delete(listener) };
  }

  onScroll(listener: () => void) {
    return this.terminal.onScroll(listener);
  }

  attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean): void {
    this.customKeyHandler = handler;
  }

  setModifierLocks(locks: { ctrl?: boolean; alt?: boolean }): void {
    this.locks = { ctrl: !!locks.ctrl, alt: !!locks.alt };
  }

  keySequence(label: string, locks: { ctrl?: boolean; alt?: boolean } = {}): string {
    return keySequence(label, this.terminal.modes.applicationCursorKeysMode, {
      ctrl: !!locks.ctrl,
      alt: !!locks.alt,
    });
  }

  sendKey(label: string, locks: { ctrl?: boolean; alt?: boolean } = {}): void {
    this.emit(this.keySequence(label, locks));
  }

  fit(): void {
    this.fitAddon.fit();
  }

  write(bytes: Uint8Array, callback?: () => void): void {
    this.terminal.write(bytes, () => {
      this.syncBufferState();
      callback?.();
    });
  }

  reset(): void {
    this.terminal.reset();
    this.syncBufferState();
  }

  focus(): void {
    if (!this.terminal.options.disableStdin) this.terminal.focus();
  }

  blur(): void {
    this.terminal.blur();
  }

  hasSelection(): boolean {
    return this.terminal.hasSelection();
  }

  getSelection(): string {
    return this.terminal.getSelection();
  }

  clearSelection(): void {
    this.terminal.clearSelection();
  }

  select(column: number, row: number, length: number): void {
    this.terminal.select(column, row, length);
  }

  scrollToLine(row: number): void {
    this.terminal.scrollToLine(row);
  }

  scrollToBottom(): void {
    this.terminal.scrollToBottom();
  }

  paste(text: string): void {
    this.terminal.paste(text);
  }

  screenRect(): DOMRect {
    return (
      this.host.querySelector<HTMLElement>(".xterm-screen")?.getBoundingClientRect() ??
      this.host.getBoundingClientRect()
    );
  }

  scrollByPixels(deltaY: number, clientX?: number, clientY?: number): void {
    if (!Number.isFinite(deltaY) || deltaY === 0) return;
    const screen = this.host.querySelector<HTMLElement>(".xterm-screen");
    if (!screen) return;
    const rect = screen.getBoundingClientRect();
    if (this.terminal.buffer.active.type === "normal") {
      const cellHeight = rect.height / Math.max(1, this.terminal.rows);
      const pixels = this.wheelRemainder + deltaY;
      const lines = pixels < 0 ? Math.ceil(pixels / cellHeight) : Math.floor(pixels / cellHeight);
      this.wheelRemainder = pixels - lines * cellHeight;
      if (lines !== 0) this.terminal.scrollLines(lines);
      return;
    }
    this.wheelRemainder = 0;
    screen.dispatchEvent(
      new WheelEvent("wheel", {
        bubbles: true,
        cancelable: true,
        clientX: clientX ?? rect.left + rect.width / 2,
        clientY: clientY ?? rect.top + rect.height / 2,
        deltaY,
        deltaMode: WheelEvent.DOM_DELTA_PIXEL,
      }),
    );
  }

  dispose(): void {
    for (const cleanup of this.cleanups.splice(0)) cleanup();
    for (const disposable of this.disposables.splice(0)) disposable.dispose();
    this.dataListeners.clear();
    this.terminal.dispose();
  }

  private emit(data: string): void {
    if (!data || this.terminal.options.disableStdin) return;
    for (const listener of this.dataListeners) listener(data);
  }

  private clearPhysicalTextInput(): void {
    this.physicalTextInput = undefined;
    if (this.physicalTextInputTimer !== undefined) window.clearTimeout(this.physicalTextInputTimer);
    this.physicalTextInputTimer = undefined;
  }

  private markPhysicalTextInput(text: string, owner: "xterm" | "bridge"): void {
    this.clearPhysicalTextInput();
    this.physicalTextInput = { text, owner };
    this.physicalTextInputTimer = window.setTimeout(() => this.clearPhysicalTextInput(), 0);
  }

  private consumePhysicalTextInput(inputType: string, data: string | null): "xterm" | "bridge" | undefined {
    const pending = this.physicalTextInput;
    if (!isPhysicalTextInputEcho(pending?.text, inputType, data) || !pending) return undefined;
    const owner = pending.owner;
    this.clearPhysicalTextInput();
    return owner;
  }

  private installInputBridge(helper: HTMLTextAreaElement): void {
    let composing = false;
    let compositionText = "";
    let streamComposition = false;
    let suppressCommitText: string | undefined;
    let suppressCommitTimer: number | undefined;

    const clearSuppressedCommit = () => {
      suppressCommitText = undefined;
      if (suppressCommitTimer !== undefined) window.clearTimeout(suppressCommitTimer);
      suppressCommitTimer = undefined;
    };

    const onCompositionStart = (event: CompositionEvent) => {
      event.stopImmediatePropagation();
      composing = true;
      compositionText = "";
      // Sticky shortcuts retain commit-time semantics. Ordinary phone typing streams each candidate revision.
      streamComposition = !this.locks.ctrl && !this.locks.alt;
      clearSuppressedCommit();
    };
    const onCompositionUpdate = (event: CompositionEvent) => {
      event.stopImmediatePropagation();
      if (!composing || !streamComposition) return;
      this.emit(compositionDelta(compositionText, event.data));
      compositionText = event.data;
    };
    const onCompositionEnd = (event: CompositionEvent) => {
      event.stopImmediatePropagation();
      if (composing) {
        if (streamComposition) this.emit(compositionDelta(compositionText, event.data));
        else this.emit(modifiedDataSequence(event.data, this.locks));
      }
      composing = false;
      compositionText = "";
      streamComposition = false;
      helper.value = "";
      // Chromium may follow compositionend with an insertText input carrying the same commit. xterm's native
      // input listener must not send that payload a second time after the streamed candidate already reached PTY.
      suppressCommitText = event.data;
      suppressCommitTimer = window.setTimeout(() => {
        clearSuppressedCommit();
      }, 0);
    };
    const onInput = (event: InputEvent) => {
      const commitEcho = isCompositionCommitEcho(suppressCommitText, event.inputType, event.data);
      if (!composing && !commitEcho) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      helper.value = "";
      if (commitEcho) clearSuppressedCommit();
    };
    const onBeforeInput = (event: InputEvent) => {
      if (isCompositionCommitEcho(suppressCommitText, event.inputType, event.data)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        helper.value = "";
        clearSuppressedCommit();
        return;
      }
      // xterm already handled this physical printable on keydown/keypress. Leave the native input event to
      // xterm too, so its own keypress-vs-input dedupe remains intact (notably for Shift+letter in Chromium).
      const physicalOwner = this.consumePhysicalTextInput(event.inputType, event.data);
      if (physicalOwner) {
        if (physicalOwner === "bridge") {
          event.preventDefault();
          event.stopImmediatePropagation();
          helper.value = "";
        }
        return;
      }
      if (event.defaultPrevented || event.isComposing || composing) return;
      const data = beforeInputSequence(
        event.inputType,
        event.data,
        this.terminal.modes.applicationCursorKeysMode,
        this.locks,
      );
      if (!data) return;
      event.preventDefault();
      this.emit(data);
      helper.value = "";
    };

    helper.addEventListener("compositionstart", onCompositionStart, true);
    helper.addEventListener("compositionupdate", onCompositionUpdate, true);
    helper.addEventListener("compositionend", onCompositionEnd, true);
    helper.addEventListener("input", onInput, true);
    helper.addEventListener("beforeinput", onBeforeInput, true);
    this.cleanups.push(() => {
      clearSuppressedCommit();
      this.clearPhysicalTextInput();
      helper.removeEventListener("compositionstart", onCompositionStart, true);
      helper.removeEventListener("compositionupdate", onCompositionUpdate, true);
      helper.removeEventListener("compositionend", onCompositionEnd, true);
      helper.removeEventListener("input", onInput, true);
      helper.removeEventListener("beforeinput", onBeforeInput, true);
    });
  }

  private syncBufferState(): void {
    const active = this.terminal.buffer.active;
    this.host.classList.toggle("rc-xterm-alt-screen", active.type === "alternate");
    this.host.dataset.terminalBuffer = active.type;
    this.host.dataset.terminalViewportLine = String(active.viewportY);
    this.host.dataset.terminalBaseLine = String(active.baseY);
  }

  private installKeyboardHandler(): void {
    this.terminal.attachCustomKeyEventHandler((event) => {
      if (event.type === "keydown" && !event.isComposing && event.keyCode !== 229 && event.key.length === 1) {
        this.markPhysicalTextInput(event.key, this.locks.ctrl || this.locks.alt ? "bridge" : "xterm");
      }
      if (this.customKeyHandler?.(event) === false) return false;
      if (
        event.type !== "keydown" ||
        event.isComposing ||
        event.keyCode === 229 ||
        (!this.locks.ctrl && !this.locks.alt)
      ) {
        return true;
      }
      const encoded = keyboardEventSequence(event, this.terminal.modes.applicationCursorKeysMode, this.locks);
      if (encoded === undefined) return true;
      event.preventDefault();
      event.stopPropagation();
      this.emit(encoded);
      return false;
    });
  }

  private installPointerArbitration(
    options: XtermTerminalOptions,
    linkSerial: () => number,
    setLinkGesture: (gesture: { x: number; y: number; moved: boolean; selecting: boolean } | undefined) => void,
  ): void {
    const macPlatform = isMacPlatform();
    const replayed = new WeakSet<Event>();
    let pending: PendingPrimaryMouse | undefined;
    let linkGesture: { x: number; y: number; moved: boolean; selecting: boolean } | undefined;

    const physicalPointer = (event: MouseEvent): boolean => {
      const source = (event as MouseEvent & { sourceCapabilities?: { firesTouchEvents?: boolean } | null })
        .sourceCapabilities;
      if (source?.firesTouchEvents) return false;
      return typeof options.focusOnPointer === "function"
        ? options.focusOnPointer(event)
        : options.focusOnPointer !== false;
    };
    const secondarySelectsWord = (event: MouseEvent): boolean =>
      typeof options.secondaryClickSelectsWord === "function"
        ? options.secondaryClickSelectsWord(event)
        : options.secondaryClickSelectsWord !== false;

    const dispatchMouse = (
      target: EventTarget,
      type: "mousedown" | "mousemove" | "mouseup",
      source: MouseEvent,
      overrides: MouseEventInit = {},
    ) => {
      const replay = new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        composed: true,
        screenX: source.screenX,
        screenY: source.screenY,
        clientX: source.clientX,
        clientY: source.clientY,
        ctrlKey: source.ctrlKey,
        shiftKey: source.shiftKey,
        altKey: source.altKey,
        metaKey: source.metaKey,
        button: source.button,
        buttons: source.buttons,
        relatedTarget: source.relatedTarget,
        detail: source.detail,
        ...overrides,
      });
      replayed.add(replay);
      target.dispatchEvent(replay);
    };

    const activateLinkAtPoint = (clientX: number, clientY: number, source: MouseEvent): boolean => {
      const screen = this.host.querySelector<HTMLElement>(".xterm-screen");
      if (!screen) return false;
      const before = linkSerial();
      dispatchMouse(screen, "mousemove", source, { bubbles: false, clientX, clientY, button: 0, buttons: 0 });
      dispatchMouse(screen, "mousedown", source, { bubbles: false, clientX, clientY, button: 0, buttons: 1 });
      dispatchMouse(screen, "mouseup", source, { bubbles: false, clientX, clientY, button: 0, buttons: 0 });
      return linkSerial() !== before;
    };

    const beginSelection = (value: PendingPrimaryMouse, move?: MouseEvent) => {
      dispatchMouse(value.target, "mousedown", value.down, {
        altKey: macPlatform || value.down.altKey,
        shiftKey: !macPlatform || value.down.shiftKey,
        button: 0,
        buttons: 1,
      });
      if (move) dispatchMouse(value.target, "mousemove", move, { button: 0, buttons: 1, detail: 0 });
    };

    const removeDocumentListeners = () => {
      document.removeEventListener("mousemove", onDocumentMouseMove, true);
      document.removeEventListener("mouseup", onDocumentMouseUp, true);
      window.removeEventListener("blur", onWindowBlur);
    };
    const clearPending = () => {
      removeDocumentListeners();
      pending = undefined;
    };
    const onDocumentMouseMove = (event: MouseEvent) => {
      const value = pending;
      if (!value || replayed.has(event)) return;
      if (
        linkGesture &&
        Math.hypot(event.clientX - linkGesture.x, event.clientY - linkGesture.y) >= PRIMARY_DRAG_THRESHOLD
      ) {
        linkGesture.moved = true;
      }
      value.lastX = event.clientX;
      value.lastY = event.clientY;
      if (value.selecting) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (Math.hypot(event.clientX - value.down.clientX, event.clientY - value.down.clientY) < PRIMARY_DRAG_THRESHOLD)
        return;
      value.selecting = true;
      beginSelection(value, event);
    };
    const onDocumentMouseUp = (event: MouseEvent) => {
      const value = pending;
      if (!value || replayed.has(event)) return;
      if (value.selecting) {
        clearPending();
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      clearPending();
      if (!activateLinkAtPoint(event.clientX, event.clientY, event)) {
        dispatchMouse(value.target, "mousedown", value.down, { button: 0, buttons: 1 });
        dispatchMouse(value.target, "mouseup", event, { button: 0, buttons: 0 });
      }
      linkGesture = undefined;
      setLinkGesture(undefined);
    };
    const onWindowBlur = () => {
      const value = pending;
      if (!value) return;
      clearPending();
      if (value.selecting) {
        dispatchMouse(value.target, "mouseup", value.down, {
          clientX: value.lastX,
          clientY: value.lastY,
          button: 0,
          buttons: 0,
        });
      }
    };
    const onMouseDownCapture = (event: MouseEvent) => {
      if (replayed.has(event) || !physicalPointer(event)) return;
      if (event.button === 2) {
        if (this.terminal.modes.mouseTrackingMode === "none" && secondarySelectsWord(event)) {
          selectWordAtPoint(this.terminal, this.host, event.clientX, event.clientY);
        }
        return;
      }
      if (event.button !== 0) return;
      linkGesture = {
        x: event.clientX,
        y: event.clientY,
        moved: false,
        selecting: event.detail > 1 || (macPlatform ? event.altKey : event.shiftKey),
      };
      setLinkGesture(linkGesture);
      if (this.terminal.modes.mouseTrackingMode === "none" || (macPlatform ? event.altKey : event.shiftKey)) {
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      this.terminal.focus();
      const value: PendingPrimaryMouse = {
        down: event,
        target: event.target ?? this.host,
        selecting: false,
        lastX: event.clientX,
        lastY: event.clientY,
      };
      if (event.detail > 1) {
        beginSelection(value);
        return;
      }
      pending = value;
      document.addEventListener("mousemove", onDocumentMouseMove, true);
      document.addEventListener("mouseup", onDocumentMouseUp, true);
      window.addEventListener("blur", onWindowBlur);
    };
    const onMouseMoveCapture = (event: MouseEvent) => {
      if (linkGesture && event.buttons === 1 && !replayed.has(event)) {
        if (Math.hypot(event.clientX - linkGesture.x, event.clientY - linkGesture.y) >= PRIMARY_DRAG_THRESHOLD) {
          linkGesture.moved = true;
        }
      }
      if (replayed.has(event) || event.buttons !== 0 || !physicalPointer(event) || !this.terminal.hasSelection())
        return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    const onMouseUpCapture = (event: MouseEvent) => {
      if (event.button !== 0 || replayed.has(event) || !linkGesture) return;
      queueMicrotask(() => {
        linkGesture = undefined;
        setLinkGesture(undefined);
      });
    };

    this.host.addEventListener("mousedown", onMouseDownCapture, true);
    this.host.addEventListener("mousemove", onMouseMoveCapture, true);
    this.host.addEventListener("mouseup", onMouseUpCapture, true);
    this.cleanups.push(() => {
      clearPending();
      this.host.removeEventListener("mousedown", onMouseDownCapture, true);
      this.host.removeEventListener("mousemove", onMouseMoveCapture, true);
      this.host.removeEventListener("mouseup", onMouseUpCapture, true);
    });
  }
}
