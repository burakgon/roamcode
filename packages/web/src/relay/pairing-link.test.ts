import { afterEach, describe, expect, test } from "vitest";
import { generateBrowserRelayDeviceCredential } from "./client";
import {
  clearRelayPairingAttempt,
  consumeOrResumeRelayPairingAttempt,
  consumeRelayPairingFromUrl,
  RelayPairingLinkError,
  type RelayPairingPackage,
} from "./pairing-link";

const pairing: RelayPairingPackage = {
  v: 1,
  label: "Studio",
  relayUrl: "wss://relay.example/v1/connect",
  routeId: "route-1",
  deviceId: "device-1",
  deviceCredential: `rrd_${"d".repeat(43)}`,
  deviceToken: `rcd_${"t".repeat(43)}`,
  pairingSecret: `rcp_${"p".repeat(43)}`,
  expiresAt: Date.now() + 5 * 60_000,
  hostIdentityPublicKey: "a".repeat(100),
  hostIdentityFingerprint: `sha256:${"h".repeat(43)}`,
};

function encode(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

afterEach(() => {
  sessionStorage.clear();
  window.history.replaceState({}, "", "/");
});

describe("relay pairing links", () => {
  test("creates a distinct durable routing capability outside the link package", () => {
    const first = generateBrowserRelayDeviceCredential();
    const second = generateBrowserRelayDeviceCredential();
    expect(first).toMatch(/^rrd_[A-Za-z0-9_-]{43}$/);
    expect(second).toMatch(/^rrd_[A-Za-z0-9_-]{43}$/);
    expect(first).not.toBe(second);
    expect(first).not.toBe(pairing.deviceCredential);
  });

  test("consumes a strict fragment package without leaving secrets in history", () => {
    window.history.replaceState({}, "", `/?session=s1#relay-pair=${encode(pairing)}&view=compact`);
    expect(consumeRelayPairingFromUrl()).toEqual(pairing);
    expect(window.location.search).toBe("?session=s1");
    expect(window.location.hash).toBe("#view=compact");
  });

  test("resumes the same short-lived attempt after a reload and clears it explicitly", () => {
    window.history.replaceState({}, "", `/#relay-pair=${encode(pairing)}`);
    const first = consumeOrResumeRelayPairingAttempt(Date.now());
    expect(first?.pairing).toEqual(pairing);
    expect(first?.durableDeviceCredential).toMatch(/^rrd_[A-Za-z0-9_-]{43}$/);
    expect(first?.durableDeviceCredential).not.toBe(pairing.deviceCredential);
    expect(window.location.hash).toBe("");

    const resumed = consumeOrResumeRelayPairingAttempt(Date.now());
    expect(resumed).toEqual(first);

    clearRelayPairingAttempt();
    expect(consumeOrResumeRelayPairingAttempt(Date.now())).toBeUndefined();
  });

  test("drops expired, malformed, and bootstrap-reusing pending attempts", () => {
    const key = "roamcode.relay-pairing.pending.v1";
    sessionStorage.setItem(
      key,
      JSON.stringify({
        pairing: { ...pairing, expiresAt: Date.now() - 1 },
        durableDeviceCredential: `rrd_${"z".repeat(43)}`,
      }),
    );
    expect(consumeOrResumeRelayPairingAttempt(Date.now())).toBeUndefined();
    expect(sessionStorage.getItem(key)).toBeNull();

    sessionStorage.setItem(key, "{not-json");
    expect(consumeOrResumeRelayPairingAttempt(Date.now())).toBeUndefined();
    expect(sessionStorage.getItem(key)).toBeNull();

    sessionStorage.setItem(key, JSON.stringify({ pairing, durableDeviceCredential: pairing.deviceCredential }));
    expect(consumeOrResumeRelayPairingAttempt(Date.now())).toBeUndefined();
    expect(sessionStorage.getItem(key)).toBeNull();
  });

  test("does not restore a stale attempt when a malformed new link is opened", () => {
    window.history.replaceState({}, "", `/#relay-pair=${encode(pairing)}`);
    expect(consumeOrResumeRelayPairingAttempt(Date.now())).toBeDefined();
    window.history.replaceState({}, "", "/#relay-pair=not-valid-json");
    expect(() => consumeOrResumeRelayPairingAttempt(Date.now())).toThrow(RelayPairingLinkError);
    expect(sessionStorage.getItem("roamcode.relay-pairing.pending.v1")).toBeNull();
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

  test("accepts the complete IPv4 loopback block for isolated relay development", () => {
    window.history.replaceState(
      {},
      "",
      `/#relay-pair=${encode({ ...pairing, relayUrl: "ws://127.0.0.2:4281/v1/connect" })}`,
    );
    expect(consumeRelayPairingFromUrl()).toMatchObject({ relayUrl: "ws://127.0.0.2:4281/v1/connect" });
  });

  test("rejects misleading direction controls in a host label", () => {
    window.history.replaceState({}, "", `/#relay-pair=${encode({ ...pairing, label: "Studio\u202Etxt.exe" })}`);
    expect(() => consumeRelayPairingFromUrl()).toThrow(RelayPairingLinkError);
  });
});
