import { afterEach, describe, expect, test } from "vitest";
import { consumeRelayPairingFromUrl, RelayPairingLinkError, type RelayPairingPackage } from "./pairing-link";

const pairing: RelayPairingPackage = {
  v: 1,
  label: "Studio",
  relayUrl: "wss://relay.example/v1/connect",
  routeId: "route-1",
  deviceId: "device-1",
  deviceCredential: `rrd_${"d".repeat(43)}`,
  deviceToken: `rcd_${"t".repeat(43)}`,
  pairingSecret: `rcp_${"p".repeat(43)}`,
  expiresAt: 1234,
  hostIdentityPublicKey: "a".repeat(100),
  hostIdentityFingerprint: `sha256:${"h".repeat(43)}`,
};

function encode(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

afterEach(() => window.history.replaceState({}, "", "/"));

describe("relay pairing links", () => {
  test("consumes a strict fragment package without leaving secrets in history", () => {
    window.history.replaceState({}, "", `/?session=s1#relay-pair=${encode(pairing)}&view=compact`);
    expect(consumeRelayPairingFromUrl()).toEqual(pairing);
    expect(window.location.search).toBe("?session=s1");
    expect(window.location.hash).toBe("#view=compact");
  });

  test("removes malformed sensitive bytes before reporting the error", () => {
    window.history.replaceState({}, "", "/#relay-pair=not_valid%25");
    expect(() => consumeRelayPairingFromUrl()).toThrow(RelayPairingLinkError);
    expect(window.location.hash).toBe("");
  });

  test("rejects insecure remote relay endpoints", () => {
    window.history.replaceState({}, "", `/#relay-pair=${encode({ ...pairing, relayUrl: "ws://relay.example" })}`);
    expect(() => consumeRelayPairingFromUrl()).toThrow(/trusted relay URL/i);
  });
});
