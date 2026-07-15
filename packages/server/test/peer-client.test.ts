import { describe, expect, test, vi } from "vitest";
import {
  claimPeerPairing,
  parsePeerPairingUrl,
  PeerRequestError,
  requestPeerJson,
  revokeClaimedPeerDevice,
  verifyPeerConnection,
} from "../src/peer-client.js";

const connection = {
  baseUrl: "https://peer.example.test",
  credential: `rcd_${"p".repeat(43)}`,
};

describe("peer client", () => {
  test("claims a one-use pairing fragment without putting it in a request URL", async () => {
    const secret = `rcp_${"s".repeat(43)}`;
    const token = `rcd_${"d".repeat(43)}`;
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Promise.resolve(
        new Response(JSON.stringify({ token, device: { id: "device-peer" } }), {
          status: 201,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    await expect(
      claimPeerPairing({
        pairingUrl: `https://peer.example.test/#pair=${secret}`,
        deviceName: "RoamCode peer · Local host",
        fetch,
      }),
    ).resolves.toEqual({ baseUrl: "https://peer.example.test", credential: token, deviceId: "device-peer" });
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe("https://peer.example.test/pairing/claim");
    expect(String(url)).not.toContain(secret);
    expect(JSON.parse(String(init?.body))).toEqual({ secret, name: "RoamCode peer · Local host" });
    expect(init?.redirect).toBe("error");
  });

  test("rejects malformed or non-secure pairing links", () => {
    const secret = `rcp_${"s".repeat(43)}`;
    expect(parsePeerPairingUrl(`https://peer.example.test/#pair=${secret}`)).toEqual({
      baseUrl: "https://peer.example.test",
      secret,
    });
    for (const value of [
      `http://peer.example.test/#pair=${secret}`,
      `https://peer.example.test/path#pair=${secret}`,
      `https://peer.example.test/?from=mail#pair=${secret}`,
      `https://peer.example.test/#pair=${secret}&extra=1`,
      "https://peer.example.test/#pair=short",
    ]) {
      expect(() => parsePeerPairingUrl(value)).toThrow(/invalid peer pairing link/);
    }
  });

  test("can revoke a claimed device during failed setup without exposing the credential", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(null, { status: 204 }));
    await expect(
      revokeClaimedPeerDevice({
        baseUrl: connection.baseUrl,
        credential: connection.credential,
        deviceId: "device-peer",
        fetch,
      }),
    ).resolves.toBe(true);
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe("https://peer.example.test/devices/device-peer");
    expect(String(url)).not.toContain(connection.credential);
    expect((init?.headers as Record<string, string>).authorization).toBe(`Bearer ${connection.credential}`);
  });

  test("verifies a v1 peer with bearer auth only in the header", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response(
          JSON.stringify({
            protocolVersion: 1,
            serverVersion: "1.2.3",
            host: { id: "host-remote", label: "Remote build" },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    await expect(verifyPeerConnection({ ...connection, localHostId: "host-local", fetch })).resolves.toMatchObject({
      remoteHostId: "host-remote",
      remoteVersion: "1.2.3",
    });
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe("https://peer.example.test/api/v1/capabilities");
    expect(String(url)).not.toContain(connection.credential);
    expect((init?.headers as Record<string, string>).authorization).toBe(`Bearer ${connection.credential}`);
    expect(init?.redirect).toBe("error");
  });

  test("rejects self-peering and incompatible protocols", async () => {
    const response = (protocolVersion: number, id: string) =>
      vi.fn<typeof globalThis.fetch>(
        async () =>
          new Response(JSON.stringify({ protocolVersion, serverVersion: "1.2.3", host: { id, label: "Peer" } }), {
            status: 200,
          }),
      );
    await expect(
      verifyPeerConnection({ ...connection, localHostId: "same", fetch: response(1, "same") }),
    ).rejects.toThrow(/cannot register itself/);
    await expect(
      verifyPeerConnection({ ...connection, localHostId: "local", fetch: response(2, "remote") }),
    ).rejects.toThrow(/incompatible/);
  });

  test("bounds responses and never echoes arbitrary proxy HTML", async () => {
    const oversized = vi.fn<typeof globalThis.fetch>(
      async () => new Response("{}", { status: 200, headers: { "content-length": String(3 * 1024 * 1024) } }),
    );
    await expect(requestPeerJson(connection, "/api/v1/agents", { fetch: oversized })).rejects.toThrow(/oversized/);

    const proxy = vi.fn<typeof globalThis.fetch>(
      async () => new Response("<html>private upstream page</html>", { status: 502 }),
    );
    try {
      await requestPeerJson(connection, "/api/v1/agents", { fetch: proxy });
      throw new Error("expected request to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(PeerRequestError);
      expect((error as Error).message).not.toContain("private upstream page");
    }
  });

  test("forwards a derived idempotency key without forwarding ambient headers", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () => new Response(JSON.stringify({ accepted: true, focused: false }), { status: 202 }),
    );
    await expect(
      requestPeerJson(connection, "/api/v1/sessions/session-1/input", {
        method: "POST",
        body: { data: "continue" },
        idempotencyKey: "peer-derived-key",
        fetch,
      }),
    ).resolves.toMatchObject({ status: 202, body: { accepted: true, focused: false } });
    const headers = fetch.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers["idempotency-key"]).toBe("peer-derived-key");
    expect(headers.cookie).toBeUndefined();
    expect(headers.origin).toBeUndefined();
  });
});
