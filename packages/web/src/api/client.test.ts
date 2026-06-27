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
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ sessions: [{ id: "s1", cwd: "/p", dangerouslySkip: false, status: "running", createdAt: 1 }] }),
    );
    const api = createApiClient({ baseUrl, getToken: () => "tok" });
    const sessions = await api.listSessions();
    expect(sessions).toHaveLength(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${baseUrl}/sessions`);
    expect((init as RequestInit).headers).toMatchObject({ authorization: "Bearer tok" });
  });

  it("createSession POSTs the body and returns session", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ session: { id: "s2", cwd: "/x", dangerouslySkip: false, status: "running", createdAt: 2 } }, 201),
    );
    const api = createApiClient({ baseUrl, getToken: () => undefined });
    const s = await api.createSession({ cwd: "/x", model: "opus" });
    expect(s.id).toBe("s2");
    const [, init] = fetchMock.mock.calls[0]!;
    expect((init as RequestInit).method).toBe("POST");
    expect(JSON.parse((init as RequestInit).body as string)).toMatchObject({ cwd: "/x", model: "opus" });
  });

  it("getResumable GETs /resumable and returns the rows", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        sessions: [
          { sessionId: "r1", cwd: "/p", summary: "fix it", lastActivity: 9, messageCount: 4, gitBranch: "main" },
        ],
      }),
    );
    const api = createApiClient({ baseUrl, getToken: () => "tok" });
    const rows = await api.getResumable();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.sessionId).toBe("r1");
    expect(fetchMock.mock.calls[0]![0]).toBe(`${baseUrl}/resumable`);
  });

  it("getResumable passes the cwd query when scoped", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ sessions: [] }));
    const api = createApiClient({ baseUrl, getToken: () => undefined });
    await api.getResumable("/home/u/proj");
    expect(fetchMock.mock.calls[0]![0]).toBe(`${baseUrl}/resumable?cwd=${encodeURIComponent("/home/u/proj")}`);
  });

  it("createSession passes resumeSessionId when resuming", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ session: { id: "r1", cwd: "/x", dangerouslySkip: false, status: "running", createdAt: 3 } }),
    );
    const api = createApiClient({ baseUrl, getToken: () => undefined });
    const s = await api.createSession({ resumeSessionId: "r1" });
    expect(s.id).toBe("r1");
    expect(JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string)).toMatchObject({
      resumeSessionId: "r1",
    });
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

  it("deleteSession DELETEs /sessions/:id and resolves on a 204 with no body", async () => {
    // A 204 No Content with an empty body — the client must NOT try to parse JSON (that would throw).
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    const api = createApiClient({ baseUrl, getToken: () => "tok" });
    await expect(api.deleteSession("s1")).resolves.toBeUndefined();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${baseUrl}/sessions/s1`);
    expect((init as RequestInit).method).toBe("DELETE");
    expect((init as RequestInit).headers).toMatchObject({ authorization: "Bearer tok" });
  });

  it("deleteSession rejects with ApiError on a real failure (5xx)", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "boom" }, 500));
    const api = createApiClient({ baseUrl, getToken: () => "tok" });
    await expect(api.deleteSession("s1")).rejects.toMatchObject({ status: 500, message: "boom" });
  });

  it("downloadUrl includes path and token", () => {
    const api = createApiClient({ baseUrl, getToken: () => "tok" });
    expect(api.downloadUrl("/home/u/a.txt")).toBe(
      `${baseUrl}/fs/download?path=${encodeURIComponent("/home/u/a.txt")}&token=tok`,
    );
  });

  it("getVersion GETs /version and returns the version info", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        current: "v2026.06.20 · a",
        latest: "v2026.06.25 · b",
        behind: 2,
        updatable: true,
        updateAvailable: true,
        changelog: [{ sha: "b", subject: "new", group: "new", when: "2h", date: "2026-06-25T10:00:00Z" }],
      }),
    );
    const api = createApiClient({ baseUrl, getToken: () => "tok" });
    const v = await api.getVersion();
    expect(v.behind).toBe(2);
    expect(v.updateAvailable).toBe(true);
    expect(fetchMock.mock.calls[0]![0]).toBe(`${baseUrl}/version`);
  });

  it("applyUpdate POSTs /update with confirm:true (resolves on a 202, no body)", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 202 }));
    const api = createApiClient({ baseUrl, getToken: () => "tok" });
    await expect(api.applyUpdate()).resolves.toBeUndefined();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${baseUrl}/update`);
    expect((init as RequestInit).method).toBe("POST");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ confirm: true });
  });

  it("applyUpdate rejects with ApiError when the server refuses (409)", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: "not a git checkout" }, 409));
    const api = createApiClient({ baseUrl, getToken: () => "tok" });
    await expect(api.applyUpdate()).rejects.toMatchObject({ status: 409 });
    await expect(api.applyUpdate()).rejects.toBeInstanceOf(ApiError);
  });

  it("getUpdateStatus GETs /update/status", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ state: "building", phase: "building" }));
    const api = createApiClient({ baseUrl, getToken: () => "tok" });
    const s = await api.getUpdateStatus();
    expect(s.state).toBe("building");
    expect(fetchMock.mock.calls[0]![0]).toBe(`${baseUrl}/update/status`);
  });

  it("getModels GETs /models and returns the list", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ models: [{ value: "opus[1m]", displayName: "Opus" }] }));
    const api = createApiClient({ baseUrl, getToken: () => undefined });
    const models = await api.getModels();
    expect(models).toEqual([{ value: "opus[1m]", displayName: "Opus" }]);
    expect(fetchMock.mock.calls[0]![0]).toBe(`${baseUrl}/models`);
  });
});

describe("wsUrl", () => {
  it("builds a ws:// url with token and since", () => {
    expect(wsUrl("http://127.0.0.1:4280", "abc", { token: "t", since: 12 })).toBe(
      "ws://127.0.0.1:4280/sessions/abc/ws?token=t&since=12",
    );
  });
  it("omits absent params and upgrades https->wss", () => {
    expect(wsUrl("https://host", "abc", {})).toBe("wss://host/sessions/abc/ws");
  });
});
