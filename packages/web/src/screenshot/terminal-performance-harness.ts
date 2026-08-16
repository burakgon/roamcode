import { TERMINAL_WRITE_CHUNK_BYTES } from "../chat/terminal-output";

const MAX_UNPARSED_BYTES = 4 * TERMINAL_WRITE_CHUNK_BYTES;

export interface TerminalPerformanceSnapshot {
  sentBytes: number;
  parsedBytes: number;
  unparsedBytes: number;
  maxUnparsedBytes: number;
  resizeFrames: Array<[number, number]>;
  inputSendMs: Record<string, number>;
  visibleEchoMs: Record<string, number>;
  deliveredFrameIds: number[];
  parsedFrameIds: number[];
}

type Producer = {
  remainingBytes: number;
  settled: boolean;
  resolve(): void;
};

type QueuedFrame = {
  bytes: Uint8Array;
  producer?: Producer;
  echo?: { marker: string; startedAt: number };
};

function nextAnimationFrame(callback: FrameRequestCallback): void {
  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(callback);
    return;
  }
  setTimeout(() => callback(performance.now()), 16);
}

/** Dev-only bounded output source used by the real-browser terminal smoke. */
export class ScreenshotTerminalPerformanceHarness {
  private readonly encoder = new TextEncoder();
  private readonly deliver: (bytes: Uint8Array, parsed: () => void) => void;
  private readonly normalQueue: QueuedFrame[] = [];
  private readonly priorityQueue: QueuedFrame[] = [];
  private readonly producers = new Set<Producer>();
  private armedEcho: { marker: string; startedAt: number } | undefined;
  private sentBytes = 0;
  private parsedBytes = 0;
  private unparsedBytes = 0;
  private maxUnparsedBytes = 0;
  private resizeFrames: Array<[number, number]> = [];
  private inputSendMs: Record<string, number> = {};
  private visibleEchoMs: Record<string, number> = {};
  private deliveredFrameIds: number[] = [];
  private parsedFrameIds: number[] = [];
  private nextFrameId = 1;
  private pumping = false;
  private closed = false;

  constructor(deliver: (bytes: Uint8Array, parsed: () => void) => void) {
    this.deliver = deliver;
  }

  push(text: string): Promise<void> {
    if (this.closed) return Promise.resolve();
    const bytes = this.encoder.encode(text);
    if (bytes.byteLength === 0) return Promise.resolve();

    let resolve!: () => void;
    const completion = new Promise<void>((settled) => {
      resolve = settled;
    });
    const producer: Producer = { remainingBytes: bytes.byteLength, settled: false, resolve };
    this.producers.add(producer);
    for (let offset = 0; offset < bytes.byteLength; offset += TERMINAL_WRITE_CHUNK_BYTES) {
      this.normalQueue.push({
        bytes: bytes.subarray(offset, Math.min(bytes.byteLength, offset + TERMINAL_WRITE_CHUNK_BYTES)),
        producer,
      });
    }
    this.pump();
    return completion;
  }

  armEcho(marker: string, startedAt: number): void {
    if (this.closed) return;
    this.armedEcho = { marker, startedAt };
  }

  sendInput(data: string): void {
    if (this.closed || data.length === 0) return;
    const echo = this.armedEcho;
    this.armedEcho = undefined;
    if (!echo) return;

    this.inputSendMs[echo.marker] = Math.max(0, performance.now() - echo.startedAt);
    this.priorityQueue.push({ bytes: this.encoder.encode(`\r\n${echo.marker}\r\n`), echo });
    this.pump();
  }

  recordResize(cols: number, rows: number): void {
    if (!this.closed) this.resizeFrames.push([cols, rows]);
  }

  resetMetrics(): void {
    if (this.unparsedBytes !== 0) {
      throw new Error("cannot reset terminal performance metrics while output is in flight");
    }
    this.sentBytes = 0;
    this.parsedBytes = 0;
    this.maxUnparsedBytes = 0;
    this.resizeFrames = [];
    this.inputSendMs = {};
    this.visibleEchoMs = {};
    this.deliveredFrameIds = [];
    this.parsedFrameIds = [];
    this.nextFrameId = 1;
    this.armedEcho = undefined;
  }

  snapshot(): TerminalPerformanceSnapshot {
    return {
      sentBytes: this.sentBytes,
      parsedBytes: this.parsedBytes,
      unparsedBytes: this.unparsedBytes,
      maxUnparsedBytes: this.maxUnparsedBytes,
      resizeFrames: this.resizeFrames.map(([cols, rows]) => [cols, rows]),
      inputSendMs: { ...this.inputSendMs },
      visibleEchoMs: { ...this.visibleEchoMs },
      deliveredFrameIds: [...this.deliveredFrameIds],
      parsedFrameIds: [...this.parsedFrameIds],
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.normalQueue.length = 0;
    this.priorityQueue.length = 0;
    this.armedEcho = undefined;
    this.unparsedBytes = 0;
    for (const producer of this.producers) this.settleProducer(producer);
  }

  private pump(): void {
    if (this.closed || this.pumping) return;
    this.pumping = true;
    try {
      while (!this.closed) {
        const next = this.priorityQueue[0] ?? this.normalQueue[0];
        if (!next || this.unparsedBytes + next.bytes.byteLength > MAX_UNPARSED_BYTES) return;
        const frame = this.priorityQueue.shift() ?? this.normalQueue.shift();
        if (!frame) return;
        this.deliverFrame(frame);
      }
    } finally {
      this.pumping = false;
    }
  }

  private deliverFrame(frame: QueuedFrame): void {
    const frameId = this.nextFrameId++;
    this.sentBytes += frame.bytes.byteLength;
    this.unparsedBytes += frame.bytes.byteLength;
    this.maxUnparsedBytes = Math.max(this.maxUnparsedBytes, this.unparsedBytes);
    this.deliveredFrameIds.push(frameId);

    let received = false;
    this.deliver(frame.bytes, () => {
      if (received || this.closed) return;
      received = true;
      this.parsedBytes += frame.bytes.byteLength;
      this.unparsedBytes -= frame.bytes.byteLength;
      this.parsedFrameIds.push(frameId);
      if (frame.producer) {
        frame.producer.remainingBytes -= frame.bytes.byteLength;
        if (frame.producer.remainingBytes === 0) this.settleProducer(frame.producer);
      }
      if (frame.echo) this.recordVisibleEcho(frame.echo);
      this.pump();
    });
  }

  private recordVisibleEcho(echo: { marker: string; startedAt: number }): void {
    nextAnimationFrame(() => {
      nextAnimationFrame(() => {
        if (!this.closed) this.visibleEchoMs[echo.marker] = Math.max(0, performance.now() - echo.startedAt);
      });
    });
  }

  private settleProducer(producer: Producer): void {
    if (producer.settled) return;
    producer.settled = true;
    this.producers.delete(producer);
    producer.resolve();
  }
}
