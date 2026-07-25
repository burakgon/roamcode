export interface GhosttyWasmExports extends WebAssembly.Exports {
  memory: WebAssembly.Memory;
  ghostty_type_json(): number;
  ghostty_wasm_alloc_opaque(): number;
  ghostty_wasm_free_opaque(ptr: number): void;
  ghostty_wasm_alloc_u8_array(len: number): number;
  ghostty_wasm_free_u8_array(ptr: number, len: number): void;
  ghostty_wasm_alloc_u8(): number;
  ghostty_wasm_free_u8(ptr: number): void;
  ghostty_wasm_alloc_usize(): number;
  ghostty_wasm_free_usize(ptr: number): void;

  ghostty_terminal_new(allocator: number, terminalOut: number, options: number): number;
  ghostty_terminal_free(terminal: number): void;
  ghostty_terminal_reset(terminal: number): void;
  ghostty_terminal_resize(
    terminal: number,
    cols: number,
    rows: number,
    cellWidthPx: number,
    cellHeightPx: number,
  ): number;
  ghostty_terminal_vt_write(terminal: number, data: number, len: number): void;
  ghostty_terminal_scroll_viewport(terminal: number, behavior: number): void;
  ghostty_terminal_mode_get(terminal: number, mode: number, valueOut: number): number;

  ghostty_render_state_new(allocator: number, stateOut: number): number;
  ghostty_render_state_free(state: number): void;
  ghostty_render_state_update(state: number, terminal: number): number;
  ghostty_render_state_get(state: number, key: number, valueOut: number): number;
  ghostty_render_state_colors_get(state: number, colorsOut: number): number;
  ghostty_render_state_row_iterator_new(allocator: number, iteratorOut: number): number;
  ghostty_render_state_row_iterator_free(iterator: number): void;
  ghostty_render_state_row_iterator_next(iterator: number): boolean;
  ghostty_render_state_row_get(iterator: number, key: number, valueOut: number): number;
  ghostty_render_state_row_cells_new(allocator: number, cellsOut: number): number;
  ghostty_render_state_row_cells_free(cells: number): void;
  ghostty_render_state_row_cells_next(cells: number): boolean;
  ghostty_render_state_row_cells_get(cells: number, key: number, valueOut: number): number;
  ghostty_cell_get(cell: bigint, key: number, valueOut: number): number;

  ghostty_key_encoder_new(allocator: number, encoderOut: number): number;
  ghostty_key_encoder_free(encoder: number): void;
  ghostty_key_encoder_setopt_from_terminal(encoder: number, terminal: number): void;
  ghostty_key_encoder_encode(
    encoder: number,
    event: number,
    output: number,
    outputLen: number,
    writtenOut: number,
  ): number;
  ghostty_key_event_new(allocator: number, eventOut: number): number;
  ghostty_key_event_free(event: number): void;
  ghostty_key_event_set_action(event: number, action: number): void;
  ghostty_key_event_set_key(event: number, key: number): void;
  ghostty_key_event_set_mods(event: number, mods: number): void;
  ghostty_key_event_set_consumed_mods(event: number, mods: number): void;
  ghostty_key_event_set_composing(event: number, composing: boolean): void;
  ghostty_key_event_set_utf8(event: number, value: number, len: number): void;
  ghostty_key_event_set_unshifted_codepoint(event: number, codepoint: number): void;

  ghostty_mouse_encoder_new(allocator: number, encoderOut: number): number;
  ghostty_mouse_encoder_free(encoder: number): void;
  ghostty_mouse_encoder_setopt(encoder: number, option: number, value: number): void;
  ghostty_mouse_encoder_setopt_from_terminal(encoder: number, terminal: number): void;
  ghostty_mouse_encoder_encode(
    encoder: number,
    event: number,
    output: number,
    outputLen: number,
    writtenOut: number,
  ): number;
  ghostty_mouse_event_new(allocator: number, eventOut: number): number;
  ghostty_mouse_event_free(event: number): void;
  ghostty_mouse_event_set_action(event: number, action: number): void;
  ghostty_mouse_event_set_button(event: number, button: number): void;
  ghostty_mouse_event_clear_button(event: number): void;
  ghostty_mouse_event_set_mods(event: number, mods: number): void;
  ghostty_mouse_event_set_position(event: number, position: number): void;

  ghostty_paste_encode(
    data: number,
    dataLen: number,
    bracketed: boolean,
    output: number,
    outputLen: number,
    writtenOut: number,
  ): number;
}

export const enum RenderStateData {
  Cols = 1,
  Rows = 2,
  RowIterator = 4,
  CursorVisualStyle = 10,
  CursorVisible = 11,
  CursorViewportHasValue = 14,
  CursorViewportX = 15,
  CursorViewportY = 16,
}

export const enum RenderStateRowData {
  Cells = 3,
}

export const enum RowCellsData {
  Raw = 1,
  Style = 2,
  GraphemesLength = 3,
  GraphemesBuffer = 4,
  BackgroundColor = 5,
  ForegroundColor = 6,
}

