export const TERMINAL_WRITE_CHUNK_BYTES = 64 * 1024;

export interface TerminalByteWriter {
  write(data: Uint8Array, callback?: () => void): void;
}

/**
 * xterm time-slices its write queue between submitted chunks. Reconnect history can arrive as one 12 MiB
 * WebSocket frame, so split that frame before enqueueing it and keep the parser's byte order unchanged.
 */
export function writeTerminalBytes(terminal: TerminalByteWriter, bytes: Uint8Array, onParsed?: () => void): number {
  if (bytes.byteLength === 0) {
    terminal.write(bytes, onParsed);
    return 1;
  }

  const chunks = Math.ceil(bytes.byteLength / TERMINAL_WRITE_CHUNK_BYTES);
  for (let offset = 0; offset < bytes.byteLength; offset += TERMINAL_WRITE_CHUNK_BYTES) {
    const end = Math.min(bytes.byteLength, offset + TERMINAL_WRITE_CHUNK_BYTES);
    terminal.write(bytes.subarray(offset, end), end === bytes.byteLength ? onParsed : undefined);
  }
  return chunks;
}

/** Keeps historical terminal protocol side effects disabled until xterm has parsed the replay frame. */
export class TerminalReplayGuard {
  private active = false;
  private awaitingFrame = false;

  get suppressSideEffects(): boolean {
    return this.active;
  }

  begin(): void {
    this.active = true;
    this.awaitingFrame = true;
  }

  /** Return a callback for the first replay data frame. Later live frames do not own the guard. */
  acceptFrame(): (() => void) | undefined {
    if (!this.active || !this.awaitingFrame) return undefined;
    this.awaitingFrame = false;
    return () => {
      this.active = false;
    };
  }

  /** An end marker with no preceding data means the replay was empty or its frame was dropped. */
  end(): void {
    if (this.active && this.awaitingFrame) this.reset();
  }

  reset(): void {
    this.active = false;
    this.awaitingFrame = false;
  }
}
