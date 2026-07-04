import type {
  ClaudeAuthStatus,
  DirListing,
  FsSearchResult,
  ModelInfo,
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
  /** Session kind — always "terminal" (a PTY-backed claude TUI over the binary terminal WebSocket). */
  mode?: "terminal";
}

export interface ApiClient {
  listSessions(): Promise<SessionMeta[]>;
  createSession(body: CreateSessionBody): Promise<SessionMeta>;
  /** Close a session: DELETE /sessions/:id → 204 (no body). Removes it from the list + store while
   * keeping the transcript (still resumable via /resume). Idempotent server-side, so deleting an
   * already-gone session also resolves. Rejects (ApiError) only on a real failure (e.g. 5xx/network). */
  deleteSession(id: string): Promise<void>;
  /** Rename a session SERVER-side: PATCH /sessions/:id {name} → 204. The server is the cross-device
   * source of truth for names; an empty (or whitespace-only) name is sent as null, which CLEARS it
   * (display falls back to the local label / cwd basename). */
  renameSession(id: string, name: string): Promise<void>;
  listDir(path?: string): Promise<DirListing>;
  /** Create a directory: POST /fs/mkdir {path} → {path}. A 409 (already exists) rejects with ApiError
   * so the picker can show its inline "already exists" instead of a generic failure. */
  mkdir(path: string): Promise<{ path: string }>;
  /** Deep directory search under `base`: GET /fs/search?q=&base= → up to 30 matches, shallowest-first.
   * Powers the picker's "Deeper matches" section (find a folder without clicking through the tree). */
  searchDirs(q: string, base?: string): Promise<FsSearchResult[]>;
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
  /** OTA rollback: POST /update/rollback {confirm:true} → restart onto the PREVIOUS running build. Shares
   * the /update/status lifecycle (same polling finishes/fails the flow); a 409/400 means no previous
   * build is recorded — the caller maps that to a human message. */
  rollbackUpdate(): Promise<void>;
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

/** How an ENDED session should come back when the terminal WS reattaches: `continue` respawns claude
 * with --continue (resume the last conversation in that cwd); `fresh` (or absent) spawns a fresh claude.
 * The server ignores the param for a still-running session, so carrying it on a retry is harmless. */
export type RespawnMode = "continue" | "fresh";

/**
 * The PREFERRED terminal WS URL builder: fetches a SINGLE-USE ~30s ticket (POST /ws-ticket) and connects
 * with `?ticket=` so the LONG-LIVED token stays out of WS URLs / proxy access logs. ANY failure (an old
 * server mid-OTA without the route, a network blip) falls back to the legacy `?token=` URL — connecting
 * always beats purity. Re-invoked per (re)connect attempt via the socket's async URL thunk, so every
 * attempt gets a fresh ticket (they're single-use by design).
 */
export async function terminalWsTicketUrl(
  id: string,
  cols?: number,
  rows?: number,
  respawn?: RespawnMode,
): Promise<string> {
  const token = loadToken();
  try {
    const res = await fetch(`${API_BASE_URL}/ws-ticket`, {
      method: "POST",
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
    if (res.ok) {
      const body = (await res.json()) as { ticket?: unknown };
      if (typeof body.ticket === "string" && body.ticket) {
        const params = new URLSearchParams({ ticket: body.ticket });
        if (Number.isInteger(cols) && (cols as number) > 0) params.set("cols", String(cols));
        if (Number.isInteger(rows) && (rows as number) > 0) params.set("rows", String(rows));
        if (respawn) params.set("respawn", respawn);
        return `${wsBaseFor(API_BASE_URL)}/sessions/${id}/terminal?${params.toString()}`;
      }
    }
  } catch {
    /* fall through to the legacy URL */
  }
  return terminalWsUrl(id, cols, rows, respawn);
}

/** The LEGACY binary terminal WebSocket url (`?token=`) for a terminal-mode session — the fallback for
 * terminalWsTicketUrl above (and old servers). The client passes its fitted `cols`/`rows` so the server
 * spawns the pty/tmux at the real viewport size (no first-paint reflow). `respawn` is appended ONLY when
 * set (the ended overlay's "Resume conversation" picks `continue`). */
export function terminalWsUrl(id: string, cols?: number, rows?: number, respawn?: RespawnMode): string {
  const extra: Record<string, string> = {};
  if (Number.isInteger(cols) && (cols as number) > 0) extra.cols = String(cols);
  if (Number.isInteger(rows) && (rows as number) > 0) extra.rows = String(rows);
  if (respawn) extra.respawn = respawn;
  const qs = authQuery(loadToken(), extra);
  return `${wsBaseFor(API_BASE_URL)}/sessions/${id}/terminal${qs ? `?${qs}` : ""}`;
}

/** Standalone (no api instance) view/download URL for a server-local file — for the terminal Files panel. */
export function terminalDownloadUrl(path: string): string {
  const token = loadToken();
  const tokenParam = token ? `&token=${encodeURIComponent(token)}` : "";
  return `${API_BASE_URL}/fs/download?path=${encodeURIComponent(path)}${tokenParam}`;
}

/** Upload a file for a terminal session: the server saves it in the app data dir, outside any project repo
 *  (created + pruned to a 7-day TTL server-side), and returns its absolute path — which the client hands to
 *  claude. */
export async function terminalUpload(sessionId: string, file: File): Promise<{ path: string }> {
  const token = loadToken();
  const form = new FormData();
  form.append("file", file, file.name);
  const res = await fetch(`${API_BASE_URL}/sessions/${encodeURIComponent(sessionId)}/upload`, {
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

  // Attach a request timeout so a server that accepts the connection but never responds can't strand the
  // loading UI ("Connecting…" / "Loading…" / "Starting…") forever. Respects a caller-supplied signal, and
  // degrades to no timeout where AbortSignal.timeout is unavailable (old engines / jsdom in tests).
  const DEFAULT_TIMEOUT_MS = 15_000;
  function withTimeout(init: RequestInit | undefined, ms = DEFAULT_TIMEOUT_MS): RequestInit {
    if (init?.signal) return init;
    const hasTimeout = typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function";
    return hasTimeout ? { ...init, signal: AbortSignal.timeout(ms) } : (init ?? {});
  }

  async function req<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${baseUrl}${path}`, withTimeout(init));
    if (!res.ok) throw await errorFor(res);
    return (await res.json()) as T;
  }

  /** For endpoints that resolve with no JSON body (e.g. DELETE → 204 No Content). A non-2xx still
   * throws ApiError (so a real failure surfaces); a 204 with an empty body resolves WITHOUT trying to
   * parse JSON (parsing an empty 204 body throws and would otherwise look like a failure). */
  async function reqNoBody(path: string, init?: RequestInit): Promise<void> {
    const res = await fetch(`${baseUrl}${path}`, withTimeout(init));
    if (!res.ok) throw await errorFor(res);
  }

  return {
    async listSessions() {
      const body = await req<{ sessions: SessionMeta[] }>("/sessions", { headers: headers() });
      return body.sessions;
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
    async renameSession(id, name) {
      // 204 No Content. Empty/whitespace → null, which CLEARS the server name (the contract treats
      // null/empty as "unset"); otherwise send the trimmed label (mirrors the local saveSessionName trim).
      const trimmed = name.trim();
      await reqNoBody(`/sessions/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: headers({ "content-type": "application/json" }),
        body: JSON.stringify({ name: trimmed === "" ? null : trimmed }),
      });
    },
    async listDir(path) {
      const qs = path ? `?path=${encodeURIComponent(path)}` : "";
      return req<DirListing>(`/fs/list${qs}`, { headers: headers() });
    },
    async mkdir(path) {
      // A 409 (exists) rejects via ApiError — the picker shows its inline "already exists" for it.
      return req<{ path: string }>("/fs/mkdir", {
        method: "POST",
        headers: headers({ "content-type": "application/json" }),
        body: JSON.stringify({ path }),
      });
    },
    async searchDirs(q, base) {
      const params = new URLSearchParams({ q });
      if (base) params.set("base", base);
      const body = await req<{ results: FsSearchResult[] }>(`/fs/search?${params.toString()}`, {
        headers: headers(),
      });
      return body.results;
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
    async rollbackUpdate() {
      // Same confirm double-gate as applyUpdate (a server-restarting action); rejects with ApiError on
      // 409/400 when there's no previous build recorded — the caller shows the human message.
      await reqNoBody("/update/rollback", {
        method: "POST",
        headers: headers({ "content-type": "application/json" }),
        body: JSON.stringify({ confirm: true }),
      });
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
