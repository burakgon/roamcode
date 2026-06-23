import { render, screen, act } from "@testing-library/react";
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
        sessions: [
          { id: "s1", cwd: "/home/u/remote-coder", dangerouslySkip: false, status: "running", createdAt: 1 },
        ],
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

  it("opens the new-session wizard (directory picker) from the New session button", async () => {
    await renderReady();
    // Open the sessions sheet to reach its New session button.
    await userEvent.click(screen.getByRole("button", { name: /show sessions/i }));
    // Listing the start directory once the picker mounts.
    fetchMock.mockResolvedValueOnce(jsonResponse({ path: "/home/u", entries: [] }));
    await userEvent.click(screen.getByRole("button", { name: /new session/i }));
    expect(await screen.findByRole("dialog", { name: /pick a directory/i })).toBeInTheDocument();
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
  const sessionA: SessionMeta = { id: "a", cwd: "/home/u/proj-a", dangerouslySkip: false, status: "running", createdAt: 1 };
  const sessionB: SessionMeta = { id: "b", cwd: "/home/u/proj-b", dangerouslySkip: false, status: "running", createdAt: 2 };

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
    expect(wsSends).toContainEqual({ sessionId: "a", frame: { type: "permission", requestId: "a-r1", decision: "allow" } });
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
