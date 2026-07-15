import { describe, expect, test, vi } from "vitest";
import { createRelayDeviceProvisioner } from "../src/relay-provision.js";

const HOST_CREDENTIAL = `rrh_${"h".repeat(43)}`;
const CREDENTIAL_HASH = `sha256:${"d".repeat(43)}`;

describe("relay device provisioner", () => {
  test("keeps host credentials out of URLs and provisions bounded bootstrap expiry", async () => {
    const request = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    const provisioner = createRelayDeviceProvisioner({
      relayUrl: "wss://relay.example/v1/connect",
      routeId: "route-1",
      hostCredential: HOST_CREDENTIAL,
      request,
    });
    await provisioner.putDevice("device-1", CREDENTIAL_HASH, 1234);

    const [url, init] = request.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://relay.example/v1/routes/route-1/devices/device-1");
    expect(url).not.toContain(HOST_CREDENTIAL);
    expect(init.headers).toMatchObject({ authorization: `Bearer ${HOST_CREDENTIAL}` });
    expect(JSON.parse(String(init.body))).toEqual({ credentialHash: CREDENTIAL_HASH, expiresAt: 1234 });
  });

  test("promotes by omitting expiry and treats an already-absent revoke as success", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "not found" }), { status: 404 }));
    const provisioner = createRelayDeviceProvisioner({
      relayUrl: "https://relay.example",
      routeId: "route-1",
      hostCredential: HOST_CREDENTIAL,
      request,
    });
    await provisioner.putDevice("device-1", CREDENTIAL_HASH);
    await expect(provisioner.revokeDevice("device-1")).resolves.toBeUndefined();
    expect(JSON.parse(String(request.mock.calls[0]![1].body))).toEqual({ credentialHash: CREDENTIAL_HASH });
  });
});
