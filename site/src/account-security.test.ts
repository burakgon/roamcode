import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("./product-capabilities", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./product-capabilities")>()),
  fetchProductLaunchCapabilities: vi.fn(async () => ({ v: 1, account: true, managedTerminal: true })),
}));

import { mountAccountShell } from "./app-shell";

const ORGANIZATION_ID = "00000000-0000-4000-8000-000000000011";
const DEVICE_ONE_ID = "00000000-0000-4000-8000-000000000012";
const DEVICE_TWO_ID = "00000000-0000-4000-8000-000000000013";
const HOST_DEVICE_ID = "00000000-0000-4000-8000-000000000014";

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

function accountApi(
  onDelete: (deviceId: string) => Promise<Response>,
  onListDevices?: (devices: ReadonlyArray<Record<string, unknown>>) => Promise<Response>,
  onListHostDevices?: (devices: ReadonlyArray<Record<string, unknown>>) => Promise<Response>,
  onDeleteHostDevice: (deviceId: string) => Promise<Response> = async () => new Response(null, { status: 204 }),
) {
  const deleted = new Set<string>();
  const deleteIds: string[] = [];
  let deviceReads = 0;
  let hostDeviceReads = 0;
  const deletedHostDevices = new Set<string>();
  const hostDeviceDeleteIds: string[] = [];
  const devices = [
    {
      id: DEVICE_ONE_ID,
      organizationId: ORGANIZATION_ID,
      organizationName: "Example Engineering",
      name: "Laptop CLI",
      platform: "darwin",
      clientId: "roamcode-cli",
      scopes: ["identity", "hosts:write"],
      lastSeenAt: "2026-07-17T09:00:00.000Z",
      revokedAt: null,
      createdAt: "2026-07-17T08:00:00.000Z",
    },
    {
      id: DEVICE_TWO_ID,
      organizationId: ORGANIZATION_ID,
      organizationName: "Example Engineering",
      name: "Tablet CLI",
      platform: "ios",
      clientId: "roamcode-cli",
      scopes: ["identity"],
      lastSeenAt: null,
      revokedAt: null,
      createdAt: "2026-07-17T08:30:00.000Z",
    },
  ];
  const hostDevices = [
    {
      id: HOST_DEVICE_ID,
      organizationId: ORGANIZATION_ID,
      organizationName: "Example Engineering",
      hostId: "00000000-0000-4000-8000-000000000015",
      hostName: "Studio Mac",
      actorId: "device:browser-1",
      label: "Safari on iPad",
      pairedBy: "user-1",
      pairedAt: "2026-07-17T08:45:00.000Z",
      lastSeenAt: "2026-07-17T09:10:00.000Z",
      revokedAt: null,
    },
  ];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(new URL(String(input), location.origin), init);
    const url = new URL(request.url);
    if (url.pathname === "/api/v1/meta/providers") {
      return json({
        email_password: true,
        passkey: false,
        github: false,
        google: false,
        mode: "local_dev",
      });
    }
    if (url.pathname === "/api/auth/get-session") {
      return json({
        session: { id: "session-1" },
        user: { id: "user-1", name: "Ada", email: "ada@example.test", emailVerified: true },
      });
    }
    if (url.pathname === "/api/v1/account/bootstrap") {
      return json({
        user: { id: "user-1", name: "Ada", email: "ada@example.test" },
        contexts: [
          {
            id: ORGANIZATION_ID,
            kind: "organization",
            slug: "example-engineering",
            name: "Example Engineering",
            plan: "free",
            role: "admin",
          },
        ],
      });
    }
    if (url.pathname === `/api/v1/orgs/${ORGANIZATION_ID}/hosts`) return json({ hosts: [] });
    if (url.pathname === `/api/v1/orgs/${ORGANIZATION_ID}/access`) return json({ access: [] });
    if (url.pathname === `/api/v1/orgs/${ORGANIZATION_ID}/members`) {
      return json({
        members: [
          {
            organizationId: ORGANIZATION_ID,
            userId: "user-1",
            role: "admin",
            status: "active",
            name: "Ada",
            email: "ada@example.test",
            joinedAt: "2026-07-17T08:00:00.000Z",
          },
        ],
      });
    }
    if (url.pathname === "/api/v1/auth/devices" && request.method === "GET") {
      deviceReads += 1;
      const activeDevices = devices.filter((device) => !deleted.has(device.id));
      return onListDevices ? onListDevices(activeDevices) : json({ devices: activeDevices });
    }
    if (url.pathname === "/api/v1/account/host-devices" && request.method === "GET") {
      hostDeviceReads += 1;
      const activeDevices = hostDevices.filter((device) => !deletedHostDevices.has(device.id));
      return onListHostDevices ? onListHostDevices(activeDevices) : json({ devices: activeDevices });
    }
    if (url.pathname === "/api/v1/legal/documents") return json({ documents: [] });
    if (url.pathname.startsWith("/api/v1/auth/devices/") && request.method === "DELETE") {
      const deviceId = decodeURIComponent(url.pathname.slice("/api/v1/auth/devices/".length));
      deleteIds.push(deviceId);
      const response = await onDelete(deviceId);
      if (response.ok) deleted.add(deviceId);
      return response;
    }
    if (url.pathname.startsWith("/api/v1/account/host-devices/") && request.method === "DELETE") {
      const deviceId = decodeURIComponent(url.pathname.slice("/api/v1/account/host-devices/".length));
      hostDeviceDeleteIds.push(deviceId);
      const response = await onDeleteHostDevice(deviceId);
      if (response.ok) deletedHostDevices.add(deviceId);
      return response;
    }
    throw new Error(`Unexpected request: ${request.method} ${url.pathname}`);
  });
  return {
    deleteIds,
    hostDeviceDeleteIds,
    fetchMock,
    getDeviceReads: () => deviceReads,
    getHostDeviceReads: () => hostDeviceReads,
  };
}

