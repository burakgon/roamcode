import { render, screen, act, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { saveToken, loadToken } from "./auth/token-store";
import { useStore } from "./store/store";
import { loadDefaults, saveDefaults } from "./settings/defaults";
import type { SessionMeta } from "./types/server";

// TerminalView bridges xterm.js (needs a real canvas / matchMedia), which jsdom lacks. These App-shell
// tests only care about the rail/selection/landing chrome, not the terminal internals, so stub it.
vi.mock("./chat/TerminalView", () => ({
  TerminalView: (props: { session: { id: string }; onShowSessions?: () => void; onClose?: () => void }) => (
    <div data-testid="terminal-view">
      {/* The real TerminalView renders these via ChatHeader; the shell tests reach for them. */}
      <button type="button" aria-label="Show sessions" onClick={props.onShowSessions}>
        menu
      </button>
      <button type="button" aria-label="Close session" onClick={props.onClose}>
        close
      </button>
      <span>terminal:{props.session.id}</span>
    </div>
  ),
}));

let fetchMock: ReturnType<typeof vi.fn>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

beforeEach(() => {
  localStorage.clear();
  // Reset the shared zustand singleton so tests don't leak state into each other.
  useStore.setState({ token: undefined, sessions: [], activeSessionId: undefined, lastActiveAt: {} });
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("App token validation on load", () => {
  it("with a stored token, validates via GET /sessions (200) and renders the session list", async () => {
    saveToken("good-token");
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        sessions: [{ id: "s1", cwd: "/home/u/roamcode", dangerouslySkip: false, status: "running", createdAt: 1 }],
      }),
    );

    render(<App />);

    // The validated session shows up in the list (proof we hit /sessions and stored the result).
    expect(await screen.findByText("roamcode")).toBeInTheDocument();
    // It fetched /sessions with the stored bearer token.
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toMatch(/\/sessions$/);
    expect((init as RequestInit).headers).toMatchObject({ authorization: "Bearer good-token" });
    // Token survives a successful validation.
    expect(loadToken()).toBe("good-token");
  });

  it("on a 401, clears the stored token and returns to the login screen", async () => {
    saveToken("bad-token");
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "unauthorized" }, 401));

    render(<App />);

    // Back at login, surfacing the 401.
    expect(await screen.findByText(/invalid token \(401\)/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/access token/i)).toBeInTheDocument();
    // The bad token was cleared from storage.
    expect(loadToken()).toBeUndefined();
  });

  it("with no stored token, shows the login screen without calling the server", () => {
    render(<App />);
    expect(screen.getByLabelText(/access token/i)).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("with ?token=<t> in the connect URL, authenticates directly (no login prompt) and strips the token from the URL", async () => {
    window.history.replaceState({}, "", "/index.html?token=url-token");
    fetchMock.mockResolvedValueOnce(jsonResponse({ sessions: [] }));

    render(<App />);

    // It validated via /sessions using the URL token — the login screen never appears.
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toMatch(/\/sessions$/);
    expect((init as RequestInit).headers).toMatchObject({ authorization: "Bearer url-token" });
    // Persisted for next time, and stripped from the address bar (not left in history/referer).
    expect(loadToken()).toBe("url-token");
    expect(window.location.search).toBe("");
    expect(screen.queryByLabelText(/access token/i)).not.toBeInTheDocument();
    window.history.replaceState({}, "", "/");
  });
});

