export interface TerminalResizeTarget {
  readonly cols: number;
  readonly rows: number;
  proposeDimensions(): { cols: number; rows: number } | undefined;
  fitPreservingViewport(): void;
}

export interface TerminalResizeScheduler {
  requestFrame(callback: FrameRequestCallback): number;
  cancelFrame(handle: number): void;
}

interface ViewportFitTarget {
  active: { type: "normal" | "alternate"; viewportY: number; baseY: number };
  fit(): void;
  scrollToLine(line: number): void;
}

export function fitTerminalPreservingViewport(target: ViewportFitTarget): void {
  const savedViewport =
    target.active.type === "normal" && target.active.viewportY < target.active.baseY
      ? target.active.viewportY
      : undefined;
  target.fit();
  if (savedViewport === undefined || target.active.type !== "normal") return;
  target.scrollToLine(Math.min(savedViewport, target.active.baseY));
}

export class TerminalResizeCoordinator {
  private readonly scheduler: TerminalResizeScheduler;
  private frameHandle: number | undefined;
  private sendTimer: ReturnType<typeof setTimeout> | undefined;
  private pendingDimensions: [number, number] | undefined;
  private lastSentDimensions: [number, number] | undefined;
  private connectionIsOpen = false;
  private disposed = false;

  constructor(
    private readonly target: TerminalResizeTarget,
    private readonly send: (cols: number, rows: number) => void,
    scheduler: Partial<TerminalResizeScheduler> = {},
  ) {
    this.scheduler = {
      requestFrame: scheduler.requestFrame ?? ((callback) => requestAnimationFrame(callback)),
      cancelFrame: scheduler.cancelFrame ?? ((handle) => cancelAnimationFrame(handle)),
    };
  }

  request(): void {
    if (this.disposed || this.frameHandle !== undefined) return;
    // The sentinel also supports deterministic schedulers that invoke callbacks synchronously.
    this.frameHandle = -1;
    const handle = this.scheduler.requestFrame(() => {
      this.frameHandle = undefined;
      if (this.disposed) return;
      try {
        this.fitNow();
      } catch {
        // A transient pre-layout xterm measurement is retried by the next observer/font/viewport request.
      }
    });
    if (this.frameHandle === -1) this.frameHandle = handle;
  }

  fitNow(): boolean {
    if (this.disposed) return false;
    const proposed = this.target.proposeDimensions();
    if (
      !proposed ||
      !Number.isFinite(proposed.cols) ||
      !Number.isFinite(proposed.rows) ||
      proposed.cols <= 0 ||
      proposed.rows <= 0
    ) {
      return false;
    }

    const beforeCols = this.target.cols;
    const beforeRows = this.target.rows;
    if (proposed.cols === beforeCols && proposed.rows === beforeRows) return true;

    this.target.fitPreservingViewport();
    const cols = this.target.cols;
    const rows = this.target.rows;
    if (this.connectionIsOpen && (cols !== beforeCols || rows !== beforeRows)) {
      this.scheduleSend(cols, rows);
    }
    return true;
  }

  connectionOpened(): void {
    if (this.disposed) return;
    this.connectionIsOpen = true;
    this.clearSendTimer();
    this.lastSentDimensions = undefined;
    this.sendCurrent(this.target.cols, this.target.rows);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.frameHandle !== undefined && this.frameHandle !== -1) {
      this.scheduler.cancelFrame(this.frameHandle);
    }
    this.frameHandle = undefined;
    this.clearSendTimer();
  }

  private scheduleSend(cols: number, rows: number): void {
    this.pendingDimensions = [cols, rows];
    if (this.sendTimer !== undefined) clearTimeout(this.sendTimer);
    this.sendTimer = setTimeout(() => {
      this.sendTimer = undefined;
      const pending = this.pendingDimensions;
      this.pendingDimensions = undefined;
      if (!pending || this.disposed) return;
      this.sendCurrent(pending[0], pending[1]);
    }, 80);
  }

  private sendCurrent(cols: number, rows: number): void {
    if (this.lastSentDimensions?.[0] === cols && this.lastSentDimensions[1] === rows) return;
    this.send(cols, rows);
    this.lastSentDimensions = [cols, rows];
  }

  private clearSendTimer(): void {
    if (this.sendTimer !== undefined) clearTimeout(this.sendTimer);
    this.sendTimer = undefined;
    this.pendingDimensions = undefined;
  }
}
