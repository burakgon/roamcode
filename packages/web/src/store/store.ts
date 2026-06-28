import { create } from "zustand";
import type { ContentBlock, LiveState, ServerFrame, SessionMeta, UsageInfo, VersionInfo } from "../types/server";
import { emptyView, reduceFrame } from "./frame-reducer";
import type { SessionView } from "./frame-reducer";

/** Client-side UX phase of the OTA self-update (distinct from the server-reported UpdateStatus.state):
 * idle = not updating; updating = we POSTed /update and are polling + waiting to reconnect; failed =
 * the updater reported a failure (offer Retry). */
export type UpdateUxState = "idle" | "updating" | "failed";

/**
 * Reconcile per-session activity stamps against a (re)loaded meta list. For each session the stamp is
 * the max of: any existing local stamp (an optimistic send/receive bump), the server's monotonic
 * `lastActivityAt`, and (as a floor) `createdAt`. Stamps for sessions NOT in the list are dropped, so a
 * vanished/closed session leaves no stale order behind. Returns a NEW record (immutable update).
 */
function reconcileActivity(prev: Record<string, number>, sessions: SessionMeta[]): Record<string, number> {
  const next: Record<string, number> = {};
  for (const s of sessions) {
    const server = s.lastActivityAt ?? s.createdAt;
    const local = prev[s.id];
    next[s.id] = local !== undefined ? Math.max(local, server) : server;
  }
  return next;
}

/**
 * Return `sessions` with `id`'s `awaiting` flag set to `awaiting`, or the SAME array reference when nothing
 * changes (no id match, or already that value). meta.awaiting is otherwise only refreshed by the 15s
 * `GET /sessions` poll, so without this an answered prompt kept the rail "needs you" chip, the global
 * badge, and the active chat's Stop button stuck for up to ~15s. Syncing it from the live view (in
 * applyFrame) clears/raises all of them instantly; the poll re-confirms. The no-op-same-ref path keeps an
 * ordinary stream frame from reallocating the array (no needless rail re-render).
 */
function syncAwaiting(sessions: SessionMeta[], id: string, awaiting: boolean): SessionMeta[] {
  const idx = sessions.findIndex((s) => s.id === id);
  if (idx < 0 || (sessions[idx]!.awaiting ?? false) === awaiting) return sessions;
  const next = sessions.slice();
  next[idx] = { ...next[idx]!, awaiting };
  return next;
}

/**
 * Identity signature(s) of a turn, for deduping live turns against a transcript fold on reopen (the
 * loadHistory race guard). Most turns have one stable key; a USER turn yields TWO — by checkpointId AND by
 * text — so an optimistic bubble (text only, no checkpointId yet) dedups against its already-echoed self in
 * the transcript (checkpointId set). A `result` turn has no transcript counterpart, so its (unique) key is
 * never in the transcript set → it's always carried forward.
 */
function turnSignatures(t: SessionView["turns"][number]): string[] {
  switch (t.kind) {
    case "user": {
      const text = t.blocks
        .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
        .map((b) => b.text)
        .join("\n");
      const sigs = [`u:tx:${text}`];
      if (t.checkpointId !== undefined) sigs.push(`u:cp:${t.checkpointId}`);
      return sigs;
    }
    case "assistant-text":
      return [`a:${t.text}`];
    case "thinking":
      return [`th:${t.text}`];
    case "tool-use":
      return [`tu:${t.id}`];
    case "tool-result":
      return [`tr:${t.toolUseId}`];
    case "subagent-ref":
      return [`sa:${t.id}`];
    case "asked-question":
      return [`aq:${t.id}`];
    case "attachment":
      return [`at:${t.id}`];
    case "command":
      return [`cmd:${t.command ?? ""}/${t.output ?? ""}`];
    case "system-note":
      return [`sn:${t.text}`];
    case "result":
      return [`res:${t.result ?? ""}:${t.totalCostUsd ?? ""}`];
    case "rewound":
      return [`rw:${t.checkpointId}:${t.mode}`];
  }
}

/** A frame that represents a real conversation turn (user text or assistant message) — the only
 * inbound frames that count as "activity" for rail ordering. Stream deltas, permission/question,
 * result, diagnostic, exit and system frames are plumbing, not a new turn, so they don't reorder. */
function isMessageFrame(frame: ServerFrame): boolean {
  if (frame.kind !== "event") return false;
  const type = (frame.payload as { type?: string } | null)?.type;
  return type === "user" || type === "assistant";
}

