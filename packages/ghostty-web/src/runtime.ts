import {
  CellData,
  CellWide,
  type GhosttyCellSnapshot,
  type GhosttyFrame,
  type GhosttyKeyInput,
  type GhosttyMouseInput,
  type GhosttyWasmExports,
  RenderStateData,
  RenderStateRowData,
  RowCellsData,
} from "./types";

const REQUIRED_EXPORTS = [
  "memory",
  "ghostty_type_json",
  "ghostty_terminal_new",
  "ghostty_terminal_vt_write",
  "ghostty_terminal_resize",
  "ghostty_render_state_new",
  "ghostty_render_state_update",
  "ghostty_render_state_row_iterator_new",
  "ghostty_render_state_row_cells_new",
  "ghostty_key_encoder_new",
  "ghostty_key_encoder_encode",
  "ghostty_mouse_encoder_new",
  "ghostty_mouse_encoder_encode",
] as const;

type AbiLayout = {
  size: number;
  fields: Record<string, { offset: number; size: number; type: string }>;
};

export interface GhosttyAbi {
  GhosttyTerminalOptions: AbiLayout;
  GhosttyRenderStateColors: AbiLayout;
  GhosttyMouseEncoderSize: AbiLayout;
  GhosttyTerminalScrollViewport: AbiLayout;
  GhosttyStyle: AbiLayout;
}

function readCString(memory: WebAssembly.Memory, pointer: number): string {
  const bytes = new Uint8Array(memory.buffer, pointer);
  let length = 0;
  while (length < bytes.length && bytes[length] !== 0) length++;
  return new TextDecoder().decode(bytes.subarray(0, length));
}

function assertAbi(value: unknown): asserts value is GhosttyAbi {
  if (!value || typeof value !== "object") throw new Error("Ghostty returned invalid ABI metadata");
  const abi = value as Partial<GhosttyAbi>;
  if (abi.GhosttyTerminalOptions?.size !== 8) {
    throw new Error(`Unsupported GhosttyTerminalOptions ABI size: ${String(abi.GhosttyTerminalOptions?.size)}`);
  }
  if (abi.GhosttyRenderStateColors?.size !== 784) {
    throw new Error(`Unsupported GhosttyRenderStateColors ABI size: ${String(abi.GhosttyRenderStateColors?.size)}`);
  }
  if (abi.GhosttyMouseEncoderSize?.size !== 36) {
    throw new Error(`Unsupported GhosttyMouseEncoderSize ABI size: ${String(abi.GhosttyMouseEncoderSize?.size)}`);
  }
  if (abi.GhosttyTerminalScrollViewport?.size !== 24) {
    throw new Error(
      `Unsupported GhosttyTerminalScrollViewport ABI size: ${String(abi.GhosttyTerminalScrollViewport?.size)}`,
    );
  }
  if (abi.GhosttyStyle?.size !== 72) {
    throw new Error(`Unsupported GhosttyStyle ABI size: ${String(abi.GhosttyStyle?.size)}`);
  }
}

function cssRgb(bytes: Uint8Array): string {
  return `rgb(${bytes[0] ?? 0}, ${bytes[1] ?? 0}, ${bytes[2] ?? 0})`;
}

function abiField(layout: AbiLayout, name: string): { offset: number; size: number; type: string } {
  const field = layout.fields[name];
  if (!field) throw new Error(`Ghostty ABI metadata is missing field ${name}`);
  return field;
}

export class GhosttyRuntime {
  readonly exports: GhosttyWasmExports;
  readonly abi: GhosttyAbi;

  constructor(exports: GhosttyWasmExports) {
    for (const name of REQUIRED_EXPORTS) {
      if (!(name in exports)) throw new Error(`Ghostty WASM is missing required export ${name}`);
    }
    this.exports = exports;
    const abi = JSON.parse(readCString(exports.memory, exports.ghostty_type_json())) as unknown;
    assertAbi(abi);
    this.abi = abi;
  }

  createTerminal(cols = 80, rows = 24, scrollback = 1000): GhosttyTerminalCore {
    return new GhosttyTerminalCore(this, cols, rows, scrollback);
  }
}

