import { create } from "zustand";
import type { ContentBlock, ServerFrame, SessionMeta } from "../types/server";
import { emptyView, reduceFrame } from "./frame-reducer";
import type { SessionView } from "./frame-reducer";

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
  setActive: (id: string | undefined) => void;
  /** Remove a session client-side after it's been stopped/closed server-side: drops it from the
   * list and clears its view + activity stamp. Does NOT touch activeSessionId (the caller decides
   * what to select next, since "close the active one" wants the new top, not undefined-by-default). */
  removeSession: (id: string) => void;
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
    set((state) => {
      // Seed an activity stamp for any session we haven't seen yet, from its createdAt, so a freshly
      // loaded list still has a stable most-recent-first order. Keep existing stamps (a session that's
      // already been selected/active stays where the user put it).
      const lastActiveAt = { ...state.lastActiveAt };
      for (const s of sessions) if (lastActiveAt[s.id] === undefined) lastActiveAt[s.id] = s.createdAt;
      return { sessions, lastActiveAt };
    }),
  setActive: (id) =>
    set((state) =>
      // Selecting a session floats it to the top of the rail (like focusing a chat). Undefined clears
      // the selection (the empty/landing state) and touches nothing.
      id === undefined
        ? { activeSessionId: undefined }
        : { activeSessionId: id, lastActiveAt: { ...state.lastActiveAt, [id]: Date.now() } },
    ),
  removeSession: (id) =>
    set((state) => {
      const views = { ...state.views };
      delete views[id];
      const lastActiveAt = { ...state.lastActiveAt };
      delete lastActiveAt[id];
      return { sessions: state.sessions.filter((s) => s.id !== id), views, lastActiveAt };
    }),
  applyFrame: (id, frame) =>
    set((state) => {
      const current = state.views[id] ?? emptyView();
      // A session receiving a frame is "active" — bump it so it floats up the rail.
      return {
        views: { ...state.views, [id]: reduceFrame(current, frame) },
        lastActiveAt: { ...state.lastActiveAt, [id]: Date.now() },
      };
    }),
  // Fold a batch of frames in a single store update (one re-render) — used to replay REST history.
  applyFrames: (id, frames) =>
    set((state) => {
      let view = state.views[id] ?? emptyView();
      for (const frame of frames) view = reduceFrame(view, frame);
      return {
        views: { ...state.views, [id]: view },
        lastActiveAt: { ...state.lastActiveAt, [id]: Date.now() },
      };
    }),
  appendUserMessage: (id, blocks) =>
    set((state) => {
      const current = state.views[id] ?? emptyView();
      return {
        views: { ...state.views, [id]: { ...current, turns: [...current.turns, { kind: "user", blocks }] } },
      };
    }),
  resetSession: (id) => set((state) => ({ views: { ...state.views, [id]: emptyView() } })),
  viewFor: (id) => get().views[id] ?? emptyView(),
}));
