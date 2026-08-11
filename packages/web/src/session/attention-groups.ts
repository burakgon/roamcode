import type { SessionMeta } from "../types/server";
import { sortSessions } from "./order";
import type { SessionOrder } from "./order-preference";

export type SessionAttentionSection = "need-you" | "working" | "other";

export interface AttentionGroupedSessions {
  needYou: SessionMeta[];
  working: SessionMeta[];
  other: SessionMeta[];
}

/**
 * Resolve the user-facing section from server truth. Newer hosts report the foreground agent under
 * `agent.activity`; older hosts project the same state onto `activity` / `awaiting`, so the rail accepts
 * both without duplicating sessions or guessing from terminal text in the browser.
 */
export function sessionAttentionSection(session: SessionMeta): SessionAttentionSection {
  const activity = session.agent?.activity ?? session.activity;
  if (session.awaiting || activity === "blocked") return "need-you";
  if (session.status === "running" && activity === "working") return "working";
  return "other";
}

/** Stable ordering inside each attention section; every input session is returned exactly once. */
export function groupSessionsByAttention(
  sessions: SessionMeta[],
  lastActiveAt: Record<string, number>,
  order: SessionOrder,
): AttentionGroupedSessions {
  const grouped: AttentionGroupedSessions = { needYou: [], working: [], other: [] };
  for (const session of sortSessions(sessions, lastActiveAt, order)) {
    const section = sessionAttentionSection(session);
    if (section === "need-you") grouped.needYou.push(session);
    else if (section === "working") grouped.working.push(session);
    else grouped.other.push(session);
  }
  return grouped;
}
