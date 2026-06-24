import { create } from "zustand";
import type { ContentBlock, ServerFrame, SessionMeta } from "../types/server";
import { emptyView, reduceFrame } from "./frame-reducer";
import type { SessionView } from "./frame-reducer";

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
  /** Optimistically append the user's own message to the view on send (claude does not echo the
   * typed user text back as a render-able turn, so without this the sender never sees their message). */
  appendUserMessage: (id: string, blocks: ContentBlock[]) => void;
  resetSession: (id: string) => void;
  viewFor: (id: string) => SessionView;
}

export const useStore = create<StoreState>((set, get) => ({
  token: undefined,
  sessions: [],
  activeSessionId: undefined,
  views: {},
  lastActiveAt: {},
  setToken: (token) => set({ token }),
  setSessions: (sessions) =>
    set((state) => ({ sessions, lastActiveAt: reconcileActivity(state.lastActiveAt, sessions) })),
  // Same activity reconciliation as setSessions, but explicitly a refresh-merge: it replaces the meta
  // list (dropping any session no longer returned by the server) while leaving `views` untouched, so a
  // background poll never disturbs the actively-connected live conversation.
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
      // Activity-sort is driven by conversation activity ONLY: bump the stamp on an inbound user/
      // assistant MESSAGE frame (real turns), but NOT on plumbing frames (stream deltas, permissions,
      // diagnostics, system) — and never on select/open. This keeps the rail honest about which chat
      // last actually moved.
      const lastActiveAt = isMessageFrame(frame)
        ? { ...state.lastActiveAt, [id]: Date.now() }
        : state.lastActiveAt;
      return { views: { ...state.views, [id]: reduceFrame(current, frame) }, lastActiveAt };
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
  appendUserMessage: (id, blocks) =>
    set((state) => {
      const current = state.views[id] ?? emptyView();
      // The user just sent — that IS activity, so bump the stamp (optimistically, ahead of the server
      // echo) so the chat floats up the rail the instant they hit send.
      return {
        views: { ...state.views, [id]: { ...current, turns: [...current.turns, { kind: "user", blocks }] } },
        lastActiveAt: { ...state.lastActiveAt, [id]: Date.now() },
      };
    }),
  resetSession: (id) => set((state) => ({ views: { ...state.views, [id]: emptyView() } })),
  viewFor: (id) => get().views[id] ?? emptyView(),
}));
