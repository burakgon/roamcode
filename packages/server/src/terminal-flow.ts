export const TERMINAL_FLOW_LIMITS = {
  version: 1,
  highWatermarkBytes: 256 * 1024,
  lowWatermarkBytes: 64 * 1024,
  maxFrameBytes: 64 * 1024,
  maxPendingBytes: 16 * 1024 * 1024,
  stallMs: 5_000,
} as const;

export type TerminalAckResult = "advanced" | "ignored" | "invalid";
export type TerminalFlowCloseReason = "protocol" | "stalled" | "overflow" | "replay-required" | "transport";

export interface TerminalFlowWindowCallbacks {
  sendBinary(frame: Buffer): void;
  sendText(frame: string): void;
  onPressure(pressured: boolean): void;
  onClose(reason: TerminalFlowCloseReason): void;
}

interface BinaryQueueItem {
  kind: "binary";
  data: Buffer;
  offset: number;
}

interface TextQueueItem {
  kind: "text";
  data: string;
  bytes: number;
}

type QueueItem = BinaryQueueItem | TextQueueItem;

export class TerminalFlowWindow {
  private readonly queue: QueueItem[] = [];
  private sent = 0;
  private acknowledged = 0;
  private pending = 0;
  private isPressured = false;
  private viewing = true;
  private replayRequired = false;
  private closed = false;
  private stallTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly callbacks: TerminalFlowWindowCallbacks) {}

  get sentBytes(): number {
    return this.sent;
  }

  get acknowledgedBytes(): number {
    return this.acknowledged;
  }

  get unacknowledgedBytes(): number {
    return this.sent - this.acknowledged;
  }

  get pendingBytes(): number {
    return this.pending;
  }

  get pressured(): boolean {
    return this.isPressured;
  }

  get needsReplay(): boolean {
    return this.replayRequired;
  }

  enqueueData(chunk: string | Buffer): void {
    if (this.closed || this.replayRequired) return;

    const bytes = typeof chunk === "string" ? Buffer.byteLength(chunk, "utf8") : chunk.byteLength;
    const availableWindow = Math.max(0, TERMINAL_FLOW_LIMITS.highWatermarkBytes - this.unacknowledgedBytes);
    if (this.pending + bytes > TERMINAL_FLOW_LIMITS.maxPendingBytes + availableWindow) {
      this.close("overflow");
      return;
    }

    const data = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    this.queue.push({ kind: "binary", data, offset: 0 });
    this.pending += data.byteLength;
    this.drain();
  }

  enqueueControl(frame: string): void {
    if (this.closed || this.replayRequired) return;

    const bytes = Buffer.byteLength(frame, "utf8");
    if (this.queue.length > 0 && this.pending + bytes > TERMINAL_FLOW_LIMITS.maxPendingBytes) {
      this.close("overflow");
      return;
    }

    this.queue.push({ kind: "text", data: frame, bytes });
    this.pending += bytes;
    this.drain();
  }

  acknowledge(parsedBytes: number): TerminalAckResult {
    if (!Number.isSafeInteger(parsedBytes) || parsedBytes < 0 || parsedBytes > this.sent) {
      return "invalid";
    }
    if (parsedBytes <= this.acknowledged) return "ignored";

    this.acknowledged = parsedBytes;
    this.drain();
    if (!this.closed && this.isPressured) this.armStallTimer();
    return "advanced";
  }

  setViewing(viewing: boolean): void {
    if (this.closed || this.viewing === viewing) return;
    this.viewing = viewing;

    if (!viewing) {
      if (this.queue.length > 0) this.requireReplay();
      this.updatePressure();
      return;
    }

    if (this.replayRequired) {
      this.close("replay-required");
      return;
    }

    this.drain();
  }

  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    this.clearQueue();
    this.clearStallTimer();
    this.setPressure(false);
  }

  private drain(): void {
    if (this.closed || this.replayRequired) return;

    while (this.queue.length > 0) {
      const item = this.queue[0];
      if (!item) break;
      if (item.kind === "text") {
        try {
          this.callbacks.sendText(item.data);
        } catch {
          this.close("transport");
          return;
        }
        this.pending -= item.bytes;
        this.queue.shift();
        continue;
      }

      const availableWindow = TERMINAL_FLOW_LIMITS.highWatermarkBytes - this.unacknowledgedBytes;
      if (availableWindow <= 0) {
        if (!this.viewing) this.requireReplay();
        break;
      }

      const remaining = item.data.byteLength - item.offset;
      const frameBytes = Math.min(remaining, availableWindow, TERMINAL_FLOW_LIMITS.maxFrameBytes);
      const frame = item.data.subarray(item.offset, item.offset + frameBytes);
      try {
        this.callbacks.sendBinary(frame);
      } catch {
        this.close("transport");
        return;
      }

      item.offset += frameBytes;
      this.pending -= frameBytes;
      this.sent += frameBytes;
      if (item.offset === item.data.byteLength) this.queue.shift();
    }

    this.updatePressure();
  }

  private updatePressure(): void {
    if (!this.viewing) {
      this.setPressure(false);
      return;
    }

    if (!this.isPressured && this.unacknowledgedBytes >= TERMINAL_FLOW_LIMITS.highWatermarkBytes) {
      this.setPressure(true);
      return;
    }

    if (
      this.isPressured &&
      this.queue.length === 0 &&
      this.unacknowledgedBytes <= TERMINAL_FLOW_LIMITS.lowWatermarkBytes
    ) {
      this.setPressure(false);
    }
  }

  private setPressure(pressured: boolean): void {
    if (this.isPressured === pressured) return;
    this.isPressured = pressured;
    if (pressured) this.armStallTimer();
    else this.clearStallTimer();
    this.callbacks.onPressure(pressured);
  }

  private armStallTimer(): void {
    this.clearStallTimer();
    this.stallTimer = setTimeout(() => this.close("stalled"), TERMINAL_FLOW_LIMITS.stallMs);
    this.stallTimer.unref?.();
  }

  private clearStallTimer(): void {
    if (this.stallTimer === undefined) return;
    clearTimeout(this.stallTimer);
    this.stallTimer = undefined;
  }

  private requireReplay(): void {
    this.replayRequired = true;
    this.clearQueue();
    this.updatePressure();
  }

  private clearQueue(): void {
    this.queue.length = 0;
    this.pending = 0;
  }

  private close(reason: TerminalFlowCloseReason): void {
    if (this.closed) return;
    this.closed = true;
    this.clearQueue();
    this.clearStallTimer();
    this.setPressure(false);
    this.callbacks.onClose(reason);
  }
}