interface StoreState {
  token: string | undefined;
  sessions: SessionMeta[];
  activeSessionId?: string;
  views: Record<string, SessionView>;
  /** Per-session "most recently opened/active" timestamp (ms). Bumped on select and on every
   * inbound frame so the rail can float the live/just-opened session to the top, chat-app style.
   * Seeded from each session's createdAt when the list loads so fresh lists still have an order. */
  lastActiveAt: Record<string, number>;
  /** OTA self-update: the latest GET /version result (undefined until first polled). Drives the
   * update banner + panel. */
  updateInfo?: VersionInfo;
  /** Client-side update UX phase (idle | updating | failed). */
  updateState: UpdateUxState;
  /** Set the polled version info. */
  setUpdateInfo: (info: VersionInfo | undefined) => void;
  /** Set the client-side update UX phase. */
  setUpdateState: (state: UpdateUxState) => void;
  /** Claude usage limits (GET /usage): the latest snapshot. `null`/undefined → the rail hides the bars. */
  usage?: UsageInfo | null;
  /** Set the polled usage snapshot. */
  setUsage: (usage: UsageInfo | null) => void;
  setToken: (token: string | undefined) => void;
  setSessions: (sessions: SessionMeta[]) => void;
  /** Merge a freshly-polled `GET /sessions` list into the store WITHOUT clobbering the actively
   * connected session's live WS view: replaces the meta list (so vanished/closed sessions drop and
   * statuses/awaiting refresh), reconciles each `lastActiveAt` to the max of the local optimistic
   * stamp and the server's monotonic `lastActivityAt`, and prunes stamps for dropped sessions. The
   * `views` map is left fully intact so the live conversation is never disturbed by a poll. */
  mergeSessionMeta: (sessions: SessionMeta[]) => void;
  setActive: (id: string | undefined) => void;
  /** Remove a session client-side after it's been stopped/closed server-side: drops it from the
   * list and clears its view + activity stamp. Does NOT touch activeSessionId (the caller decides
   * what to select next, since "close the active one" wants the new top, not undefined-by-default). */
  removeSession: (id: string) => void;
  /** Re-add a session (e.g. an optimistic close that the server rejected) so the rail row reappears
   * instead of silently vanishing. No-op if the id is already present (idempotent). */
  addSession: (session: SessionMeta) => void;
  applyFrame: (id: string, frame: ServerFrame) => void;
  applyFrames: (id: string, frames: ServerFrame[]) => void;
  /**
   * Load the authoritative reopen history for a session: REPLACE the view by folding the transcript
   * `frames` (every user + assistant turn, correctly typed) into a fresh view, then set `lastSeq` to
   * the server's `sinceSeq` — NOT to the transcript frames' display seqs. The display history and the
   * WS seq space are decoupled: the transcript frames carry 1-based DISPLAY seqs (used only to render
   * them in order), while `sinceSeq` is the replay buffer's max seq the WS resumes from. The reducer
   * then dedups live frames against `sinceSeq` — buffer frames (seq ≤ sinceSeq) are no-ops, live
   * frames (seq > sinceSeq) append cleanly — so a reopen shows the full transcript with no double
   * display and no dropped live updates. Does NOT reorder the rail (replaying history isn't activity).
   */
  loadHistory: (id: string, frames: ServerFrame[], sinceSeq: number, live?: LiveState) => void;
  /** Optimistically append the user's own message to the view on send (claude does not echo the
   * typed user text back as a render-able turn, so without this the sender never sees their message).
   * `queued`: Claude was busy (renders below the live stream, "Queued"). `pending`: the send was buffered
   * because the socket wasn't open ("Sending…"); cleared by {@link clearPending} or the echo reconcile. */
  appendUserMessage: (id: string, blocks: ContentBlock[], queued?: boolean, pending?: boolean) => void;
  /** Clear the `pending` ("Sending…") flag on a session's user turns — called when the socket flushes its
   * buffer on (re)connect, so a buffered message stops reading "Sending…" the moment it's delivered. */
  clearPending: (id: string) => void;
  resetSession: (id: string) => void;
  /** Mark a session as compacting (the user sent `/compact`) so the telemetry shows "Compacting…" until
   *  the turn's result clears it. No-op-safe on an unknown id (seeds an empty view). */
  setCompacting: (id: string, compacting: boolean) => void;
  viewFor: (id: string) => SessionView;
}

