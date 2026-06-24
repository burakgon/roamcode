import { create } from "zustand";
import type { ContentBlock, ServerFrame, SessionMeta } from "../types/server";
import { emptyView, reduceFrame } from "./frame-reducer";
import type { SessionView } from "./frame-reducer";

interface StoreState {
  token: string | undefined;
  sessions: SessionMeta[];
  activeSessionId?: string;
  views: Record<string, SessionView>;
  setToken: (token: string | undefined) => void;
  setSessions: (sessions: SessionMeta[]) => void;
  setActive: (id: string | undefined) => void;
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
  setToken: (token) => set({ token }),
  setSessions: (sessions) => set({ sessions }),
  setActive: (id) => set({ activeSessionId: id }),
  applyFrame: (id, frame) =>
    set((state) => {
      const current = state.views[id] ?? emptyView();
      return { views: { ...state.views, [id]: reduceFrame(current, frame) } };
    }),
  // Fold a batch of frames in a single store update (one re-render) — used to replay REST history.
  applyFrames: (id, frames) =>
    set((state) => {
      let view = state.views[id] ?? emptyView();
      for (const frame of frames) view = reduceFrame(view, frame);
      return { views: { ...state.views, [id]: view } };
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
