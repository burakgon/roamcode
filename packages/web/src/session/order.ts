import type { SessionMeta } from "../types/server";

/**
 * Order the rail like a chat app: most-recently-opened/active session first. Sorts by the client-side
 * `lastActiveAt[id]` (bumped on select + on inbound frames), falling back to `createdAt` when a stamp
 * is missing, and breaking ties by `createdAt` descending so a deterministic order survives equal
 * stamps. PURE — returns a NEW array, never mutates the input (the store array stays insertion-order).
 */
export function sortSessionsByActivity(
  sessions: SessionMeta[],
  lastActiveAt: Record<string, number>,
): SessionMeta[] {
  const activity = (s: SessionMeta): number => lastActiveAt[s.id] ?? s.createdAt;
  return [...sessions].sort((a, b) => activity(b) - activity(a) || b.createdAt - a.createdAt);
}
