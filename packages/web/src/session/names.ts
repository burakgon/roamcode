import { useEffect, useState } from "react";
import type { SessionMeta } from "../types/server";

/**
 * Session display names. The SERVER is now the source of truth (SessionMeta.name via PATCH /sessions/:id),
 * so a rename made on one device shows on every other. This module keeps the LEGACY localStorage map for
 * two jobs: (1) a fallback label for sessions named before the server grew names, and (2) the
 * instant-optimistic layer — a rename writes here first (dispatching `rc-session-names-change`, which every
 * useSessionNames() subscriber re-reads live) while the PATCH travels; the next /sessions poll then carries
 * the server name. Priority in displaySessionName: server `s.name` → local map → cwd basename.
 */

const NAMES_KEY = "rc-session-names";
const CHANGE_EVENT = "rc-session-names-change";

export function loadSessionNames(): Record<string, string> {
  try {
    const raw = window.localStorage?.getItem(NAMES_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : {};
    return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

export function saveSessionName(id: string, name: string): void {
  try {
    const all = loadSessionNames();
    const trimmed = name.trim();
    if (trimmed) all[id] = trimmed;
    else delete all[id]; // clearing the field reverts to the cwd basename
    window.localStorage?.setItem(NAMES_KEY, JSON.stringify(all));
  } catch {
    /* storage blocked (private mode) — the rename just won't persist */
  }
  try {
    window.dispatchEvent(new Event(CHANGE_EVENT));
  } catch {
    /* no window/Event (jsdom teardown) — subscribers will read fresh on next mount */
  }
}

export function basename(p: string): string {
  const parts = p.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || p;
}

/** A session's display name: the SERVER name (cross-device truth) first, then the legacy/optimistic local
 *  label, then the cwd basename. All trimmed-falsy values fall through, so a cleared name reverts cleanly. */
export function displaySessionName(s: Pick<SessionMeta, "id" | "cwd" | "name">, names: Record<string, string>): string {
  return s.name?.trim() || names[s.id]?.trim() || basename(s.cwd);
}

/** Live name map — re-reads on every rename (the rc-session-names-change event), so headers/rows update
 *  the moment a rename commits anywhere. */
export function useSessionNames(): Record<string, string> {
  const [names, setNames] = useState<Record<string, string>>(() => loadSessionNames());
  useEffect(() => {
    const onChange = (): void => setNames(loadSessionNames());
    window.addEventListener(CHANGE_EVENT, onChange);
    return () => window.removeEventListener(CHANGE_EVENT, onChange);
  }, []);
  return names;
}
