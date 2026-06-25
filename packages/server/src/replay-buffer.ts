export type ServerFrameKind =
  | "event"
  | "permission"
  | "question"
  | "result"
  | "diagnostic"
  | "exit"
  | "attachment"
  | "rewound";

export interface ServerFrame {
  seq: number;
  kind: ServerFrameKind;
  payload: unknown;
}

export function isCriticalKind(kind: ServerFrameKind): boolean {
  // attachment is critical: a file Claude sent must survive a WS reconnect (like permission/result).
  // rewound is critical: the "↩ Rewound to here" marker (and the conversation truncation it drives) must
  // survive a reconnect so a reopened chat reflects the rewind rather than the pre-rewind transcript.
  return (
    kind === "permission" || kind === "question" || kind === "result" || kind === "attachment" || kind === "rewound"
  );
}

/**
 * Per-session ring buffer for WS reconnect replay (spec §10).
 * `capacity` bounds NON-critical frames; permission/result frames are never evicted.
 */
export class ReplayBuffer {
  private readonly capacity: number;
  private frames: ServerFrame[] = [];
  private nextSeq = 1;

  constructor(capacity = 200) {
    this.capacity = capacity;
  }

  /**
   * Assign a seq and retain the frame for reconnect replay. Returns the seq'd frame.
   *
   * `stream_event` frames (transient partial text/thinking deltas) are deliberately NOT retained: the
   * final `assistant` event carries the full text, so replaying partials is pointless AND — because
   * they vastly outnumber real content — they would evict assistant/tool frames out of the bounded
   * buffer. They STILL get a real seq (so ordering and `?since=` deltas stay correct) and are still
   * fanned out live to connected WS clients for the typing animation; they're just not kept around.
   */
  push(kind: ServerFrameKind, payload: unknown): ServerFrame {
    const frame: ServerFrame = { seq: this.nextSeq++, kind, payload };
    if (!this.isTransient(kind, payload)) {
      this.frames.push(frame);
      this.evictIfNeeded();
    }
    return frame;
  }

  /** A frame whose content is a transient partial delta — emitted live but never retained for replay. */
  private isTransient(kind: ServerFrameKind, payload: unknown): boolean {
    return kind === "event" && (payload as { type?: string } | null)?.type === "stream_event";
  }

  /** The highest seq assigned so far (0 before any push). Lets a reopen resume the WS from here. */
  maxSeq(): number {
    return this.nextSeq - 1;
  }

  private evictIfNeeded(): void {
    let nonCritical = this.frames.reduce((n, f) => (isCriticalKind(f.kind) ? n : n + 1), 0);
    while (nonCritical > this.capacity) {
      const idx = this.frames.findIndex((f) => !isCriticalKind(f.kind));
      if (idx === -1) break; // only critical frames remain — keep them all
      this.frames.splice(idx, 1);
      nonCritical -= 1;
    }
  }

  snapshot(): ServerFrame[] {
    return [...this.frames];
  }

  since(seq: number): ServerFrame[] {
    return this.frames.filter((f) => f.seq > seq);
  }
}
