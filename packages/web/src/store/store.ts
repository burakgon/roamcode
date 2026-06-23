import { create } from "zustand";
import type { ServerFrame, SessionMeta } from "../types/server";
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
  resetSession: (id) => set((state) => ({ views: { ...state.views, [id]: emptyView() } })),
  viewFor: (id) => get().views[id] ?? emptyView(),
}));
