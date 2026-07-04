import { useEffect, useState } from "react";
import type { SessionMeta } from "../types/server";

/**
 * Client-only session names — a per-session-id editable label in THIS browser's localStorage (the server
 * has no concept of a session name; a row with no custom name falls back to its cwd basename). Shared by
 * the rail (rename lives there) AND the chat header (which previously kept showing the basename after a
 * rename — the reported bug): saves dispatch `rc-session-names-change`, and useSessionNames() re-reads on
 * it, so every subscriber updates live.
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

/** A session's display name: the custom label if set, else the cwd basename. */
export function displaySessionName(s: Pick<SessionMeta, "id" | "cwd">, names: Record<string, string>): string {
  return names[s.id]?.trim() || basename(s.cwd);
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
