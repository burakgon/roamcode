import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApiClient, ApiError, wsUrl } from "./client";

const baseUrl = "http://127.0.0.1:4280";
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("ApiClient", () => {
  it("listSessions GETs /sessions with a bearer token and returns the array", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ sessions: [{ id: "s1", cwd: "/p", dangerouslySkip: false, status: "running", createdAt: 1 }] }));
    const api = createApiClient({ baseUrl, getToken: () => "tok" });
    const sessions = await api.listSessions();
    expect(sessions).toHaveLength(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${baseUrl}/sessions`);
    expect((init as RequestInit).headers).toMatchObject({ authorization: "Bearer tok" });
  });

  it("createSession POSTs the body and returns session", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ session: { id: "s2", cwd: "/x", dangerouslySkip: false, status: "running", createdAt: 2 } }, 201));
    const api = createApiClient({ baseUrl, getToken: () => undefined });
    const s = await api.createSession({ cwd: "/x", model: "opus" });
    expect(s.id).toBe("s2");
    const [, init] = fetchMock.mock.calls[0]!;
    expect((init as RequestInit).method).toBe("POST");
    expect(JSON.parse((init as RequestInit).body as string)).toMatchObject({ cwd: "/x", model: "opus" });
  });

  it("throws ApiError with status 401 on unauthorized", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "unauthorized" }, 401));
    const api = createApiClient({ baseUrl, getToken: () => "bad" });
    await expect(api.listSessions()).rejects.toMatchObject({ status: 401 });
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "unauthorized" }, 401));
    await expect(api.listSessions()).rejects.toBeInstanceOf(ApiError);
  });

  it("listDir GETs /fs/list with the path query", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ path: "/home", entries: [] }));
    const api = createApiClient({ baseUrl, getToken: () => undefined });
    await api.listDir("/home/u");
    expect(fetchMock.mock.calls[0]![0]).toBe(`${baseUrl}/fs/list?path=${encodeURIComponent("/home/u")}`);
  });

  it("downloadUrl includes path and token", () => {
    const api = createApiClient({ baseUrl, getToken: () => "tok" });
    expect(api.downloadUrl("/home/u/a.txt")).toBe(`${baseUrl}/fs/download?path=${encodeURIComponent("/home/u/a.txt")}&token=tok`);
  });
});

describe("wsUrl", () => {
  it("builds a ws:// url with token and since", () => {
    expect(wsUrl("http://127.0.0.1:4280", "abc", { token: "t", since: 12 })).toBe("ws://127.0.0.1:4280/sessions/abc/ws?token=t&since=12");
  });
  it("omits absent params and upgrades https->wss", () => {
    expect(wsUrl("https://host", "abc", {})).toBe("wss://host/sessions/abc/ws");
  });
});
