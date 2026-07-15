import { describe, expect, test } from "vitest";
import {
  createRelayHandshakeHello,
  establishRelayChannel,
  generateRelayIdentity,
  verifyRelayHandshakeHello,
} from "../src/relay-crypto.js";
import {
  BrowserRelayCryptoError,
  createBrowserRelayHandshakeHello,
  establishBrowserRelayChannel,
  generateBrowserRelayIdentity,
  verifyBrowserRelayHandshakeHello,
} from "../../web/src/relay/crypto.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

describe("browser and host relay crypto interoperability", () => {
  test("exchanges signed P-256 handshakes and AES-GCM traffic in both directions", async () => {
    const now = 4_000_000;
    const deviceIdentity = await generateBrowserRelayIdentity();
    const hostIdentity = generateRelayIdentity();
    const device = await createBrowserRelayHandshakeHello({
      role: "device",
      routeId: "route-interop",
      deviceId: "device-browser",
      identity: deviceIdentity,
      issuedAt: now,
    });
    const host = createRelayHandshakeHello({
      role: "host",
      routeId: "route-interop",
      deviceId: "device-browser",
      sessionId: device.hello.sessionId,
      identity: hostIdentity,
      issuedAt: now,
    });

    verifyRelayHandshakeHello(device.hello, {
      role: "device",
      routeId: "route-interop",
      deviceId: "device-browser",
      sessionId: device.hello.sessionId,
      identityPublicKey: deviceIdentity.publicKey,
      now,
    });
    await verifyBrowserRelayHandshakeHello(host.hello, {
      role: "host",
      routeId: "route-interop",
      deviceId: "device-browser",
      sessionId: device.hello.sessionId,
      identityPublicKey: hostIdentity.publicKey,
      now,
    });

    const browserChannel = await establishBrowserRelayChannel({
      role: "device",
      localEphemeral: device.ephemeral,
      deviceHello: device.hello,
      hostHello: host.hello,
      deviceIdentityPublicKey: deviceIdentity.publicKey,
      hostIdentityPublicKey: hostIdentity.publicKey,
      now: () => now,
    });
    const hostChannel = establishRelayChannel({
      role: "host",
      localEphemeral: host.ephemeral,
      deviceHello: device.hello,
      hostHello: host.hello,
      deviceIdentityPublicKey: deviceIdentity.publicKey,
      hostIdentityPublicKey: hostIdentity.publicKey,
      now: () => now,
    });

    const request = await browserChannel.encrypt("rpc-request", encoder.encode("browser-to-host"));
    expect(hostChannel.decrypt(request).toString()).toBe("browser-to-host");
    const response = hostChannel.encrypt("rpc-response", Buffer.from("host-to-browser"));
    expect(decoder.decode(await browserChannel.decrypt(response))).toBe("host-to-browser");
    expect(browserChannel.sequences()).toEqual({ send: "1", receive: "1" });
    expect(hostChannel.sequences()).toEqual({ send: "1", receive: "1" });
  });

  test("keeps the browser identity private key non-extractable and rejects a false host pin", async () => {
    const deviceIdentity = await generateBrowserRelayIdentity();
    expect(deviceIdentity.privateKey.extractable).toBe(false);
    await expect(crypto.subtle.exportKey("pkcs8", deviceIdentity.privateKey)).rejects.toThrow();

    const host = generateRelayIdentity();
    const unrelated = generateRelayIdentity();
    const device = await createBrowserRelayHandshakeHello({
      role: "device",
      routeId: "route-pin",
      deviceId: "device-pin",
      identity: deviceIdentity,
    });
    const hostHello = createRelayHandshakeHello({
      role: "host",
      routeId: "route-pin",
      deviceId: "device-pin",
      sessionId: device.hello.sessionId,
      identity: host,
    });
    await expect(
      verifyBrowserRelayHandshakeHello(hostHello.hello, {
        role: "host",
        routeId: "route-pin",
        deviceId: "device-pin",
        sessionId: device.hello.sessionId,
        identityPublicKey: unrelated.publicKey,
      }),
    ).rejects.toMatchObject<Partial<BrowserRelayCryptoError>>({ code: "RELAY_IDENTITY_MISMATCH" });
  });
});
