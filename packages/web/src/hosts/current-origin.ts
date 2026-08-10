export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const LEGACY_REGISTRY_KEY = "roamcode.direct-hosts.v1";
const LEGACY_TOKEN_PREFIX = "roamcode.direct-host-token.";

function store(storage?: StorageLike): StorageLike {
  return storage ?? window.localStorage;
}

function normalizeOrigin(value: string): string {
  return new URL(value, window.location.href).origin;
}

function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function validCredential(value: string): boolean {
  return value.length > 0 && value.length <= 4096 && value.trim() === value && !/[\s\p{Cc}\p{Zl}\p{Zp}]/u.test(value);
}

function hasOrigin(value: unknown, origin: string): boolean {
  if (typeof value !== "string") return false;
  try {
    return normalizeOrigin(value) === origin;
  } catch {
    return false;
  }
}

/** Stable browser-state scope for the one server origin that serves this app. */
export function currentOriginScopeId(baseUrl: string): string {
  return `host_${fnv1a(normalizeOrigin(baseUrl))}`;
}

/**
 * Read a token left by the removed multi-host registry only when it belongs to this exact origin.
 * The legacy keys are intentionally left untouched so the migration is non-destructive.
 */
export function loadLegacyCurrentOriginToken(baseUrl: string, storage?: StorageLike): string | undefined {
  try {
    const origin = normalizeOrigin(baseUrl);
    const parsed = JSON.parse(store(storage).getItem(LEGACY_REGISTRY_KEY) ?? "null") as {
      hosts?: Array<{ id?: unknown; baseUrl?: unknown }>;
    } | null;
    const host = parsed?.hosts?.find(
      (candidate) =>
        typeof candidate.id === "string" &&
        /^[A-Za-z0-9_-]{1,128}$/.test(candidate.id) &&
        hasOrigin(candidate.baseUrl, origin),
    );
    if (!host || typeof host.id !== "string") return undefined;
    const token = store(storage).getItem(`${LEGACY_TOKEN_PREFIX}${host.id}`);
    return token && validCredential(token) ? token : undefined;
  } catch {
    return undefined;
  }
}
