import type { SessionMeta } from "../types/server";

/**
 * Order the rail like a chat app, with one override: sessions that are AWAITING you (a pending
 * permission/question, `s.awaiting`) always float to the TOP so the thing that needs an answer is never
 * buried below chatter. Within each group (awaiting first, then the rest) the order is most-recently-
 * opened/active first: by the client-side `lastActiveAt[id]` (bumped on select + on inbound frames),
 * falling back to `createdAt` when a stamp is missing, and breaking ties by `createdAt` descending so a
 * deterministic order survives equal stamps. PURE — returns a NEW array, never mutates the input (the
 * store array stays insertion-order).
 */
export function sortSessionsByActivity(sessions: SessionMeta[], lastActiveAt: Record<string, number>): SessionMeta[] {
  const activity = (s: SessionMeta): number => lastActiveAt[s.id] ?? s.createdAt;
  const awaitingRank = (s: SessionMeta): number => (s.awaiting ? 1 : 0);
  return [...sessions].sort(
    (a, b) => awaitingRank(b) - awaitingRank(a) || activity(b) - activity(a) || b.createdAt - a.createdAt,
  );
}