describe("App ready-state controls", () => {
  async function renderReady() {
    saveToken("good-token");
    fetchMock.mockResolvedValueOnce(jsonResponse({ sessions: [] }));
    render(<App />);
    // The always-visible mobile sessions toggle proves we reached the ready state.
    await screen.findByRole("button", { name: /show sessions/i });
  }

  it("describes the landing and onboarding as Claude-or-Codex, not Claude-only", async () => {
    await renderReady();
    expect(screen.getByText(/drive claude code or codex from your phone/i)).toBeVisible();
    expect(screen.getByText(/sessions run the selected agent cli/i)).toBeVisible();
    expect(screen.getByText(/claude code or codex needs you/i)).toBeVisible();
  });

  it("opens the mobile sessions sheet from the sessions toggle", async () => {
    await renderReady();
    // The rail is closed on mobile until toggled.
    expect(screen.getByTestId("sessions-rail")).toHaveAttribute("data-open", "false");
    await userEvent.click(screen.getByRole("button", { name: /show sessions/i }));
    // After toggling, the sessions rail is marked open.
    expect(screen.getByTestId("sessions-rail")).toHaveAttribute("data-open", "true");
  });

  it("the landing-state menu button is mobile-only (carries the rc-menu-btn class hidden on desktop)", async () => {
    await renderReady();
    expect(screen.getByRole("button", { name: /show sessions/i })).toHaveClass("rc-menu-btn");
  });

  it("the landing menu button folds the needs-you count into its label when sessions await", async () => {
    saveToken("good-token");
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        sessions: [
          { id: "s1", cwd: "/home/u/a", dangerouslySkip: false, status: "running", createdAt: 1, awaiting: true },
          { id: "s2", cwd: "/home/u/b", dangerouslySkip: false, status: "running", createdAt: 2, awaiting: true },
        ],
      }),
    );
    render(<App />);
    // No active session → landing state; its menu button carries the count (never color-only).
    const menu = await screen.findByRole("button", { name: "Show sessions, 2 need you" });
    expect(menu).toHaveTextContent("2");
  });

  it("opens the new-session wizard (directory picker) from the New session button", async () => {
    await renderReady();
    // Open the sessions sheet to reach its New session button.
    await userEvent.click(screen.getByRole("button", { name: /show sessions/i }));
    // Listing the start directory once the picker mounts.
    fetchMock.mockResolvedValueOnce(jsonResponse({ path: "/home/u", entries: [] }));
    // The landing panel also offers a "New session" CTA, so scope to the rail's button here.
    const rail = within(screen.getByTestId("sessions-rail"));
    await userEvent.click(rail.getByRole("button", { name: /new session/i }));
    expect(await screen.findByRole("dialog", { name: /pick a directory/i })).toBeInTheDocument();
  });

  it("keeps Codex selectable and visibly degrades when lazy metadata loading fails", async () => {
    saveToken("good-token");
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (/\/sessions$/.test(url)) return Promise.resolve(jsonResponse({ sessions: [] }));
      if (/\/providers$/.test(url)) {
        return Promise.resolve(
          jsonResponse({
            providers: {
              claude: { terminalAvailable: true, metadataAvailable: true },
              codex: { terminalAvailable: true, metadataAvailable: true },
            },
          }),
        );
      }
      if (/\/providers\/codex\/models$/.test(url)) {
        return Promise.resolve(jsonResponse({ error: "Codex metadata unavailable" }, 503));
      }
      if (/\/providers\/codex\/profiles$/.test(url)) {
        return Promise.resolve(jsonResponse({ profiles: ["work.secure"] }));
      }
      if (/\/fs\/list/.test(url)) {
        return Promise.resolve(jsonResponse({ path: "/home/u", entries: [] }));
      }
      return Promise.resolve(jsonResponse({}, 404));
    });

    render(<App />);
    await screen.findByRole("button", { name: /show sessions/i });
    await userEvent.click(screen.getByRole("button", { name: /show sessions/i }));
    const rail = within(screen.getByTestId("sessions-rail"));
    await userEvent.click(rail.getByRole("button", { name: /new session/i }));
    await userEvent.click(await screen.findByRole("button", { name: /use this directory/i }));

    const codex = await screen.findByRole("radio", { name: /codex/i });
    expect(codex).toBeEnabled();
    expect(await screen.findByText(/metadata unavailable.*bounded custom values/i)).toBeVisible();
  });

  it("surfaces provider availability load failure and retries without guessing availability", async () => {
    saveToken("good-token");
    let providerAttempts = 0;
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (/\/sessions$/.test(url)) return Promise.resolve(jsonResponse({ sessions: [] }));
      if (/\/providers$/.test(url)) {
        providerAttempts += 1;
        return Promise.resolve(
          providerAttempts === 1
            ? jsonResponse({ error: "temporary" }, 503)
            : jsonResponse({
                providers: {
                  claude: { terminalAvailable: true, metadataAvailable: true },
                  codex: { terminalAvailable: true, metadataAvailable: false },
                },
              }),
        );
      }
      if (/\/fs\/list/.test(url)) return Promise.resolve(jsonResponse({ path: "/home/u", entries: [] }));
      return Promise.resolve(jsonResponse({}, 404));
    });

    render(<App />);
    await screen.findByRole("button", { name: /show sessions/i });
    await userEvent.click(screen.getByRole("button", { name: /show sessions/i }));
    const rail = within(screen.getByTestId("sessions-rail"));
    await userEvent.click(rail.getByRole("button", { name: /new session/i }));
    await userEvent.click(await screen.findByRole("button", { name: /use this directory/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/could not load provider availability/i);
    expect(screen.getByRole("radio", { name: /claude code/i })).toBeDisabled();
    expect(screen.getByRole("radio", { name: /codex/i })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: /retry provider availability/i }));
    await waitFor(() => expect(screen.getByRole("radio", { name: /claude code/i })).toBeEnabled());
    expect(screen.getByRole("radio", { name: /codex/i })).toBeEnabled();
    expect(providerAttempts).toBe(2);
  });

  it("loads provider auth independently and keeps terminals selectable when one auth check fails", async () => {
    saveToken("good-token");
    const claudeAuth = deferred<Response>();
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (/\/sessions$/.test(url)) return Promise.resolve(jsonResponse({ sessions: [] }));
      if (/\/providers$/.test(url)) {
        return Promise.resolve(
          jsonResponse({
            providers: {
              claude: { terminalAvailable: true, metadataAvailable: true },
              codex: { terminalAvailable: true, metadataAvailable: false },
            },
          }),
        );
      }
      if (/\/providers\/claude\/auth\/status$/.test(url)) return claudeAuth.promise;
      if (/\/providers\/codex\/auth\/status$/.test(url)) {
        return Promise.resolve(jsonResponse({ available: true, authenticated: true, authMethod: "chatgpt" }));
      }
      if (/\/fs\/list/.test(url)) return Promise.resolve(jsonResponse({ path: "/home/u", entries: [] }));
      return Promise.resolve(jsonResponse({}, 404));
    });

    render(<App />);
    await screen.findByRole("button", { name: /show sessions/i });
    await userEvent.click(screen.getByRole("button", { name: /show sessions/i }));
    const rail = within(screen.getByTestId("sessions-rail"));
    await userEvent.click(rail.getByRole("button", { name: /new session/i }));
    await userEvent.click(await screen.findByRole("button", { name: /use this directory/i }));

    expect(await screen.findByText(/checking sign-in/i)).toBeVisible();
    expect(await screen.findByText(/^signed in$/i)).toBeVisible();
    expect(screen.getByRole("radio", { name: /claude code/i })).toBeEnabled();
    expect(screen.getByRole("radio", { name: /codex/i })).toBeEnabled();

    await act(async () => claudeAuth.resolve(jsonResponse({ error: "auth probe failed" }, 503)));
    expect(await screen.findByText(/claude code sign-in status unavailable/i)).toBeVisible();
    expect(screen.getByText(/^signed in$/i)).toBeVisible();
    expect(screen.getByRole("radio", { name: /claude code/i })).toBeEnabled();
  });

  it("ignores an older background auth result after a newer wizard retry", async () => {
    saveToken("good-token");
    let providerAttempts = 0;
    let claudeAuthAttempts = 0;
    const staleBackground = deferred<Response>();
    const newerRetry = deferred<Response>();
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (/\/sessions$/.test(url)) return Promise.resolve(jsonResponse({ sessions: [] }));
      if (/\/providers$/.test(url)) {
        providerAttempts += 1;
        return Promise.resolve(
          providerAttempts === 1
            ? jsonResponse({ error: "temporary" }, 503)
            : jsonResponse({
                providers: {
                  claude: { terminalAvailable: true, metadataAvailable: true },
                  codex: { terminalAvailable: true, metadataAvailable: false },
                },
              }),
        );
      }
      if (/\/providers\/claude\/auth\/status$/.test(url)) {
        claudeAuthAttempts += 1;
        if (claudeAuthAttempts === 1) return staleBackground.promise;
        if (claudeAuthAttempts === 2) return Promise.resolve(jsonResponse({ error: "temporary" }, 503));
        return newerRetry.promise;
      }
      if (/\/providers\/codex\/auth\/status$/.test(url)) {
        return Promise.resolve(jsonResponse({ available: true, authenticated: true }));
      }
      if (/\/fs\/list/.test(url)) return Promise.resolve(jsonResponse({ path: "/home/u", entries: [] }));
      return Promise.resolve(jsonResponse({}, 404));
    });

    render(<App />);
    await screen.findByRole("button", { name: /show sessions/i });
    await userEvent.click(screen.getByRole("button", { name: /show sessions/i }));
    const rail = within(screen.getByTestId("sessions-rail"));
    await userEvent.click(rail.getByRole("button", { name: /new session/i }));
    await userEvent.click(await screen.findByRole("button", { name: /use this directory/i }));
    expect(await screen.findByText(/claude code sign-in status unavailable/i)).toBeVisible();
    await userEvent.click(await screen.findByRole("button", { name: /retry provider availability/i }));

    await act(async () => newerRetry.resolve(jsonResponse({ available: true, loggedIn: true })));
    const claudeCard = screen.getByRole("radio", { name: /claude code/i }).closest("label")!;
    expect(within(claudeCard).getByText(/^signed in$/i)).toBeVisible();
    expect(screen.queryByText(/turns will fail until you sign in/i)).not.toBeInTheDocument();

    await act(async () => staleBackground.resolve(jsonResponse({ available: true, loggedIn: false })));
    expect(within(claudeCard).getByText(/^signed in$/i)).toBeVisible();
    expect(screen.queryByText(/turns will fail until you sign in/i)).not.toBeInTheDocument();
    expect(providerAttempts).toBe(2);
    expect(claudeAuthAttempts).toBe(3);
  });

  it.each([
    ["error", 503],
    ["401", 401],
  ] as const)(
    "ignores an older wizard retry %s when a newer background focus check is in flight",
    async (kind, status) => {
      void kind;
      saveToken("good-token");
      let claudeAuthAttempts = 0;
      const staleRetry = deferred<Response>();
      const newerFocus = deferred<Response>();
      fetchMock.mockImplementation((input: RequestInfo | URL) => {
        const url = String(input);
        if (/\/sessions$/.test(url)) return Promise.resolve(jsonResponse({ sessions: [] }));
        if (/\/providers$/.test(url)) {
          return Promise.resolve(
            jsonResponse({
              providers: {
                claude: { terminalAvailable: true, metadataAvailable: true },
                codex: { terminalAvailable: true, metadataAvailable: false },
              },
            }),
          );
        }
        if (/\/providers\/claude\/auth\/status$/.test(url)) {
          claudeAuthAttempts += 1;
          if (claudeAuthAttempts === 1) return Promise.resolve(jsonResponse({ available: true, loggedIn: true }));
          if (claudeAuthAttempts === 2) return Promise.resolve(jsonResponse({ error: "temporary" }, 503));
          if (claudeAuthAttempts === 3) return staleRetry.promise;
          return newerFocus.promise;
        }
        if (/\/providers\/codex\/auth\/status$/.test(url)) {
          return Promise.resolve(jsonResponse({ available: true, authenticated: true }));
        }
        if (/\/fs\/list/.test(url)) return Promise.resolve(jsonResponse({ path: "/home/u", entries: [] }));
        return Promise.resolve(jsonResponse({}, 404));
      });

      render(<App />);
      await screen.findByRole("button", { name: /show sessions/i });
      await userEvent.click(screen.getByRole("button", { name: /show sessions/i }));
      const rail = within(screen.getByTestId("sessions-rail"));
      await userEvent.click(rail.getByRole("button", { name: /new session/i }));
      await userEvent.click(await screen.findByRole("button", { name: /use this directory/i }));
      expect(await screen.findByText(/claude code sign-in status unavailable/i)).toBeVisible();
      await userEvent.click(screen.getByRole("button", { name: /retry provider availability/i }));
      await waitFor(() => expect(claudeAuthAttempts).toBe(3));

      act(() => window.dispatchEvent(new Event("focus")));
      await waitFor(() => expect(claudeAuthAttempts).toBe(4));
      await act(async () => staleRetry.resolve(jsonResponse({ error: "stale auth failure" }, status)));
      const claudeCard = screen.getByRole("radio", { name: /claude code/i }).closest("label")!;
      expect(within(claudeCard).getByText(/checking sign-in/i)).toBeVisible();
      expect(screen.queryByText(/turns will fail until you sign in/i)).not.toBeInTheDocument();

      await act(async () => newerFocus.resolve(jsonResponse({ available: true, loggedIn: false })));
      expect(within(claudeCard).getByText(/signed out/i)).toBeVisible();
      expect(screen.getByText(/turns will fail until you sign in/i)).toBeVisible();
    },
  );
});

