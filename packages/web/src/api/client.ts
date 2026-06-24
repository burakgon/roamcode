import type { DirListing, ResumableSession, ServerFrame, SessionMeta } from "../types/server";

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export interface CreateSessionBody {
  /** Required for a fresh session; optional when resuming (the transcript supplies the cwd). */
  cwd?: string;
  model?: string;
  effort?: string;
  addDirs?: string[];
  dangerouslySkip?: boolean;
  /** Resume a past conversation by its session id — the server seeds the replay buffer from the
   * on-disk transcript so the prior thread replays into the chat on WS connect. */
  resumeSessionId?: string;
}

export interface ApiClient {
  listSessions(): Promise<SessionMeta[]>;
  /** Past, resumable conversations (recent-first). Optionally scoped to a `cwd`. */
  getResumable(cwd?: string): Promise<ResumableSession[]>;
  getSession(id: string): Promise<{ session: SessionMeta; history: ServerFrame[] }>;
  createSession(body: CreateSessionBody): Promise<SessionMeta>;
  /** Close a session: DELETE /sessions/:id → 204 (no body). Removes it from the list + store while
   * keeping the transcript (still resumable via /resume). Idempotent server-side, so deleting an
   * already-gone session also resolves. Rejects (ApiError) only on a real failure (e.g. 5xx/network). */
  deleteSession(id: string): Promise<void>;
  /** Legacy stop endpoint (Settings "Stop session"): POST /sessions/:id/stop. Now also fully removes
   * the session server-side. 404 when already gone. */
  stopSession(id: string): Promise<void>;
  listDir(path?: string): Promise<DirListing>;
  uploadFile(dir: string, file: File): Promise<{ path: string }>;
  downloadUrl(path: string): string;
  getVapidPublicKey(): Promise<string>;
  subscribePush(sub: PushSubscriptionJSON): Promise<void>;
  unsubscribePush(endpoint: string): Promise<void>;
}

export interface ApiClientOptions {
  baseUrl: string;
  getToken: () => string | undefined;
}

export function wsUrl(baseUrl: string, id: string, opts: { token?: string; since?: number }): string {
  const wsBase = baseUrl.replace(/^http/, "ws");
  const params = new URLSearchParams();
  if (opts.token) params.set("token", opts.token);
  if (opts.since !== undefined) params.set("since", String(opts.since));
  const qs = params.toString();
  return `${wsBase}/sessions/${id}/ws${qs ? `?${qs}` : ""}`;
}

export function createApiClient(opts: ApiClientOptions): ApiClient {
  const { baseUrl, getToken } = opts;

  function headers(extra?: Record<string, string>): Record<string, string> {
    const h: Record<string, string> = { ...extra };
    const token = getToken();
    if (token) h.authorization = `Bearer ${token}`;
    return h;
  }

  async function errorFor(res: Response): Promise<ApiError> {
    let message = `request failed (${res.status})`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // non-JSON error body — keep the default message
    }
    return new ApiError(res.status, message);
  }

  async function req<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${baseUrl}${path}`, init);
    if (!res.ok) throw await errorFor(res);
    return (await res.json()) as T;
  }

  /** For endpoints that resolve with no JSON body (e.g. DELETE → 204 No Content). A non-2xx still
   * throws ApiError (so a real failure surfaces); a 204 with an empty body resolves WITHOUT trying to
   * parse JSON (parsing an empty 204 body throws and would otherwise look like a failure). */
  async function reqNoBody(path: string, init?: RequestInit): Promise<void> {
    const res = await fetch(`${baseUrl}${path}`, init);
    if (!res.ok) throw await errorFor(res);
  }

  return {
    async listSessions() {
      const body = await req<{ sessions: SessionMeta[] }>("/sessions", { headers: headers() });
      return body.sessions;
    },
    async getResumable(cwd) {
      const qs = cwd ? `?cwd=${encodeURIComponent(cwd)}` : "";
      const body = await req<{ sessions: ResumableSession[] }>(`/resumable${qs}`, { headers: headers() });
      return body.sessions;
    },
    async getSession(id) {
      return req<{ session: SessionMeta; history: ServerFrame[] }>(`/sessions/${id}`, { headers: headers() });
    },
    async createSession(body) {
      const created = await req<{ session: SessionMeta }>("/sessions", {
        method: "POST",
        headers: headers({ "content-type": "application/json" }),
        body: JSON.stringify(body),
      });
      return created.session;
    },
    async deleteSession(id) {
      // 204 No Content — do NOT parse a body. A real failure (5xx/network) rejects via ApiError so the
      // caller can surface it / undo the optimistic removal.
      await reqNoBody(`/sessions/${id}`, { method: "DELETE", headers: headers() });
    },
    async stopSession(id) {
      await req<{ ok: true }>(`/sessions/${id}/stop`, { method: "POST", headers: headers() });
    },
    async listDir(path) {
      const qs = path ? `?path=${encodeURIComponent(path)}` : "";
      return req<DirListing>(`/fs/list${qs}`, { headers: headers() });
    },
    async uploadFile(dir, file) {
      const form = new FormData();
      form.append("file", file, file.name);
      const res = await fetch(`${baseUrl}/fs/upload?dir=${encodeURIComponent(dir)}`, {
        method: "POST",
        headers: headers(), // do NOT set content-type; the browser sets the multipart boundary
        body: form,
      });
      if (!res.ok) {
        let message = `upload failed (${res.status})`;
        try {
          const body = (await res.json()) as { error?: string };
          if (body.error) message = body.error;
        } catch {
          // ignore
        }
        throw new ApiError(res.status, message);
      }
      return (await res.json()) as { path: string };
    },
    downloadUrl(path) {
      const token = getToken();
      const tokenParam = token ? `&token=${encodeURIComponent(token)}` : "";
      return `${baseUrl}/fs/download?path=${encodeURIComponent(path)}${tokenParam}`;
    },
    async getVapidPublicKey() {
      const body = await req<{ publicKey: string }>("/push/vapid", { headers: headers() });
      return body.publicKey;
    },
    async subscribePush(sub) {
      await req<{ ok: true }>("/push/subscribe", {
        method: "POST",
        headers: headers({ "content-type": "application/json" }),
        body: JSON.stringify({ endpoint: sub.endpoint, keys: sub.keys }),
      });
    },
    async unsubscribePush(endpoint) {
      await req<{ ok: true }>("/push/unsubscribe", {
        method: "POST",
        headers: headers({ "content-type": "application/json" }),
        body: JSON.stringify({ endpoint }),
      });
    },
  };
}
