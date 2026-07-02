import { create } from "zustand";
import type { SessionMeta, UsageInfo, VersionInfo } from "../types/server";

// Persist the active session id so a reload / relaunch / OTA-heal (all of which iOS PWAs do often) returns
// you to the session you were in instead of the empty landing. App validates it against the live list on
// load (clears it if that session is gone). Best-effort — private-mode storage failures are ignored.
const ACTIVE_KEY = "rc-active-session";
function loadActiveSession(): string | undefined {
  try {
    return (typeof localStorage !== "undefined" && localStorage.getItem(ACTIVE_KEY)) || undefined;
  } catch {
    return undefined;
  }
}
function saveActiveSession(id: string | undefined): void {
  try {
    if (typeof localStorage === "undefined") return;
    if (id) localStorage.setItem(ACTIVE_KEY, id);
    else localStorage.removeItem(ACTIVE_KEY);
  } catch {
    /* private mode / storage blocked — non-fatal */
  }
}

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

interface StoreState {
  token: string | undefined;
  sessions: SessionMeta[];
  activeSessionId?: string;
  /** Per-session "most recently opened/active" timestamp (ms). Bumped on select-independent activity so
   * the rail can float the just-active session to the top, chat-app style. Seeded from each session's
   * createdAt when the list loads so fresh lists still have an order. */
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
  /** Merge a freshly-polled `GET /sessions` list into the store: replaces the meta list (so vanished/
   * closed sessions drop and statuses/awaiting refresh), reconciles each `lastActiveAt` to the max of
   * the local optimistic stamp and the server's monotonic `lastActivityAt`, and prunes stamps for
   * dropped sessions. */
  mergeSessionMeta: (sessions: SessionMeta[]) => void;
  setActive: (id: string | undefined) => void;
  /** Remove a session client-side after it's been stopped/closed server-side: drops it from the
   * list and clears its activity stamp. Does NOT touch activeSessionId (the caller decides
   * what to select next, since "close the active one" wants the new top, not undefined-by-default). */
  removeSession: (id: string) => void;
  /** Re-add a session (e.g. an optimistic close that the server rejected) so the rail row reappears
   * instead of silently vanishing. No-op if the id is already present (idempotent). */
  addSession: (session: SessionMeta) => void;
}

export const useStore = create<StoreState>((set) => ({
  token: undefined,
  sessions: [],
  activeSessionId: loadActiveSession(),
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
  // list (dropping any session no longer returned by the server). `awaiting` stays SERVER-authoritative
  // here (the poll can legitimately RAISE it for a prompt that hasn't otherwise surfaced yet).
  mergeSessionMeta: (sessions) =>
    set((state) => ({ sessions, lastActiveAt: reconcileActivity(state.lastActiveAt, sessions) })),
  setActive: (id) => {
    // Selecting a session NEVER reorders the rail: it only changes which conversation is shown.
    // (Activity stamps are bumped on send/receive only — never on select — so viewing a chat is inert.)
    saveActiveSession(id); // persist so a reload returns to this session (see loadActiveSession)
    set({ activeSessionId: id });
  },
  removeSession: (id) =>
    set((state) => {
      const lastActiveAt = { ...state.lastActiveAt };
      delete lastActiveAt[id];
      return { sessions: state.sessions.filter((s) => s.id !== id), lastActiveAt };
    }),
  addSession: (session) =>
    set((state) =>
      state.sessions.some((s) => s.id === session.id)
        ? state
        : { sessions: [...state.sessions, session], lastActiveAt: reconcileActivity(state.lastActiveAt, [session]) },
    ),
}));
