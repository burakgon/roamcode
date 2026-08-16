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
  private receivingReplay = false;
  private suppressingSideEffects = false;
  private pendingReplayFrames = 0;
  private generation = 0;

  get suppressSideEffects(): boolean {
    return this.suppressingSideEffects;
  }

  begin(): void {
    this.generation += 1;
    this.receivingReplay = true;
    this.suppressingSideEffects = true;
    this.pendingReplayFrames = 0;
  }

  wrapFrame(onParsed?: () => void): () => void {
    const replayFrame = this.receivingReplay;
    const generation = this.generation;
    if (replayFrame) this.pendingReplayFrames += 1;
    let completed = false;
    return () => {
      if (completed) return;
      completed = true;
      if (replayFrame && generation === this.generation) {
        this.pendingReplayFrames -= 1;
        if (!this.receivingReplay && this.pendingReplayFrames === 0) this.suppressingSideEffects = false;
      }
      onParsed?.();
    };
  }

  end(): void {
    this.receivingReplay = false;
    if (this.pendingReplayFrames === 0) this.suppressingSideEffects = false;
  }

  reset(): void {
    this.generation += 1;
    this.receivingReplay = false;
    this.suppressingSideEffects = false;
    this.pendingReplayFrames = 0;
  }
}
