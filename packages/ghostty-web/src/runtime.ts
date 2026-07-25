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
  "ghostty_terminal_set",
  "ghostty_terminal_get",
  "ghostty_terminal_grid_ref",
  "ghostty_terminal_selection_format_buf",
  "ghostty_selection_gesture_new",
  "ghostty_selection_gesture_event_new",
  "ghostty_selection_gesture_event",
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

const enum GhosttyResult {
  Success = 0,
  OutOfSpace = -3,
  NoValue = -4,
}

const enum GhosttyTerminalOption {
  Selection = 21,
}

const enum GhosttyTerminalData {
  Selection = 31,
}

const enum GhosttyPointTag {
  Viewport = 1,
}

const enum GhosttySelectionGestureEventType {
  Press = 0,
  Release = 1,
  Drag = 2,
}

const enum GhosttySelectionGestureEventOption {
  Ref = 0,
  Position = 1,
  RepeatDistance = 2,
  TimeNs = 3,
  RepeatIntervalNs = 4,
  Rectangle = 7,
  Geometry = 8,
}

export interface GhosttyAbi {
  GhosttyTerminalOptions: AbiLayout;
  GhosttyRenderStateColors: AbiLayout;
  GhosttyMouseEncoderSize: AbiLayout;
  GhosttyTerminalScrollViewport: AbiLayout;
  GhosttyStyle: AbiLayout;
  GhosttySelection: AbiLayout;
  GhosttyGridRef: AbiLayout;
  GhosttyPoint: AbiLayout;
  GhosttyPointCoordinate: AbiLayout;
  GhosttySelectionGestureGeometry: AbiLayout;
  GhosttySurfacePosition: AbiLayout;
  GhosttyTerminalSelectWordOptions: AbiLayout;
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
  if (abi.GhosttySelection?.size !== 32) {
    throw new Error(`Unsupported GhosttySelection ABI size: ${String(abi.GhosttySelection?.size)}`);
  }
  if (abi.GhosttyGridRef?.size !== 12) {
    throw new Error(`Unsupported GhosttyGridRef ABI size: ${String(abi.GhosttyGridRef?.size)}`);
  }
  if (abi.GhosttyPoint?.size !== 24 || abi.GhosttyPointCoordinate?.size !== 8) {
    throw new Error(
      `Unsupported Ghostty point ABI sizes: ${String(abi.GhosttyPoint?.size)}/${String(abi.GhosttyPointCoordinate?.size)}`,
    );
  }
  if (abi.GhosttySelectionGestureGeometry?.size !== 16 || abi.GhosttySurfacePosition?.size !== 16) {
    throw new Error(
      `Unsupported Ghostty selection gesture ABI sizes: ${String(abi.GhosttySelectionGestureGeometry?.size)}/${String(abi.GhosttySurfacePosition?.size)}`,
    );
  }
  if (abi.GhosttyTerminalSelectWordOptions?.size !== 24) {
    throw new Error(
      `Unsupported GhosttyTerminalSelectWordOptions ABI size: ${String(abi.GhosttyTerminalSelectWordOptions?.size)}`,
    );
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

export interface GhosttySelectionInput {
  column: number;
  row: number;
  x: number;
  y: number;
  cellWidth: number;
  paddingLeft: number;
  screenHeight: number;
  timeMs?: number;
  rectangle?: boolean;
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
  private selectionGesture = 0;
  private selectionPressEvent = 0;
  private selectionDragEvent = 0;
  private selectionReleaseEvent = 0;
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
      this.selectionGesture = this.allocateHandle((out) => this.exports.ghostty_selection_gesture_new(0, out));
      this.selectionPressEvent = this.allocateHandle((out) =>
        this.exports.ghostty_selection_gesture_event_new(0, out, GhosttySelectionGestureEventType.Press),
      );
      this.selectionReleaseEvent = this.allocateHandle((out) =>
        this.exports.ghostty_selection_gesture_event_new(0, out, GhosttySelectionGestureEventType.Release),
      );
      this.selectionDragEvent = this.allocateHandle((out) =>
        this.exports.ghostty_selection_gesture_event_new(0, out, GhosttySelectionGestureEventType.Drag),
      );
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
    this.exports.ghostty_selection_gesture_reset(this.selectionGesture, this.terminal);
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

  private writeViewportPoint(pointer: number, input: Pick<GhosttySelectionInput, "column" | "row">): void {
    const point = this.abi.GhosttyPoint;
    const coordinate = this.abi.GhosttyPointCoordinate;
    const bytes = new Uint8Array(this.memory.buffer, pointer, point.size);
    bytes.fill(0);
    const view = this.view();
    view.setInt32(pointer + abiField(point, "tag").offset, GhosttyPointTag.Viewport, true);
    const value = pointer + abiField(point, "value").offset;
    view.setUint16(value + abiField(coordinate, "x").offset, Math.max(0, Math.min(65535, input.column)), true);
    view.setUint32(value + abiField(coordinate, "y").offset, Math.max(0, Math.floor(input.row)), true);
  }

  private resolveGridRef(point: number, ref: number): boolean {
    return this.exports.ghostty_terminal_grid_ref(this.terminal, point, ref) === 0;
  }

  private setGestureOption(event: number, option: number, value: number): void {
    const result = this.exports.ghostty_selection_gesture_event_set(event, option, value);
    if (result !== 0) throw new Error(`Ghostty selection gesture option failed (${result})`);
  }

  private installSelection(selection: number): void {
    const result = this.exports.ghostty_terminal_set(this.terminal, GhosttyTerminalOption.Selection, selection);
    if (result !== GhosttyResult.Success) throw new Error(`Ghostty selection install failed (${result})`);
  }

  clearSelection(): void {
    this.assertLive();
    this.installSelection(0);
  }

  cancelSelection(): void {
    this.assertLive();
    this.exports.ghostty_selection_gesture_reset(this.selectionGesture, this.terminal);
    this.installSelection(0);
  }

  beginSelection(input: GhosttySelectionInput): boolean {
    this.assertLive();
    const pointSize = this.abi.GhosttyPoint.size;
    const refSize = this.abi.GhosttyGridRef.size;
    const positionSize = this.abi.GhosttySurfacePosition.size;
    const selectionSize = this.abi.GhosttySelection.size;
    const point = this.exports.ghostty_wasm_alloc_u8_array(pointSize);
    const ref = this.exports.ghostty_wasm_alloc_u8_array(refSize);
    const position = this.exports.ghostty_wasm_alloc_u8_array(positionSize);
    const scalar = this.exports.ghostty_wasm_alloc_u8_array(8);
    const selection = this.exports.ghostty_wasm_alloc_u8_array(selectionSize);
    try {
      this.writeViewportPoint(point, input);
      if (!this.resolveGridRef(point, ref)) return false;

      const view = this.view();
      const positionLayout = this.abi.GhosttySurfacePosition;
      view.setFloat64(position + abiField(positionLayout, "x").offset, input.x, true);
      view.setFloat64(position + abiField(positionLayout, "y").offset, input.y, true);
      this.setGestureOption(this.selectionPressEvent, GhosttySelectionGestureEventOption.Ref, ref);
      this.setGestureOption(this.selectionPressEvent, GhosttySelectionGestureEventOption.Position, position);
      view.setFloat64(scalar, Math.max(1, input.cellWidth), true);
      this.setGestureOption(this.selectionPressEvent, GhosttySelectionGestureEventOption.RepeatDistance, scalar);
      view.setBigUint64(scalar, BigInt(Math.max(0, Math.round((input.timeMs ?? 0) * 1_000_000))), true);
      this.setGestureOption(this.selectionPressEvent, GhosttySelectionGestureEventOption.TimeNs, scalar);
      view.setBigUint64(scalar, 500_000_000n, true);
      this.setGestureOption(this.selectionPressEvent, GhosttySelectionGestureEventOption.RepeatIntervalNs, scalar);

      const result = this.exports.ghostty_selection_gesture_event(
        this.selectionGesture,
        this.terminal,
        this.selectionPressEvent,
        selection,
      );
      if (result === GhosttyResult.Success) this.installSelection(selection);
      else if (result === GhosttyResult.NoValue) this.installSelection(0);
      else throw new Error(`Ghostty selection press failed (${result})`);
      return true;
    } finally {
      this.exports.ghostty_wasm_free_u8_array(selection, selectionSize);
      this.exports.ghostty_wasm_free_u8_array(scalar, 8);
      this.exports.ghostty_wasm_free_u8_array(position, positionSize);
      this.exports.ghostty_wasm_free_u8_array(ref, refSize);
      this.exports.ghostty_wasm_free_u8_array(point, pointSize);
    }
  }

  updateSelection(input: GhosttySelectionInput): boolean {
    this.assertLive();
    const pointSize = this.abi.GhosttyPoint.size;
    const refSize = this.abi.GhosttyGridRef.size;
    const positionSize = this.abi.GhosttySurfacePosition.size;
    const geometrySize = this.abi.GhosttySelectionGestureGeometry.size;
    const selectionSize = this.abi.GhosttySelection.size;
    const point = this.exports.ghostty_wasm_alloc_u8_array(pointSize);
    const ref = this.exports.ghostty_wasm_alloc_u8_array(refSize);
    const position = this.exports.ghostty_wasm_alloc_u8_array(positionSize);
    const geometry = this.exports.ghostty_wasm_alloc_u8_array(geometrySize);
    const rectangle = this.exports.ghostty_wasm_alloc_u8();
    const selection = this.exports.ghostty_wasm_alloc_u8_array(selectionSize);
    try {
      this.writeViewportPoint(point, input);
      if (!this.resolveGridRef(point, ref)) return false;

      const view = this.view();
      const positionLayout = this.abi.GhosttySurfacePosition;
      view.setFloat64(position + abiField(positionLayout, "x").offset, input.x, true);
      view.setFloat64(position + abiField(positionLayout, "y").offset, input.y, true);
      const geometryLayout = this.abi.GhosttySelectionGestureGeometry;
      view.setUint32(geometry + abiField(geometryLayout, "columns").offset, this._cols, true);
      view.setUint32(
        geometry + abiField(geometryLayout, "cell_width").offset,
        Math.max(1, Math.round(input.cellWidth)),
        true,
      );
      view.setUint32(
        geometry + abiField(geometryLayout, "padding_left").offset,
        Math.max(0, Math.round(input.paddingLeft)),
        true,
      );
      view.setUint32(
        geometry + abiField(geometryLayout, "screen_height").offset,
        Math.max(1, Math.round(input.screenHeight)),
        true,
      );
      view.setUint8(rectangle, input.rectangle === true ? 1 : 0);

      this.setGestureOption(this.selectionDragEvent, GhosttySelectionGestureEventOption.Ref, ref);
      this.setGestureOption(this.selectionDragEvent, GhosttySelectionGestureEventOption.Position, position);
      this.setGestureOption(this.selectionDragEvent, GhosttySelectionGestureEventOption.Rectangle, rectangle);
      this.setGestureOption(this.selectionDragEvent, GhosttySelectionGestureEventOption.Geometry, geometry);
      const result = this.exports.ghostty_selection_gesture_event(
        this.selectionGesture,
        this.terminal,
        this.selectionDragEvent,
        selection,
      );
      if (result === GhosttyResult.Success) this.installSelection(selection);
      else if (result === GhosttyResult.NoValue) this.installSelection(0);
      else throw new Error(`Ghostty selection drag failed (${result})`);
      return true;
    } finally {
      this.exports.ghostty_wasm_free_u8_array(selection, selectionSize);
      this.exports.ghostty_wasm_free_u8(rectangle);
      this.exports.ghostty_wasm_free_u8_array(geometry, geometrySize);
      this.exports.ghostty_wasm_free_u8_array(position, positionSize);
      this.exports.ghostty_wasm_free_u8_array(ref, refSize);
      this.exports.ghostty_wasm_free_u8_array(point, pointSize);
    }
  }

  endSelection(input?: Pick<GhosttySelectionInput, "column" | "row">): void {
    this.assertLive();
    const pointSize = this.abi.GhosttyPoint.size;
    const refSize = this.abi.GhosttyGridRef.size;
    const point = this.exports.ghostty_wasm_alloc_u8_array(pointSize);
    const ref = this.exports.ghostty_wasm_alloc_u8_array(refSize);
    try {
      let refValue = 0;
      if (input) {
        this.writeViewportPoint(point, input);
        if (this.resolveGridRef(point, ref)) refValue = ref;
      }
      this.setGestureOption(this.selectionReleaseEvent, GhosttySelectionGestureEventOption.Ref, refValue);
      const result = this.exports.ghostty_selection_gesture_event(
        this.selectionGesture,
        this.terminal,
        this.selectionReleaseEvent,
        0,
      );
      if (result !== GhosttyResult.Success && result !== GhosttyResult.NoValue) {
        throw new Error(`Ghostty selection release failed (${result})`);
      }
    } finally {
      this.exports.ghostty_wasm_free_u8_array(ref, refSize);
      this.exports.ghostty_wasm_free_u8_array(point, pointSize);
    }
  }

  selectWordAt(input: Pick<GhosttySelectionInput, "column" | "row">): boolean {
    this.assertLive();
    const pointSize = this.abi.GhosttyPoint.size;
    const refSize = this.abi.GhosttyGridRef.size;
    const selectionSize = this.abi.GhosttySelection.size;
    const optionsSize = this.abi.GhosttyTerminalSelectWordOptions.size;
    const point = this.exports.ghostty_wasm_alloc_u8_array(pointSize);
    const ref = this.exports.ghostty_wasm_alloc_u8_array(refSize);
    const selection = this.exports.ghostty_wasm_alloc_u8_array(selectionSize);
    const options = this.exports.ghostty_wasm_alloc_u8_array(optionsSize);
    const contains = this.exports.ghostty_wasm_alloc_u8();
    try {
      this.writeViewportPoint(point, input);
      const current = this.exports.ghostty_terminal_get(this.terminal, GhosttyTerminalData.Selection, selection);
      if (
        current === GhosttyResult.Success &&
        this.exports.ghostty_terminal_selection_contains(this.terminal, selection, point, contains) ===
          GhosttyResult.Success &&
        this.view().getUint8(contains) !== 0
      ) {
        return true;
      }
      if (!this.resolveGridRef(point, ref)) return false;

      new Uint8Array(this.memory.buffer, options, optionsSize).fill(0);
      const layout = this.abi.GhosttyTerminalSelectWordOptions;
      const view = this.view();
      view.setUint32(options + abiField(layout, "size").offset, optionsSize, true);
      new Uint8Array(this.memory.buffer, options + abiField(layout, "ref").offset, refSize).set(
        new Uint8Array(this.memory.buffer, ref, refSize),
      );
      const result = this.exports.ghostty_terminal_select_word(this.terminal, options, selection);
      if (result === GhosttyResult.NoValue) return false;
      if (result !== GhosttyResult.Success) throw new Error(`Ghostty word selection failed (${result})`);
      this.installSelection(selection);
      return true;
    } finally {
      this.exports.ghostty_wasm_free_u8(contains);
      this.exports.ghostty_wasm_free_u8_array(options, optionsSize);
      this.exports.ghostty_wasm_free_u8_array(selection, selectionSize);
      this.exports.ghostty_wasm_free_u8_array(ref, refSize);
      this.exports.ghostty_wasm_free_u8_array(point, pointSize);
    }
  }

  selectionText(): string {
    this.assertLive();
    // wasm32 lays this official sized C struct out as:
    // size_t, enum, bool, bool, padding, GhosttySelection*.
    const optionsSize = 16;
    const options = this.exports.ghostty_wasm_alloc_u8_array(optionsSize);
    const written = this.exports.ghostty_wasm_alloc_usize();
    let output = 0;
    let outputSize = 0;
    try {
      new Uint8Array(this.memory.buffer, options, optionsSize).fill(0);
      const view = this.view();
      view.setUint32(options, optionsSize, true);
      view.setInt32(options + 4, 0, true);
      view.setUint8(options + 8, 1);
      view.setUint8(options + 9, 1);
      let result = this.exports.ghostty_terminal_selection_format_buf(this.terminal, options, 0, 0, written);
      if (result === GhosttyResult.NoValue) return "";
      if (result !== GhosttyResult.OutOfSpace) {
        throw new Error(`Ghostty selection size query failed (${result})`);
      }
      outputSize = view.getUint32(written, true);
      if (outputSize === 0) return "";
      output = this.exports.ghostty_wasm_alloc_u8_array(outputSize);
      result = this.exports.ghostty_terminal_selection_format_buf(this.terminal, options, output, outputSize, written);
      if (result !== GhosttyResult.Success) throw new Error(`Ghostty selection formatting failed (${result})`);
      return new TextDecoder().decode(new Uint8Array(this.memory.buffer, output, this.view().getUint32(written, true)));
    } finally {
      if (output) this.exports.ghostty_wasm_free_u8_array(output, outputSize);
      this.exports.ghostty_wasm_free_usize(written);
      this.exports.ghostty_wasm_free_u8_array(options, optionsSize);
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
          const selectedResult = this.exports.ghostty_render_state_row_cells_get(
            this.rowCells,
            RowCellsData.Selected,
            scalar,
          );
          const selected = selectedResult === 0 && this.view().getUint8(scalar) !== 0;

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
            selected,
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
            selected: false,
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
            selected: false,
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
    if (this.selectionReleaseEvent) this.exports.ghostty_selection_gesture_event_free(this.selectionReleaseEvent);
    if (this.selectionDragEvent) this.exports.ghostty_selection_gesture_event_free(this.selectionDragEvent);
    if (this.selectionPressEvent) this.exports.ghostty_selection_gesture_event_free(this.selectionPressEvent);
    if (this.selectionGesture) this.exports.ghostty_selection_gesture_free(this.selectionGesture, this.terminal);
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
    this.selectionReleaseEvent = 0;
    this.selectionDragEvent = 0;
    this.selectionPressEvent = 0;
    this.selectionGesture = 0;
    this.keyEvent = 0;
    this.keyEncoder = 0;
    this.rowCells = 0;
    this.rowIterator = 0;
    this.renderState = 0;
    this.terminal = 0;
  }
}