describe("App session defaults ownership", () => {
  function installDefaultsApi(options?: {
    serverDefaults?: { effort: string; dangerouslySkip: boolean };
    revision?: number;
    putResponse?: Promise<Response>;
    rejectDefaultsGetAfter?: number;
  }) {
    let defaultsGets = 0;
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (/\/sessions$/.test(url)) return Promise.resolve(jsonResponse({ sessions: [] }));
      if (/\/settings\/session-defaults$/.test(url) && method === "GET") {
        defaultsGets += 1;
        if (options?.rejectDefaultsGetAfter !== undefined && defaultsGets > options.rejectDefaultsGetAfter) {
          return Promise.reject(new Error("offline"));
        }
        return Promise.resolve(
          jsonResponse({
            defaults: options?.serverDefaults ?? { effort: "high", dangerouslySkip: false },
            revision: options?.revision ?? 2,
            updatedAt: 123,
          }),
        );
      }
      if (/\/settings\/session-defaults$/.test(url) && method === "PUT") {
        return (
          options?.putResponse ??
          Promise.resolve(
            jsonResponse({ defaults: { effort: "high", dangerouslySkip: false }, revision: 3, updatedAt: 456 }),
          )
        );
      }
      if (/\/providers$/.test(url)) {
        return Promise.resolve(
          jsonResponse({
            providers: {
              claude: { terminalAvailable: true, metadataAvailable: true },
              codex: { terminalAvailable: true, metadataAvailable: false },
            },
          }),
        );
      }
      if (/\/providers\/claude\/models$/.test(url)) {
        return Promise.resolve(
          jsonResponse({
            models: [
              {
                value: "claude-default",
                displayName: "Claude Default",
                isDefault: true,
                supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
              },
            ],
          }),
        );
      }
      if (/\/fs\/list/.test(url)) return Promise.resolve(jsonResponse({ path: "/home/u", entries: [] }));
      return Promise.resolve(jsonResponse({}, 404));
    });
  }

  async function openGlobalSettings() {
    await screen.findByRole("button", { name: /show sessions/i });
    await userEvent.click(screen.getByRole("button", { name: /show sessions/i }));
    await userEvent.click(within(screen.getByTestId("sessions-rail")).getByRole("button", { name: "Settings" }));
  }

  it("hydrates once after authentication and gives settings and a fresh wizard the same authoritative defaults", async () => {
    saveToken("good-token");
    saveDefaults({ effort: "low", dangerouslySkip: false });
    installDefaultsApi();

    render(<App />);
    await waitFor(() => expect(loadDefaults()).toEqual({ effort: "high", dangerouslySkip: false }));

    // A later cache mutation must not replace App's in-memory authority when a panel opens.
    saveDefaults({ effort: "low", dangerouslySkip: false });
    await openGlobalSettings();
    expect(screen.getByLabelText(/default effort/i)).toHaveValue("high");
    await userEvent.click(screen.getByRole("button", { name: "Close settings" }));

    await userEvent.click(screen.getByRole("button", { name: /show sessions/i }));
    const rail = within(screen.getByTestId("sessions-rail"));
    await userEvent.click(rail.getByRole("button", { name: /new session/i }));
    await userEvent.click(await screen.findByRole("button", { name: /use this directory/i }));
    await userEvent.click(await screen.findByRole("radio", { name: /claude code/i }));
    expect(screen.getByLabelText("Effort")).toHaveValue("high");
  });

  it("does not show an authoritative Saved confirmation before the server PUT resolves", async () => {
    saveToken("good-token");
    const pendingPut = deferred<Response>();
    installDefaultsApi({ serverDefaults: { effort: "low", dangerouslySkip: false }, putResponse: pendingPut.promise });

    render(<App />);
    await openGlobalSettings();
    await userEvent.selectOptions(screen.getByLabelText(/default effort/i), "high");
    await userEvent.click(screen.getByRole("button", { name: /save defaults/i }));

    expect(screen.queryByText("Saved")).not.toBeInTheDocument();
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringMatching(/\/settings\/session-defaults$/),
        expect.objectContaining({ method: "PUT" }),
      ),
    );

    pendingPut.resolve(
      jsonResponse({ defaults: { effort: "high", dangerouslySkip: false }, revision: 3, updatedAt: 456 }),
    );
    expect(await screen.findByText("Saved")).toBeInTheDocument();
  });

  it("clears in-memory sync state on sign out without erasing the local defaults cache", async () => {
    saveToken("first-token");
    saveDefaults({ effort: "low", dangerouslySkip: false });
    installDefaultsApi({ rejectDefaultsGetAfter: 1 });
    vi.spyOn(window, "confirm").mockReturnValue(true);

    render(<App />);
    await waitFor(() => expect(loadDefaults()).toEqual({ effort: "high", dangerouslySkip: false }));
    saveDefaults({ effort: "xhigh", dangerouslySkip: false });
    await openGlobalSettings();
    await userEvent.click(screen.getByRole("button", { name: "Sign out" }));

    expect(await screen.findByLabelText(/access token/i)).toBeInTheDocument();
    expect(loadDefaults()).toEqual({ effort: "xhigh", dangerouslySkip: false });
    await userEvent.type(screen.getByLabelText(/access token/i), "second-token");
    await userEvent.click(screen.getByRole("button", { name: "Connect" }));
    await openGlobalSettings();
    expect(screen.getByLabelText(/default effort/i)).toHaveValue("xhigh");
  });
});

