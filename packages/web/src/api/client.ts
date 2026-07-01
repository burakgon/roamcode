import type {
  ClaudeAuthStatus,
  DirListing,
  LiveState,
  ModelInfo,
  ResumableSession,
  ServerFrame,
  SessionMeta,
  UpdateStatus,
  UsageInfo,
  VersionInfo,
} from "../types/server";
import { loadToken, saveToken } from "../auth/token-store";
import { API_BASE_URL } from "../config";

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
  /** Starting permission mode (default | acceptEdits | plan) for a fresh session. */
  permissionMode?: string;
  /** Resume a past conversation by its session id — the server seeds the replay buffer from the
   * on-disk transcript so the prior thread replays into the chat on WS connect. */
  resumeSessionId?: string;
  /** Session kind: "chat" (the default Claude conversation) or "terminal" (a PTY-backed claude TUI
   * driven over the binary terminal WebSocket). Omitted defaults to "chat" server-side. */
  mode?: "chat" | "terminal";
}

export interface ApiClient {
  listSessions(): Promise<SessionMeta[]>;
  /** Past, resumable conversations (recent-first). Optionally scoped to a `cwd`. */
  getResumable(cwd?: string): Promise<ResumableSession[]>;
  /** Reopen a session: `history` is the FULL transcript (every user + assistant turn, correctly
   * typed); `sinceSeq` is the replay buffer's max seq — connect the WS with `?since=sinceSeq` so it
   * replays only NEW frames (no re-render of the shown history). */
  getSession(
    id: string,
    opts?: { full?: boolean },
  ): Promise<{
    session: SessionMeta;
    history: ServerFrame[];
    sinceSeq: number;
    truncated: boolean;
    total?: number;
    /** Server's live tail: whether a turn is in flight + the last result's usage — used to seed the
     *  switched-to chat's wire state + context meter (neither survives in the transcript). */
    live?: LiveState;
  }>;
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
  /** Upload an image (binary) to the content-addressed store (POST /images) → its `{ ref }`. The composer
   *  uploads on attach so the phone never uplinks base64; the WS `user` send then carries the ref. */
  uploadImage(file: File): Promise<{ ref: string }>;
  downloadUrl(path: string): string;
  /** Resolve a relative server media path (e.g. a file-backed image ref `/images/<ref>`) to an absolute,
   *  token-bearing URL usable as an <img src>. The token is appended (`?` or `&` as needed). */
  mediaUrl(relativePath: string): string;
  getVapidPublicKey(): Promise<string>;
  subscribePush(sub: PushSubscriptionJSON): Promise<void>;
  unsubscribePush(endpoint: string): Promise<void>;
  /** OTA self-update: GET /version → {current,latest,behind,updatable,updateAvailable,changelog}.
   * `force` (the in-app "Check for updates") bypasses the server's cached git check for a fresh fetch. */
  getVersion(force?: boolean): Promise<VersionInfo>;
  /** OTA: POST /update {confirm:true} → 202; the server spawns the detached pull+build+restart. */
  applyUpdate(): Promise<void>;
  /** OTA: GET /update/status → the detached updater's progress {state,phase,error?,target?,log?}. */
  getUpdateStatus(): Promise<UpdateStatus>;
  /** Claude usage limits: GET /usage → {usage: UsageInfo | null}. `null` when unavailable (the UI hides
   * the bars). The server TTL-caches the underlying spawn, so polling this is cheap. */
  getUsage(): Promise<UsageInfo | null>;
  /** Selectable models for the model dropdown: GET /models → {models}. Empty when unavailable
   * (the UI falls back to a free-text field). */
  getModels(): Promise<ModelInfo[]>;
  /** Rotate the single access token: POST /token/rotate (authed) → {token}. The OLD token is invalid the
   * instant this resolves, so the new token MUST be re-stored. Persists it to the token-store and returns
   * it so the caller can re-issue any token-bearing links (e.g. a fresh connect URL). */
  rotateToken(): Promise<string>;
  /** In-app Claude sign-in. `getAuthStatus` → which account is signed in (GET /auth/status). `startAuthLogin`
   * → an authorize URL the user opens in a browser (POST /auth/login/start). `submitAuthCode` → finish the
   * exchange with the pasted code (POST /auth/login/code). `cancelAuthLogin` → abandon it. */
  getAuthStatus(): Promise<ClaudeAuthStatus>;
  startAuthLogin(): Promise<{ loginId: string; url: string }>;
  submitAuthCode(loginId: string, code: string): Promise<{ ok: boolean; message?: string }>;
  cancelAuthLogin(): Promise<void>;
  /** The server's installed claude version + the latest published one (GET /claude/version), for the
   *  "update available" hint. Either may be null when unknown. */
  getClaudeVersion(): Promise<{ installed: string | null; latest: string | null }>;
}