export async function instantiateGhostty(bytes: ArrayBuffer): Promise<GhosttyRuntime> {
  const state: { exports?: GhosttyWasmExports } = {};
  const module = await WebAssembly.compile(bytes);
  const instance = await WebAssembly.instantiate(module, {
    env: {
      log(pointer: number, length: number) {
        if (!state.exports) return;
        const message = new TextDecoder().decode(new Uint8Array(state.exports.memory.buffer, pointer, length));
        console.debug("[ghostty-vt]", message);
      },
    },
  });
  state.exports = instance.exports as GhosttyWasmExports;
  return new GhosttyRuntime(state.exports);
}

const DEFAULT_WASM_URL = new URL("./ghostty-vt.wasm", import.meta.url).href;
let runtimePromise: Promise<GhosttyRuntime> | undefined;

export function loadGhosttyRuntime(wasmUrl = DEFAULT_WASM_URL): Promise<GhosttyRuntime> {
  if (!runtimePromise) {
    const pending = fetch(wasmUrl)
      .then((response) => {
        if (!response.ok) throw new Error(`Ghostty WASM request failed (${response.status})`);
        return response.arrayBuffer();
      })
      .then(instantiateGhostty);
    runtimePromise = pending;
    void pending.catch(() => {
      if (runtimePromise === pending) runtimePromise = undefined;
    });
  }
  return runtimePromise;
}

export function resetGhosttyRuntimeForTests(): void {
  runtimePromise = undefined;
}

export class GhosttyTerminalCore {
  private readonly exports: GhosttyWasmExports;
  private readonly memory: WebAssembly.Memory;
  private readonly abi: GhosttyAbi;
  private terminal = 0;
  private renderState = 0;
  private rowIterator = 0;
  private rowCells = 0;
  private keyEncoder = 0;
  private keyEvent = 0;
  private mouseEncoder = 0;
  private mouseEvent = 0;
  private disposed = false;
  private _cols: number;
  private _rows: number;

  constructor(runtime: GhosttyRuntime, cols: number, rows: number, scrollback: number) {
    this.exports = runtime.exports;
    this.memory = runtime.exports.memory;
    this.abi = runtime.abi;
    this._cols = Math.max(1, Math.min(65535, Math.floor(cols)));
    this._rows = Math.max(1, Math.min(65535, Math.floor(rows)));

    const options = this.exports.ghostty_wasm_alloc_u8_array(runtime.abi.GhosttyTerminalOptions.size);
    try {
      const view = this.view();
      view.setUint16(options + abiField(runtime.abi.GhosttyTerminalOptions, "cols").offset, this._cols, true);
      view.setUint16(options + abiField(runtime.abi.GhosttyTerminalOptions, "rows").offset, this._rows, true);
      view.setUint32(
        options + abiField(runtime.abi.GhosttyTerminalOptions, "max_scrollback").offset,
        Math.max(0, Math.floor(scrollback)),
        true,
      );
      this.terminal = this.allocateHandle((out) => this.exports.ghostty_terminal_new(0, out, options));
    } finally {
      this.exports.ghostty_wasm_free_u8_array(options, runtime.abi.GhosttyTerminalOptions.size);
    }
    try {
      this.renderState = this.allocateHandle((out) => this.exports.ghostty_render_state_new(0, out));
      this.rowIterator = this.allocateHandle((out) => this.exports.ghostty_render_state_row_iterator_new(0, out));
      this.rowCells = this.allocateHandle((out) => this.exports.ghostty_render_state_row_cells_new(0, out));
      this.keyEncoder = this.allocateHandle((out) => this.exports.ghostty_key_encoder_new(0, out));
      this.keyEvent = this.allocateHandle((out) => this.exports.ghostty_key_event_new(0, out));
      this.mouseEncoder = this.allocateHandle((out) => this.exports.ghostty_mouse_encoder_new(0, out));
      this.mouseEvent = this.allocateHandle((out) => this.exports.ghostty_mouse_event_new(0, out));
    } catch (error) {
      this.dispose();
      throw error;
    }
  }

  get cols(): number {
    return this._cols;
  }

  get rows(): number {
    return this._rows;
  }