export const enum CellData {
  Wide = 3,
}

export const enum CellWide {
  Narrow = 0,
  Wide = 1,
  SpacerTail = 2,
  SpacerHead = 3,
}

export const enum KeyAction {
  Release = 0,
  Press = 1,
  Repeat = 2,
}

export const enum Mods {
  Shift = 1 << 0,
  Control = 1 << 1,
  Alt = 1 << 2,
  Super = 1 << 3,
  CapsLock = 1 << 4,
  NumLock = 1 << 5,
}

export const enum GhosttyKey {
  Unidentified = 0,
  Backquote = 1,
  Backslash = 2,
  BracketLeft = 3,
  BracketRight = 4,
  Comma = 5,
  Digit0 = 6,
  Digit1 = 7,
  Digit2 = 8,
  Digit3 = 9,
  Digit4 = 10,
  Digit5 = 11,
  Digit6 = 12,
  Digit7 = 13,
  Digit8 = 14,
  Digit9 = 15,
  Equal = 16,
  IntlBackslash = 17,
  IntlRo = 18,
  IntlYen = 19,
  A = 20,
  B = 21,
  C = 22,
  D = 23,
  E = 24,
  F = 25,
  G = 26,
  H = 27,
  I = 28,
  J = 29,
  K = 30,
  L = 31,
  M = 32,
  N = 33,
  O = 34,
  P = 35,
  Q = 36,
  R = 37,
  S = 38,
  T = 39,
  U = 40,
  V = 41,
  W = 42,
  X = 43,
  Y = 44,
  Z = 45,
  Minus = 46,
  Period = 47,
  Quote = 48,
  Semicolon = 49,
  Slash = 50,
  AltLeft = 51,
  AltRight = 52,
  Backspace = 53,
  CapsLock = 54,
  ContextMenu = 55,
  ControlLeft = 56,
  ControlRight = 57,
  Enter = 58,
  MetaLeft = 59,
  MetaRight = 60,
  ShiftLeft = 61,
  ShiftRight = 62,
  Space = 63,
  Tab = 64,
  Delete = 68,
  End = 69,
  Help = 70,
  Home = 71,
  Insert = 72,
  PageDown = 73,
  PageUp = 74,
  ArrowDown = 75,
  ArrowLeft = 76,
  ArrowRight = 77,
  ArrowUp = 78,
  NumLock = 79,
  Numpad0 = 80,
  Numpad1 = 81,
  Numpad2 = 82,
  Numpad3 = 83,
  Numpad4 = 84,
  Numpad5 = 85,
  Numpad6 = 86,
  Numpad7 = 87,
  Numpad8 = 88,
  Numpad9 = 89,
  NumpadAdd = 90,
  NumpadDecimal = 95,
  NumpadDivide = 96,
  NumpadEnter = 97,
  NumpadMultiply = 104,
  NumpadSubtract = 107,
  Escape = 120,
  F1 = 121,
  F2 = 122,
  F3 = 123,
  F4 = 124,
  F5 = 125,
  F6 = 126,
  F7 = 127,
  F8 = 128,
  F9 = 129,
  F10 = 130,
  F11 = 131,
  F12 = 132,
  F13 = 133,
  F14 = 134,
  F15 = 135,
  F16 = 136,
  F17 = 137,
  F18 = 138,
  F19 = 139,
  F20 = 140,
  F21 = 141,
  F22 = 142,
  F23 = 143,
  F24 = 144,
  PrintScreen = 148,
  ScrollLock = 149,
  Pause = 150,
}

export interface GhosttyKeyInput {
  action: KeyAction;
  key: GhosttyKey;
  mods: number;
  utf8?: string;
  composing?: boolean;
  unshiftedCodepoint?: number;
}

export const enum MouseAction {
  Press = 0,
  Release = 1,
  Motion = 2,
}

export const enum MouseButton {
  Left = 1,
  Right = 2,
  Middle = 3,
  WheelUp = 4,
  WheelDown = 5,
}

export interface GhosttyMouseInput {
  action: MouseAction;
  button?: MouseButton;
  mods: number;
  x: number;
  y: number;
  anyButtonPressed: boolean;
  screenWidth: number;
  screenHeight: number;
  cellWidth: number;
  cellHeight: number;
}

export interface GhosttyCellSnapshot {
  text: string;
  width: 0 | 1 | 2;
  foreground?: string;
  background?: string;
  bold: boolean;
  italic: boolean;
  faint: boolean;
  blink: boolean;
  inverse: boolean;
  invisible: boolean;
  strikethrough: boolean;
  overline: boolean;
  underline: boolean;
}

export interface GhosttyFrame {
  cols: number;
  rows: number;
  cells: GhosttyCellSnapshot[][];
  foreground: string;
  background: string;
  cursor: {
    x: number;
    y: number;
    visible: boolean;
    style: "bar" | "block" | "underline" | "hollow";
    color: string;
  };
}
