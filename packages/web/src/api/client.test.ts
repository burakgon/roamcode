import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApiClient, terminalWsUrl, ApiError } from "./client";

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

  it("rotateToken POSTs /token/rotate, returns the new token, and persists it to the token store", async () => {
    localStorage.clear();
    localStorage.setItem("remote-coder.token", "old-token");
    fetchMock.mockResolvedValueOnce(jsonResponse({ token: "fresh-token" }));
    const api = createApiClient({ baseUrl, getToken: () => "old-token" });
    const next = await api.rotateToken();
    expect(next).toBe("fresh-token");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${baseUrl}/token/rotate`);
    expect((init as RequestInit).method).toBe("POST");
    expect((init as RequestInit).headers).toMatchObject({ authorization: "Bearer old-token" });
    // The new token is stored so subsequent requests use it (the old one is dead server-side).
    expect(localStorage.getItem("remote-coder.token")).toBe("fresh-token");
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

  it("renameSession PATCHes /sessions/:id with the trimmed name (204, no body)", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    const api = createApiClient({ baseUrl, getToken: () => "tok" });
    await expect(api.renameSession("s1", "  My session  ")).resolves.toBeUndefined();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${baseUrl}/sessions/s1`);
    expect((init as RequestInit).method).toBe("PATCH");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ name: "My session" });
  });

  it("renameSession sends name:null for an empty string (clears the server name)", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    const api = createApiClient({ baseUrl, getToken: () => "tok" });
    await api.renameSession("s1", "   ");
    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ name: null });
  });

  it("rollbackUpdate POSTs /update/rollback with confirm:true and surfaces a 409 as ApiError", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 202 }));
    const api = createApiClient({ baseUrl, getToken: () => "tok" });
    await expect(api.rollbackUpdate()).resolves.toBeUndefined();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${baseUrl}/update/rollback`);
    expect((init as RequestInit).method).toBe("POST");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ confirm: true });
    // No previous build recorded → 409 rejects with the status the UI maps to its human message.
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "no previous build" }, 409));
    await expect(api.rollbackUpdate()).rejects.toMatchObject({ status: 409 });
  });

  it("mkdir POSTs /fs/mkdir with the path and rejects a 409 (exists) with ApiError", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ path: "/home/u/new-proj" }));
    const api = createApiClient({ baseUrl, getToken: () => "tok" });
    const created = await api.mkdir("/home/u/new-proj");
    expect(created).toEqual({ path: "/home/u/new-proj" });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${baseUrl}/fs/mkdir`);
    expect((init as RequestInit).method).toBe("POST");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ path: "/home/u/new-proj" });
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "exists" }, 409));
    await expect(api.mkdir("/home/u/new-proj")).rejects.toMatchObject({ status: 409 });
  });

  it("searchDirs GETs /fs/search with q + base and returns the results array", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ results: [{ path: "/home/u/deep/web", name: "web", isGitRepo: true }] }),
    );
    const api = createApiClient({ baseUrl, getToken: () => "tok" });
    const results = await api.searchDirs("web", "/home/u");
    expect(results).toEqual([{ path: "/home/u/deep/web", name: "web", isGitRepo: true }]);
    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toBe(`${baseUrl}/fs/search?q=web&base=${encodeURIComponent("/home/u")}`);
  });
});

describe("terminalWsUrl", () => {
  it("appends respawn ONLY when a mode is chosen (Resume conversation → respawn=continue)", () => {
    // Absent (fresh spawn / plain re-attach): no respawn key rides the query at all.
    expect(terminalWsUrl("s1", 80, 24)).not.toContain("respawn=");
    // The ended overlay's Resume: the same URL + respawn=continue.
    const resume = terminalWsUrl("s1", 80, 24, "continue");
    expect(resume).toContain("/sessions/s1/terminal");
    expect(resume).toContain("respawn=continue");
    expect(resume).toContain("cols=80");
    expect(resume).toContain("rows=24");
    // Explicit fresh is also expressible (the server treats absent and fresh identically).
    expect(terminalWsUrl("s1", 80, 24, "fresh")).toContain("respawn=fresh");
  });
});
