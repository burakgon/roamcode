import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { ApiClient } from "../api/client";
import { DeviceAccess } from "./DeviceAccess";

afterEach(() => vi.unstubAllGlobals());

function apiStub(overrides: Partial<ApiClient> = {}): ApiClient {
  return {
    listDevices: vi.fn().mockResolvedValue({
      currentDeviceId: "phone",
      devices: [
        { id: "phone", name: "RoamCode on iPhone", createdAt: 1, lastSeenAt: Date.now() },
        { id: "laptop", name: "RoamCode on Mac", createdAt: 1, lastSeenAt: Date.now() - 60_000 },
      ],
    }),
    renameDevice: vi.fn().mockResolvedValue({ id: "phone", name: "Travel phone", createdAt: 1, lastSeenAt: 1 }),
    startPairing: vi.fn().mockResolvedValue({
      secret: `rcp_${"a".repeat(43)}`,
      expiresAt: Date.now() + 300_000,
      scopes: ["direct"],
    }),
    startRelayPairing: vi.fn().mockResolvedValue({
      url: `https://app.roamcode.example/#relay-pair=${"x".repeat(120)}`,
      pairing: {
        v: 1,
        label: "Studio",
        relayUrl: "wss://relay.roamcode.example/v1/connect",
        routeId: "route-1",
        deviceId: "remote-phone",
        deviceCredential: `rrd_${"d".repeat(43)}`,
        deviceToken: `rcd_${"t".repeat(43)}`,
        pairingSecret: `rcp_${"p".repeat(43)}`,
        expiresAt: Date.now() + 300_000,
        hostIdentityPublicKey: "a".repeat(100),
        hostIdentityFingerprint: `sha256:${"h".repeat(43)}`,
      },
    }),
    revokeDevice: vi.fn().mockResolvedValue(undefined),
    resetAccess: vi.fn().mockResolvedValue({ token: "new-host-token", revokedDevices: 2 }),
    ...overrides,
  } as unknown as ApiClient;
}

describe("DeviceAccess", () => {
  test("shows the current device and lets another device be revoked", async () => {
    const api = apiStub();
    render(<DeviceAccess api={api} />);

    expect(await screen.findByText("RoamCode on iPhone")).toBeVisible();
    expect(screen.getByText("this device")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Revoke" }));
    expect(api.revokeDevice).not.toHaveBeenCalled();
    expect(screen.getByText(/lose terminal and notification access immediately/i)).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Revoke RoamCode on Mac" }));
    await waitFor(() => expect(api.revokeDevice).toHaveBeenCalledWith("laptop"));
  });

  test("creates a scannable, expiring one-use pairing link", async () => {
    const api = apiStub();
    render(<DeviceAccess api={api} />);
    await screen.findByText("RoamCode on iPhone");
    await userEvent.click(screen.getByRole("button", { name: /pair another device/i }));

    expect(await screen.findByAltText(/qr code for pairing/i)).toBeVisible();
    expect(screen.getByText(/one use · expires in/i)).toBeVisible();
    expect(screen.getByText(/never grants provider credentials/i)).toBeVisible();
    await waitFor(() => expect(screen.getByText(/#pair=rcp_/i)).toBeVisible());
    expect(api.startPairing).toHaveBeenCalledOnce();
  });

  test("creates an encrypted remote pairing link with explicit relay trust copy", async () => {
    const api = apiStub();
    render(<DeviceAccess api={api} />);
    await screen.findByText("RoamCode on iPhone");
    await userEvent.click(screen.getByRole("button", { name: /pair remotely/i }));

    expect(await screen.findByAltText(/encrypted remote roamcode access/i)).toBeVisible();
    expect(screen.getByText(/scan from any network/i)).toBeVisible();
    expect(screen.getByText(/relay routes encrypted bytes and cannot read prompts/i)).toBeVisible();
    expect(screen.getByText(/#relay-pair=/i)).toBeVisible();
    expect(api.startRelayPairing).toHaveBeenCalledOnce();
  });

  test("renames and self-unpairs the current device", async () => {
    const api = apiStub();
    const onUnpaired = vi.fn();
    render(<DeviceAccess api={api} onUnpaired={onUnpaired} />);
    await screen.findByText("RoamCode on iPhone");

    await userEvent.click(screen.getAllByRole("button", { name: "Rename" })[0]!);
    const input = screen.getByRole("textbox", { name: "Rename RoamCode on iPhone" });
    await userEvent.clear(input);
    await userEvent.type(input, "Travel phone");
    await userEvent.click(screen.getByRole("button", { name: "Save RoamCode on iPhone" }));
    await waitFor(() => expect(api.renameDevice).toHaveBeenCalledWith("phone", "Travel phone"));

    await userEvent.click(screen.getByRole("button", { name: "Unpair" }));
    expect(api.revokeDevice).not.toHaveBeenCalledWith("phone");
    await userEvent.click(screen.getByRole("button", { name: "Unpair RoamCode on iPhone" }));
    await waitFor(() => expect(api.revokeDevice).toHaveBeenCalledWith("phone"));
    expect(onUnpaired).toHaveBeenCalledTimes(1);
  });

  test("offers a typed full recovery reset only to the host credential", async () => {
    const api = apiStub({ listDevices: vi.fn().mockResolvedValue({ devices: [] }) });
    const onTokenChanged = vi.fn();
    render(<DeviceAccess api={api} onTokenChanged={onTokenChanged} />);

    await userEvent.click(await screen.findByRole("button", { name: "Reset all access" }));
    const reset = screen.getByRole("button", { name: "Reset access now" });
    expect(reset).toBeDisabled();
    await userEvent.type(screen.getByRole("textbox", { name: /type reset to continue/i }), "RESET");
    await userEvent.click(reset);
    await waitFor(() => expect(api.resetAccess).toHaveBeenCalledTimes(1));
    expect(onTokenChanged).toHaveBeenCalledWith("new-host-token");
    expect(screen.getByText(/2 devices revoked/i)).toBeVisible();
  });

  test("upgrades a legacy browser to its own revocable key in one tap", async () => {
    const api = apiStub({
      listDevices: vi.fn().mockResolvedValue({ devices: [] }),
    });
    const onTokenChanged = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            token: "device-token",
            device: { id: "browser", name: "Browser", createdAt: 1, lastSeenAt: 1 },
          }),
          { status: 201, headers: { "content-type": "application/json" } },
        ),
      ),
    );
    render(<DeviceAccess api={api} onTokenChanged={onTokenChanged} />);

    await userEvent.click(await screen.findByRole("button", { name: /make revocable/i }));
    await waitFor(() => expect(onTokenChanged).toHaveBeenCalledWith("device-token"));
    expect(screen.getByText(/now has its own revocable key/i)).toBeVisible();
  });
});