  private view(): DataView {
    return new DataView(this.memory.buffer);
  }

  private allocateHandle(create: (out: number) => number): number {
    const out = this.exports.ghostty_wasm_alloc_opaque();
    if (!out) throw new Error("Ghostty failed to allocate an opaque handle");
    try {
      const result = create(out);
      if (result !== 0) throw new Error(`Ghostty handle creation failed (${result})`);
      const handle = this.view().getUint32(out, true);
      if (!handle) throw new Error("Ghostty returned an empty handle");
      return handle;
    } finally {
      this.exports.ghostty_wasm_free_opaque(out);
    }
  }

  private populateHandle(handle: number, populate: (out: number) => number): void {
    const out = this.exports.ghostty_wasm_alloc_opaque();
    if (!out) throw new Error("Ghostty failed to allocate an iterator handle");
    try {
      this.view().setUint32(out, handle, true);
      const result = populate(out);
      if (result !== 0) throw new Error(`Ghostty iterator population failed (${result})`);
    } finally {
      this.exports.ghostty_wasm_free_opaque(out);
    }
  }

  private assertLive(): void {
    if (this.disposed || !this.terminal) throw new Error("Ghostty terminal is disposed");
  }

  write(data: Uint8Array): void {
    this.assertLive();
    if (data.length === 0) return;
    const pointer = this.exports.ghostty_wasm_alloc_u8_array(data.length);
    try {
      new Uint8Array(this.memory.buffer).set(data, pointer);
      this.exports.ghostty_terminal_vt_write(this.terminal, pointer, data.length);
    } finally {
      this.exports.ghostty_wasm_free_u8_array(pointer, data.length);
    }
  }

  reset(): void {
    this.assertLive();
    this.exports.ghostty_terminal_reset(this.terminal);
  }

  resize(cols: number, rows: number, cellWidthPx: number, cellHeightPx: number): void {
    this.assertLive();
    const nextCols = Math.max(1, Math.min(65535, Math.floor(cols)));
    const nextRows = Math.max(1, Math.min(65535, Math.floor(rows)));
    const result = this.exports.ghostty_terminal_resize(
      this.terminal,
      nextCols,
      nextRows,
      Math.max(0, Math.round(cellWidthPx)),
      Math.max(0, Math.round(cellHeightPx)),
    );
    if (result !== 0) throw new Error(`Ghostty resize failed (${result})`);
    this._cols = nextCols;
    this._rows = nextRows;
  }

  scrollViewport(delta: number): void {
    this.assertLive();
    if (!Number.isFinite(delta) || delta === 0) return;
    const layout = this.abi.GhosttyTerminalScrollViewport;
    const size = layout.size;
    const behavior = this.exports.ghostty_wasm_alloc_u8_array(size);
    try {
      new Uint8Array(this.memory.buffer, behavior, size).fill(0);
      const view = this.view();
      view.setInt32(behavior + abiField(layout, "tag").offset, 2, true);
      view.setInt32(behavior + abiField(layout, "value").offset, Math.trunc(delta), true);
      this.exports.ghostty_terminal_scroll_viewport(this.terminal, behavior);
    } finally {
      this.exports.ghostty_wasm_free_u8_array(behavior, size);
    }
  }

  private terminalMode(mode: number): boolean {
    const out = this.exports.ghostty_wasm_alloc_u8();
    try {
      return this.exports.ghostty_terminal_mode_get(this.terminal, mode & 0x7fff, out) === 0
        ? this.view().getUint8(out) !== 0
        : false;
    } finally {
      this.exports.ghostty_wasm_free_u8(out);
    }
  }

