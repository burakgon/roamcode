import { randomUUID } from "node:crypto";
import type { CliOptions } from "./args.js";

export const API_ACTIONS = [
  "capabilities",
  "sessions",
  "agents",
  "workspaces",
  "devices",
  "presence",
  "adapters",
  "events",
  "openapi",
  "send",
  "wait",
  "focus",
  "start",
] as const;

type ApiAction = (typeof API_ACTIONS)[number];

export interface ApiCommandOptions {
  options: CliOptions;
  env: NodeJS.ProcessEnv;
  stdout: (message: string) => void;
  stderr: (message: string) => void;
  fetch?: typeof globalThis.fetch;
  generateIdempotencyKey?: () => string;
}

function safeId(value: string | undefined, label: string): string {
  if (!value || !/^[A-Za-z0-9._:-]{1,256}$/.test(value)) throw new Error(`${label} must be a valid id`);
  return value;
}

function baseUrl(options: CliOptions, env: NodeJS.ProcessEnv): URL {
  const value = options.publicUrl ?? env.ROAMCODE_API_URL ?? "http://127.0.0.1:4280";
  const url = new URL(value);
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("ROAMCODE_API_URL must be an http(s) origin without credentials, query, or fragment");
  }
  url.pathname = url.pathname.replace(/\/$/, "");
  return url;
}

function parseNonNegative(value: string | undefined, fallback: number, max: number, label: string): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > max) throw new Error(`${label} must be 0-${max}`);
  return parsed;
}

function requestFor(
  action: ApiAction,
  options: CliOptions,
): { method: string; path: string; body?: unknown; waitMs?: number } {
  switch (action) {
    case "capabilities":
      return { method: "GET", path: "/api/v1/capabilities" };
    case "sessions":
    case "agents":
    case "workspaces":
    case "devices":
    case "presence":
    case "adapters":
      return { method: "GET", path: `/api/v1/${action}` };
    case "openapi":
      return { method: "GET", path: "/api/v1/openapi.json" };
    case "events": {
      const after = parseNonNegative(options.after, 0, Number.MAX_SAFE_INTEGER, "--after");
      return { method: "GET", path: `/api/v1/events?after=${after}` };
    }
    case "send": {
      const sessionId = safeId(options.sessionId, "--session");
      if (options.data === undefined) throw new Error("api send requires --data");
      return {
        method: "POST",
        path: `/api/v1/sessions/${encodeURIComponent(sessionId)}/input`,
        body: {
          data: options.data,
          ...(options.appendNewline ? { appendNewline: true } : {}),
        },
      };
    }
    case "wait": {
      const agentId = safeId(options.agentId, "--agent");
      const timeoutMs = parseNonNegative(options.timeoutMs, 30_000, 30_000, "--timeout-ms");
      const after = parseNonNegative(options.after, 0, Number.MAX_SAFE_INTEGER, "--after");
      return {
        method: "GET",
        path: `/api/v1/agents/${encodeURIComponent(agentId)}/wait?after=${after}&timeoutMs=${timeoutMs}`,
        waitMs: timeoutMs,
      };
    }
    case "focus": {
      const agentId = safeId(options.agentId, "--agent");
      return {
        method: "POST",
        path: `/api/v1/agents/${encodeURIComponent(agentId)}/focus`,
        body: { mode: options.activate ? "activate" : "request" },
      };
    }
    case "start": {
      if (!options.cwd) throw new Error("api start requires --cwd");
      return {
        method: "POST",
        path: "/api/v1/sessions",
        body: { cwd: options.cwd, mode: "terminal" },
      };
    }
  }
}

export async function runApiCommand(input: ApiCommandOptions): Promise<number> {
  try {
    const action = input.options.apiAction;
    if (!action || !API_ACTIONS.includes(action as ApiAction)) {
      throw new Error(`api action must be one of: ${API_ACTIONS.join(", ")}`);
    }
    const token = input.env.ROAMCODE_API_TOKEN;
    if (!token || token.length > 4096 || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(token)) {
      throw new Error("ROAMCODE_API_TOKEN is required and must be a valid bearer credential");
    }
    const request = requestFor(action as ApiAction, input.options);
    const origin = baseUrl(input.options, input.env);
    const url = new URL(request.path, `${origin.href.replace(/\/$/, "")}/`);
    const headers: Record<string, string> = {
      authorization: `Bearer ${token}`,
      accept: "application/json",
    };
    if (request.body !== undefined) headers["content-type"] = "application/json";
    if (request.method !== "GET" && request.method !== "HEAD") {
      headers["idempotency-key"] = input.options.idempotencyKey ?? (input.generateIdempotencyKey ?? randomUUID)();
    }
    const response = await (input.fetch ?? globalThis.fetch)(url, {
      method: request.method,
      headers,
      ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
      signal: AbortSignal.timeout((request.waitMs ?? 10_000) + 5_000),
    });
    const text = await response.text();
    if (!response.ok) {
      let message = `${response.status} ${response.statusText}`.trim();
      try {
        const error = JSON.parse(text) as { code?: unknown; error?: unknown };
        if (typeof error.code === "string" || typeof error.error === "string") {
          message = [error.code, error.error].filter((item): item is string => typeof item === "string").join(": ");
        }
      } catch {
        /* never echo an arbitrary HTML/proxy body into an agent transcript */
      }
      input.stderr(`RoamCode API request failed: ${message.slice(0, 320)}\n`);
      return 1;
    }
    if (response.status === 204 || text.length === 0) input.stdout('{"ok":true}\n');
    else {
      const parsed = JSON.parse(text) as unknown;
      input.stdout(`${JSON.stringify(parsed, null, 2)}\n`);
    }
    return 0;
  } catch (error) {
    input.stderr(`${(error as Error).message}\n`);
    return 2;
  }
}
