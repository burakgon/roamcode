import type { DirListing, ServerFrame, SessionMeta } from "../types/server";

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export interface CreateSessionBody {
  cwd: string;
  model?: string;
  effort?: string;
  addDirs?: string[];
  dangerouslySkip?: boolean;
}

export interface ApiClient {
  listSessions(): Promise<SessionMeta[]>;
  getSession(id: string): Promise<{ session: SessionMeta; history: ServerFrame[] }>;
  createSession(body: CreateSessionBody): Promise<SessionMeta>;
  stopSession(id: string): Promise<void>;
  listDir(path?: string): Promise<DirListing>;
  uploadFile(dir: string, file: File): Promise<{ path: string }>;
  downloadUrl(path: string): string;
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

  async function req<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${baseUrl}${path}`, init);
    if (!res.ok) {
      let message = `request failed (${res.status})`;
      try {
        const body = (await res.json()) as { error?: string };
        if (body.error) message = body.error;
      } catch {
        // non-JSON error body — keep the default message
      }
      throw new ApiError(res.status, message);
    }
    return (await res.json()) as T;
  }

  return {
    async listSessions() {
      const body = await req<{ sessions: SessionMeta[] }>("/sessions", { headers: headers() });
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
  };
}
