import { describe, expect, test } from "vitest";
import {
  createRelayHandshakeHello,
  establishRelayChannel,
  generateRelayIdentity,
  hkdfSha256,
  RelayCryptoError,
  validateRelayIdentity,
  type RelayEncryptedFrame,
  type RelayHandshakeHello,
} from "../src/relay-crypto.js";

function errorCode(action: () => unknown): string | undefined {
  try {
    action();
  } catch (error) {
    return error instanceof RelayCryptoError ? error.code : undefined;
  }
  return undefined;
}

function channelPair(options: { now?: number; maxFrames?: number } = {}) {
  const now = options.now ?? 1_000_000;
  const deviceIdentity = generateRelayIdentity();
  const hostIdentity = generateRelayIdentity();
  const device = createRelayHandshakeHello({
    role: "device",
    routeId: "route-1",
    deviceId: "device-1",
    identity: deviceIdentity,
    issuedAt: now,
  });
  const host = createRelayHandshakeHello({
    role: "host",
    routeId: "route-1",
    deviceId: "device-1",
    sessionId: device.hello.sessionId,
    identity: hostIdentity,
    issuedAt: now,
  });
  const shared = {
    deviceHello: device.hello,
    hostHello: host.hello,
    deviceIdentityPublicKey: deviceIdentity.publicKey,
    hostIdentityPublicKey: hostIdentity.publicKey,
    now: () => now,
    ...(options.maxFrames ? { maxFrames: options.maxFrames } : {}),
  };
  return {
    deviceIdentity,
    hostIdentity,
    deviceHello: device.hello,
    hostHello: host.hello,
    device: establishRelayChannel({ role: "device", localEphemeral: device.ephemeral, ...shared }),
    host: establishRelayChannel({ role: "host", localEphemeral: host.ephemeral, ...shared }),
  };
}