  encodePaste(text: string): Uint8Array {
    this.assertLive();
    const input = new TextEncoder().encode(text);
    if (input.length === 0) return input;
    const data = this.exports.ghostty_wasm_alloc_u8_array(input.length);
    const written = this.exports.ghostty_wasm_alloc_usize();
    let output = 0;
    let outputSize = input.length + 32;
    try {
      new Uint8Array(this.memory.buffer).set(input, data);
      output = this.exports.ghostty_wasm_alloc_u8_array(outputSize);
      let result = this.exports.ghostty_paste_encode(
        data,
        input.length,
        this.terminalMode(2004),
        output,
        outputSize,
        written,
      );
      if (result === -3) {
        const needed = this.view().getUint32(written, true);
        this.exports.ghostty_wasm_free_u8_array(output, outputSize);
        outputSize = needed;
        output = this.exports.ghostty_wasm_alloc_u8_array(outputSize);
        new Uint8Array(this.memory.buffer).set(input, data);
        result = this.exports.ghostty_paste_encode(
          data,
          input.length,
          this.terminalMode(2004),
          output,
          outputSize,
          written,
        );
      }
      if (result !== 0) throw new Error(`Ghostty paste encoding failed (${result})`);
      return new Uint8Array(this.memory.buffer, output, this.view().getUint32(written, true)).slice();
    } finally {
      if (output) this.exports.ghostty_wasm_free_u8_array(output, outputSize);
      this.exports.ghostty_wasm_free_u8_array(data, input.length);
      this.exports.ghostty_wasm_free_usize(written);
    }
  }

  encodeKey(input: GhosttyKeyInput): Uint8Array {
    this.assertLive();
    this.exports.ghostty_key_encoder_setopt_from_terminal(this.keyEncoder, this.terminal);
    this.exports.ghostty_key_event_set_action(this.keyEvent, input.action);
    this.exports.ghostty_key_event_set_key(this.keyEvent, input.key);
    this.exports.ghostty_key_event_set_mods(this.keyEvent, input.mods);
    this.exports.ghostty_key_event_set_consumed_mods(this.keyEvent, 0);
    this.exports.ghostty_key_event_set_composing(this.keyEvent, input.composing === true);
    this.exports.ghostty_key_event_set_unshifted_codepoint(this.keyEvent, input.unshiftedCodepoint ?? 0);

    const utf8 = input.utf8 ? new TextEncoder().encode(input.utf8) : undefined;
    let utf8Pointer = 0;
    if (utf8?.length) {
      utf8Pointer = this.exports.ghostty_wasm_alloc_u8_array(utf8.length);
      new Uint8Array(this.memory.buffer).set(utf8, utf8Pointer);
      this.exports.ghostty_key_event_set_utf8(this.keyEvent, utf8Pointer, utf8.length);
    } else {
      this.exports.ghostty_key_event_set_utf8(this.keyEvent, 0, 0);
    }

    const written = this.exports.ghostty_wasm_alloc_usize();
    let outputSize = 128;
    let output = this.exports.ghostty_wasm_alloc_u8_array(outputSize);
    try {
      let result = this.exports.ghostty_key_encoder_encode(this.keyEncoder, this.keyEvent, output, outputSize, written);
      if (result === -3) {
        const needed = this.view().getUint32(written, true);
        this.exports.ghostty_wasm_free_u8_array(output, outputSize);
        outputSize = needed;
        output = this.exports.ghostty_wasm_alloc_u8_array(outputSize);
        result = this.exports.ghostty_key_encoder_encode(this.keyEncoder, this.keyEvent, output, outputSize, written);
      }
      if (result !== 0) throw new Error(`Ghostty key encoding failed (${result})`);
      return new Uint8Array(this.memory.buffer, output, this.view().getUint32(written, true)).slice();
    } finally {
      this.exports.ghostty_wasm_free_u8_array(output, outputSize);
      this.exports.ghostty_wasm_free_usize(written);
      if (utf8Pointer && utf8) this.exports.ghostty_wasm_free_u8_array(utf8Pointer, utf8.length);
    }
  }

