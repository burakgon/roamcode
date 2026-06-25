import { render, screen, act, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { saveToken, loadToken } from "./auth/token-store";
import { useStore } from "./store/store";
import type { OutboundFrame, SessionMeta } from "./types/server";

let fetchMock: ReturnType<typeof vi.fn>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

beforeEach(() => {
  localStorage.clear();
  // Reset the shared zustand singleton so tests don't leak state into each other.
  useStore.setState({ token: undefined, sessions: [], activeSessionId: undefined, views: {} });
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("App token validation on load", () => {
  it("with a stored token, validates via GET /sessions (200) and renders the session list", async () => {
    saveToken("good-token");
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        sessions: [{ id: "s1", cwd: "/home/u/remote-coder", dangerouslySkip: false, status: "running", createdAt: 1 }],
      }),
    );

    render(<App />);

    // The validated session shows up in the list (proof we hit /sessions and stored the result).
    expect(await screen.findByText("remote-coder")).toBeInTheDocument();
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

    // Close the ACTIVE session via its ✕.
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

    await userEvent.click(rail.getByRole("button", { name: "Close session alpha" }));
    await waitFor(() => expect(useStore.getState().sessions).toEqual([]));
    await waitFor(() => expect(useStore.getState().activeSessionId).toBeUndefined());
  });
});

// ---------------------------------------------------------------------------------------------
// Session refresh poll + activity-sort-not-select: a focus-triggered GET /sessions refresh updates
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

  it("a focus-triggered refresh updates awaiting and drops a vanished session, keeping the live view", async () => {
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
    // Activate `a` and seed a live view (a streamed delta) so we can prove the poll doesn't wipe it.
    act(() => useStore.getState().setActive("a"));
    act(() =>
      useStore.getState().applyFrame("a", {
        seq: 1,
        kind: "event",
        payload: {
          type: "stream_event",
          event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "live" } },
        },
      }),
    );
    expect(useStore.getState().viewFor("a").liveText).toBe("live");

    // Trigger the refresh via window focus; the next GET returns only `a` (awaiting), dropping `b`.
    polled = true;
    act(() => window.dispatchEvent(new Event("focus")));

    // The poll merged meta only: b is dropped, a is now awaiting — and a's live view is untouched.
    await waitFor(() => expect(useStore.getState().sessions.map((s) => s.id)).toEqual(["a"]));
    await waitFor(() => expect(useStore.getState().sessions[0]!.awaiting).toBe(true));
    expect(useStore.getState().viewFor("a").liveText).toBe("live");
  });

  it("selecting a session does NOT change the rail order (activity sort, not select)", async () => {
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

    // b has the newer lastActivityAt (20 > 10), so it sorts first. Selecting the OLDER `a` must NOT
    // float it to the top — the order stays b, a.
    const before = rail.getAllByRole("button", { name: /close session/i }).map((el) => el.getAttribute("aria-label"));
    expect(before).toEqual(["Close session beta", "Close session alpha"]);
    await userEvent.click(rail.getByText("alpha"));
    await waitFor(() => expect(useStore.getState().activeSessionId).toBe("a"));
    await userEvent.click(screen.getByRole("button", { name: /show sessions/i }));
    const after = rail.getAllByRole("button", { name: /close session/i }).map((el) => el.getAttribute("aria-label"));
    // Unchanged — viewing a chat did not reorder the rail.
    expect(after).toEqual(["Close session beta", "Close session alpha"]);
  });
});

// A WebSocket stub that reaches OPEN and captures outbound frames per session id (parsed from the
// connect URL). Lets us assert exactly which permission decisions ChatView sends for which session.
const wsSends: { sessionId: string; frame: OutboundFrame }[] = [];
class CapturingWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readonly OPEN = CapturingWebSocket.OPEN;
  readyState = CapturingWebSocket.OPEN; // open immediately so send() forwards
  onopen: (() => void) | null = null;
  onmessage: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readonly sessionId: string;
  constructor(url: string) {
    // URL shape: ws://host/sessions/<id>/ws?token=...
    this.sessionId = url.match(/\/sessions\/([^/]+)\/ws/)?.[1] ?? "";
    queueMicrotask(() => this.onopen?.());
  }
  send(data: string) {
    wsSends.push({ sessionId: this.sessionId, frame: JSON.parse(data) as OutboundFrame });
  }
  close() {}
}