describe("App — closing sessions from the rail (✕)", () => {
  const a: SessionMeta = { id: "a", cwd: "/home/u/alpha", dangerouslySkip: false, status: "running", createdAt: 1 };
  const b: SessionMeta = { id: "b", cwd: "/home/u/beta", dangerouslySkip: false, status: "running", createdAt: 2 };

  let realWS: typeof WebSocket;
  let deleted: string[];
  beforeEach(() => {
    deleted = [];
    // A no-op WebSocket so the active ChatView can mount without a real socket.
    realWS = globalThis.WebSocket;
    class NoopWS {
      static readonly OPEN = 1;
      readyState = 1;
      onopen: (() => void) | null = null;
      onmessage: (() => void) | null = null;
      onclose: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor() {
        queueMicrotask(() => this.onopen?.());
      }
      send() {}
      close() {}
    }
    globalThis.WebSocket = NoopWS as unknown as typeof WebSocket;
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      // Close = DELETE /sessions/:id → 204 with NO body (the api client must resolve without parsing).
      const delMatch = url.match(/\/sessions\/([^/?]+)$/);
      if (delMatch && init?.method === "DELETE") {
        deleted.push(delMatch[1] ?? "");
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      if (/\/sessions$/.test(url)) return Promise.resolve(jsonResponse({ sessions: [a, b] }));
      const m = url.match(/\/sessions\/([^/?]+)/);
      if (m) {
        const session = m[1] === "a" ? a : b;
        return Promise.resolve(jsonResponse({ session, history: [] }));
      }
      return Promise.resolve(jsonResponse({}, 404));
    });
  });
  afterEach(() => {
    globalThis.WebSocket = realWS;
  });

  it("✕ DELETEs the session (handling a 204), removes the row, and (for the active one) reselects the new top", async () => {
    saveToken("good-token");
    render(<App />);
    await screen.findByRole("button", { name: /show sessions/i });
    await userEvent.click(screen.getByRole("button", { name: /show sessions/i }));
    const rail = within(screen.getByTestId("sessions-rail"));

    // Select session "a" (the active one we'll close), then reopen the sheet (selecting closes it).
    await userEvent.click(rail.getByText("alpha"));
    await waitFor(() => expect(useStore.getState().activeSessionId).toBe("a"));
    await userEvent.click(screen.getByRole("button", { name: /show sessions/i }));

    // Close the ACTIVE session: open its ⋯ actions, then tap ✕.
    await userEvent.click(rail.getByRole("button", { name: "Actions for alpha" }));
    await userEvent.click(rail.getByRole("button", { name: "Close session alpha" }));

    // It DELETEd the session server-side (204 resolved cleanly) and dropped it from the store.
    await waitFor(() => expect(deleted).toContain("a"));
    await waitFor(() => expect(useStore.getState().sessions.map((s) => s.id)).toEqual(["b"]));
    // Closing the active session reselected the only remaining one (the new top).
    await waitFor(() => expect(useStore.getState().activeSessionId).toBe("b"));
    // The closed row is gone from the rail and stays gone (no re-add on a clean 204).
    expect(rail.queryByRole("button", { name: "Close session alpha" })).not.toBeInTheDocument();
  });

  it("re-adds the row and surfaces an error when the close DELETE actually fails", async () => {
    // Override: DELETE fails with a 500 so the optimistic removal must be undone.
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (/\/sessions\/([^/?]+)$/.test(url) && init?.method === "DELETE") {
        return Promise.resolve(jsonResponse({ error: "boom" }, 500));
      }
      if (/\/sessions$/.test(url)) return Promise.resolve(jsonResponse({ sessions: [a, b] }));
      const m = url.match(/\/sessions\/([^/?]+)/);
      if (m) return Promise.resolve(jsonResponse({ session: m[1] === "a" ? a : b, history: [] }));
      return Promise.resolve(jsonResponse({}, 404));
    });
    saveToken("good-token");
    render(<App />);
    await screen.findByRole("button", { name: /show sessions/i });
    await userEvent.click(screen.getByRole("button", { name: /show sessions/i }));
    const rail = within(screen.getByTestId("sessions-rail"));

    await userEvent.click(rail.getByRole("button", { name: "Actions for alpha" }));
    await userEvent.click(rail.getByRole("button", { name: "Close session alpha" }));

    // The failed close is surfaced (not silently swallowed) and the row reappears.
    expect(await screen.findByRole("alert")).toHaveTextContent(/boom/i);
    await waitFor(() =>
      expect(
        useStore
          .getState()
          .sessions.map((s) => s.id)
          .sort(),
      ).toEqual(["a", "b"]),
    );
  });

  it("closing the last session clears the selection to the empty/landing state", async () => {
    saveToken("good-token");
    fetchMock.mockImplementationOnce(() => Promise.resolve(jsonResponse({ sessions: [a] })));
    render(<App />);
    await screen.findByRole("button", { name: /show sessions/i });
    await userEvent.click(screen.getByRole("button", { name: /show sessions/i }));
    const rail = within(screen.getByTestId("sessions-rail"));
    await userEvent.click(rail.getByText("alpha"));
    await waitFor(() => expect(useStore.getState().activeSessionId).toBe("a"));
    await userEvent.click(screen.getByRole("button", { name: /show sessions/i }));

    await userEvent.click(rail.getByRole("button", { name: "Actions for alpha" }));
    await userEvent.click(rail.getByRole("button", { name: "Close session alpha" }));
    await waitFor(() => expect(useStore.getState().sessions).toEqual([]));
    await waitFor(() => expect(useStore.getState().activeSessionId).toBeUndefined());
  });

  it("reselects the visible activity-order top after closing the active session", async () => {
    const c: SessionMeta = {
      id: "c",
      cwd: "/home/u/gamma",
      dangerouslySkip: false,
      status: "running",
      createdAt: 3,
      lastActivityAt: 20,
    };
    localStorage.setItem("roamcode.session-order", "activity");
    saveToken("good-token");
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "DELETE") return Promise.resolve(new Response(null, { status: 204 }));
      if (/\/sessions$/.test(url))
        return Promise.resolve(
          jsonResponse({ sessions: [{ ...a, lastActivityAt: 100 }, { ...b, lastActivityAt: 30 }, c] }),
        );
      const match = url.match(/\/sessions\/([^/?]+)/);
      if (match)
        return Promise.resolve(jsonResponse({ session: match[1] === "a" ? a : match[1] === "b" ? b : c, history: [] }));
      return Promise.resolve(jsonResponse({}, 404));
    });

    render(<App />);
    await screen.findByRole("button", { name: /show sessions/i });
    await userEvent.click(screen.getByRole("button", { name: /show sessions/i }));
    const rail = within(screen.getByTestId("sessions-rail"));
    expect(
      rail.getAllByRole("button", { name: /actions for/i }).map((node) => node.getAttribute("aria-label")),
    ).toEqual(["Actions for alpha", "Actions for beta", "Actions for gamma"]);
    await userEvent.click(rail.getByText("alpha"));
    await waitFor(() => expect(useStore.getState().activeSessionId).toBe("a"));
    await userEvent.click(screen.getByRole("button", { name: /show sessions/i }));
    await userEvent.click(rail.getByRole("button", { name: "Actions for alpha" }));
    await userEvent.click(rail.getByRole("button", { name: "Close session alpha" }));
    await waitFor(() => expect(useStore.getState().activeSessionId).toBe("b"));
  });

  it("reselects the first filtered rail row instead of a higher-ranked hidden session", async () => {
    const visibleAlpha: SessionMeta = {
      ...a,
      cwd: "/home/u/visible-alpha",
      createdAt: 3,
    };
    const hidden: SessionMeta = {
      id: "hidden",
      cwd: "/home/u/hidden",
      dangerouslySkip: false,
      status: "running",
      createdAt: 2,
    };
    const visibleBeta: SessionMeta = {
      ...b,
      cwd: "/home/u/visible-beta",
      createdAt: 1,
    };
    const all = [visibleAlpha, hidden, visibleBeta];
    saveToken("good-token");
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "DELETE") return Promise.resolve(new Response(null, { status: 204 }));
      if (/\/sessions$/.test(url)) return Promise.resolve(jsonResponse({ sessions: all }));
      const match = url.match(/\/sessions\/([^/?]+)/);
      if (match) {
        const session = all.find((item) => item.id === match[1]);
        return Promise.resolve(jsonResponse({ session, history: [] }));
      }
      return Promise.resolve(jsonResponse({}, 404));
    });

    render(<App />);
    await screen.findByRole("button", { name: /show sessions/i });
    await waitFor(() =>
      expect(useStore.getState().sessions.map((session) => session.id)).toEqual(["a", "hidden", "b"]),
    );
    act(() => useStore.getState().setActive("a"));
    await waitFor(() => expect(useStore.getState().activeSessionId).toBe("a"));
    await userEvent.click(screen.getByRole("button", { name: /show sessions/i }));
    const rail = within(screen.getByTestId("sessions-rail"));
    await userEvent.type(rail.getByRole("textbox", { name: /filter sessions/i }), "visible");
    expect(rail.queryByText("hidden")).not.toBeInTheDocument();
    expect(
      rail.getAllByRole("button", { name: /actions for/i }).map((node) => node.getAttribute("aria-label")),
    ).toEqual(["Actions for visible-alpha", "Actions for visible-beta"]);

    await userEvent.click(rail.getByRole("button", { name: "Actions for visible-alpha" }));
    await userEvent.click(rail.getByRole("button", { name: "Close session visible-alpha" }));

    await waitFor(() => expect(useStore.getState().activeSessionId).toBe("b"));
  });
});