  encodeMouse(input: GhosttyMouseInput): Uint8Array {
    this.assertLive();
    this.exports.ghostty_mouse_encoder_setopt_from_terminal(this.mouseEncoder, this.terminal);

    const geometryLayout = this.abi.GhosttyMouseEncoderSize;
    const geometrySize = geometryLayout.size;
    const geometry = this.exports.ghostty_wasm_alloc_u8_array(geometrySize);
    const booleanValue = this.exports.ghostty_wasm_alloc_u8();
    const position = this.exports.ghostty_wasm_alloc_u8_array(8);
    const written = this.exports.ghostty_wasm_alloc_usize();
    const outputSize = 128;
    const output = this.exports.ghostty_wasm_alloc_u8_array(outputSize);
    try {
      new Uint8Array(this.memory.buffer, geometry, geometrySize).fill(0);
      const view = this.view();
      view.setUint32(geometry + abiField(geometryLayout, "size").offset, geometrySize, true);
      view.setUint32(
        geometry + abiField(geometryLayout, "screen_width").offset,
        Math.max(1, Math.round(input.screenWidth)),
        true,
      );
      view.setUint32(
        geometry + abiField(geometryLayout, "screen_height").offset,
        Math.max(1, Math.round(input.screenHeight)),
        true,
      );
      view.setUint32(
        geometry + abiField(geometryLayout, "cell_width").offset,
        Math.max(1, Math.round(input.cellWidth)),
        true,
      );
      view.setUint32(
        geometry + abiField(geometryLayout, "cell_height").offset,
        Math.max(1, Math.round(input.cellHeight)),
        true,
      );
      this.exports.ghostty_mouse_encoder_setopt(this.mouseEncoder, 2, geometry);
      view.setUint8(booleanValue, input.anyButtonPressed ? 1 : 0);
      this.exports.ghostty_mouse_encoder_setopt(this.mouseEncoder, 3, booleanValue);

      this.exports.ghostty_mouse_event_set_action(this.mouseEvent, input.action);
      if (input.button === undefined) this.exports.ghostty_mouse_event_clear_button(this.mouseEvent);
      else this.exports.ghostty_mouse_event_set_button(this.mouseEvent, input.button);
      this.exports.ghostty_mouse_event_set_mods(this.mouseEvent, input.mods);
      view.setFloat32(position, input.x, true);
      view.setFloat32(position + 4, input.y, true);
      this.exports.ghostty_mouse_event_set_position(this.mouseEvent, position);

      const result = this.exports.ghostty_mouse_encoder_encode(
        this.mouseEncoder,
        this.mouseEvent,
        output,
        outputSize,
        written,
      );
      if (result !== 0) throw new Error(`Ghostty mouse encoding failed (${result})`);
      return new Uint8Array(this.memory.buffer, output, this.view().getUint32(written, true)).slice();
    } finally {
      this.exports.ghostty_wasm_free_u8_array(output, outputSize);
      this.exports.ghostty_wasm_free_usize(written);
      this.exports.ghostty_wasm_free_u8_array(position, 8);
      this.exports.ghostty_wasm_free_u8(booleanValue);
      this.exports.ghostty_wasm_free_u8_array(geometry, geometrySize);
    }
  }