describe("App — auto-allow rules are scoped per session (no cross-session leak)", () => {
  const sessionA: SessionMeta = {
    id: "a",
    cwd: "/home/u/proj-a",
    dangerouslySkip: false,
    status: "running",
    createdAt: 1,
  };
  const sessionB: SessionMeta = {
    id: "b",
    cwd: "/home/u/proj-b",
    dangerouslySkip: false,
    status: "running",
    createdAt: 2,
  };

  let realWS: typeof WebSocket;
  beforeEach(() => {
    wsSends.length = 0;
    realWS = globalThis.WebSocket;
    globalThis.WebSocket = CapturingWebSocket as unknown as typeof WebSocket;
    // Route REST: GET /sessions → both sessions; GET /sessions/<id> → empty history for that session.
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (/\/sessions$/.test(url)) return Promise.resolve(jsonResponse({ sessions: [sessionA, sessionB] }));
      const m = url.match(/\/sessions\/([^/?]+)/);
      if (m) {
        const session = m[1] === "a" ? sessionA : sessionB;
        return Promise.resolve(jsonResponse({ session, history: [] }));
      }
      return Promise.resolve(jsonResponse({}, 404));
    });
  });
  afterEach(() => {
    globalThis.WebSocket = realWS;
  });

  async function settle() {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  function pushPermission(sessionId: string, requestId: string, toolName: string, seq: number) {
    act(() => {
      useStore.getState().applyFrame(sessionId, {
        seq,
        kind: "permission",
        payload: { requestId, kind: "can_use_tool", toolName, toolInput: { file_path: "/tmp/x" } },
      });
    });
  }

  it("an 'Always allow <tool>' rule set in session A does NOT auto-allow the same tool in session B", async () => {
    saveToken("good-token");
    render(<App />);
    await screen.findByRole("button", { name: /show sessions/i });

    // Activate session A and let its ChatView mount + load (empty) history. The ChatHeader's
    // LiveWire carries an aria-label naming the active session — a unique marker of which session's
    // ChatView is mounted (the rail's per-row LiveWire has no label).
    act(() => useStore.getState().setActive("a"));
    await settle();
    expect(screen.getByLabelText(/^session proj-a/i)).toBeInTheDocument();

    // In A: a Write permission arrives; register the per-session "Always allow Write" rule.
    pushPermission("a", "a-r1", "Write", 99);
    await screen.findByRole("region", { name: /permission request/i });
    await userEvent.click(screen.getByRole("button", { name: /always allow write/i }));
    // A answered its own request allow, and the auto-allow indicator is visible in A.
    expect(wsSends).toContainEqual({
      sessionId: "a",
      frame: { type: "permission", requestId: "a-r1", decision: "allow" },
    });
    expect(screen.getByText(/auto-allow/i)).toBeInTheDocument();

    // Switch the active session to B — this must remount ChatView (key by session id) with fresh
    // per-instance auto-allow/answered state, NOT reuse A's component instance.
    act(() => useStore.getState().setActive("b"));
    await settle();
    expect(screen.getByLabelText(/^session proj-b/i)).toBeInTheDocument();
    // B starts with no auto-allow rules (the indicator from A must be gone).
    expect(screen.queryByText(/auto-allow/i)).not.toBeInTheDocument();

    // In B: a Write permission arrives for the SAME tool. It must PROMPT (not be silently allowed).
    pushPermission("b", "b-r1", "Write", 99);
    const region = await screen.findByRole("region", { name: /permission request/i });
    expect(region).toBeInTheDocument();
    expect(screen.getByText("Write")).toBeInTheDocument();

    // Critically: no auto-allow decision was ever sent for B's request — the gate held.
    expect(wsSends).not.toContainEqual({
      sessionId: "b",
      frame: { type: "permission", requestId: "b-r1", decision: "allow" },
    });
    expect(wsSends.filter((s) => s.sessionId === "b")).toHaveLength(0);
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

// A controllable fake WebSocket so the test can push frames into the chat view.
class FakeWS {
  static last: FakeWS | undefined;
  url: string;
  readyState = 1;
  OPEN = 1;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];
  constructor(url: string) {
    this.url = url;
    FakeWS.last = this;
    setTimeout(() => this.onopen?.(), 0);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
  push(frame: unknown) {
    act(() => this.onmessage?.({ data: JSON.stringify(frame) }));
  }
}

const flowSession: SessionMeta = {
  id: "sess-1",
  cwd: "/home/u/proj",
  dangerouslySkip: false,
  status: "running",
  createdAt: 1,
};

describe("App full flow", () => {
  let flowFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    localStorage.clear();
    useStore.setState({ token: undefined, sessions: [], activeSessionId: undefined, views: {} });
    FakeWS.last = undefined;
    vi.stubGlobal("WebSocket", FakeWS as unknown as typeof WebSocket);
    flowFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.endsWith("/sessions") && method === "GET") return jsonResponse({ sessions: [] });
      if (url.endsWith("/sessions") && method === "POST") return jsonResponse({ session: flowSession }, 201);
      if (url.includes("/fs/list")) return jsonResponse({ path: "/home/u", entries: [] });
      if (url.includes(`/sessions/${flowSession.id}`) && !url.includes("/stop")) {
        return jsonResponse({ session: flowSession, history: [] });
      }
      return jsonResponse({ error: "not found" }, 404);
    });
    vi.stubGlobal("fetch", flowFetch);
  });

  afterEach(() => vi.unstubAllGlobals());

  it("logs in, lists sessions, starts a new session, and renders streamed + permission frames", async () => {
    render(<App />);

    // 1) Login (tokenless dev path).
    await userEvent.click(await screen.findByRole("button", { name: /without a token/i }));

    // 2) Empty session list → open the wizard.
    await userEvent.click(await screen.findByRole("button", { name: /new session/i }));

    // 3) Directory picker → use the current dir → settings → start.
    await userEvent.click(await screen.findByRole("button", { name: /use this directory/i }));
    await userEvent.click(await screen.findByRole("button", { name: /start session/i }));

    // 4) The chat view for the created session renders (header shows the cwd).
    await waitFor(() => expect(screen.getByText("/home/u/proj")).toBeInTheDocument());

    // 5) Push a streamed text delta over the socket → it renders live.
    await waitFor(() => expect(FakeWS.last).toBeDefined());
    FakeWS.last!.push({
      seq: 1,
      kind: "event",
      payload: {
        type: "stream_event",
        event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Working on it" } },
      },
    });
    await waitFor(() => expect(screen.getByText(/working on it/i)).toBeInTheDocument());

    // 6) Push a permission frame → the iris awaiting-you prompt appears → answer Allow over WS.
    FakeWS.last!.push({
      seq: 2,
      kind: "permission",
      payload: {
        requestId: "req-1",
        kind: "hook_callback",
        toolName: "Write",
        toolInput: { file_path: "/home/u/proj/a.txt" },
      },
    });
    const region = await screen.findByRole("region", { name: /permission request/i });
    await userEvent.click(within(region).getByRole("button", { name: /^allow$/i }));
    expect(FakeWS.last!.sent.some((s) => s.includes("req-1") && s.includes("allow"))).toBe(true);

    // 7) A result frame clears the prompt.
    FakeWS.last!.push({
      seq: 3,
      kind: "result",
      payload: { type: "result", result: "Created the file", permissionDenials: [] },
    });
    await waitFor(() => expect(screen.queryByRole("region", { name: /permission request/i })).not.toBeInTheDocument());
    expect(screen.getByText(/created the file/i)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------------------------
// `/resume` slash command (client action): typing `/resume` in the chat composer opens the
// new-session wizard on its RESUME tab — a client-side UI action, NOT text sent to claude.
// ---------------------------------------------------------------------------------------------
describe("App — /resume slash command opens the resume picker", () => {
  const activeSession: SessionMeta = {
    id: "live-1",
    cwd: "/home/u/proj",
    dangerouslySkip: false,
    status: "running",
    createdAt: 1,
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
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (/\/resumable/.test(url)) {
        return Promise.resolve(
          jsonResponse({
            sessions: [
              { sessionId: "r-1", cwd: "/home/u/proj", summary: "Earlier work", lastActivity: 1, messageCount: 5 },
            ],
          }),
        );
      }
      if (/\/sessions$/.test(url)) return Promise.resolve(jsonResponse({ sessions: [activeSession] }));
      const m = url.match(/\/sessions\/([^/?]+)/);
      if (m) return Promise.resolve(jsonResponse({ session: activeSession, history: [] }));
      return Promise.resolve(jsonResponse({}, 404));
    });
  });
  afterEach(() => {
    globalThis.WebSocket = realWS;
  });

  it("typing /resume in the composer opens the wizard on the Resume tab (no message sent to claude)", async () => {
    saveToken("good-token");
    render(<App />);
    await screen.findByRole("button", { name: /show sessions/i });
    act(() => useStore.getState().setActive("live-1"));

    // Type the slash command and pick /resume from the menu (targeted by its hint — the bare
    // "/resume" text also appears as the textarea value once fully typed).
    const box = await screen.findByLabelText(/message claude/i);
    await userEvent.type(box, "/resume");
    await userEvent.click(screen.getByText(/resume a past session/i));

    // The resume picker opened (client-side action) with its tab selected — NOT the directory picker.
    expect(await screen.findByRole("dialog", { name: /resume a past session/i })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /resume/i })).toHaveAttribute("aria-selected", "true");
    expect(await screen.findByText("Earlier work")).toBeInTheDocument();
    // The composer cleared — the slash text was never sent to claude.
    expect(box.textContent).toBe("");
  });
});