describe("relay cryptographic protocol", () => {
  test("validates that persisted relay key material is one matching identity", () => {
    const identity = generateRelayIdentity();
    expect(validateRelayIdentity(identity)).toEqual(identity);
    const unrelated = generateRelayIdentity();
    expect(errorCode(() => validateRelayIdentity({ ...identity, privateKey: unrelated.privateKey }))).toBe(
      "INVALID_RELAY_IDENTITY",
    );
    expect(errorCode(() => validateRelayIdentity({ ...identity, fingerprint: unrelated.fingerprint }))).toBe(
      "INVALID_RELAY_IDENTITY",
    );
  });

  test("matches RFC 5869 HKDF-SHA-256 test case 1", () => {
    const output = hkdfSha256(
      Buffer.from("0b".repeat(22), "hex"),
      Buffer.from("000102030405060708090a0b0c", "hex"),
      Buffer.from("f0f1f2f3f4f5f6f7f8f9", "hex"),
      42,
    );
    expect(output.toString("hex")).toBe(
      "3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865",
    );
  });

  test("derives independent directional keys and hides application plaintext from the relay", () => {
    const pair = channelPair();
    const request = pair.device.encrypt("rpc-request", Buffer.from("private-terminal-marker"));
    expect(JSON.stringify(request)).not.toContain("private-terminal-marker");
    expect(pair.host.decrypt(request).toString()).toBe("private-terminal-marker");
    const response = pair.host.encrypt("rpc-response", Buffer.from('{"status":200}'));
    expect(pair.device.decrypt(response).toString()).toBe('{"status":200}');
    expect(pair.device.sequences()).toEqual({ send: "1", receive: "1" });
    expect(pair.host.sequences()).toEqual({ send: "1", receive: "1" });
  });

  test("rejects tampering without advancing receive state, then accepts the original frame", () => {
    const pair = channelPair();
    const frame = pair.device.encrypt("stream-data", Buffer.from("payload"));
    const altered = Buffer.from(frame.ciphertext, "base64url");
    altered[0] = altered[0]! ^ 1;
    const tampered: RelayEncryptedFrame = {
      ...frame,
      ciphertext: altered.toString("base64url"),
    };
    expect(errorCode(() => pair.host.decrypt(tampered))).toBe("RELAY_FRAME_AUTH_FAILED");
    expect(pair.host.sequences().receive).toBe("0");
    expect(pair.host.decrypt(frame).toString()).toBe("payload");
  });

  test("fails closed on replay, skipped sequence, wrong session, and AAD kind changes", () => {
    const pair = channelPair();
    const first = pair.device.encrypt("stream-data", Buffer.from("one"));
    expect(pair.host.decrypt(first).toString()).toBe("one");
    expect(errorCode(() => pair.host.decrypt(first))).toBe("RELAY_FRAME_OUT_OF_ORDER");

    const second = pair.device.encrypt("stream-data", Buffer.from("two"));
    expect(errorCode(() => pair.host.decrypt({ ...second, seq: "3" }))).toBe("RELAY_FRAME_OUT_OF_ORDER");
    expect(errorCode(() => pair.host.decrypt({ ...second, sessionId: "another-session" }))).toBe("RELAY_FRAME_INVALID");
    expect(errorCode(() => pair.host.decrypt({ ...second, kind: "rpc-request" }))).toBe("RELAY_FRAME_AUTH_FAILED");
    expect(pair.host.decrypt(second).toString()).toBe("two");
  });

  test("pins identities, roles, context, signatures, and the handshake clock", () => {
    const pair = channelPair();
    const unrelated = generateRelayIdentity();
    expect(
      errorCode(() =>
        establishRelayChannel({
          role: "device",
          localEphemeral: createRelayHandshakeHello({
            role: "device",
            routeId: "route-1",
            deviceId: "device-1",
            sessionId: pair.deviceHello.sessionId,
            identity: pair.deviceIdentity,
            issuedAt: 1_000_000,
          }).ephemeral,
          deviceHello: pair.deviceHello,
          hostHello: pair.hostHello,
          deviceIdentityPublicKey: pair.deviceIdentity.publicKey,
          hostIdentityPublicKey: unrelated.publicKey,
          now: () => 1_000_000,
        }),
      ),
    ).toBe("RELAY_IDENTITY_MISMATCH");

    const altered: RelayHandshakeHello = { ...pair.deviceHello, routeId: "route-2" };
    expect(
      errorCode(() =>
        establishRelayChannel({
          role: "host",
          localEphemeral: createRelayHandshakeHello({
            role: "host",
            routeId: "route-1",
            deviceId: "device-1",
            sessionId: pair.deviceHello.sessionId,
            identity: pair.hostIdentity,
            issuedAt: 1_000_000,
          }).ephemeral,
          deviceHello: altered,
          hostHello: pair.hostHello,
          deviceIdentityPublicKey: pair.deviceIdentity.publicKey,
          hostIdentityPublicKey: pair.hostIdentity.publicKey,
          now: () => 1_000_000,
        }),
      ),
    ).toBe("RELAY_HANDSHAKE_MISMATCH");

    const stale = channelPair({ now: 1_000_000 });
    expect(
      errorCode(() =>
        establishRelayChannel({
          role: "device",
          localEphemeral: createRelayHandshakeHello({
            role: "device",
            routeId: "route-1",
            deviceId: "device-1",
            sessionId: stale.deviceHello.sessionId,
            identity: stale.deviceIdentity,
            issuedAt: 1_000_000,
          }).ephemeral,
          deviceHello: stale.deviceHello,
          hostHello: stale.hostHello,
          deviceIdentityPublicKey: stale.deviceIdentity.publicKey,
          hostIdentityPublicKey: stale.hostIdentity.publicKey,
          now: () => 2_000_000,
        }),
      ),
    ).toBe("RELAY_HANDSHAKE_EXPIRED");
  });

  test("requires scheduled rotation and unrelated fresh ephemeral sessions", () => {
    const first = channelPair({ maxFrames: 2 });
    const a = first.device.encrypt("rpc-request", Buffer.from("same"));
    first.device.encrypt("rpc-request", Buffer.from("second"));
    expect(errorCode(() => first.device.encrypt("rpc-request", Buffer.from("third")))).toBe(
      "RELAY_KEY_ROTATION_REQUIRED",
    );

    const second = channelPair({ maxFrames: 2 });
    const b = second.device.encrypt("rpc-request", Buffer.from("same"));
    expect(b.sessionId).not.toBe(a.sessionId);
    expect(b.ciphertext).not.toBe(a.ciphertext);
    first.device.close();
    expect(errorCode(() => first.device.encrypt("close", Buffer.alloc(0)))).toBe("RELAY_CHANNEL_CLOSED");
  });
});
