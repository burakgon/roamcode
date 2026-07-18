import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { mountAccountShell } from "./app-shell";

const ORGANIZATION_ID = "00000000-0000-4000-8000-000000000091";
const HOST_ID = "00000000-0000-4000-8000-000000000092";

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

function providers(): Response {
  return json({
    email_password: true,
    passkey: false,
    github: false,
    google: false,
    managed_oidc: false,
    mode: "local_dev",
  });
}

describe("hosted product launch gate", () => {
  beforeEach(() => {
    document.body.replaceChildren();
    document.documentElement.className = "";
    localStorage.clear();
    sessionStorage.clear();
    history.replaceState(null, "", "/app?mode=sign-up");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("keeps old-control-plane sign-in and sign-out usable without calling new account APIs", async () => {
    let signedIn = false;
    const requests: string[] = [];
    const requestCredentials: Array<[string, RequestCredentials]> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(new URL(String(input), location.origin), init);
        const url = new URL(request.url);
        requests.push(`${request.method} ${url.pathname}`);
        requestCredentials.push([url.pathname, request.credentials]);
        if (url.pathname === "/api/v1/meta/product-capabilities") return json({ error: "not_found" }, 404);
        if (url.pathname === "/api/v1/meta/providers") return providers();
        if (url.pathname === "/api/auth/get-session") {
          return json(
            signedIn
              ? {
                  session: { id: "session-1" },
                  user: {
                    id: "user-1",
                    name: "Ada",
                    email: "ada@example.test",
                    emailVerified: true,
                  },
                }
              : null,
          );
        }
        if (url.pathname === "/api/auth/sign-in/email") {
          expect(await request.json()).toMatchObject({ email: "ada@example.test", rememberMe: true });
          signedIn = true;
          return json({ ok: true });
        }
        if (url.pathname === "/api/auth/sign-out") {
          signedIn = false;
          return new Response(null, { status: 204 });
        }
        throw new Error(`Unexpected request: ${request.method} ${url.pathname}`);
      }),
    );

    mountAccountShell();
    await vi.waitFor(() => expect(document.querySelector("#auth-title")?.textContent).toBe("Welcome back"));
    expect(document.body.textContent).toContain("Hosted product unavailable");
    expect(document.querySelector('[data-mode="sign-up"]')).toBeNull();
    expect(document.querySelector<HTMLFormElement>('[data-form="auth"]')?.dataset.mode).toBe("sign-in");
    expect(location.search).toBe("");

    const form = document.querySelector<HTMLFormElement>('[data-form="auth"]')!;
    form.querySelector<HTMLInputElement>('[name="email"]')!.value = "ada@example.test";
    form.querySelector<HTMLInputElement>('[name="password"]')!.value = "correct-horse-battery";
    form.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));

    await vi.waitFor(() =>
      expect(document.querySelector("#hosted-product-title")?.textContent).toBe("Hosted product unavailable"),
    );
    expect(document.body.textContent).toContain("ada@example.test");
    expect(requests.some((request) => request.endsWith("/api/v1/account/bootstrap"))).toBe(false);
    expect(requests.some((request) => request.includes("sign-up"))).toBe(false);
    expect(
      requestCredentials
        .filter(([path]) => path === "/api/v1/meta/product-capabilities")
        .every(([, credentials]) => credentials === "omit"),
    ).toBe(true);
    expect(
      requestCredentials
        .filter(([path]) => path !== "/api/v1/meta/product-capabilities")
        .every(([, credentials]) => credentials === "include"),
    ).toBe(true);

    document.querySelector<HTMLButtonElement>('[data-action="sign-out"]')?.click();
    await vi.waitFor(() => expect(document.querySelector("#auth-title")?.textContent).toBe("Welcome back"));
    expect(requests).toContain("POST /api/auth/sign-out");
  });

  test("loads account inventory but never offers enrollment for an incompatible managed contract", async () => {
    history.replaceState(null, "", "/app/agents");
    const requests: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(new URL(String(input), location.origin), init);
        const url = new URL(request.url);
        requests.push(`${request.method} ${url.pathname}`);
        if (url.pathname === "/api/v1/meta/product-capabilities") {
          return json({
            v: 1,
            launch: { account: true, managedTerminal: true },
            capabilities: ["account.v1", "managed-device-enrollment.v1"],
            requiredNodeCapabilities: ["terminal.v1", "managed-device-enrollment.v1"],
          });
        }
        if (url.pathname === "/api/v1/meta/providers") return providers();
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
                slug: "example",
                name: "Example",
                plan: "free",
                role: "member",
              },
            ],
          });
        }
        if (url.pathname === `/api/v1/orgs/${ORGANIZATION_ID}/hosts`) {
          return json({
            hosts: [
              {
                id: HOST_ID,
                organizationId: ORGANIZATION_ID,
                name: "Studio Mac",
                slug: "studio-mac",
                status: "online",
                tokenVersion: 1,
                provisioningSagaId: "saga-1",
                agentVersion: "1.2.0",
                lastSeenAt: "2026-07-17T08:30:00.000Z",
                createdAt: "2026-07-17T08:00:00.000Z",
                heartbeatState: "ready",
                capabilities: ["terminal.v1", "relay.v1", "managed-device-enrollment.v1"],
              },
            ],
          });
        }
        if (url.pathname === `/api/v1/hosts/${HOST_ID}/status`) {
          return json({
            host: {},
            relay: {
              status: { hostOnline: true, activeDevices: 1 },
              route: { id: "route-1", label: "Studio Mac", deviceCount: 1 },
              connection: { path: "/v1/connect", protocolVersion: 1 },
            },
          });
        }
        if (url.pathname === "/api/v1/auth/devices") return json({ devices: [] });
        if (url.pathname === "/api/v1/legal/documents") return json({ documents: [] });
        throw new Error(`Unexpected request: ${request.method} ${url.pathname}`);
      }),
    );

    mountAccountShell();
    await vi.waitFor(() => expect(document.body.textContent).toContain("Studio Mac"));
    expect(document.body.textContent).toContain("Managed terminal unavailable");
    expect(document.querySelector('a[href*="enroll="]')).toBeNull();
    expect(document.querySelector<HTMLButtonElement>(".rc-cloud-node-card button")?.disabled).toBe(true);
    expect(requests).not.toContain(`GET /api/v1/orgs/${ORGANIZATION_ID}/access`);

    document.querySelector<HTMLAnchorElement>('.rc-cloud-account-link[data-route="account"]')?.click();
    await vi.waitFor(() => expect(document.body.textContent).toContain("CLI sign-ins"));
    expect(document.body.textContent).not.toContain("Browser access to Nodes");
    expect(requests).not.toContain("GET /api/v1/account/host-devices");
  });
});