export const useStore = create<StoreState>((set, get) => ({
  token: undefined,
  sessions: [],
  activeSessionId: undefined,
  views: {},
  lastActiveAt: {},
  updateInfo: undefined,
  updateState: "idle",
  setUpdateInfo: (updateInfo) => set({ updateInfo }),
  setUpdateState: (updateState) => set({ updateState }),
  usage: undefined,
  setUsage: (usage) => set({ usage }),
  setToken: (token) => set({ token }),
  setSessions: (sessions) =>
    set((state) => ({ sessions, lastActiveAt: reconcileActivity(state.lastActiveAt, sessions) })),
  // Same activity reconciliation as setSessions, but explicitly a refresh-merge: it replaces the meta
  // list (dropping any session no longer returned by the server) while leaving `views` untouched, so a
  // background poll never disturbs the actively-connected live conversation. `awaiting` stays SERVER-
  // authoritative here (the poll can legitimately RAISE it for a prompt the live view hasn't received
  // yet); the instant clear/raise between polls is handled optimistically by applyFrame's syncAwaiting.
  mergeSessionMeta: (sessions) =>
    set((state) => ({ sessions, lastActiveAt: reconcileActivity(state.lastActiveAt, sessions) })),
  setActive: (id) =>
    // Selecting a session NEVER reorders the rail: it only changes which conversation is shown.
    // (Activity stamps are bumped on send/receive only — never on select — so viewing a chat is inert.)
    set({ activeSessionId: id }),
  removeSession: (id) =>
    set((state) => {
      const views = { ...state.views };
      delete views[id];
      const lastActiveAt = { ...state.lastActiveAt };
      delete lastActiveAt[id];
      return { sessions: state.sessions.filter((s) => s.id !== id), views, lastActiveAt };
    }),
  addSession: (session) =>
    set((state) =>
      state.sessions.some((s) => s.id === session.id)
        ? state
        : { sessions: [...state.sessions, session], lastActiveAt: reconcileActivity(state.lastActiveAt, [session]) },
    ),
  applyFrame: (id, frame) =>
    set((state) => {
      const current = state.views[id] ?? emptyView();
      const nextView = reduceFrame(current, frame);
      // Activity-sort is driven by conversation activity ONLY: bump the stamp on an inbound user/
      // assistant MESSAGE frame (real turns), but NOT on plumbing frames (stream deltas, permissions,
      // diagnostics, system) — and never on select/open. This keeps the rail honest about which chat
      // last actually moved.
      const lastActiveAt = isMessageFrame(frame) ? { ...state.lastActiveAt, [id]: Date.now() } : state.lastActiveAt;
      // Keep meta.awaiting in lockstep with the live view for the CONNECTED session so the "needs you"
      // chip / global badge / Stop button react the instant a prompt arrives or is answered (the poll lags).
      const liveAwaiting = nextView.pendingQuestion !== undefined || nextView.pendingPermission !== undefined;
      const sessions = syncAwaiting(state.sessions, id, liveAwaiting);
      return { views: { ...state.views, [id]: nextView }, lastActiveAt, sessions };
    }),
  // Fold a batch of frames in a single store update (one re-render) — used to replay REST history.
  // History replay must NOT reorder the rail (replaying an old transcript isn't new activity), so it
  // deliberately leaves `lastActiveAt` alone; the server's `lastActivityAt` (merged on load) owns order.
  applyFrames: (id, frames) =>
    set((state) => {
      let view = state.views[id] ?? emptyView();
      for (const frame of frames) view = reduceFrame(view, frame);
      return { views: { ...state.views, [id]: view } };
    }),
  loadHistory: (id, frames, sinceSeq, live) =>
    set((state) => {
      // Fold the transcript frames into a FRESH view so the reopen is authoritative for the history —
      // it replaces anything the WS may have replayed (e.g. an incomplete buffer snapshot). The
      // transcript frames carry DISPLAY seqs; we then set lastSeq to the WS `sinceSeq` so live frames
      // are deduped against the WS seq space, not the display one.
      let view = emptyView();
      for (const frame of frames) view = reduceFrame(view, frame);
      // A replayed transcript is PAST history with no `result`/stream frames (parseTranscript keeps only
      // user/assistant lines). So SEED the transient state from the server's authoritative live tail
      // (`live`, from the replay buffer) instead of guessing: `turnActive` → a "working" wire so a
      // switched-to chat doesn't show a wrong "idle" while Claude works between frames; no turn → idle, so
      // a dormant reopen has no phantom "Running tool". `usage` seeds the context meter, which the
      // transcript can't (it has no result). Granular live WS frames (seq > sinceSeq) refine the wire from
      // here, and the race guard below carries any already-arrived live state forward.
      // Merge the meter usage: folding the transcript already set `contextTokens` from the LAST assistant
      // message's per-turn usage (the correct, current occupancy) — prefer that; take the `contextWindow`
      // denominator from the seed (the transcript has no result frame). Undefined when neither exists.
      const foldedUsage = view.usage;
      const seededUsage = {
        contextTokens: foldedUsage?.contextTokens ?? live?.usage?.contextTokens,
        contextWindow: live?.usage?.contextWindow ?? foldedUsage?.contextWindow,
        outputTokens: foldedUsage?.outputTokens ?? live?.usage?.outputTokens,
      };
      const hasUsage = seededUsage.contextTokens !== undefined || seededUsage.contextWindow !== undefined;
      // A prompt still pending at (re)open → seed it so the card shows immediately AND the wire reads
      // "awaiting" (not a phantom "working"), otherwise the reopened chat is stuck with no way to answer.
      const pendingPermission = live?.pendingPermission;
      const pendingQuestion = live?.pendingQuestion;
      const awaiting = pendingPermission !== undefined || pendingQuestion !== undefined;
      view = {
        ...view,
        lastSeq: sinceSeq,
        wireState: awaiting ? "awaiting" : live?.turnActive ? "running-tool" : "idle",
        pendingPermission,
        pendingQuestion,
        usage: hasUsage ? seededUsage : undefined,
        liveText: "",
        thinkingText: "",
      };

      // Race guard: if live frames (seq > sinceSeq) already arrived for this session BEFORE the history
      // resolved (e.g. an early WS frame, or a poll seeding a live delta), DON'T clobber that live
      // state. Carry the current view's streaming/pending fields and its higher lastSeq forward, and
      // keep any extra turns it accumulated beyond the transcript so nothing live is dropped.
      const current = state.views[id];
      if (current && current.lastSeq > sinceSeq) {
        // Carry forward the live turns that aren't already in the freshly-folded transcript, matched by
        // IDENTITY (not by index). The old `current.turns.slice(view.turns.length)` assumed the live view
        // was an exact prefix of the transcript fold — but on a fresh open `current` was reset to empty and
        // then accumulated only a FEW early live frames (seq > sinceSeq), so it's SHORTER than the
        // transcript and the slice returned [] — silently DROPPING those early live turns (and lastSeq was
        // carried forward, so the WS never re-sent them). Build a signature set of the transcript turns
        // (user turns keyed by BOTH checkpointId and text, so an optimistic bubble dedups against its
        // echoed self) and append only the live turns not already present.
        const seen = new Set<string>();
        for (const t of view.turns) for (const sig of turnSignatures(t)) seen.add(sig);
        const extraTurns = current.turns.filter((t) => !turnSignatures(t).some((sig) => seen.has(sig)));
        view = {
          ...view,
          turns: [...view.turns, ...extraTurns],
          liveText: current.liveText,
          thinkingText: current.thinkingText,
          pendingPermission: current.pendingPermission,
          pendingQuestion: current.pendingQuestion,
          lastResult: current.lastResult,
          // A live result that landed before history resolved owns the freshest usage; else keep the seed.
          usage: current.usage ?? view.usage,
          wireState: current.wireState,
          // Carry any live subagent state forward so a race (a subagent frame arriving before history
          // resolved) doesn't drop the registry. Current (live) wins per key; order is unioned.
          subagents: { ...view.subagents, ...current.subagents },
          subagentOrder: [...new Set([...view.subagentOrder, ...current.subagentOrder])],
          subagentTaskIndex: { ...view.subagentTaskIndex, ...current.subagentTaskIndex },
          seenUserUuids: new Set([...view.seenUserUuids, ...current.seenUserUuids]),
          lastSeq: current.lastSeq,
        };
      }
      return { views: { ...state.views, [id]: view } };
    }),
  appendUserMessage: (id, blocks, queued = false, pending = false) =>
    set((state) => {
      const current = state.views[id] ?? emptyView();
      // The user just sent — that IS activity, so bump the stamp (optimistically, ahead of the server
      // echo) so the chat floats up the rail the instant they hit send. `queued` (sent while a turn was
      // running) renders the bubble below the live stream so order is preserved until the echo reconciles.
      // `pending` (the send was buffered because the socket wasn't open) drives the "Sending…" label.
      return {
        views: {
          ...state.views,
          [id]: {
            ...current,
            turns: [
              ...current.turns,
              { kind: "user", blocks, ...(queued ? { queued: true } : {}), ...(pending ? { pending: true } : {}) },
            ],
          },
        },
        lastActiveAt: { ...state.lastActiveAt, [id]: Date.now() },
      };
    }),
  clearPending: (id) =>
    set((state) => {
      const view = state.views[id];
      if (!view || !view.turns.some((t) => t.kind === "user" && t.pending)) return {}; // nothing buffered
      // The socket (re)opened and flushed its buffer → those messages are delivered now; drop "Sending…".
      const turns = view.turns.map((t) => (t.kind === "user" && t.pending ? { ...t, pending: false } : t));
      return { views: { ...state.views, [id]: { ...view, turns } } };
    }),
  resetSession: (id) => set((state) => ({ views: { ...state.views, [id]: emptyView() } })),
  setCompacting: (id, compacting) =>
    set((state) => ({ views: { ...state.views, [id]: { ...(state.views[id] ?? emptyView()), compacting } } })),
  viewFor: (id) => get().views[id] ?? emptyView(),
}));
