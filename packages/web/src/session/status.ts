import type { SessionMeta } from "../types/server";
import type { LiveWireState } from "../ui/LiveWire";

/**
 * Map a session's server meta (+ its optional live view) to a single, scannable rail status. The
 * corrected model (post commit e5b0b5f):
 *
 *   - `meta.awaiting` ALWAYS wins → "awaiting" (the loud iris "needs you"). It comes from the meta, so
 *     it works even for sessions WITHOUT a live view (the client isn't connected to that session yet).
 *   - `errored` → "error" (a real crash only — a clean exit is NOT an error).
 *   - `dormant` → "dormant" (a calm, resumable, idle-ish look — process not live, but fine).
 *   - `stopped` → "idle".
 *   - `running` → the live wire state from the connected view (working/streaming/idle); falls back to
 *     "idle" when there's no live view yet.
 *
 * Pure + total; never throws.
 */
export function wireStateForSession(meta: SessionMeta, view?: { wireState: LiveWireState }): LiveWireState {
  // Awaiting is the highest-priority signal and is meta-driven, so it surfaces for sessions you're not
  // actively viewing — this is the one that must win.
  if (meta.awaiting) return "awaiting";
  if (meta.status === "errored") return "error";
  if (meta.status === "dormant") return "dormant";
  if (meta.status === "stopped") return "idle";
  // running: defer to the live view's wire state when connected, else idle.
  return view?.wireState ?? "idle";
}
