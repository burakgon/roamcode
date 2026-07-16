import { browserRelayConnectUrl, generateBrowserRelayDeviceCredential } from "./client";

const MAX_PAIRING_BYTES = 8 * 1024;
const MAX_PAIRING_LIFETIME_MS = 10 * 60_000;
const PENDING_PAIRING_KEY = "roamcode.relay-pairing.pending.v1";
const UNSAFE_DISPLAY_TEXT = /[\p{Cc}\p{Zl}\p{Zp}\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;

export interface RelayPairingPackage {
  v: 1;
  label: string;
  relayUrl: string;
  routeId: string;
  deviceId: string;
  deviceCredential: string;
  deviceToken: string;
  pairingSecret: string;
  expiresAt: number;
  hostIdentityPublicKey: string;
  hostIdentityFingerprint: string;
}

export interface RelayPairingAttempt {
  pairing: RelayPairingPackage;
  durableDeviceCredential: string;
}

export class RelayPairingLinkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RelayPairingLinkError";
  }
}

function base64UrlDecode(value: string): Uint8Array<ArrayBuffer> {
  if (!value || value.length > MAX_PAIRING_BYTES * 2 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new RelayPairingLinkError("This relay pairing link is invalid.");
  }
  try {
    const binary = atob(
      value
        .replaceAll("-", "+")
        .replaceAll("_", "/")
        .padEnd(Math.ceil(value.length / 4) * 4, "="),
    );
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    if (bytes.byteLength > MAX_PAIRING_BYTES) throw new Error("too large");
    return bytes;
  } catch {
    throw new RelayPairingLinkError("This relay pairing link is invalid.");
  }
}

function safeId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9._:-]{1,256}$/.test(value);
}

function parsePackage(value: unknown): RelayPairingPackage {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new RelayPairingLinkError("This relay pairing link is invalid.");
  const pairing = value as Record<string, unknown>;
  const label = typeof pairing.label === "string" ? pairing.label.trim().replace(/\s+/g, " ") : "";
  if (
    pairing.v !== 1 ||
    !label ||
    label.length > 80 ||
    UNSAFE_DISPLAY_TEXT.test(label) ||
    typeof pairing.relayUrl !== "string" ||
    !safeId(pairing.routeId) ||
    !safeId(pairing.deviceId) ||
    typeof pairing.deviceCredential !== "string" ||
    !/^rrd_[A-Za-z0-9_-]{43}$/.test(pairing.deviceCredential) ||
    typeof pairing.deviceToken !== "string" ||
    !/^rcd_[A-Za-z0-9_-]{43}$/.test(pairing.deviceToken) ||
    typeof pairing.pairingSecret !== "string" ||
    !/^rcp_[A-Za-z0-9_-]{43}$/.test(pairing.pairingSecret) ||
    !Number.isSafeInteger(pairing.expiresAt) ||
    (pairing.expiresAt as number) < 0 ||
    typeof pairing.hostIdentityPublicKey !== "string" ||
    !/^[A-Za-z0-9_-]{80,1024}$/.test(pairing.hostIdentityPublicKey) ||
    typeof pairing.hostIdentityFingerprint !== "string" ||
    !/^sha256:[A-Za-z0-9_-]{43}$/.test(pairing.hostIdentityFingerprint)
  ) {
    throw new RelayPairingLinkError("This relay pairing link is invalid.");
  }
  let relayUrl: string;
  try {
    relayUrl = browserRelayConnectUrl(pairing.relayUrl);
  } catch {
    throw new RelayPairingLinkError("This relay pairing link does not use a trusted relay URL.");
  }
  return {
    v: 1,
    label,
    relayUrl,
    routeId: pairing.routeId,
    deviceId: pairing.deviceId,
    deviceCredential: pairing.deviceCredential,
    deviceToken: pairing.deviceToken,
    pairingSecret: pairing.pairingSecret,
    expiresAt: pairing.expiresAt as number,
    hostIdentityPublicKey: pairing.hostIdentityPublicKey,
    hostIdentityFingerprint: pairing.hostIdentityFingerprint,
  };
}

function safeSessionStorage(): Storage | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.sessionStorage;
  } catch {
    return undefined;
  }
}

function removePendingAttempt(storage: Storage | undefined): void {
  try {
    storage?.removeItem(PENDING_PAIRING_KEY);
  } catch {
    /* Pairing still works in memory when browser storage is unavailable. */
  }
}

function parseAttempt(value: unknown, now: number): RelayPairingAttempt {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RelayPairingLinkError("This relay pairing attempt is invalid.");
  }
  const attempt = value as Record<string, unknown>;
  const pairing = parsePackage(attempt.pairing);
  const durableDeviceCredential = attempt.durableDeviceCredential;
  if (
    typeof durableDeviceCredential !== "string" ||
    !/^rrd_[A-Za-z0-9_-]{43}$/.test(durableDeviceCredential) ||
    durableDeviceCredential === pairing.deviceCredential
  ) {
    throw new RelayPairingLinkError("This relay pairing attempt is invalid.");
  }
  if (pairing.expiresAt < now || pairing.expiresAt > now + MAX_PAIRING_LIFETIME_MS) {
    throw new RelayPairingLinkError("This relay pairing link expired. Create a fresh link.");
  }
  return { pairing, durableDeviceCredential };
}

/** Consume before parsing so even a malformed secret package is immediately removed from history. */
export function consumeRelayPairingFromUrl(): RelayPairingPackage | undefined {
  if (typeof window === "undefined") return undefined;
  const fragment = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const encoded = fragment.get("relay-pair");
  if (encoded === null || encoded === "") return undefined;
  fragment.delete("relay-pair");
  const hash = fragment.toString();
  window.history.replaceState({}, "", window.location.pathname + window.location.search + (hash ? `#${hash}` : ""));
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(base64UrlDecode(encoded)));
  } catch (error) {
    if (error instanceof RelayPairingLinkError) throw error;
    throw new RelayPairingLinkError("This relay pairing link is invalid.");
  }
  return parsePackage(value);
}

/**
 * Remove the secret fragment immediately, then keep an unfinished attempt only in this tab's session storage.
 * This survives an accidental reload without creating a durable cross-session credential copy.
 */
export function consumeOrResumeRelayPairingAttempt(
  now = Date.now(),
  storage: Storage | undefined = safeSessionStorage(),
): RelayPairingAttempt | undefined {
  let pairing: RelayPairingPackage | undefined;
  try {
    pairing = consumeRelayPairingFromUrl();
  } catch (error) {
    removePendingAttempt(storage);
    throw error;
  }

  if (pairing) {
    const attempt = parseAttempt({ pairing, durableDeviceCredential: generateBrowserRelayDeviceCredential() }, now);
    try {
      storage?.setItem(PENDING_PAIRING_KEY, JSON.stringify(attempt));
    } catch {
      /* The in-memory attempt remains usable for this page load. */
    }
    return attempt;
  }

  let raw: string | null;
  try {
    raw = storage?.getItem(PENDING_PAIRING_KEY) ?? null;
  } catch {
    return undefined;
  }
  if (!raw) return undefined;
  try {
    return parseAttempt(JSON.parse(raw) as unknown, now);
  } catch {
    removePendingAttempt(storage);
    return undefined;
  }
}

export function clearRelayPairingAttempt(storage: Storage | undefined = safeSessionStorage()): void {
  removePendingAttempt(storage);
}