export interface ApiClientOptions {
  baseUrl: string;
  getToken: () => string | undefined;
}

/** http(s) → ws(s) for a WebSocket base, shared by every WS url builder. */
function wsBaseFor(baseUrl: string): string {
  return baseUrl.replace(/^http/, "ws");
}

/** Build the `?token=…` query the WS gate accepts (a browser WebSocket can't set an Authorization
 * header, so the token MUST ride as a query param). Returns the query body WITHOUT the leading `?`
 * (empty when there's no token), so each builder appends it uniformly. Shared so token handling lives
 * in exactly one place. */
function authQuery(token?: string, extra?: Record<string, string>): string {
  const params = new URLSearchParams();
  if (token) params.set("token", token);
  for (const [k, v] of Object.entries(extra ?? {})) params.set(k, v);
  return params.toString();
}

export function wsUrl(baseUrl: string, id: string, opts: { token?: string; since?: number }): string {
  const qs = authQuery(opts.token, opts.since !== undefined ? { since: String(opts.since) } : undefined);
  return `${wsBaseFor(baseUrl)}/sessions/${id}/ws${qs ? `?${qs}` : ""}`;
}

/** The binary terminal WebSocket url for a terminal-mode session (PTY-backed claude TUI), sourcing the
 * app's base url + stored token itself so callers (TerminalView) pass only the session id. Reuses the
 * SAME `authQuery` token logic as `wsUrl` — no duplicated token handling. The client passes its fitted
 * `cols`/`rows` so the server spawns the pty/tmux at the real viewport size (no first-paint reflow). */
export function terminalWsUrl(id: string, cols?: number, rows?: number): string {
  const extra: Record<string, string> = {};
  if (Number.isInteger(cols) && (cols as number) > 0) extra.cols = String(cols);
  if (Number.isInteger(rows) && (rows as number) > 0) extra.rows = String(rows);
  const qs = authQuery(loadToken(), extra);
  return `${wsBaseFor(API_BASE_URL)}/sessions/${id}/terminal${qs ? `?${qs}` : ""}`;
}

/** Standalone (no api instance) view/download URL for a server-local file — for the terminal Files panel. */
export function terminalDownloadUrl(path: string): string {
  const token = loadToken();
  const tokenParam = token ? `&token=${encodeURIComponent(token)}` : "";
  return `${API_BASE_URL}/fs/download?path=${encodeURIComponent(path)}${tokenParam}`;
}

/** Standalone upload for the terminal Files panel: saves `file` under `dir` and returns its server path
 *  (an absolute path the user can hand to the terminal's claude). */
