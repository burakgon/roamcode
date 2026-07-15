import type { RelayEncryptedFrame, RelayHandshakeHello } from "./relay-crypto.js";

export const RELAY_WIRE_PROTOCOL_VERSION = 1 as const;
export const RELAY_WIRE_MAX_ENVELOPE_BYTES = 1_400_000;

export type RelayWireEnvelope =
  | { v: 1; t: "device-hello"; hello: RelayHandshakeHello; identityPublicKey?: string }
  | { v: 1; t: "host-hello"; hello: RelayHandshakeHello }
  | { v: 1; t: "cipher"; frame: RelayEncryptedFrame };

export function encodeRelayWireEnvelope(envelope: RelayWireEnvelope): string {
  const encoded = Buffer.from(JSON.stringify(envelope), "utf8");
  if (encoded.byteLength > RELAY_WIRE_MAX_ENVELOPE_BYTES) throw new Error("relay envelope is too large");
  return encoded.toString("base64url");
}

export function decodeRelayWireEnvelope(payload: unknown): RelayWireEnvelope {
  if (typeof payload !== "string" || !payload || !/^[A-Za-z0-9_-]+$/.test(payload)) {
    throw new Error("invalid relay envelope");
  }
  const encoded = Buffer.from(payload, "base64url");
  if (
    encoded.byteLength < 2 ||
    encoded.byteLength > RELAY_WIRE_MAX_ENVELOPE_BYTES ||
    encoded.toString("base64url") !== payload
  ) {
    throw new Error("invalid relay envelope");
  }
  let value: unknown;
  try {
    value = JSON.parse(encoded.toString("utf8"));
  } catch {
    throw new Error("invalid relay envelope");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid relay envelope");
  const envelope = value as Record<string, unknown>;
  if (envelope.v !== RELAY_WIRE_PROTOCOL_VERSION) throw new Error("unsupported relay envelope");
  if (envelope.t === "device-hello" || envelope.t === "host-hello") {
    if (!envelope.hello || typeof envelope.hello !== "object" || Array.isArray(envelope.hello)) {
      throw new Error("invalid relay handshake envelope");
    }
    return envelope as unknown as RelayWireEnvelope;
  }
  if (envelope.t === "cipher") {
    if (!envelope.frame || typeof envelope.frame !== "object" || Array.isArray(envelope.frame)) {
      throw new Error("invalid relay cipher envelope");
    }
    return envelope as unknown as RelayWireEnvelope;
  }
  throw new Error("unknown relay envelope");
}