async function openAccount(): Promise<void> {
  mountAccountShell();
  await vi.waitFor(() => expect(document.body.textContent).toContain("CLI sign-ins"));
}

describe("hosted account security controls", () => {
  beforeEach(() => {
    document.body.replaceChildren();
    document.documentElement.className = "";
    localStorage.clear();
    sessionStorage.clear();
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
    history.replaceState(null, "", `/app/account?context=${ORGANIZATION_ID}`);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("keeps People secondary and revokes a CLI device through an inline two-step flow", async () => {
    let releaseDelete: ((response: Response) => void) | undefined;
    const api = accountApi(
      () =>
        new Promise<Response>((resolve) => {
          releaseDelete = resolve;
        }),
    );
    vi.stubGlobal("fetch", api.fetchMock);
    await openAccount();

    const primaryLabels = Array.from(
      document.querySelectorAll<HTMLElement>(".rc-cloud-primary--bottom [data-route] b"),
      (element) => element.textContent,
    );
    expect(primaryLabels).toEqual(["Sessions", "Automations", "Agents"]);
    const people = document.querySelector<HTMLAnchorElement>('.rc-cloud-admin-entry[data-route="people"]');
    expect(people?.getAttribute("href")).toBe("/app/people");

    document
      .querySelector<HTMLButtonElement>(`[data-action="prepare-device-revoke"][data-device-id="${DEVICE_ONE_ID}"]`)
      ?.click();
    expect(api.deleteIds).toEqual([]);
    expect(document.body.textContent).toContain("Revoke this CLI session?");
    document
      .querySelector<HTMLButtonElement>(`[data-action="cancel-device-revoke"][data-device-id="${DEVICE_ONE_ID}"]`)
      ?.click();
    expect(document.body.textContent).not.toContain("Revoke this CLI session?");
    expect(api.deleteIds).toEqual([]);

    document
      .querySelector<HTMLButtonElement>(`[data-action="prepare-device-revoke"][data-device-id="${DEVICE_ONE_ID}"]`)
      ?.click();
    document
      .querySelector<HTMLButtonElement>(`[data-action="confirm-device-revoke"][data-device-id="${DEVICE_ONE_ID}"]`)
      ?.click();
    await vi.waitFor(() => expect(api.deleteIds).toEqual([DEVICE_ONE_ID]));
    expect(document.body.textContent).toContain("Revoking…");
    const otherDeviceAction = document.querySelector<HTMLButtonElement>(
      `[data-action="prepare-device-revoke"][data-device-id="${DEVICE_TWO_ID}"]`,
    );
    expect(otherDeviceAction?.disabled).toBe(true);
    otherDeviceAction?.click();
    expect(api.deleteIds).toEqual([DEVICE_ONE_ID]);
    expect(
      document.querySelector(`[data-action="confirm-device-revoke"][data-device-id="${DEVICE_TWO_ID}"]`),
    ).toBeNull();

    releaseDelete?.(new Response(null, { status: 204 }));
    await vi.waitFor(() => {
      expect(document.body.textContent).toContain("Laptop CLI can no longer access RoamCode Cloud.");
      expect(document.body.textContent).not.toContain("Laptop CLIExample Engineering");
    });
    expect(document.body.textContent).toContain("Tablet CLI");
    expect(api.getDeviceReads()).toBeGreaterThanOrEqual(2);
  });

  test("keeps the device and retry controls when revocation fails", async () => {
    const api = accountApi(async () =>
      json({ error: "cloud_unavailable", error_description: "Device revocation is temporarily unavailable." }, 503),
    );
    vi.stubGlobal("fetch", api.fetchMock);
    await openAccount();

    document
      .querySelector<HTMLButtonElement>(`[data-action="prepare-device-revoke"][data-device-id="${DEVICE_ONE_ID}"]`)
      ?.click();
    document
      .querySelector<HTMLButtonElement>(`[data-action="confirm-device-revoke"][data-device-id="${DEVICE_ONE_ID}"]`)
      ?.click();

    await vi.waitFor(() => {
      expect(document.querySelector('[role="alert"]')?.textContent).toContain(
        "Device revocation is temporarily unavailable.",
      );
    });
    expect(document.body.textContent).toContain("Laptop CLI");
    expect(document.body.textContent).toContain("Revoke this CLI session?");
    expect(
      document.querySelector<HTMLButtonElement>(
        `[data-action="confirm-device-revoke"][data-device-id="${DEVICE_ONE_ID}"]`,
      )?.disabled,
    ).toBe(false);
  });

  test("lists and revokes managed browser access independently from CLI sign-ins", async () => {
    let releaseDelete: ((response: Response) => void) | undefined;
    const api = accountApi(
      async () => new Response(null, { status: 204 }),
      undefined,
      undefined,
      () =>
        new Promise<Response>((resolve) => {
          releaseDelete = resolve;
        }),
    );
    vi.stubGlobal("fetch", api.fetchMock);
    await openAccount();

    await vi.waitFor(() => expect(document.body.textContent).toContain("Safari on iPad"));
    expect(document.body.textContent).toContain("Browser access to Nodes");
    expect(document.body.textContent).toContain("Studio Mac · Example Engineering");
    expect(document.body.textContent).toContain("Laptop CLI");

    document
      .querySelector<HTMLButtonElement>(
        `[data-action="prepare-managed-host-device-revoke"][data-device-id="${HOST_DEVICE_ID}"]`,
      )
      ?.click();
    expect(api.hostDeviceDeleteIds).toEqual([]);
    expect(document.body.textContent).toContain("Revoke this browser's access to Studio Mac?");
    document
      .querySelector<HTMLButtonElement>(
        `[data-action="confirm-managed-host-device-revoke"][data-device-id="${HOST_DEVICE_ID}"]`,
      )
      ?.click();
    await vi.waitFor(() => expect(api.hostDeviceDeleteIds).toEqual([HOST_DEVICE_ID]));
    expect(document.body.textContent).toContain("Revoking…");
    expect(
      document.querySelector<HTMLButtonElement>(
        `[data-action="prepare-device-revoke"][data-device-id="${DEVICE_ONE_ID}"]`,
      )?.disabled,
    ).toBe(false);

    releaseDelete?.(new Response(null, { status: 204 }));
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain("Safari on iPad can no longer access Studio Mac."),
    );
    expect(document.body.textContent).toContain("Laptop CLI");
    expect(document.body.textContent).toContain("No managed browsers have been enrolled");
    expect(api.getHostDeviceReads()).toBeGreaterThanOrEqual(2);
  });

  test("keeps managed browser loading and failure states independent and retryable", async () => {
    let releaseFirstRead: ((response: Response) => void) | undefined;
    let hostInventoryUnavailable = true;
    const api = accountApi(
      async () => new Response(null, { status: 204 }),
      undefined,
      (devices) => {
        if (!releaseFirstRead) {
          return new Promise<Response>((resolve) => {
            releaseFirstRead = resolve;
          });
        }
        return Promise.resolve(
          hostInventoryUnavailable
            ? json({ error_description: "Browser inventory unavailable." }, 503)
            : json({ devices }),
        );
      },
    );
    vi.stubGlobal("fetch", api.fetchMock);
    await openAccount();

    await vi.waitFor(() => expect(document.body.textContent).toContain("Laptop CLI"));
    expect(document.body.textContent).toContain("Loading managed browser access…");
    releaseFirstRead?.(json({ error_description: "Browser inventory unavailable." }, 503));
    await vi.waitFor(() => expect(document.body.textContent).toContain("Browser access is unknown"));
    expect(document.body.textContent).toContain("Browser inventory unavailable.");
    expect(document.body.textContent).toContain("Existing browser credentials may still be active.");
    expect(document.body.textContent).not.toContain("No managed browsers have been enrolled");
    expect(document.body.textContent).toContain("Laptop CLI");

    hostInventoryUnavailable = false;
    document.querySelector<HTMLButtonElement>('[data-action="retry-managed-host-devices"]')?.click();
    await vi.waitFor(() => expect(document.body.textContent).toContain("Safari on iPad"));
    expect(api.getHostDeviceReads()).toBe(2);
    expect(document.body.textContent).not.toContain("Browser access is unknown");
  });

  test("shows an explicit unknown state and retries when the cloud device list fails", async () => {
    let unavailable = true;
    const api = accountApi(
      async () => new Response(null, { status: 204 }),
      async (devices) =>
        unavailable
          ? json(
              {
                error: "cloud_unavailable",
                error_description: "Cloud device inventory is temporarily unavailable.",
              },
              503,
            )
          : json({ devices }),
    );
    vi.stubGlobal("fetch", api.fetchMock);
    await openAccount();

    await vi.waitFor(() => expect(document.body.textContent).toContain("Cloud device status is unknown"));
    expect(document.body.textContent).toContain("Existing device sessions may still be active.");
    expect(document.body.textContent).not.toContain("No CLI device sessions are active.");
    expect(document.querySelector('[data-action="retry-cloud-devices"]')).not.toBeNull();

    unavailable = false;
    document.querySelector<HTMLButtonElement>('[data-action="retry-cloud-devices"]')?.click();
    await vi.waitFor(() => expect(document.body.textContent).toContain("Laptop CLI"));
    expect(api.getDeviceReads()).toBe(2);
    expect(document.body.textContent).not.toContain("Cloud device status is unknown");
  });
});