  snapshot(): GhosttyFrame {
    this.assertLive();
    const update = this.exports.ghostty_render_state_update(this.renderState, this.terminal);
    if (update !== 0) throw new Error(`Ghostty render-state update failed (${update})`);

    const colorsLayout = this.abi.GhosttyRenderStateColors;
    const colorsSize = colorsLayout.size;
    const colors = this.exports.ghostty_wasm_alloc_u8_array(colorsSize);
    const scalar = this.exports.ghostty_wasm_alloc_u8_array(4);
    const rgb = this.exports.ghostty_wasm_alloc_u8_array(3);
    const rawCell = this.exports.ghostty_wasm_alloc_u8_array(8);
    const styleLayout = this.abi.GhosttyStyle;
    const styleSize = styleLayout.size;
    const styleOffsets = {
      size: abiField(styleLayout, "size").offset,
      bold: abiField(styleLayout, "bold").offset,
      italic: abiField(styleLayout, "italic").offset,
      faint: abiField(styleLayout, "faint").offset,
      blink: abiField(styleLayout, "blink").offset,
      inverse: abiField(styleLayout, "inverse").offset,
      invisible: abiField(styleLayout, "invisible").offset,
      strikethrough: abiField(styleLayout, "strikethrough").offset,
      overline: abiField(styleLayout, "overline").offset,
      underline: abiField(styleLayout, "underline").offset,
    };
    const style = this.exports.ghostty_wasm_alloc_u8_array(styleSize);
    let graphemesCapacity = 64;
    let graphemes = this.exports.ghostty_wasm_alloc_u8_array(graphemesCapacity);
    try {
      this.view().setUint32(colors + abiField(colorsLayout, "size").offset, colorsSize, true);
      const colorsResult = this.exports.ghostty_render_state_colors_get(this.renderState, colors);
      if (colorsResult !== 0) throw new Error(`Ghostty colors read failed (${colorsResult})`);
      const background = cssRgb(
        new Uint8Array(this.memory.buffer, colors + abiField(colorsLayout, "background").offset, 3),
      );
      const foreground = cssRgb(
        new Uint8Array(this.memory.buffer, colors + abiField(colorsLayout, "foreground").offset, 3),
      );
      const cursorColor =
        this.view().getUint8(colors + abiField(colorsLayout, "cursor_has_value").offset) !== 0
          ? cssRgb(new Uint8Array(this.memory.buffer, colors + abiField(colorsLayout, "cursor").offset, 3))
          : foreground;

      const readRenderInt = (key: RenderStateData): number => {
        const result = this.exports.ghostty_render_state_get(this.renderState, key, scalar);
        if (result !== 0) return 0;
        return key === RenderStateData.CursorVisible || key === RenderStateData.CursorViewportHasValue
          ? this.view().getUint8(scalar)
          : this.view().getUint16(scalar, true);
      };
      const cols = readRenderInt(RenderStateData.Cols) || this._cols;
      const rows = readRenderInt(RenderStateData.Rows) || this._rows;
      const cursorHasPosition = readRenderInt(RenderStateData.CursorViewportHasValue) !== 0;
      const cursorStyleResult = this.exports.ghostty_render_state_get(
        this.renderState,
        RenderStateData.CursorVisualStyle,
        scalar,
      );
      const cursorStyleValue = cursorStyleResult === 0 ? this.view().getInt32(scalar, true) : 1;
      const cursorStyle =
        cursorStyleValue === 0
          ? "bar"
          : cursorStyleValue === 2
            ? "underline"
            : cursorStyleValue === 3
              ? "hollow"
              : "block";

      this.populateHandle(this.rowIterator, (out) =>
        this.exports.ghostty_render_state_get(this.renderState, RenderStateData.RowIterator, out),
      );
      const cells: GhosttyCellSnapshot[][] = [];
      let row = 0;
      while (row < rows && this.exports.ghostty_render_state_row_iterator_next(this.rowIterator)) {
        this.populateHandle(this.rowCells, (out) =>
          this.exports.ghostty_render_state_row_get(this.rowIterator, RenderStateRowData.Cells, out),
        );
        const line: GhosttyCellSnapshot[] = [];
        let col = 0;
        while (col < cols && this.exports.ghostty_render_state_row_cells_next(this.rowCells)) {
          this.exports.ghostty_render_state_row_cells_get(this.rowCells, RowCellsData.GraphemesLength, scalar);
          const graphemeCount = this.view().getUint32(scalar, true);
          const needed = Math.max(4, graphemeCount * 4);
          if (needed > graphemesCapacity) {
            this.exports.ghostty_wasm_free_u8_array(graphemes, graphemesCapacity);
            graphemesCapacity = needed;
            graphemes = this.exports.ghostty_wasm_alloc_u8_array(graphemesCapacity);
          }
          let text = " ";
          if (graphemeCount > 0) {
            this.exports.ghostty_render_state_row_cells_get(this.rowCells, RowCellsData.GraphemesBuffer, graphemes);
            text = String.fromCodePoint(...Array.from(new Uint32Array(this.memory.buffer, graphemes, graphemeCount)));
          }

          const foregroundResult = this.exports.ghostty_render_state_row_cells_get(
            this.rowCells,
            RowCellsData.ForegroundColor,
            rgb,
          );
          const cellForeground =
            foregroundResult === 0 ? cssRgb(new Uint8Array(this.memory.buffer, rgb, 3)) : undefined;
          const backgroundResult = this.exports.ghostty_render_state_row_cells_get(
            this.rowCells,
            RowCellsData.BackgroundColor,
            rgb,
          );
          const cellBackground =
            backgroundResult === 0 ? cssRgb(new Uint8Array(this.memory.buffer, rgb, 3)) : undefined;

          this.view().setUint32(style + styleOffsets.size, styleSize, true);
          this.exports.ghostty_render_state_row_cells_get(this.rowCells, RowCellsData.Style, style);
          const styleBytes = new Uint8Array(this.memory.buffer, style, styleSize);

          this.exports.ghostty_render_state_row_cells_get(this.rowCells, RowCellsData.Raw, rawCell);
          const raw = this.view().getBigUint64(rawCell, true);
          this.exports.ghostty_cell_get(raw, CellData.Wide, scalar);
          const wide = this.view().getInt32(scalar, true);
          const width: 0 | 1 | 2 =
            wide === CellWide.Wide ? 2 : wide === CellWide.SpacerTail || wide === CellWide.SpacerHead ? 0 : 1;

          line.push({
            text,
            width,
            foreground: cellForeground,
            background: cellBackground,
            bold: styleBytes[styleOffsets.bold] !== 0,
            italic: styleBytes[styleOffsets.italic] !== 0,
            faint: styleBytes[styleOffsets.faint] !== 0,
            blink: styleBytes[styleOffsets.blink] !== 0,
            inverse: styleBytes[styleOffsets.inverse] !== 0,
            invisible: styleBytes[styleOffsets.invisible] !== 0,
            strikethrough: styleBytes[styleOffsets.strikethrough] !== 0,
            overline: styleBytes[styleOffsets.overline] !== 0,
            underline: this.view().getInt32(style + styleOffsets.underline, true) !== 0,
          });
          col++;
        }
        while (line.length < cols) {
          line.push({
            text: " ",
            width: 1,
            bold: false,
            italic: false,
            faint: false,
            blink: false,
            inverse: false,
            invisible: false,
            strikethrough: false,
            overline: false,
            underline: false,
          });
        }
        cells.push(line);
        row++;
      }
      while (cells.length < rows) {
        cells.push(
          Array.from({ length: cols }, () => ({
            text: " ",
            width: 1 as const,
            bold: false,
            italic: false,
            faint: false,
            blink: false,
            inverse: false,
            invisible: false,
            strikethrough: false,
            overline: false,
            underline: false,
          })),
        );
      }

      return {
        cols,
        rows,
        cells,
        foreground,
        background,
        cursor: {
          x: cursorHasPosition ? readRenderInt(RenderStateData.CursorViewportX) : 0,
          y: cursorHasPosition ? readRenderInt(RenderStateData.CursorViewportY) : 0,
          visible: cursorHasPosition && readRenderInt(RenderStateData.CursorVisible) !== 0,
          style: cursorStyle,
          color: cursorColor,
        },
      };
    } finally {
      this.exports.ghostty_wasm_free_u8_array(graphemes, graphemesCapacity);
      this.exports.ghostty_wasm_free_u8_array(style, styleSize);
      this.exports.ghostty_wasm_free_u8_array(rawCell, 8);
      this.exports.ghostty_wasm_free_u8_array(rgb, 3);
      this.exports.ghostty_wasm_free_u8_array(scalar, 4);
      this.exports.ghostty_wasm_free_u8_array(colors, colorsSize);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.mouseEvent) this.exports.ghostty_mouse_event_free(this.mouseEvent);
    if (this.mouseEncoder) this.exports.ghostty_mouse_encoder_free(this.mouseEncoder);
    if (this.keyEvent) this.exports.ghostty_key_event_free(this.keyEvent);
    if (this.keyEncoder) this.exports.ghostty_key_encoder_free(this.keyEncoder);
    if (this.rowCells) this.exports.ghostty_render_state_row_cells_free(this.rowCells);
    if (this.rowIterator) this.exports.ghostty_render_state_row_iterator_free(this.rowIterator);
    if (this.renderState) this.exports.ghostty_render_state_free(this.renderState);
    if (this.terminal) this.exports.ghostty_terminal_free(this.terminal);
    this.mouseEvent = 0;
    this.mouseEncoder = 0;
    this.keyEvent = 0;
    this.keyEncoder = 0;
    this.rowCells = 0;
    this.rowIterator = 0;
    this.renderState = 0;
    this.terminal = 0;
  }
}
