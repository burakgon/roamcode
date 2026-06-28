export type ServerFrameKind =
  | "event"
  | "permission"
  | "question"
  | "result"
  | "diagnostic"
  | "exit"
  | "attachment"
  | "rewound"
  // A prompt (question/permission) was answered/cancelled. Fanned out LIVE so connected clients clear
  // their pending prompt immediately; NOT retained (the matching question/permission frame is pruned
  // from the buffer instead — see resolvePrompt — so a reconnecting client never replays it as pending).
  | "resolve"
  // A control signal SYNTHESIZED at subscribe time (never pushed/retained): the reconnect buffer rotated
  // past the client's `?since=` position, so it must refetch full REST history. See SessionHub.subscribe.
  | "resync";

export interface ServerFrame {
  seq: number;
  kind: ServerFrameKind;
  payload: unknown;
}

export function isCriticalKind(kind: ServerFrameKind): boolean {
  // attachment is critical: a file Claude sent must survive a WS reconnect (like permission/result).
  // rewound is critical: the "↩ Rewound to here" marker (and the conversation truncation it drives) must
  // survive a reconnect so a reopened chat reflects the rewind rather than the pre-rewind transcript.
  // resolve is critical: a `?since=` DELTA reconnect must still learn an answered prompt was cleared (the
  // question/permission frame it refers to is pruned, so this is net-neutral on buffer size).
  return (
    kind === "permission" ||
    kind === "question" ||
    kind === "result" ||
    kind === "attachment" ||
    kind === "rewound" ||
    kind === "resolve"
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
  /** The highest seq of any RETAINED frame we had to evict — content a `?since=` delta can no longer
   *  recover. A client whose `since` is below this missed at least one evicted frame → `hasGap` true.
   *  Transient (never-retained) frames don't count: they're superseded by the final assistant/result. */
  private evictedThrough = 0;

  /** `startSeq` lets a re-seeded buffer (a resumed-in-place session) CONTINUE the prior seq space instead
   *  of restarting at 1 — a still-connected client would otherwise see seqs go backwards and drop the
   *  live continuation frames it de-dupes by max-seq. */
  constructor(capacity = 200, startSeq = 1) {
    this.capacity = capacity;
    this.nextSeq = startSeq;
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

  /**
   * A prompt (question/permission) was answered/cancelled: drop its retained frame so a client that
   * reconnects and replays the buffer does NOT re-show the already-resolved prompt as still pending.
   * Also drops any earlier `resolve` for this id (a re-used requestId never piles duplicates). Matches by
   * the frame payload's `requestId` (questions carry both `requestId` and `askId` — the `askId` mirrors
   * `requestId`, so matching `requestId` covers both the built-in and MCP ask paths). The freshly-emitted
   * `resolve` frame (pushed right after this) is RETAINED so a `?since=` delta reconnect still learns the
   * prompt is gone.
   */
  resolvePrompt(requestId: string): void {
    this.frames = this.frames.filter((f) => {
      if (f.kind !== "question" && f.kind !== "permission" && f.kind !== "resolve") return true;
      return (f.payload as { requestId?: string } | null)?.requestId !== requestId;
    });
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
      // Record the high-water mark of evicted content so a reconnecting client below it can be told to
      // resync (refetch) instead of silently missing this frame in a `?since=` delta.
      this.evictedThrough = Math.max(this.evictedThrough, this.frames[idx]!.seq);
      this.frames.splice(idx, 1);
      nonCritical -= 1;
    }
  }

  /**
   * True when a `?since=<sinceSeq>` reconnect would MISS evicted content: the client's last-seen seq is
   * below the highest evicted-retained seq, so at least one frame it still needs is gone from the buffer.
   * The server answers this with a `resync` signal so the client refetches the full REST history instead
   * of rendering an incomplete conversation.
   */
  hasGap(sinceSeq: number): boolean {
    return sinceSeq < this.evictedThrough;
  }

  snapshot(): ServerFrame[] {
    return [...this.frames];
  }

  since(seq: number): ServerFrame[] {
    return this.frames.filter((f) => f.seq > seq);
  }
}