// ---------------------------------------------------------------------------------------------
// Session refresh poll + policy-sort-not-select: a focus-triggered GET /sessions refresh updates
// status/awaiting and drops a vanished session WITHOUT disturbing the active session's live view;
// and selecting a session never reorders the rail.
// ---------------------------------------------------------------------------------------------
describe("App — session list refresh + select-doesn't-reorder", () => {
  const a: SessionMeta = {
    id: "a",
    cwd: "/home/u/alpha",
    dangerouslySkip: false,
    status: "running",
    createdAt: 1,
    lastActivityAt: 10,
  };
  const b: SessionMeta = {
    id: "b",
    cwd: "/home/u/beta",
    dangerouslySkip: false,
    status: "running",
    createdAt: 2,
    lastActivityAt: 20,
  };

  let realWS: typeof WebSocket;
  beforeEach(() => {
    realWS = globalThis.WebSocket;
    class NoopWS {
      static readonly OPEN = 1;
      readyState = 1;
      onopen: (() => void) | null = null;
      onmessage: (() => void) | null = null;
      onclose: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor() {
        queueMicrotask(() => this.onopen?.());
      }
      send() {}
      close() {}
    }
    globalThis.WebSocket = NoopWS as unknown as typeof WebSocket;
  });
  afterEach(() => {
    globalThis.WebSocket = realWS;
  });

  it("defaults to stable created order and applies a persisted activity-order change immediately", async () => {
    const stableA = { ...a, createdAt: 1, lastActivityAt: 100 };
    const stableB = { ...b, createdAt: 2, lastActivityAt: 10 };
    saveToken("good-token");
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (/\/sessions$/.test(url)) return Promise.resolve(jsonResponse({ sessions: [stableA, stableB] }));
      return Promise.resolve(jsonResponse({}, 404));
    });

    render(<App />);
    await screen.findByRole("button", { name: /show sessions/i });
    await userEvent.click(screen.getByRole("button", { name: /show sessions/i }));
    const rail = within(screen.getByTestId("sessions-rail"));
    expect(
      rail.getAllByRole("button", { name: /actions for/i }).map((node) => node.getAttribute("aria-label")),
    ).toEqual(["Actions for beta", "Actions for alpha"]);

    await userEvent.click(rail.getByRole("button", { name: "Settings" }));
    await userEvent.selectOptions(screen.getByLabelText(/session order/i), "activity");
    expect(localStorage.getItem("roamcode.session-order")).toBe("activity");
    await userEvent.click(screen.getByRole("button", { name: "Close settings" }));
    await userEvent.click(screen.getByRole("button", { name: /show sessions/i }));
    const reopenedRail = within(screen.getByTestId("sessions-rail"));
    expect(
      reopenedRail.getAllByRole("button", { name: /actions for/i }).map((node) => node.getAttribute("aria-label")),
    ).toEqual(["Actions for alpha", "Actions for beta"]);
  });

  it("applies activity order immediately when localStorage persistence is blocked", async () => {
    const stableA = { ...a, createdAt: 1, lastActivityAt: 100 };
    const stableB = { ...b, createdAt: 2, lastActivityAt: 10 };
    saveToken("good-token");
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (/\/sessions$/.test(url)) return Promise.resolve(jsonResponse({ sessions: [stableA, stableB] }));
      return Promise.resolve(jsonResponse({}, 404));
    });

    render(<App />);
    await screen.findByRole("button", { name: /show sessions/i });
    await userEvent.click(screen.getByRole("button", { name: /show sessions/i }));
    const rail = within(screen.getByTestId("sessions-rail"));
    expect(
      rail.getAllByRole("button", { name: /actions for/i }).map((node) => node.getAttribute("aria-label")),
    ).toEqual(["Actions for beta", "Actions for alpha"]);

    await userEvent.click(rail.getByRole("button", { name: "Settings" }));
    const setItem = vi.fn(() => {
      throw new DOMException("storage blocked", "SecurityError");
    });
    vi.stubGlobal("localStorage", { setItem });
    await expect(userEvent.selectOptions(screen.getByLabelText(/session order/i), "activity")).resolves.toBeUndefined();
    expect(screen.getByLabelText(/session order/i)).toHaveValue("activity");
    expect(setItem).toHaveBeenCalledWith("roamcode.session-order", "activity");

    await userEvent.click(screen.getByRole("button", { name: "Close settings" }));
    await userEvent.click(screen.getByRole("button", { name: /show sessions/i }));
    const reopenedRail = within(screen.getByTestId("sessions-rail"));
    expect(
      reopenedRail.getAllByRole("button", { name: /actions for/i }).map((node) => node.getAttribute("aria-label")),
    ).toEqual(["Actions for alpha", "Actions for beta"]);
  });

  it("a focus-triggered refresh updates awaiting and drops a vanished session", async () => {
    saveToken("good-token");
    // First GET → both sessions (no awaiting). Later GETs → only `a`, now awaiting (b vanished).
    let polled = false;
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (/\/sessions$/.test(url)) {
        const list = polled ? [{ ...a, awaiting: true }] : [a, b];
        return Promise.resolve(jsonResponse({ sessions: list }));
      }
      const m = url.match(/\/sessions\/([^/?]+)/);
      if (m) return Promise.resolve(jsonResponse({ session: m[1] === "a" ? a : b, history: [] }));
      return Promise.resolve(jsonResponse({}, 404));
    });

    render(<App />);
    await screen.findByRole("button", { name: /show sessions/i });
    act(() => useStore.getState().setActive("a"));

    // Trigger the refresh via window focus; the next GET returns only `a` (awaiting), dropping `b`.
    polled = true;
    act(() => window.dispatchEvent(new Event("focus")));

    // The poll merged meta: b is dropped, a is now awaiting.
    await waitFor(() => expect(useStore.getState().sessions.map((s) => s.id)).toEqual(["a"]));
    await waitFor(() => expect(useStore.getState().sessions[0]!.awaiting).toBe(true));
  });

  it("provider-labels a single foreground needs-you alert", async () => {
    saveToken("good-token");
    let awaiting = false;
    const codex = { ...a, provider: "codex" as const, name: "Payments" };
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (/\/sessions$/.test(url)) {
        return Promise.resolve(jsonResponse({ sessions: [{ ...codex, awaiting }] }));
      }
      return Promise.resolve(jsonResponse({}, 404));
    });
    render(<App />);
    await screen.findByText("Payments");

    // Let the refresh loop seed its previous-awaiting baseline before creating the false→true edge.
    act(() => window.dispatchEvent(new Event("focus")));
    await waitFor(() => {
      const sessionReads = fetchMock.mock.calls.filter(([input]) => /\/sessions$/.test(String(input)));
      expect(sessionReads.length).toBeGreaterThanOrEqual(2);
    });

    awaiting = true;
    act(() => window.dispatchEvent(new Event("focus")));

    expect(await screen.findByRole("alert")).toHaveTextContent(/codex.*payments.*needs you/i);
  });

  it("selecting a session does NOT change the rail order (policy sort, not select)", async () => {
    saveToken("good-token");
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (/\/sessions$/.test(url)) return Promise.resolve(jsonResponse({ sessions: [a, b] }));
      const m = url.match(/\/sessions\/([^/?]+)/);
      if (m) return Promise.resolve(jsonResponse({ session: m[1] === "a" ? a : b, history: [] }));
      return Promise.resolve(jsonResponse({}, 404));
    });
    render(<App />);
    await screen.findByRole("button", { name: /show sessions/i });
    await userEvent.click(screen.getByRole("button", { name: /show sessions/i }));
    const rail = within(screen.getByTestId("sessions-rail"));

    // b has the newer createdAt (2 > 1), so the default stable policy sorts it first. Selecting `a` must NOT
    // float it to the top — the order stays b, a.
    // Each row's ⋯ is labelled by basename; their DOM order reflects rail order.
    const before = rail.getAllByRole("button", { name: /actions for/i }).map((el) => el.getAttribute("aria-label"));
    expect(before).toEqual(["Actions for beta", "Actions for alpha"]);
    await userEvent.click(rail.getByText("alpha"));
    await waitFor(() => expect(useStore.getState().activeSessionId).toBe("a"));
    await userEvent.click(screen.getByRole("button", { name: /show sessions/i }));
    const after = rail.getAllByRole("button", { name: /actions for/i }).map((el) => el.getAttribute("aria-label"));
    // Unchanged — viewing a chat did not reorder the rail.
    expect(after).toEqual(["Actions for beta", "Actions for alpha"]);
  });
});