export async function terminalUpload(dir: string, file: File): Promise<{ path: string }> {
  const token = loadToken();
  const form = new FormData();
  form.append("file", file, file.name);
  const res = await fetch(`${API_BASE_URL}/fs/upload?dir=${encodeURIComponent(dir)}`, {
    method: "POST",
    headers: token ? { authorization: `Bearer ${token}` } : {},
    body: form,
  });
  if (!res.ok) {
    let message = `upload failed (${res.status})`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      /* ignore */
    }
    throw new Error(message);
  }
  return (await res.json()) as { path: string };
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
    async getSession(id, opts) {
      // Default: the server returns only the most-recent window of turns (fast open). `full` re-requests
      // the ENTIRE transcript — the explicit "load earlier" path.
      const qs = opts?.full ? "?full=1" : "";
      const body = await req<{
        session: SessionMeta;
        history: ServerFrame[];
        sinceSeq?: number;
        truncated?: boolean;
        total?: number;
        live?: LiveState;
      }>(`/sessions/${id}${qs}`, { headers: headers() });
      // sinceSeq is the WS-resume seq; default to 0 (full replay) if an older server omits it.
      return {
        session: body.session,
        history: body.history,
        sinceSeq: body.sinceSeq ?? 0,
        truncated: body.truncated ?? false,
        total: body.total,
        live: body.live,
      };
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
    async uploadImage(file) {
      const form = new FormData();
      form.append("file", file, file.name);
      const res = await fetch(`${baseUrl}/images`, {
        method: "POST",
        headers: headers(), // do NOT set content-type; the browser sets the multipart boundary
        body: form,
      });
      if (!res.ok) throw await errorFor(res);
      return (await res.json()) as { ref: string };
    },
    downloadUrl(path) {
      const token = getToken();
      const tokenParam = token ? `&token=${encodeURIComponent(token)}` : "";
      return `${baseUrl}/fs/download?path=${encodeURIComponent(path)}${tokenParam}`;
    },
    mediaUrl(relativePath) {
      const token = getToken();
      // The relative ref already includes a `?` query, so append the token with `&` (or `?` defensively
      // if a future ref has none). The browser's <img> GET can't set an Authorization header, so the
      // token MUST travel as a query param (the server's auth gate accepts `?token=`).
      const sep = relativePath.includes("?") ? "&" : "?";
      const tokenParam = token ? `${sep}token=${encodeURIComponent(token)}` : "";
      return `${baseUrl}${relativePath}${tokenParam}`;
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
    async getVersion(force?: boolean) {
      return req<VersionInfo>(`/version${force ? "?force=1" : ""}`, { headers: headers() });
    },
    async applyUpdate() {
      // POST /update {confirm:true} → 202. confirm is the double-gate for an RCE-by-design action
      // (the server rebuilds + restarts itself from our own repo); the token already gated the call.
      await reqNoBody("/update", {
        method: "POST",
        headers: headers({ "content-type": "application/json" }),
        body: JSON.stringify({ confirm: true }),
      });
    },
    async getUpdateStatus() {
      return req<UpdateStatus>("/update/status", { headers: headers() });
    },
    async getUsage() {
      const body = await req<{ usage: UsageInfo | null }>("/usage", { headers: headers() });
      return body.usage;
    },
    async getModels() {
      const body = await req<{ models: ModelInfo[] }>("/models", { headers: headers() });
      return body.models;
    },
    async rotateToken() {
      // POST with the CURRENT token; the server returns a fresh one and invalidates the old. Persist the
      // new token IMMEDIATELY so every subsequent request (whose `getToken` reads the store) uses it — the
      // old token is dead the moment this responds.
      const body = await req<{ token: string }>("/token/rotate", { method: "POST", headers: headers() });
      saveToken(body.token);
      return body.token;
    },
    async getAuthStatus() {
      return req<ClaudeAuthStatus>("/auth/status", { headers: headers() });
    },
    async startAuthLogin() {
      return req<{ loginId: string; url: string }>("/auth/login/start", { method: "POST", headers: headers() });
    },
    async submitAuthCode(loginId, code) {
      return req<{ ok: boolean; message?: string }>("/auth/login/code", {
        method: "POST",
        headers: headers({ "content-type": "application/json" }),
        body: JSON.stringify({ loginId, code }),
      });
    },
    async cancelAuthLogin() {
      await reqNoBody("/auth/login/cancel", { method: "POST", headers: headers() });
    },
    async getClaudeVersion() {
      return req<{ installed: string | null; latest: string | null }>("/claude/version", { headers: headers() });
    },
  };
}
