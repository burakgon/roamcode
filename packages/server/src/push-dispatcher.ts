import type { PushStore, PushSubscriptionRecord } from "./push-store.js";
import type { ServerFrame } from "./replay-buffer.js";

export interface PushMessage {
  title: string;
  body: string;
  /** Deep link the SW opens on click. */
  url: string;
  /** Notification tag = session id, so a device replaces (not stacks) the prior notification. */
  tag: string;
}

/** Inject the real web-push send in production; tests pass a stub. Resolves with the HTTP statusCode. */
export type PushSendFn = (sub: PushSubscriptionRecord, payload: string) => Promise<{ statusCode: number }>;

export interface PushDispatcherOptions {
  store: PushStore;
  send: PushSendFn;
  /** Origin used to build the deep link (default ""). */
  baseUrl?: string;
  /** At most one push per session per window (default 5000ms). 0 = no coalescing (send immediately). */
  coalesceMs?: number;
}

const PUSH_KINDS = new Set<ServerFrame["kind"]>(["result", "permission", "question"]);

/** Notification urgency for coalescing: a prompt that NEEDS YOU outranks a turn `result`. */
function pushPriority(kind: ServerFrame["kind"]): number {
  return kind === "permission" || kind === "question" ? 2 : 1;
}

interface PendingWindow {
  timer: ReturnType<typeof setTimeout>;
  latest: ServerFrame;
}

export class PushDispatcher {
  private readonly store: PushStore;
  private readonly send: PushSendFn;
  private baseUrl: string;
  private readonly coalesceMs: number;
  private readonly pending = new Map<string, PendingWindow>();

  constructor(opts: PushDispatcherOptions) {
    this.store = opts.store;
    this.send = opts.send;
    this.baseUrl = opts.baseUrl ?? "";
    this.coalesceMs = opts.coalesceMs ?? 5000;
  }

  /** Set the deep-link origin once the server's listen URL is known (handles port 0). */
  setBaseUrl(baseUrl: string): void {
    this.baseUrl = baseUrl;
  }

  /** Observe a hub frame. Pushable kinds are coalesced per session; others are ignored. */
  handleFrame(sessionId: string, frame: ServerFrame): void {
    if (!PUSH_KINDS.has(frame.kind)) return;
    if (this.coalesceMs <= 0) {
      void this.flush(sessionId, frame);
      return;
    }
    const existing = this.pending.get(sessionId);
    if (existing) {
      // Keep the most ATTENTION-worthy frame in the window: a `result` (task done) must NOT bury a
      // pending `permission`/`question` (you'd never learn approval/an answer is needed). Same priority
      // → latest wins.
      if (pushPriority(frame.kind) >= pushPriority(existing.latest.kind)) existing.latest = frame;
      return;
    }
    const timer = setTimeout(() => {
      const win = this.pending.get(sessionId);
      this.pending.delete(sessionId);
      if (win) void this.flush(sessionId, win.latest);
    }, this.coalesceMs);
    // Don't keep the event loop alive for a pending push (server shutdown shouldn't block on it).
    if (typeof (timer as { unref?: () => void }).unref === "function") (timer as { unref: () => void }).unref();
    this.pending.set(sessionId, { timer, latest: frame });
  }

  private async flush(sessionId: string, frame: ServerFrame): Promise<void> {
    const message = this.buildMessage(sessionId, frame);
    const payload = JSON.stringify(message);
    const subs = this.store.list({ sessionId });
    await Promise.all(
      subs.map(async (sub) => {
        try {
          const { statusCode } = await this.send(sub, payload);
          // Prune subscriptions the push service reports as permanently gone/forbidden (not just 404/410)
          // so a dead endpoint isn't retried on every flush forever.
          if (statusCode === 404 || statusCode === 410 || statusCode === 403) this.store.remove(sub.endpoint);
        } catch {
          // transient failure — keep the subscription, the caller logs it
        }
      }),
    );
  }

  private buildMessage(sessionId: string, frame: ServerFrame): PushMessage {
    const url = `${this.baseUrl}/?session=${encodeURIComponent(sessionId)}`;
    const base = { url, tag: sessionId };
    if (frame.kind === "permission") {
      const p = frame.payload as { toolName?: string } | undefined;
      return {
        title: "Permission needed",
        body: p?.toolName ? `Approve ${p.toolName}?` : "A tool needs your approval",
        ...base,
      };
    }
    if (frame.kind === "question") {
      const q = frame.payload as { questions?: { question?: string }[] } | undefined;
      const text = q?.questions?.[0]?.question;
      return { title: "Question", body: text ?? "The session is asking a question", ...base };
    }
    // result
    const r = frame.payload as
      | { result?: string; isError?: boolean; subtype?: string; terminalReason?: string }
      | undefined;
    // A user-initiated STOP (interrupt) ends the turn as an "error" at the protocol level (subtype
    // error_during_execution / terminal_reason aborted_streaming OR aborted_tools) — but it's a calm
    // "Stopped", not a failure: don't push it as "Task errored".
    const aborted =
      r?.terminalReason === "aborted_streaming" ||
      r?.terminalReason === "aborted_tools" ||
      r?.subtype === "error_during_execution";
    if (aborted) return { title: "Stopped", body: "You stopped the turn", ...base };
    const body = r?.result ? truncate(r.result, 120) : "Turn complete";
    return { title: r?.isError ? "Task errored" : "Task done", body, ...base };
  }
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}