// ---------------------------------------------------------------------------------------------
// APP BADGE: the home-screen badge reflects the "needs you" count (awaiting sessions), set via the
// feature-detected navigator.setAppBadge and cleared at 0.
// ---------------------------------------------------------------------------------------------
describe("App — home-screen app badge reflects the awaiting count", () => {
  let setAppBadge: ReturnType<typeof vi.fn>;
  let clearAppBadge: ReturnType<typeof vi.fn>;
  let realWS: typeof WebSocket;

  beforeEach(() => {
    setAppBadge = vi.fn(async () => {});
    clearAppBadge = vi.fn(async () => {});
    (navigator as unknown as { setAppBadge: unknown }).setAppBadge = setAppBadge;
    (navigator as unknown as { clearAppBadge: unknown }).clearAppBadge = clearAppBadge;
    realWS = globalThis.WebSocket;
    class NoopWS {
      static readonly OPEN = 1;
      readyState = 1;
      onopen: (() => void) | null = null;
      onmessage: (() => void) | null = null;
      onclose: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor() {
        queueMicrotask(() => this.onopen?.());
      }
      send() {}
      close() {}
    }
    globalThis.WebSocket = NoopWS as unknown as typeof WebSocket;
  });
  afterEach(() => {
    globalThis.WebSocket = realWS;
    delete (navigator as unknown as { setAppBadge?: unknown }).setAppBadge;
    delete (navigator as unknown as { clearAppBadge?: unknown }).clearAppBadge;
  });

  it("sets the badge to the number of awaiting sessions on load", async () => {
    saveToken("good-token");
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        sessions: [
          { id: "s1", cwd: "/home/u/a", dangerouslySkip: false, status: "running", createdAt: 1, awaiting: true },
          { id: "s2", cwd: "/home/u/b", dangerouslySkip: false, status: "running", createdAt: 2, awaiting: true },
          { id: "s3", cwd: "/home/u/c", dangerouslySkip: false, status: "running", createdAt: 3 },
        ],
      }),
    );
    render(<App />);
    await screen.findByRole("button", { name: /show sessions/i });
    await waitFor(() => expect(setAppBadge).toHaveBeenCalledWith(2));
  });

  it("clears the badge when no session is awaiting", async () => {
    saveToken("good-token");
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        sessions: [{ id: "s1", cwd: "/home/u/a", dangerouslySkip: false, status: "running", createdAt: 1 }],
      }),
    );
    render(<App />);
    await screen.findByRole("button", { name: /show sessions/i });
    await waitFor(() => expect(clearAppBadge).toHaveBeenCalled());
    expect(setAppBadge).not.toHaveBeenCalled();
  });
});

