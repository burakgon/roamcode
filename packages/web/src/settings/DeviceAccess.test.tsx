import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ApiError, type ApiClient } from "../api/client";
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
    getRelayStatus: vi.fn().mockResolvedValue({
      configured: true,
      pairingAvailable: true,
      status: "online",
      activeDevices: 1,
      reconnects: 0,
    }),
    renameDevice: vi.fn().mockResolvedValue({ id: "phone", name: "Travel phone", createdAt: 1, lastSeenAt: 1 }),
    startPairing: vi.fn().mockResolvedValue({
      secret: `rcp_${"a".repeat(43)}`,
      expiresAt: Date.now() + 300_000,
      scopes: ["direct"],
    }),
    cancelPairing: vi.fn().mockResolvedValue(undefined),
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
    cancelRelayPairing: vi.fn().mockResolvedValue(undefined),
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
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(api.cancelPairing).toHaveBeenCalledWith(`rcp_${"a".repeat(43)}`));
    expect(screen.queryByText(/#pair=rcp_/i)).not.toBeInTheDocument();
  });

  test("creates an encrypted remote pairing link with explicit relay trust copy", async () => {
    const api = apiStub();
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    render(<DeviceAccess api={api} />);
    await screen.findByText("RoamCode on iPhone");
    await userEvent.click(screen.getByRole("button", { name: /pair remotely/i }));

    expect(await screen.findByAltText(/encrypted remote roamcode access/i)).toBeVisible();
    expect(screen.getByText(/scan from any network/i)).toBeVisible();
    expect(screen.getByText(/relay routes encrypted bytes and cannot read prompts/i)).toBeVisible();
    expect(screen.getByText(/#relay-pair=/i)).toBeVisible();
    expect(api.startRelayPairing).toHaveBeenCalledOnce();
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "start" }));
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(api.cancelRelayPairing).toHaveBeenCalledWith("remote-phone"));
    expect(screen.queryByText(/#relay-pair=/i)).not.toBeInTheDocument();
  });

  test("keeps a remote pairing link visible while another cancellation is in progress", async () => {
    const api = apiStub({
      cancelRelayPairing: vi
        .fn()
        .mockRejectedValue(
          new ApiError(409, "Relay pairing cancellation is already in progress", "RELAY_PAIRING_CANCEL_IN_PROGRESS"),
        ),
    });
    render(<DeviceAccess api={api} />);
    await screen.findByText("RoamCode on iPhone");
    await userEvent.click(screen.getByRole("button", { name: /pair remotely/i }));
    expect(await screen.findByText(/scan from any network/i)).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(await screen.findByText(/another cancellation is already in progress/i)).toBeVisible();
    expect(screen.getByText(/scan from any network/i)).toBeVisible();
    expect(screen.getByText(/#relay-pair=/i)).toBeVisible();
  });

  test("shows relay health and prevents a dead-end pairing attempt before host setup", async () => {
    const api = apiStub({
      getRelayStatus: vi.fn().mockResolvedValue({
        configured: false,
        pairingAvailable: false,
        status: "not-configured",
        activeDevices: 0,
        reconnects: 0,
      }),
    });
    render(<DeviceAccess api={api} />);

    expect(await screen.findByText("Not connected")).toBeVisible();
    expect(screen.getByText(/run roamcode cloud connect on this host/i)).toBeVisible();
    expect(screen.getByRole("button", { name: "Connect on host" })).toBeDisabled();
    expect(api.startRelayPairing).not.toHaveBeenCalled();
  });

  test("keeps remote pairing disabled until relay health is known", async () => {
    const api = apiStub({ getRelayStatus: vi.fn().mockRejectedValue(new Error("temporarily unavailable")) });
    render(<DeviceAccess api={api} />);

    expect(await screen.findByText("Checking")).toBeVisible();
    expect(screen.getByText(/checking this host's cloud relay status/i)).toBeVisible();
    expect(screen.getByRole("button", { name: "Checking…" })).toBeDisabled();
    expect(api.startRelayPairing).not.toHaveBeenCalled();
  });

  test("stops presenting stale relay health after repeated status failures", async () => {
    vi.useFakeTimers();
    const getRelayStatus = vi
      .fn()
      .mockResolvedValueOnce({
        configured: true,
        pairingAvailable: true,
        status: "online",
        activeDevices: 1,
        reconnects: 0,
      })
      .mockRejectedValue(new Error("relay status unavailable"));
    const view = render(<DeviceAccess api={apiStub({ getRelayStatus })} />);

    try {
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(screen.getByText("Online")).toBeVisible();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(20_000);
      });
      expect(screen.getByText("Unavailable")).toBeVisible();
      expect(screen.getByText(/couldn't refresh this host's relay status/i)).toBeVisible();
      expect(screen.getByRole("button", { name: "Status unavailable" })).toBeDisabled();
    } finally {
      view.unmount();
      vi.useRealTimers();
    }
  });

  test("keeps relay health live while settings remain open", async () => {
    vi.useFakeTimers();
    const getRelayStatus = vi
      .fn()
      .mockResolvedValueOnce({
        configured: true,
        pairingAvailable: true,
        status: "connecting",
        activeDevices: 0,
        reconnects: 0,
      })
      .mockResolvedValueOnce({
        configured: true,
        pairingAvailable: true,
        status: "online",
        activeDevices: 2,
        reconnects: 0,
      });
    const view = render(<DeviceAccess api={apiStub({ getRelayStatus })} />);

    try {
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(screen.getByText("Connecting")).toBeVisible();
      expect(screen.getByRole("button", { name: "Relay connecting" })).toBeDisabled();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      expect(screen.getByText("Online")).toBeVisible();
      expect(screen.getByRole("button", { name: "Pair remotely" })).toBeEnabled();
      expect(screen.getByText(/2 active remote devices/i)).toBeVisible();
      expect(getRelayStatus).toHaveBeenCalledTimes(2);
    } finally {
      view.unmount();
      vi.useRealTimers();
    }
  });

  test("does not spend a one-use link while the relay is reconnecting", async () => {
    const api = apiStub({
      getRelayStatus: vi.fn().mockResolvedValue({
        configured: true,
        pairingAvailable: true,
        status: "reconnecting",
        activeDevices: 0,
        reconnects: 2,
      }),
    });
    render(<DeviceAccess api={api} />);

    expect(await screen.findByText("Reconnecting")).toBeVisible();
    expect(screen.getByText(/new pairing will unlock when it is online/i)).toBeVisible();
    expect(screen.getByRole("button", { name: "Relay reconnecting" })).toBeDisabled();
    expect(api.startRelayPairing).not.toHaveBeenCalled();
  });

  test("shows a configured but stopped relay as offline and blocks pairing", async () => {
    const api = apiStub({
      getRelayStatus: vi.fn().mockResolvedValue({
        configured: true,
        pairingAvailable: true,
        status: "stopped",
        activeDevices: 0,
        reconnects: 1,
      }),
    });
    render(<DeviceAccess api={api} />);

    expect(await screen.findByText("Offline")).toBeVisible();
    expect(screen.getByText(/restart roamcode on the host/i)).toBeVisible();
    expect(screen.getByRole("button", { name: "Relay offline" })).toBeDisabled();
    expect(api.startRelayPairing).not.toHaveBeenCalled();
  });

  test("explains when the connector exists but remote pairing setup is incomplete", async () => {
    const api = apiStub({
      getRelayStatus: vi.fn().mockResolvedValue({
        configured: true,
        pairingAvailable: false,
        status: "online",
        activeDevices: 0,
        reconnects: 0,
      }),
    });
    render(<DeviceAccess api={api} />);

    expect(await screen.findByText("Setup incomplete")).toHaveClass("rc-devices__cloud-state--setup-incomplete");
    expect(screen.getByText(/remote pairing needs a trusted app URL/i)).toBeVisible();
    expect(screen.getByText(/roamcode cloud configure --app-url/i)).toBeVisible();
    expect(screen.getByRole("button", { name: "Finish on host" })).toBeDisabled();
    expect(api.startRelayPairing).not.toHaveBeenCalled();
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
