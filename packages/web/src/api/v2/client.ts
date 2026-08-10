import type { ApiClientOptions } from "../client";
import type {
  AgentRuntimeRecord,
  CreateNodeSessionInput,
  NodeRecord,
  NodeSessionResponse,
  ProductContext,
} from "./types";

export class ProductApiV2Error extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = "ProductApiV2Error";
  }
}

export interface ProductApiV2Client {
  getContext(): Promise<ProductContext>;
  listNodes(): Promise<NodeRecord[]>;
  getNode(nodeId: string): Promise<NodeRecord>;
  listNodeRuntimes(nodeId: string): Promise<AgentRuntimeRecord[]>;
  listNodeSessions(nodeId: string): Promise<NodeSessionResponse["session"][]>;
  createNodeSession(nodeId: string, input: CreateNodeSessionInput): Promise<NodeSessionResponse>;
}

const DEFAULT_TIMEOUT_MS = 15_000;

export function createProductApiV2Client(options: ApiClientOptions): ProductApiV2Client {
  const request = options.request ?? globalThis.fetch;
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  let mutationSequence = 0;

  function headers(json = false, mutation = false): Headers {
    const result = new Headers();
    const token = options.getToken();
    if (token) result.set("authorization", `Bearer ${token}`);
    if (json) result.set("content-type", "application/json");
    if (mutation) {
      mutationSequence += 1;
      const random = globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${mutationSequence.toString(36)}`;
      result.set("idempotency-key", `web-v2-${random}`);
    }
    return result;
  }

  function withTimeout(init: RequestInit): RequestInit {
    if (init.signal || typeof AbortSignal === "undefined" || typeof AbortSignal.timeout !== "function") return init;
    return { ...init, signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS) };
  }

  function isIdempotentMutation(init: RequestInit): boolean {
    return new Headers(init.headers).has("idempotency-key");
  }

  async function send(path: string, init: RequestInit): Promise<Response> {
    const url = `${baseUrl}${path}`;
    try {
      return await request(url, withTimeout(init));
    } catch (error) {
      // A mutation may have reached the server before the browser observed a network failure or timeout.
      // Replay it once with the exact same idempotency key/body so the durable server record returns the
      // original result instead of creating a second Session. HTTP responses are authoritative and are
      // never retried here; only fetch-level exceptions enter this branch.
      if (!isIdempotentMutation(init) || init.signal) throw error;
      return request(url, withTimeout(init));
    }
  }

  async function apiError(response: Response): Promise<ProductApiV2Error> {
    let body: unknown;
    let message = `request failed (${response.status})`;
    let code: string | undefined;
    try {
      body = await response.json();
      if (body && typeof body === "object") {
        const record = body as { error?: unknown; code?: unknown };
        if (typeof record.error === "string" && record.error) message = record.error;
        if (typeof record.code === "string" && record.code) code = record.code;
      }
    } catch {
      // Keep the bounded status-only error for non-JSON failures.
    }
    return new ProductApiV2Error(response.status, message, code, body);
  }

  async function req<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await send(path, init);
    if (!response.ok) throw await apiError(response);
    return (await response.json()) as T;
  }

  const nodePath = (nodeId: string) => `/api/v2/nodes/${encodeURIComponent(nodeId)}`;

  return {
    async getContext() {
      const body = await req<{ context: ProductContext }>("/api/v2/context", { headers: headers() });
      return body.context;
    },
    async listNodes() {
      const body = await req<{ nodes: NodeRecord[] }>("/api/v2/nodes", { headers: headers() });
      return body.nodes;
    },
    async getNode(nodeId) {
      const body = await req<{ node: NodeRecord }>(nodePath(nodeId), { headers: headers() });
      return body.node;
    },
    async listNodeRuntimes(nodeId) {
      const body = await req<{ runtimes: AgentRuntimeRecord[] }>(`${nodePath(nodeId)}/runtimes`, {
        headers: headers(),
      });
      return body.runtimes;
    },
    async listNodeSessions(nodeId) {
      const body = await req<{ sessions: NodeSessionResponse["session"][] }>(`${nodePath(nodeId)}/sessions`, {
        headers: headers(),
      });
      return body.sessions;
    },
    createNodeSession(nodeId, input) {
      return req<NodeSessionResponse>(`${nodePath(nodeId)}/sessions`, {
        method: "POST",
        headers: headers(true, true),
        body: JSON.stringify(input),
      });
    },
  };
}