describe("App notification deep-link (?session=)", () => {
  const deepSession: SessionMeta = {
    id: "deep-1",
    cwd: "/home/u/deep",
    dangerouslySkip: false,
    status: "running",
    createdAt: 1,
  };

  function setSearch(search: string) {
    // jsdom's location is configurable; replace search and reset pathname so we can assert the clear.
    window.history.replaceState({}, "", "/index.html" + search);
  }

  afterEach(() => {
    window.history.replaceState({}, "", "/");
  });

  it("with ?session=<known-id> on load, selects that session and clears the query param", async () => {
    setSearch("?session=deep-1");
    saveToken("good-token");
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (/\/sessions$/.test(url)) return Promise.resolve(jsonResponse({ sessions: [deepSession] }));
      return Promise.resolve(jsonResponse({ session: deepSession, history: [] }));
    });

    render(<App />);

    // The deep-linked session becomes active (the store reflects it).
    await waitFor(() => expect(useStore.getState().activeSessionId).toBe("deep-1"));
    // The query param is stripped so a refresh won't re-trigger the deep link.
    expect(window.location.search).toBe("");
  });

  it("with an UNKNOWN ?session id, does not crash and falls back to the normal view", async () => {
    setSearch("?session=does-not-exist");
    saveToken("good-token");
    fetchMock.mockResolvedValueOnce(jsonResponse({ sessions: [deepSession] }));

    render(<App />);

    // Reaches the ready state (the always-visible mobile toggle proves no crash on the unknown id).
    await screen.findByRole("button", { name: /show sessions/i });
    // The unknown id was still "selected" (harmless), and the active ChatView falls back gracefully.
    expect(await screen.findByText(/session not found/i)).toBeInTheDocument();
    // The param is cleared regardless of whether the id resolved.
    expect(window.location.search).toBe("");
  });

  it("with NO ?session param, loads normally without selecting a session", async () => {
    saveToken("good-token");
    fetchMock.mockResolvedValueOnce(jsonResponse({ sessions: [deepSession] }));

    render(<App />);

    await screen.findByRole("button", { name: /show sessions/i });
    expect(useStore.getState().activeSessionId).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------
// Full-app flow (Task 12): drives the REAL App end-to-end with `fetch` + `WebSocket` stubbed.
// login → empty list → new-session wizard (directory picker) → chat → streamed text →
// permission prompt → answer over WS → result clears the prompt. Proves every screen connects.
// ---------------------------------------------------------------------------------------------
