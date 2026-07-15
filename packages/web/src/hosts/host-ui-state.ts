import type { StorageLike } from "./direct-hosts";

const ACTIVE_PREFIX = "roamcode.host-active-session.";
const DRAFT_PREFIX = "roamcode.host-terminal-draft.";
const MAX_DRAFT_BYTES = 64 * 1024;

function store(storage?: StorageLike): StorageLike {
  return storage ?? window.localStorage;
}

function safePart(value: string): string {
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(value)) throw new Error("Invalid host UI state key");
  return value;
}

export function loadHostActiveSession(hostId: string, storage?: StorageLike): string | undefined {
  try {
    const value = store(storage).getItem(`${ACTIVE_PREFIX}${safePart(hostId)}`);
    return value && /^[A-Za-z0-9_-]{1,256}$/.test(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

export function saveHostActiveSession(hostId: string, sessionId: string | undefined, storage?: StorageLike): void {
  try {
    const key = `${ACTIVE_PREFIX}${safePart(hostId)}`;
    if (!sessionId) {
      store(storage).removeItem(key);
      return;
    }
    store(storage).setItem(key, safePart(sessionId));
  } catch {
    /* private mode or quota failure: host switching still works, without persistence */
  }
}

export function loadTerminalDraft(hostId: string, sessionId: string, storage?: StorageLike): string {
  try {
    const value = store(storage).getItem(`${DRAFT_PREFIX}${safePart(hostId)}.${safePart(sessionId)}`) ?? "";
    return new TextEncoder().encode(value).byteLength <= MAX_DRAFT_BYTES ? value : "";
  } catch {
    return "";
  }
}

export function saveTerminalDraft(hostId: string, sessionId: string, value: string, storage?: StorageLike): void {
  const key = `${DRAFT_PREFIX}${safePart(hostId)}.${safePart(sessionId)}`;
  if (!value) {
    try {
      store(storage).removeItem(key);
    } catch {
      /* ignore unavailable storage */
    }
    return;
  }
  if (new TextEncoder().encode(value).byteLength > MAX_DRAFT_BYTES) {
    throw new Error("Draft exceeds 64 KiB");
  }
  try {
    store(storage).setItem(key, value);
  } catch {
    /* private mode or quota failure: keep the in-memory draft */
  }
}
