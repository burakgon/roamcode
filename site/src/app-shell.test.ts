import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("./product-capabilities", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./product-capabilities")>()),
  fetchProductLaunchCapabilities: vi.fn(async () => ({ v: 1, account: true, managedTerminal: true })),
}));

import { accountAuthReturnUrl, isAccountShellPath, mountAccountShell } from "./app-shell";

const PERSONAL_ID = "00000000-0000-4000-8000-000000000001";
const ORGANIZATION_ID = "00000000-0000-4000-8000-000000000002";
const HOST_ID = "00000000-0000-4000-8000-000000000003";

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

function activationFetch(
  contexts: Array<{
    id: string;
    kind: "personal" | "organization";
    slug: string;
    name: string;
    plan: "free" | "enterprise";
    role: "owner" | "admin" | "member" | "viewer";
  }>,
) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(new URL(String(input), location.origin), init);
    const url = new URL(request.url);
    if (url.pathname === "/api/v1/meta/providers") {
      return json({
        email_password: true,
        passkey: false,
        github: false,
        google: false,
        managed_oidc: false,
        mode: "local_dev",
      });
    }
    if (url.pathname === "/api/auth/get-session") {
      return json({
        session: { id: "session-1" },
        user: {
          id: "user-1",
          name: "Ada",
          email: "ada@example.test",
          emailVerified: true,
        },
      });
    }
    if (url.pathname === "/api/v1/account/bootstrap") {
      return json({ user: { id: "user-1", name: "Ada", email: "ada@example.test" }, contexts });
    }
    const context = contexts.find((candidate) => url.pathname.startsWith(`/api/v1/orgs/${candidate.id}/`));
    if (context && url.pathname.endsWith("/hosts")) return json({ hosts: [] });
    if (context && url.pathname.endsWith("/access")) return json({ access: [] });
    if (context && url.pathname.endsWith("/members")) {
      return json({
        members: [
          {
            organizationId: context.id,
            userId: "user-1",
            role: context.role,
            status: "active",
            name: "Ada",
            email: "ada@example.test",
            joinedAt: "2026-07-17T08:00:00.000Z",
          },
        ],
      });
    }
    if (url.pathname === "/api/v1/auth/device/inspect") {
      expect(await request.json()).toEqual({ user_code: "ABCD-EFGH" });
      return json({
        client: { id: "roamcode-cli", name: "RoamCode CLI" },
        device: { name: "RoamCode CLI", platform: "darwin" },
        scopes: ["identity", "organizations", "hosts", "hosts:write"],
        expires_at: "2026-07-17T18:00:00.000Z",
        warning: "Approve only if you initiated this sign-in.",
      });
    }
    throw new Error(`Unexpected request: ${request.method} ${url.pathname}`);
  });
}

