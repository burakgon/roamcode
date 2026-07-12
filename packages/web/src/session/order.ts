import type { SessionMeta } from "../types/server";
import type { SessionOrder } from "./order-preference";

/**
 * Order the rail like a chat app, with one override: sessions that are AWAITING you (a pending
 * permission/question, `s.awaiting`) always float to the TOP so the thing that needs an answer is never
 * buried below chatter. Within each group (awaiting first, then the rest), the selected policy orders by
 * either creation time or the client-side `lastActiveAt[id]` (falling back to `createdAt`). Creation time
 * then breaks primary ties, followed by id for a fully deterministic result. PURE — returns a NEW array,
 * never mutates the input (the store array stays insertion-order).
 */
export function sortSessions(
  sessions: SessionMeta[],
  lastActiveAt: Record<string, number>,
  order: SessionOrder,
): SessionMeta[] {
  const activity = (session: SessionMeta): number => lastActiveAt[session.id] ?? session.createdAt;
  const primary = (session: SessionMeta): number => (order === "activity" ? activity(session) : session.createdAt);
  const awaitingRank = (session: SessionMeta): number => (session.awaiting ? 1 : 0);
  return [...sessions].sort(
    (a, b) =>
      awaitingRank(b) - awaitingRank(a) ||
      primary(b) - primary(a) ||
      b.createdAt - a.createdAt ||
      a.id.localeCompare(b.id),
  );
}