describe("hosted account shell", () => {
  beforeEach(() => {
    document.body.replaceChildren();
    document.documentElement.className = "";
    localStorage.clear();
    sessionStorage.clear();
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
    history.replaceState(null, "", "/app/agents");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("preserves the public device user code across managed identity redirects", () => {
    expect(accountAuthReturnUrl("activate", "ABCD-EFGH", "https://roamcode.ai")).toBe(
      "https://roamcode.ai/activate?user_code=ABCD-EFGH",
    );
    expect(accountAuthReturnUrl("sessions", "ABCD-EFGH", "https://roamcode.ai")).toBe("https://roamcode.ai/app");
    expect(accountAuthReturnUrl("automations", "", "https://roamcode.ai")).toBe("https://roamcode.ai/app/automations");
    expect(accountAuthReturnUrl("agents", "", "https://roamcode.ai")).toBe("https://roamcode.ai/app/agents");
    expect(accountAuthReturnUrl("account", "", "https://roamcode.ai")).toBe("https://roamcode.ai/app/account");
  });

  test("recognizes only canonical account routes, including harmless trailing slashes", () => {
    for (const path of [
      "/app",
      "/app/",
      "/app/sessions",
      "/app/automations/",
      "/app/agents",
      "/app/account",
      "/app/people",
      "/app/reset-password",
      "/activate",
      "/invite",
    ]) {
      expect(isAccountShellPath(path)).toBe(true);
    }
    expect(isAccountShellPath("/app/projects")).toBe(false);
    expect(isAccountShellPath("/app/account/extra")).toBe(false);
  });

  test("opens marketing account creation directly in sign-up mode and scrubs the mode hint", async () => {
    history.replaceState(null, "", "/app?mode=sign-up&campaign=launch#account");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(new URL(String(input), location.origin), init);
        const url = new URL(request.url);
        if (url.pathname === "/api/v1/meta/providers") {
          return json({
            email_password: true,
            passkey: false,
            github: false,
            google: false,
            managed_oidc: false,
            mode: "local_dev",
          });
        }
        if (url.pathname === "/api/auth/get-session") return json(null);
        throw new Error(`Unexpected request: ${request.method} ${url.pathname}`);
      }),
    );

    mountAccountShell();

    await vi.waitFor(() =>
      expect(document.querySelector("#auth-title")?.textContent).toBe("Create your RoamCode account"),
    );
    expect(document.title).toBe("Create account — RoamCode");
    expect(document.querySelector<HTMLButtonElement>('button[data-mode="sign-up"]')?.getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(document.querySelector<HTMLButtonElement>('[data-form="auth"] button[type="submit"]')?.textContent).toBe(
      "Create account",
    );
    expect(location.search).toBe("?campaign=launch");
    expect(location.hash).toBe("#account");
  });

  test("turns the marketing create-account hint into a truthful managed-identity action", async () => {
    history.replaceState(null, "", "/app?mode=sign-up");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(new URL(String(input), location.origin), init);
        const url = new URL(request.url);
        if (url.pathname === "/api/v1/meta/providers")
          return json({
            email_password: false,
            passkey: false,
            github: false,
            google: false,
            managed_oidc: true,
            mode: "managed_oidc",
          });
        if (url.pathname === "/api/auth/get-session") return json(null);
        throw new Error(`Unexpected request: ${request.method} ${url.pathname}`);
      }),
    );

    mountAccountShell();

    await vi.waitFor(() => expect(document.querySelector("#auth-title")?.textContent).toBe("Continue to RoamCode"));
    expect(document.body.textContent).toContain("identity provider handles sign-in and account creation");
    expect(document.querySelector<HTMLButtonElement>('[data-action="managed-sign-in"]')?.textContent).toBe(
      "Continue with your organization",
    );
    expect(document.querySelector('[data-form="auth"]')).toBeNull();
    expect(location.search).toBe("");
  });

  test("posts the normalized device user code in managed identity callback URLs", async () => {
    history.replaceState(null, "", "/activate?user_code=abcd-efgh");
    let managedSignInBody: unknown;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(new URL(String(input), location.origin), init);
        const url = new URL(request.url);
        if (url.pathname === "/api/v1/meta/providers") {
          return json({
            email_password: false,
            passkey: false,
            github: false,
            google: false,
            managed_oidc: true,
            mode: "managed_oidc",
          });
        }
        if (url.pathname === "/api/auth/get-session") return json(null);
        if (url.pathname === "/api/auth/sign-in/oauth2") {
          managedSignInBody = await request.json();
          return json({});
        }
        throw new Error(`Unexpected request: ${request.method} ${url.pathname}`);
      }),
    );

    mountAccountShell();

    await vi.waitFor(() => expect(document.querySelector('[data-action="managed-sign-in"]')).not.toBeNull());
    document.querySelector<HTMLButtonElement>('[data-action="managed-sign-in"]')?.click();
    await vi.waitFor(() =>
      expect(managedSignInBody).toEqual({
        providerId: "managed",
        callbackURL: `${location.origin}/activate?user_code=ABCD-EFGH`,
        errorCallbackURL: `${location.origin}/activate?user_code=ABCD-EFGH`,
      }),
    );
  });

  test("preserves verified session state, creates an Organization, and guides real Node onboarding", async () => {
    let organizationCreated = false;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(new URL(String(input), location.origin), init);
      const url = new URL(request.url);

      if (url.pathname === "/api/v1/meta/providers") {
        return json({
          email_password: true,
          passkey: false,
          github: false,
          google: false,
          managed_oidc: false,
          mode: "local_dev",
        });
      }
      if (url.pathname === "/api/auth/get-session") {
        return json({
          session: { id: "session-1" },
          user: {
            id: "user-1",
            name: "Ada",
            email: "ada@example.test",
            emailVerified: true,
          },
        });
      }
      if (url.pathname === "/api/v1/account/bootstrap") {
        return json({
          // The real endpoint deliberately does not duplicate Better Auth's verification field.
          user: { id: "user-1", name: "Ada", email: "ada@example.test" },
          contexts: [
            {
              id: PERSONAL_ID,
              kind: "personal",
              slug: "personal-user-1",
              name: "Personal",
              plan: "free",
              role: "owner",
            },
            ...(organizationCreated
              ? [
                  {
                    id: ORGANIZATION_ID,
                    kind: "organization",
                    slug: "muhendislik-lab",
                    name: "Mühendislik Lab",
                    plan: "free",
                    role: "owner",
                  } as const,
                ]
              : []),
          ],
        });
      }
      if (url.pathname === `/api/v1/orgs/${PERSONAL_ID}/hosts`) return json({ hosts: [] });
      if (url.pathname === `/api/v1/orgs/${PERSONAL_ID}/members`) {
        return json({
          members: [
            {
              organizationId: PERSONAL_ID,
              userId: "user-1",
              role: "owner",
              status: "active",
              name: "Ada",
              email: "ada@example.test",
              joinedAt: "2026-07-17T08:00:00.000Z",
            },
          ],
        });
      }
      if (url.pathname === "/api/v1/orgs" && request.method === "POST") {
        expect(await request.json()).toEqual({ name: "Mühendislik Lab", slug: "muhendislik-lab" });
        organizationCreated = true;
        return json(
          {
            organization: {
              id: ORGANIZATION_ID,
              kind: "organization",
              slug: "muhendislik-lab",
              name: "Mühendislik Lab",
              plan: "free",
            },
            entitlements: {},
          },
          201,
        );
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
      if (url.pathname === `/api/v1/orgs/${ORGANIZATION_ID}/access`) {
        return json({
          access: [
            {
              hostId: HOST_ID,
              effectivePermission: "manage",
              grantExpiresAt: null,
              latestRequest: null,
            },
          ],
        });
      }
      if (url.pathname === `/api/v1/orgs/${ORGANIZATION_ID}/members`) {
        return json({
          members: [
            {
              organizationId: ORGANIZATION_ID,
              userId: "user-1",
              role: "owner",
              status: "active",
              name: "Ada",
              email: "ada@example.test",
              joinedAt: "2026-07-17T08:00:00.000Z",
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
      throw new Error(`Unexpected request: ${request.method} ${url.pathname}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    mountAccountShell();

    await vi.waitFor(() => {
      expect(document.body.textContent).toContain("Connect the computer that will run your agents");
    });
    expect(document.querySelector('svg[data-lucide="square-terminal"]')).not.toBeNull();
    expect(document.querySelector('svg[data-lucide="workflow"]')).not.toBeNull();
    expect(document.querySelector('svg[data-lucide="cpu"]')).not.toBeNull();
    expect(document.body.textContent).not.toMatch(/[▱⌁◇❯]/u);
    expect(document.body.textContent).not.toContain("Verify your email");
    expect(document.body.textContent).toContain("roamcode cloud login");
    expect(document.body.textContent).toContain('roamcode cloud connect --label "Workstation"');

    document.querySelector<HTMLAnchorElement>('.rc-cloud-mobile-head [data-route="account"]')?.click();
    await vi.waitFor(() => {
      expect(document.body.textContent).toContain(
        "Your cloud identity, contexts, CLI sign-ins, and managed browser access.",
      );
    });
    const mobileOrganizationAction = document.querySelector<HTMLButtonElement>(
      '.rc-cloud-panel-action[data-action="open-organization-dialog"]',
    );
    expect(mobileOrganizationAction).not.toBeNull();
    expect(document.querySelector('.rc-cloud-mobile-head [data-route="account"]')?.getAttribute("aria-label")).toBe(
      "Open account for Ada",
    );
    expect(
      Array.from(document.querySelectorAll('[data-route="account"]')).every(
        (link) => link.getAttribute("aria-current") === "page",
      ),
    ).toBe(true);
    mobileOrganizationAction!.click();
    const name = document.querySelector<HTMLInputElement>('#organization-dialog input[name="name"]');
    const slug = document.querySelector<HTMLInputElement>('#organization-dialog input[name="slug"]');
    expect(name).not.toBeNull();
    expect(slug).not.toBeNull();
    name!.value = "Mühendislik Lab";
    name!.dispatchEvent(new Event("input", { bubbles: true }));
    expect(slug!.value).toBe("muhendislik-lab");

    document
      .querySelector<HTMLFormElement>('[data-form="create-organization"]')
      ?.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));

    await vi.waitFor(() => {
      expect(document.querySelector<HTMLSelectElement>("#mobile-context-selector")?.value).toBe(ORGANIZATION_ID);
      expect(document.body.textContent).toContain("Mühendislik Lab is ready");
    });
    document.documentElement.scrollTop = 480;
    document.body.scrollTop = 480;
    document.querySelector<HTMLAnchorElement>('.rc-cloud-primary--bottom [data-route="agents"]')?.click();
    await vi.waitFor(() => expect(document.body.textContent).toContain("RoamCode Node service"));
    expect(
      Array.from(document.querySelectorAll('[data-route="agents"]')).every(
        (link) => link.getAttribute("aria-current") === "page",
      ),
    ).toBe(true);
    expect(document.querySelector('[data-route="account"][aria-current="page"]')).toBeNull();
    expect(document.documentElement.scrollTop).toBe(0);
    expect(document.body.scrollTop).toBe(0);
    expect(document.body.textContent).not.toContain("Agent service");
    const openNode = document.querySelector<HTMLAnchorElement>('.rc-cloud-node-card a[aria-label="Open Studio Mac"]');
    expect(openNode?.textContent).toBe("Open Node");
    expect(openNode?.getAttribute("href")).toBe(`/terminal/sessions?enroll=${HOST_ID}&context=${ORGANIZATION_ID}`);
    expect(openNode?.getAttribute("aria-label")).toBe("Open Studio Mac");
    expect(openNode?.hasAttribute("aria-disabled")).toBe(false);
    openNode?.focus();
    expect(document.activeElement).toBe(openNode);

    document.querySelector<HTMLAnchorElement>('.rc-cloud-primary--bottom [data-route="sessions"]')?.click();
    await vi.waitFor(() => expect(document.body.textContent).toContain("Choose the Node that owns the repository"));
    const sessionsGateway = document.querySelector<HTMLAnchorElement>('a[aria-label="Open Sessions on Studio Mac"]');
    expect(sessionsGateway?.textContent).toBe("Open Sessions");
    expect(sessionsGateway?.getAttribute("href")).toBe(
      `/terminal/sessions?enroll=${HOST_ID}&context=${ORGANIZATION_ID}`,
    );
    expect(document.querySelector('[aria-label="Choose a Node for Sessions"]')).not.toBeNull();

    document.querySelector<HTMLAnchorElement>('.rc-cloud-primary--bottom [data-route="automations"]')?.click();
    await vi.waitFor(() => expect(document.body.textContent).toContain("Choose the Node that will execute each Run"));
    const automationsGateway = document.querySelector<HTMLAnchorElement>(
      'a[aria-label="Open Automations on Studio Mac"]',
    );
    expect(automationsGateway?.textContent).toBe("Open Automations");
    expect(automationsGateway?.getAttribute("href")).toBe(
      `/terminal/automations?enroll=${HOST_ID}&context=${ORGANIZATION_ID}`,
    );
    expect(document.querySelector('[aria-label="Choose a Node for Automations"]')).not.toBeNull();
    expect(document.querySelector("#organization-dialog")).toBeNull();
  });

  test("does not download a member roster for Personal or non-admin contexts", async () => {
    const memberRequests: string[] = [];
    const memberContextId = "00000000-0000-4000-8000-000000000004";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(new URL(String(input), location.origin), init);
        const url = new URL(request.url);
        if (url.pathname === "/api/v1/meta/providers") {
          return json({
            email_password: true,
            passkey: false,
            github: false,
            google: false,
            managed_oidc: false,
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
                id: PERSONAL_ID,
                kind: "personal",
                slug: "personal-user-1",
                name: "Personal",
                plan: "free",
                role: "owner",
              },
              {
                id: memberContextId,
                kind: "organization",
                slug: "member-context",
                name: "Member context",
                plan: "enterprise",
                role: "member",
              },
            ],
          });
        }
        if (url.pathname === `/api/v1/orgs/${PERSONAL_ID}/hosts`) return json({ hosts: [] });
        if (url.pathname === `/api/v1/orgs/${memberContextId}/hosts`) return json({ hosts: [] });
        if (url.pathname === `/api/v1/orgs/${memberContextId}/access`) return json({ access: [] });
        if (url.pathname.endsWith("/members")) {
          memberRequests.push(url.pathname);
          return json({ members: [] });
        }
        throw new Error(`Unexpected request: ${request.method} ${url.pathname}`);
      }),
    );

    mountAccountShell();
    await vi.waitFor(() => expect(document.querySelector("#context-selector")).not.toBeNull());
    const selector = document.querySelector<HTMLSelectElement>("#context-selector");
    expect(selector).not.toBeNull();
    selector!.value = memberContextId;
    selector!.dispatchEvent(new Event("change", { bubbles: true }));
    await vi.waitFor(() => {
      expect(document.querySelector<HTMLSelectElement>("#context-selector")?.value).toBe(memberContextId);
      expect(document.querySelector(".rc-cloud-page-loading")).toBeNull();
    });

    expect(memberRequests).toEqual([]);
    expect(document.body.textContent).not.toContain("People & AccessAdmin");
  });

  test("renders Open, Request, Pending, and Node-update states from effective access and capabilities", async () => {
    const requestHostId = "00000000-0000-4000-8000-000000000031";
    const pendingHostId = "00000000-0000-4000-8000-000000000032";
    const legacyHostId = "00000000-0000-4000-8000-000000000033";
    history.replaceState(
      null,
      "",
      `/app/agents?context=${ORGANIZATION_ID}&request=${requestHostId}#node-${requestHostId}`,
    );
    let requestState: "denied" | "pending" = "denied";
    let submittedRequest: unknown;
    const hosts = [
      { id: HOST_ID, name: "Granted Mac", capabilities: ["terminal.v1", "relay.v1", "managed-device-enrollment.v1"] },
      {
        id: requestHostId,
        name: "Request Mac",
        capabilities: ["terminal.v1", "relay.v1", "managed-device-enrollment.v1"],
      },
      {
        id: pendingHostId,
        name: "Pending Mac",
        capabilities: ["terminal.v1", "relay.v1", "managed-device-enrollment.v1"],
      },
      { id: legacyHostId, name: "Legacy Mac", capabilities: ["relay.v1"] },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(new URL(String(input), location.origin), init);
        const url = new URL(request.url);
        if (url.pathname === "/api/v1/meta/providers")
          return json({
            email_password: true,
            passkey: false,
            github: false,
            google: false,
            managed_oidc: false,
            mode: "local_dev",
          });
        if (url.pathname === "/api/auth/get-session")
          return json({
            session: { id: "session-1" },
            user: { id: "user-1", name: "Ada", email: "ada@example.test", emailVerified: true },
          });
        if (url.pathname === "/api/v1/account/bootstrap")
          return json({
            user: { id: "user-1", name: "Ada", email: "ada@example.test" },
            contexts: [
              {
                id: ORGANIZATION_ID,
                kind: "organization",
                slug: "engineering",
                name: "Engineering",
                plan: "enterprise",
                role: "member",
              },
            ],
          });
        if (url.pathname === `/api/v1/orgs/${ORGANIZATION_ID}/hosts`)
          return json({
            hosts: hosts.map((host) => ({
              ...host,
              organizationId: ORGANIZATION_ID,
              slug: host.name.toLowerCase().replaceAll(" ", "-"),
              status: "online",
              tokenVersion: 1,
              provisioningSagaId: `saga-${host.id}`,
              agentVersion: "1.2.0",
              lastSeenAt: "2026-07-17T09:00:00.000Z",
              createdAt: "2026-07-17T08:00:00.000Z",
              heartbeatState: "ready",
            })),
          });
        if (url.pathname === `/api/v1/orgs/${ORGANIZATION_ID}/access`)
          return json({
            access: [
              { hostId: HOST_ID, effectivePermission: "use", grantExpiresAt: null, latestRequest: null },
              {
                hostId: requestHostId,
                effectivePermission: null,
                grantExpiresAt: "2026-07-16T09:00:00.000Z",
                latestRequest: {
                  id: "request-1",
                  permission: "use",
                  status: requestState,
                  reason: "Previous request",
                  reviewNote: requestState === "denied" ? "Add an incident reference." : null,
                  createdAt: "2026-07-17T08:00:00.000Z",
                  reviewedAt: requestState === "denied" ? "2026-07-17T08:30:00.000Z" : null,
                },
              },
              {
                hostId: pendingHostId,
                effectivePermission: null,
                grantExpiresAt: null,
                latestRequest: {
                  id: "request-2",
                  permission: "manage",
                  status: "pending",
                  reason: "Pair debugging",
                  reviewNote: null,
                  createdAt: "2026-07-17T08:50:00.000Z",
                  reviewedAt: null,
                },
              },
              { hostId: legacyHostId, effectivePermission: "manage", grantExpiresAt: null, latestRequest: null },
            ],
          });
        const statusHost = hosts.find((host) => url.pathname === `/api/v1/hosts/${host.id}/status`);
        if (statusHost)
          return json({
            host: {},
            relay: {
              status: { hostOnline: true, activeDevices: 1 },
              route: { id: `route-${statusHost.id}`, label: statusHost.name, deviceCount: 1 },
              connection: { path: "/v1/connect", protocolVersion: 1 },
            },
          });
        if (url.pathname === `/api/v1/orgs/${ORGANIZATION_ID}/access-requests` && request.method === "POST") {
          submittedRequest = await request.json();
          requestState = "pending";
          return json(
            {
              access_request: {
                id: "request-3",
                organizationId: ORGANIZATION_ID,
                requesterUserId: "user-1",
                hostId: requestHostId,
                workspaceId: null,
                permission: "use",
                reason: "INC-42 production repair",
                status: "pending",
                reviewedBy: null,
                reviewNote: null,
                createdAt: "2026-07-17T09:10:00.000Z",
                reviewedAt: null,
              },
            },
            201,
          );
        }
        throw new Error(`Unexpected request: ${request.method} ${url.pathname}`);
      }),
    );

    mountAccountShell();
    await vi.waitFor(() => expect(document.body.textContent).toContain("Add an incident reference"));
    expect(document.querySelector(`a[href^="/terminal/sessions?enroll=${HOST_ID}"]`)?.textContent).toBe("Open Node");
    expect(
      Array.from(document.querySelectorAll<HTMLButtonElement>(".rc-cloud-node-card button")).some(
        (button) => button.textContent === "Request pending",
      ),
    ).toBe(true);
    expect(document.body.textContent).toContain("Legacy Mac");
    expect(document.body.textContent).toContain("Node update required");
    expect(document.querySelector('[data-form="request-access"] option[value="view"]')).toBeNull();

    const requestForm = document.querySelector<HTMLFormElement>('[data-form="request-access"]');
    const reason = requestForm?.elements.namedItem("reason") as HTMLTextAreaElement | null;
    if (!requestForm || !reason) throw new Error("Expected access request form");
    reason.value = "INC-42 production repair";
    requestForm.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() =>
      expect(submittedRequest).toEqual({
        host_id: requestHostId,
        permission: "use",
        reason: "INC-42 production repair",
      }),
    );
    await vi.waitFor(() => expect(document.body.textContent).toContain("Access request sent for Request Mac"));
    expect(location.search).toBe(`?context=${ORGANIZATION_ID}`);
    expect(document.querySelector('[data-form="request-access"]')).toBeNull();
    expect(
      Array.from(document.querySelectorAll<HTMLButtonElement>(".rc-cloud-node-card button")).filter(
        (button) => button.textContent === "Request pending",
      ).length,
    ).toBeGreaterThanOrEqual(2);
  });

  test("shows a recoverable fleet error instead of pretending a failed inventory request is empty", async () => {
    history.replaceState(null, "", "/app/sessions");
    let inventoryAttempts = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(new URL(String(input), location.origin), init);
        const url = new URL(request.url);
        if (url.pathname === "/api/v1/meta/providers") {
          return json({
            email_password: true,
            passkey: false,
            github: false,
            google: false,
            managed_oidc: false,
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
                id: PERSONAL_ID,
                kind: "personal",
                slug: "personal-user-1",
                name: "Personal",
                plan: "free",
                role: "owner",
              },
            ],
          });
        }
        if (url.pathname === `/api/v1/orgs/${PERSONAL_ID}/hosts`) {
          inventoryAttempts += 1;
          return inventoryAttempts === 1
            ? json({ error: "cloud_unavailable", error_description: "Fleet temporarily unavailable." }, 503)
            : json({ hosts: [] });
        }
        throw new Error(`Unexpected request: ${request.method} ${url.pathname}`);
      }),
    );

    mountAccountShell();

    await vi.waitFor(() => expect(document.body.textContent).toContain("Node inventory could not be loaded"));
    expect(document.body.textContent).toContain("Fleet temporarily unavailable.");
    expect(document.body.textContent).not.toContain("No Nodes in this context");
    document.querySelector<HTMLButtonElement>('[data-action="refresh-context"]')?.click();
    await vi.waitFor(() => expect(document.body.textContent).toContain("No Nodes in this context"));
    expect(inventoryAttempts).toBe(2);
  });

  test("does not report a Node offline when only its status request failed", async () => {
    history.replaceState(null, "", "/app/sessions");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(new URL(String(input), location.origin), init);
        const url = new URL(request.url);
        if (url.pathname === "/api/v1/meta/providers") {
          return json({
            email_password: true,
            passkey: false,
            github: false,
            google: false,
            managed_oidc: false,
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
                id: PERSONAL_ID,
                kind: "personal",
                slug: "personal-user-1",
                name: "Personal",
                plan: "free",
                role: "owner",
              },
            ],
          });
        }
        if (url.pathname === `/api/v1/orgs/${PERSONAL_ID}/hosts`) {
          return json({
            hosts: [
              {
                id: HOST_ID,
                organizationId: PERSONAL_ID,
                name: "Studio Mac",
                slug: "studio-mac",
                status: "online",
                tokenVersion: 1,
                provisioningSagaId: "saga-1",
                agentVersion: "1.2.0",
                lastSeenAt: "2026-07-17T08:30:00.000Z",
                createdAt: "2026-07-17T08:00:00.000Z",
              },
            ],
          });
        }
        if (url.pathname === `/api/v1/hosts/${HOST_ID}/status`) {
          return json({ error: "cloud_unavailable", error_description: "Status unavailable." }, 503);
        }
        throw new Error(`Unexpected request: ${request.method} ${url.pathname}`);
      }),
    );

    mountAccountShell();

    await vi.waitFor(() => expect(document.body.textContent).toContain("Node status is unavailable"));
    expect(document.body.textContent).toContain("Status unknown");
    expect(document.body.textContent).not.toContain("Your Nodes are offline");
  });

  test("keeps failed member and invitation reads explicit and recovers them before enabling invites", async () => {
    history.replaceState(null, "", "/app/people");
    let memberAttempts = 0;
    let inviteAttempts = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(new URL(String(input), location.origin), init);
        const url = new URL(request.url);
        if (url.pathname === "/api/v1/meta/providers") {
          return json({
            email_password: true,
            passkey: false,
            github: false,
            google: false,
            managed_oidc: false,
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
                slug: "engineering",
                name: "Engineering",
                plan: "enterprise",
                role: "admin",
              },
            ],
          });
        }
        if (url.pathname === `/api/v1/orgs/${ORGANIZATION_ID}/hosts`) return json({ hosts: [] });
        if (url.pathname === `/api/v1/orgs/${ORGANIZATION_ID}/access`) return json({ access: [] });
        if (url.pathname === `/api/v1/orgs/${ORGANIZATION_ID}/members`) {
          memberAttempts += 1;
          return memberAttempts === 1
            ? json({ error: "cloud_unavailable", error_description: "Members temporarily unavailable." }, 503)
            : json({
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
        if (url.pathname === `/api/v1/orgs/${ORGANIZATION_ID}/invites`) {
          inviteAttempts += 1;
          return inviteAttempts === 1
            ? json({ error: "cloud_unavailable", error_description: "Invitations temporarily unavailable." }, 503)
            : json({ invites: [] });
        }
        if (url.pathname === `/api/v1/orgs/${ORGANIZATION_ID}/grants`) return json({ grants: [] });
        if (url.pathname === `/api/v1/orgs/${ORGANIZATION_ID}/access-requests`) return json({ access_requests: [] });
        throw new Error(`Unexpected request: ${request.method} ${url.pathname}`);
      }),
    );

    mountAccountShell();

    await vi.waitFor(() => expect(document.body.textContent).toContain("Member roster unavailable"));
    expect(document.querySelector('[data-route="people"]')?.getAttribute("aria-current")).toBe("page");
    await vi.waitFor(() => expect(document.body.textContent).toContain("Invitations unavailable"));
    expect(document.body.textContent).not.toContain("Members0");
    expect(
      document.querySelector<HTMLButtonElement>('[data-form="invite-member"] button[type="submit"]')?.disabled,
    ).toBe(true);

    document.querySelector<HTMLButtonElement>('[data-action="retry-people"]')?.click();
    await vi.waitFor(() => expect(document.body.textContent).toContain("No pending invitations"));
    expect(document.body.textContent).toContain("ada@example.test");
    expect(
      document.querySelector<HTMLButtonElement>('[data-form="invite-member"] button[type="submit"]')?.disabled,
    ).toBe(false);
    expect(memberAttempts).toBe(2);
    expect(inviteAttempts).toBe(2);
  });

  test("manages members, invitations, Node grants, and access reviews without inventing view access", async () => {
    history.replaceState(null, "", "/app/people");
    const bobId = "00000000-0000-4000-8000-000000000021";
    const ownerId = "00000000-0000-4000-8000-000000000022";
    const inviteId = "00000000-0000-4000-8000-000000000023";
    const legacyGrantId = "00000000-0000-4000-8000-000000000024";
    const newGrantId = "00000000-0000-4000-8000-000000000025";
    const useRequestId = "00000000-0000-4000-8000-000000000026";
    const viewRequestId = "00000000-0000-4000-8000-000000000027";
    let bob = {
      organizationId: ORGANIZATION_ID,
      userId: bobId,
      role: "member" as const,
      status: "active" as const,
      name: "Bob",
      email: "bob@example.test",
      joinedAt: "2026-07-17T08:10:00.000Z",
    };
    let removed = false;
    let invites = [
      {
        id: inviteId,
        organizationId: ORGANIZATION_ID,
        email: "pending@example.test",
        role: "member",
        status: "pending",
        expiresAt: "2026-07-24T08:00:00.000Z",
        createdAt: "2026-07-17T08:00:00.000Z",
      },
    ];
    let grants = [
      {
        id: legacyGrantId,
        organizationId: ORGANIZATION_ID,
        principalUserId: bobId,
        hostId: HOST_ID,
        workspaceId: null,
        permission: "view",
        expiresAt: null,
        createdAt: "2026-07-17T08:00:00.000Z",
      },
    ];
    let requests: Array<{
      id: string;
      organizationId: string;
      requesterUserId: string;
      hostId: string;
      workspaceId: null;
      permission: "view" | "use" | "manage";
      reason: string;
      status: "pending" | "approved" | "denied" | "cancelled";
      reviewedBy: string | null;
      reviewNote: string | null;
      createdAt: string;
      reviewedAt: string | null;
    }> = [
      {
        id: useRequestId,
        organizationId: ORGANIZATION_ID,
        requesterUserId: bobId,
        hostId: HOST_ID,
        workspaceId: null,
        permission: "use",
        reason: "Production incident",
        status: "pending",
        reviewedBy: null,
        reviewNote: null,
        createdAt: "2026-07-17T09:00:00.000Z",
        reviewedAt: null,
      },
      {
        id: viewRequestId,
        organizationId: ORGANIZATION_ID,
        requesterUserId: bobId,
        hostId: HOST_ID,
        workspaceId: null,
        permission: "view",
        reason: "Read-only audit",
        status: "pending",
        reviewedBy: null,
        reviewNote: null,
        createdAt: "2026-07-17T08:50:00.000Z",
        reviewedAt: null,
      },
    ];
    const memberPatches: unknown[] = [];
    const grantBodies: unknown[] = [];
    const requestPatches: unknown[] = [];
    const deletes: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(new URL(String(input), location.origin), init);
        const url = new URL(request.url);
        if (url.pathname === "/api/v1/meta/providers")
          return json({
            email_password: true,
            passkey: false,
            github: false,
            google: false,
            managed_oidc: false,
            mode: "local_dev",
          });
        if (url.pathname === "/api/auth/get-session")
          return json({
            session: { id: "session-1" },
            user: { id: "user-1", name: "Ada", email: "ada@example.test", emailVerified: true },
          });
        if (url.pathname === "/api/v1/account/bootstrap")
          return json({
            user: { id: "user-1", name: "Ada", email: "ada@example.test" },
            contexts: [
              {
                id: ORGANIZATION_ID,
                kind: "organization",
                slug: "engineering",
                name: "Engineering",
                plan: "enterprise",
                role: "admin",
              },
            ],
          });
        if (url.pathname === `/api/v1/orgs/${ORGANIZATION_ID}/hosts`)
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
                lastSeenAt: "2026-07-17T09:00:00.000Z",
                createdAt: "2026-07-17T08:00:00.000Z",
                heartbeatState: "ready",
                capabilities: ["terminal.v1", "relay.v1", "managed-device-enrollment.v1"],
              },
            ],
          });
        if (url.pathname === `/api/v1/orgs/${ORGANIZATION_ID}/access`)
          return json({
            access: [{ hostId: HOST_ID, effectivePermission: "manage", grantExpiresAt: null, latestRequest: null }],
          });
        if (url.pathname === `/api/v1/hosts/${HOST_ID}/status`)
          return json({
            host: {},
            relay: {
              status: { hostOnline: true, activeDevices: 1 },
              route: { id: "route-1", label: "Studio Mac", deviceCount: 1 },
              connection: { path: "/v1/connect", protocolVersion: 1 },
            },
          });
        if (url.pathname === `/api/v1/orgs/${ORGANIZATION_ID}/members` && request.method === "GET")
          return json({
            members: [
              {
                organizationId: ORGANIZATION_ID,
                userId: ownerId,
                role: "owner",
                status: "active",
                name: "Owner",
                email: "owner@example.test",
                joinedAt: "2026-07-17T08:00:00.000Z",
              },
              {
                organizationId: ORGANIZATION_ID,
                userId: "user-1",
                role: "admin",
                status: "active",
                name: "Ada",
                email: "ada@example.test",
                joinedAt: "2026-07-17T08:05:00.000Z",
              },
              ...(removed ? [] : [bob]),
            ],
          });
        if (url.pathname === `/api/v1/orgs/${ORGANIZATION_ID}/members/${bobId}` && request.method === "PATCH") {
          const body = (await request.json()) as {
            role?: "admin" | "member" | "viewer";
            status?: "active" | "suspended";
          };
          memberPatches.push(body);
          bob = { ...bob, ...body } as typeof bob;
          return json({ member: bob });
        }
        if (url.pathname === `/api/v1/orgs/${ORGANIZATION_ID}/members/${bobId}` && request.method === "DELETE") {
          deletes.push(url.pathname);
          removed = true;
          grants = grants.filter((grant) => grant.principalUserId !== bobId);
          requests = requests.filter((accessRequest) => accessRequest.requesterUserId !== bobId);
          return new Response(null, { status: 204 });
        }
        if (url.pathname === `/api/v1/orgs/${ORGANIZATION_ID}/invites` && request.method === "GET")
          return json({ invites });
        if (url.pathname === `/api/v1/orgs/${ORGANIZATION_ID}/invites/${inviteId}` && request.method === "DELETE") {
          deletes.push(url.pathname);
          invites = [];
          return new Response(null, { status: 204 });
        }
        if (url.pathname === `/api/v1/orgs/${ORGANIZATION_ID}/grants` && request.method === "GET")
          return json({ grants });
        if (url.pathname === `/api/v1/orgs/${ORGANIZATION_ID}/grants` && request.method === "POST") {
          const body = await request.json();
          grantBodies.push(body);
          const grant = {
            id: newGrantId,
            organizationId: ORGANIZATION_ID,
            principalUserId: bobId,
            hostId: HOST_ID,
            workspaceId: null,
            permission: "use",
            expiresAt: null,
            createdAt: "2026-07-17T09:10:00.000Z",
          };
          grants = [grant, ...grants.filter((candidate) => candidate.id !== newGrantId)];
          return json({ grant }, 201);
        }
        if (url.pathname.startsWith(`/api/v1/orgs/${ORGANIZATION_ID}/grants/`) && request.method === "DELETE") {
          const grantId = decodeURIComponent(url.pathname.split("/").at(-1) ?? "");
          deletes.push(url.pathname);
          grants = grants.filter((grant) => grant.id !== grantId);
          return new Response(null, { status: 204 });
        }
        if (url.pathname === `/api/v1/orgs/${ORGANIZATION_ID}/access-requests` && request.method === "GET")
          return json({ access_requests: requests });
        if (url.pathname.startsWith(`/api/v1/orgs/${ORGANIZATION_ID}/access-requests/`) && request.method === "PATCH") {
          const requestId = decodeURIComponent(url.pathname.split("/").at(-1) ?? "");
          const body = (await request.json()) as { status: "approved" | "denied" };
          requestPatches.push(body);
          const reviewed = requests.find((candidate) => candidate.id === requestId);
          if (!reviewed) return json({ error: "not_found" }, 404);
          const accessRequest = {
            ...reviewed,
            status: body.status,
            reviewedBy: "user-1",
            reviewedAt: "2026-07-17T09:15:00.000Z",
          };
          requests = requests.map((candidate) => (candidate.id === requestId ? accessRequest : candidate));
          return json({ access_request: accessRequest });
        }
        throw new Error(`Unexpected request: ${request.method} ${url.pathname}`);
      }),
    );

    mountAccountShell();
    await vi.waitFor(() => expect(document.body.textContent).toContain("Production incident"));
    expect(document.body.textContent).toContain("Owner · protected");
    expect(document.body.textContent).toContain("admin · current account");
    expect(document.querySelector('[data-form="node-grant"] option[value="view"]')).toBeNull();
    expect(document.body.textContent).toContain("View · terminal unavailable");
    const viewRequestRow = Array.from(document.querySelectorAll<HTMLLIElement>(".rc-cloud-request-list > li")).find(
      (row) => row.textContent?.includes("Read-only audit"),
    );
    expect(viewRequestRow?.textContent).toContain("View-only terminal access is not supported yet");
    expect(viewRequestRow?.querySelector('[data-status="approved"]')).toBeNull();

    const role = document.querySelector<HTMLSelectElement>(`select[data-member-role][data-user-id="${bobId}"]`);
    if (!role) throw new Error("Expected Bob role control");
    role.value = "viewer";
    role.dispatchEvent(new Event("change", { bubbles: true }));
    await vi.waitFor(() => expect(memberPatches).toContainEqual({ role: "viewer" }));
    document.querySelector<HTMLButtonElement>(`[data-action="toggle-member-status"][data-user-id="${bobId}"]`)?.click();
    await vi.waitFor(() => expect(memberPatches).toContainEqual({ status: "suspended" }));
    document.querySelector<HTMLButtonElement>(`[data-action="toggle-member-status"][data-user-id="${bobId}"]`)?.click();
    await vi.waitFor(() => expect(memberPatches).toContainEqual({ status: "active" }));

    const grantForm = document.querySelector<HTMLFormElement>('[data-form="node-grant"]');
    const grantMember = grantForm?.elements.namedItem("principal_user_id") as HTMLSelectElement | null;
    if (!grantForm || !grantMember) throw new Error("Expected Node grant form");
    grantMember.value = bobId;
    grantForm.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() =>
      expect(grantBodies).toContainEqual({ principal_user_id: bobId, host_id: HOST_ID, permission: "use" }),
    );
    expect(document.querySelector(`a[href*="node=${HOST_ID}"]`)).not.toBeNull();

    document
      .querySelector<HTMLButtonElement>(`[data-action="prepare-invite-revoke"][data-invite-id="${inviteId}"]`)
      ?.click();
    document
      .querySelector<HTMLButtonElement>(`[data-action="confirm-invite-revoke"][data-invite-id="${inviteId}"]`)
      ?.click();
    await vi.waitFor(() => expect(deletes).toContain(`/api/v1/orgs/${ORGANIZATION_ID}/invites/${inviteId}`));

    document
      .querySelector<HTMLButtonElement>(`[data-action="prepare-grant-revoke"][data-grant-id="${legacyGrantId}"]`)
      ?.click();
    document
      .querySelector<HTMLButtonElement>(`[data-action="confirm-grant-revoke"][data-grant-id="${legacyGrantId}"]`)
      ?.click();
    await vi.waitFor(() => expect(deletes).toContain(`/api/v1/orgs/${ORGANIZATION_ID}/grants/${legacyGrantId}`));

    document
      .querySelector<HTMLButtonElement>(
        `[data-action="review-access-request"][data-request-id="${useRequestId}"][data-status="approved"]`,
      )
      ?.click();
    await vi.waitFor(() => expect(requestPatches).toContainEqual({ status: "approved" }));
    document
      .querySelector<HTMLButtonElement>(
        `[data-action="review-access-request"][data-request-id="${viewRequestId}"][data-status="denied"]`,
      )
      ?.click();
    await vi.waitFor(() => expect(requestPatches).toContainEqual({ status: "denied" }));

    document
      .querySelector<HTMLButtonElement>(`[data-action="prepare-member-remove"][data-user-id="${bobId}"]`)
      ?.click();
    expect(document.body.textContent).toContain("Remove this member and revoke their access?");
    document
      .querySelector<HTMLButtonElement>(`[data-action="confirm-member-remove"][data-user-id="${bobId}"]`)
      ?.click();
    await vi.waitFor(() => expect(deletes).toContain(`/api/v1/orgs/${ORGANIZATION_ID}/members/${bobId}`));
    await vi.waitFor(() => expect(document.body.textContent).not.toContain("bob@example.test"));
  });

  test("aborts superseded context reads and never renders their stale hosts, members, or status", async () => {
    const firstContextId = "00000000-0000-4000-8000-000000000005";
    const staleContextId = "00000000-0000-4000-8000-000000000006";
    const currentContextId = "00000000-0000-4000-8000-000000000007";
    const staleHostId = "00000000-0000-4000-8000-000000000008";
    const currentHostId = "00000000-0000-4000-8000-000000000009";
    let staleStatusSignal: AbortSignal | undefined;
    let releaseStaleStatus: ((response: Response) => void) | undefined;
    const contexts = [
      { id: firstContextId, name: "First", slug: "first" },
      { id: staleContextId, name: "Stale", slug: "stale" },
      { id: currentContextId, name: "Current", slug: "current" },
    ];
    const host = (id: string, organizationId: string, name: string) => ({
      id,
      organizationId,
      name,
      slug: name.toLowerCase().replaceAll(" ", "-"),
      status: "online",
      tokenVersion: 1,
      provisioningSagaId: "00000000-0000-4000-8000-000000000010",
      agentVersion: "1.2.3",
      lastSeenAt: "2026-07-17T08:30:00.000Z",
      createdAt: "2026-07-17T08:00:00.000Z",
      heartbeatState: "ready",
      capabilities: ["terminal.v1", "relay.v1", "managed-device-enrollment.v1"],
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(new URL(String(input), location.origin), init);
        const url = new URL(request.url);
        if (url.pathname === "/api/v1/meta/providers") {
          return json({
            email_password: true,
            passkey: false,
            github: false,
            google: false,
            managed_oidc: false,
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
            contexts: contexts.map((context) => ({
              ...context,
              kind: "organization",
              plan: "enterprise",
              role: "admin",
            })),
          });
        }
        const context = contexts.find((candidate) => url.pathname.startsWith(`/api/v1/orgs/${candidate.id}/`));
        if (context && url.pathname.endsWith("/hosts")) {
          if (context.id === firstContextId) return json({ hosts: [] });
          if (context.id === staleContextId) return json({ hosts: [host(staleHostId, staleContextId, "Stale Node")] });
          return json({ hosts: [host(currentHostId, currentContextId, "Current Node")] });
        }
        if (context && url.pathname.endsWith("/members")) {
          const stale = context.id === staleContextId;
          return json({
            members: [
              {
                organizationId: context.id,
                userId: "user-1",
                role: "admin",
                status: "active",
                name: stale ? "Stale Admin" : "Current Admin",
                email: stale ? "stale@example.test" : "current@example.test",
                joinedAt: "2026-07-17T08:00:00.000Z",
              },
            ],
          });
        }
        if (context && url.pathname.endsWith("/access")) {
          const hostId =
            context.id === staleContextId ? staleHostId : context.id === currentContextId ? currentHostId : undefined;
          return json({
            access: hostId
              ? [{ hostId, effectivePermission: "manage", grantExpiresAt: null, latestRequest: null }]
              : [],
          });
        }
        if (url.pathname === `/api/v1/hosts/${staleHostId}/status`) {
          staleStatusSignal = request.signal;
          return new Promise<Response>((resolve) => {
            releaseStaleStatus = resolve;
          });
        }
        if (url.pathname === `/api/v1/hosts/${currentHostId}/status`) {
          return json({
            host: {},
            relay: {
              status: { hostOnline: true, activeDevices: 1 },
              route: { id: "route-current", label: "Current Node", deviceCount: 1 },
              connection: { path: "/v1/connect", protocolVersion: 1 },
            },
          });
        }
        if (url.pathname === `/api/v1/orgs/${currentContextId}/invites`) return json({ invites: [] });
        if (url.pathname === `/api/v1/orgs/${currentContextId}/grants`) return json({ grants: [] });
        if (url.pathname === `/api/v1/orgs/${currentContextId}/access-requests`) return json({ access_requests: [] });
        throw new Error(`Unexpected request: ${request.method} ${url.pathname}`);
      }),
    );

    mountAccountShell();
    await vi.waitFor(() => expect(document.querySelector("#context-selector")).not.toBeNull());
    const switchContext = (contextId: string) => {
      const selector = document.querySelector<HTMLSelectElement>("#context-selector");
      if (!selector) throw new Error("Expected context selector");
      selector.value = contextId;
      selector.dispatchEvent(new Event("change", { bubbles: true }));
    };
    switchContext(staleContextId);
    await vi.waitFor(() => expect(releaseStaleStatus).toBeTypeOf("function"));
    expect(staleStatusSignal?.aborted).toBe(false);

    switchContext(currentContextId);
    await vi.waitFor(() => expect(document.body.textContent).toContain("Current Node"));
    expect(staleStatusSignal?.aborted).toBe(true);
    expect(document.body.textContent).not.toContain("Stale Node");
    document.querySelector<HTMLAnchorElement>('[data-route="people"]')?.click();
    await vi.waitFor(() => expect(document.body.textContent).toContain("Current Admin"));

    if (!releaseStaleStatus) throw new Error("Expected pending stale status request");
    releaseStaleStatus(
      json({
        host: {},
        relay: {
          status: { hostOnline: true, activeDevices: 99 },
          route: { id: "route-stale", label: "Stale Node", deviceCount: 99 },
          connection: { path: "/v1/connect", protocolVersion: 1 },
        },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(document.body.textContent).toContain("Current Admin");
    expect(document.body.textContent).not.toContain("Stale Admin");
    expect(document.body.textContent).not.toContain("stale@example.test");
  });

  test("scrubs invite and reset secrets into tab storage before rendering account forms", async () => {
    let resetBody: unknown;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(new URL(String(input), location.origin), init);
      const url = new URL(request.url);
      if (url.pathname === "/api/v1/meta/providers") {
        return json({
          email_password: true,
          passkey: false,
          github: false,
          google: false,
          managed_oidc: false,
          mode: "local_dev",
        });
      }
      if (url.pathname === "/api/auth/get-session") return json(null);
      if (url.pathname === "/api/auth/reset-password" && request.method === "POST") {
        resetBody = await request.json();
        return json({ status: true });
      }
      throw new Error(`Unexpected request: ${request.method} ${url.pathname}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    history.replaceState(null, "", "/invite/?token=invite-secret&campaign=email#accept");
    mountAccountShell();
    expect(location.search).toBe("?campaign=email");
    expect(location.hash).toBe("#accept");
    expect(sessionStorage.getItem("roamcode.cloud.pending-invite.v1")).toBe("invite-secret");
    expect(document.body.textContent).not.toContain("invite-secret");

    document.body.replaceChildren();
    history.replaceState(null, "", "/app/reset-password/?token=reset-secret&campaign=email#recover");
    mountAccountShell();
    expect(location.search).toBe("?campaign=email");
    expect(location.hash).toBe("#recover");
    expect(sessionStorage.getItem("roamcode.cloud.pending-password-reset.v1")).toBe("reset-secret");
    await vi.waitFor(() => expect(document.querySelector('[data-form="reset-password"]')).not.toBeNull());
    expect(document.querySelector('input[name="token"]')).toBeNull();
    expect(document.body.textContent).not.toContain("reset-secret");

    document.body.replaceChildren();
    history.replaceState(null, "", "/app/reset-password/?campaign=email#recover");
    mountAccountShell();
    await vi.waitFor(() => expect(document.querySelector('[data-form="reset-password"]')).not.toBeNull());
    const password = document.querySelector<HTMLInputElement>('[data-form="reset-password"] input[name="password"]');
    if (!password) throw new Error("Expected reset password field");
    password.value = "correct-horse-battery-staple";
    document
      .querySelector<HTMLFormElement>('[data-form="reset-password"]')
      ?.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() =>
      expect(resetBody).toEqual({ token: "reset-secret", newPassword: "correct-horse-battery-staple" }),
    );
    expect(sessionStorage.getItem("roamcode.cloud.pending-password-reset.v1")).toBeNull();
  });

  test("offers hosts:write approval only for contexts the user can administer", async () => {
    history.replaceState(null, "", "/activate?user_code=ABCD-EFGH");
    vi.stubGlobal(
      "fetch",
      activationFetch([
        {
          id: PERSONAL_ID,
          kind: "personal",
          slug: "personal-user-1",
          name: "Personal",
          plan: "free",
          role: "owner",
        },
        {
          id: ORGANIZATION_ID,
          kind: "organization",
          slug: "read-only-org",
          name: "Read-only Organization",
          plan: "enterprise",
          role: "member",
        },
      ]),
    );

    mountAccountShell();

    await vi.waitFor(() => expect(document.body.textContent).toContain("Requested scopes"));
    const options = [...document.querySelectorAll<HTMLOptionElement>("#activation-organization option")];
    expect(options.map((option) => option.value)).toEqual([PERSONAL_ID]);
    expect(document.querySelector('[data-action="approve-device"]')).not.toBeNull();
  });

  test("keeps denial available and explains the admin requirement when no context can manage Nodes", async () => {
    history.replaceState(null, "", "/activate?user_code=ABCD-EFGH");
    vi.stubGlobal(
      "fetch",
      activationFetch([
        {
          id: ORGANIZATION_ID,
          kind: "organization",
          slug: "viewer-org",
          name: "Viewer Organization",
          plan: "enterprise",
          role: "viewer",
        },
      ]),
    );

    mountAccountShell();

    await vi.waitFor(() => expect(document.body.textContent).toContain("ask an Organization admin"));
    expect(document.querySelector("#activation-organization")).toBeNull();
    expect(document.querySelector('[data-action="approve-device"]')).toBeNull();
    expect(document.querySelector('[data-action="deny-device"]')).not.toBeNull();
    expect(document.querySelector<HTMLAnchorElement>('a[href="/app/account"]')?.textContent).toContain(
      "Open account settings",
    );
  });
});
