# roamcode — Plan 1: Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the monorepo, capture the real Claude Code stream-json + control protocol from the live binary, and build a fully tested `@roamcode/protocol` package (parse + serialize) plus a mock `claude` binary — the foundation every later plan builds on.

**Architecture:** A pnpm/TypeScript monorepo. The `protocol` package is pure (no I/O): it parses NDJSON lines emitted by `claude` into a typed discriminated union, and serializes outbound control messages (the `initialize` handshake, user messages incl. base64 image blocks, and permission `control_response`s). A one-off **spike** drove the real `claude` binary to capture canonical fixtures + a written schema (`docs/protocol-notes.md`), which are golden test inputs and feed the mock `claude` used by later plans' CI.

**Tech Stack:** Node ≥20, pnpm workspaces, TypeScript 5, tsup (build), Vitest (test), ESLint + Prettier.

## Global Constraints

- Language: **TypeScript**, ESM (`"type": "module"`), Node **≥20**. (verbatim: `"engines": { "node": ">=20" }`)
- Package manager: **pnpm** workspaces.
- **No `ANTHROPIC_API_KEY`** anywhere; the project relies on the host's **subscription** auth. Never set or require it.
- **No Agent SDK dependency** — the `@anthropic-ai/*` SDK may be read as a protocol *spec* but must NOT appear in any `package.json` `dependencies`/`devDependencies`.
- License: **MIT**. All code, comments, identifiers, and docs in **English**.
- Test runner: **Vitest**. Build: **tsup**. Every code task is TDD (red → green → commit).
- All schema knowledge lives **only** in `packages/protocol`. **`docs/protocol-notes.md` is the canonical wire-format reference** (captured from the real binary in Task 2); when any guess disagrees with it, the notes win.

---

### Task 1: Monorepo scaffolding  ✅ COMPLETE (commit `0b90799`)

Implemented as originally specified. For the record, the deliverables were: root `package.json` (ESM, `engines.node ">=20"`, scripts build/test/typecheck/lint), `pnpm-workspace.yaml`, `tsconfig.base.json`, root `tsconfig.json` (composite references), `vitest.config.ts`, `.gitignore` (includes `node_modules/`, `dist/`, `*.tsbuildinfo`, `.env*`, **`.superpowers/`**), `.npmrc`, `eslint.config.js` (typescript-eslint), `LICENSE` (MIT, 2026), and the `@roamcode/protocol` package skeleton (`package.json` with tsup build, `tsconfig.json`, `src/index.ts` exporting `PROTOCOL_PACKAGE`, `test/smoke.test.ts`). Verified green: `pnpm install`, `pnpm test` (1/1), `pnpm -C packages/protocol build`, `pnpm typecheck`, `pnpm lint`. Reviewed: Approved (2 Minor findings recorded in the ledger).

---

### Task 2: De-risk spike — capture the real stream-json + control protocol  ✅ COMPLETE (commit `d71ad4c`)

Drove the real `claude` v2.1.186 over bidirectional stream-json and captured the protocol. Deliverables: `scripts/spike/drive.mjs`, `packages/protocol/fixtures/permission-turn.jsonl` (50 lines, contains a `hook_callback` permission round-trip that was accepted — the tool ran), `packages/protocol/fixtures/simple-turn.jsonl` (23 lines, no permission), `packages/protocol/fixtures/README.md`, and **`docs/protocol-notes.md`** (the canonical schema, with a real captured example for every shape).

**Key findings that define Tasks 3–5 (full detail in `docs/protocol-notes.md`):**
- **Invocation:** `claude --input-format stream-json --output-format stream-json --verbose --include-partial-messages --include-hook-events --permission-mode default` (NO `-p`). The process exits after `result` once stdin is closed.
- **Lifecycle:** client sends an `initialize` `control_request` (registering a `PreToolUse` hook) → CLI replies with a `control_response` capability manifest → client sends a `user` message → CLI streams events → on a tool call the CLI sends a **`hook_callback` `control_request`** → client replies with a `control_response` carrying `hookSpecificOutput.permissionDecision` → tool runs → `result` → client closes stdin.
- **Permissions (KEY):** in headless stdio, a default-mode tool is **auto-denied** and **no `can_use_tool` is emitted**; the working mechanism is the `PreToolUse` hook → `hook_callback` path above. The `can_use_tool` shape (interactive transport only) is captured for reference and modeled too.
- **Envelope rule:** `request_id` is **top-level** on a `control_request`; on a `control_response` it is nested at `response.request_id`, the discriminator is `response.subtype` (`success`/`error`), and the payload is one level deeper at `response.response`.
- **Inbound `type` values:** `system` (subtypes: `init`, `status`, `thinking_tokens`, `hook_started`, `hook_response`, …), `stream_event` (wraps Anthropic SSE under `event`), `assistant`, `user` (tool results), `result`, `control_request`, `control_response`, `rate_limit_event`.
- **Fixture caveat:** lines the client SENT are tagged `"_dir":"out"` (a fixture-only annotation, not on the wire). Untagged lines are verbatim CLI output. `system/init` is NOT line 0 — it appears after the `initialize` round-trip and the SessionStart hooks (line 9 in both fixtures).

---

### Task 3: `protocol` — inbound types + `parseLine`

**Files:**
- Create: `packages/protocol/src/types.ts`
- Create: `packages/protocol/src/parse.ts`
- Modify: `packages/protocol/src/index.ts`
- Test: `packages/protocol/test/parse.test.ts`

**Canonical shapes:** `docs/protocol-notes.md` (§Message taxonomy, §1–§5). Real inputs: `packages/protocol/fixtures/{permission-turn,simple-turn}.jsonl`.

**Interfaces:**
- Consumes: nothing in code (reads fixtures in tests).
- Produces:
  - `class ProtocolParseError extends Error` (carries `.line`).
  - `type InboundEvent` discriminated union (members in Step 3).
  - `function parseLine(line: string): InboundEvent | null` — `null` for blank lines; throws `ProtocolParseError` on invalid JSON; unknown `type` → `UnknownEvent`. Ignores the fixture-only `_dir` field (it is just an extra property).

- [ ] **Step 1: Write the failing test**

`packages/protocol/test/parse.test.ts`:
```ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { parseLine, ProtocolParseError, type InboundEvent } from "../src/index.js";

function loadFixture(name: string): InboundEvent[] {
  const path = fileURLToPath(new URL(`../fixtures/${name}.jsonl`, import.meta.url));
  return readFileSync(path, "utf8")
    .split("\n")
    .map((l) => parseLine(l))
    .filter((e): e is InboundEvent => e !== null);
}
// CLI-emitted lines only (drop the fixture's outbound `_dir:"out"` lines).
function inbound(events: InboundEvent[]): InboundEvent[] {
  return events.filter((e) => (e.raw as { _dir?: string })._dir !== "out");
}

test("blank lines return null", () => {
  expect(parseLine("")).toBeNull();
  expect(parseLine("   ")).toBeNull();
});

test("invalid JSON throws ProtocolParseError", () => {
  expect(() => parseLine("{nope")).toThrow(ProtocolParseError);
});

test("parses system/init with session and model", () => {
  const line = JSON.stringify({ type: "system", subtype: "init", session_id: "s1", model: "claude-opus-4-8[1m]", tools: ["Bash"], cwd: "/w" });
  expect(parseLine(line)).toMatchObject({ type: "system", subtype: "init", sessionId: "s1", model: "claude-opus-4-8[1m]", cwd: "/w" });
});

test("parses a hook_callback control_request: requestId top-level, subtype from request", () => {
  const line = JSON.stringify({ type: "control_request", request_id: "r1", request: { subtype: "hook_callback", callback_id: "hook_0", input: { tool_name: "Write" } } });
  expect(parseLine(line)).toMatchObject({ type: "control_request", requestId: "r1", subtype: "hook_callback" });
});

test("parses a control_response: requestId + subtype nested under response", () => {
  const line = JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: "r1", response: { ok: true } } });
  expect(parseLine(line)).toMatchObject({ type: "control_response", requestId: "r1", subtype: "success" });
});

test("unknown type becomes UnknownEvent and keeps raw", () => {
  const ev = parseLine(JSON.stringify({ type: "brand_new", x: 1 }));
  expect(ev?.type).toBe("unknown");
  expect((ev as { raw: { x: number } }).raw.x).toBe(1);
});

test("golden: simple-turn parses; has system/init and a result; no permission request", () => {
  const cli = inbound(loadFixture("simple-turn"));
  expect(cli.some((e) => e.type === "system" && (e as { subtype: string }).subtype === "init")).toBe(true);
  expect(cli.some((e) => e.type === "result")).toBe(true);
  expect(cli.some((e) => e.type === "control_request")).toBe(false);
});

test("golden: permission-turn has a hook_callback control_request and a result", () => {
  const cli = inbound(loadFixture("permission-turn"));
  expect(cli.some((e) => e.type === "control_request" && (e as { subtype: string }).subtype === "hook_callback")).toBe(true);
  expect(cli.some((e) => e.type === "result")).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- parse`
Expected: FAIL — `parseLine` / `ProtocolParseError` not exported.

- [ ] **Step 3: Write the types**

`packages/protocol/src/types.ts`:
```ts
export interface SystemEvent {
  type: "system";
  subtype: string; // "init" | "status" | "thinking_tokens" | "hook_started" | "hook_response" | ...
  sessionId?: string;
  // present when subtype === "init":
  model?: string;
  tools?: string[];
  cwd?: string;
  raw: unknown;
}
export interface StreamEvent { type: "stream_event"; event: unknown; sessionId?: string; raw: unknown; }
export interface AssistantEvent { type: "assistant"; message: unknown; sessionId?: string; raw: unknown; }
export interface UserEvent { type: "user"; message: unknown; sessionId?: string; raw: unknown; }
export interface ResultEvent {
  type: "result";
  subtype?: string;
  isError?: boolean;
  result?: string;
  sessionId?: string;
  totalCostUsd?: number;
  permissionDenials?: unknown[];
  raw: unknown;
}
export interface ControlRequestEvent {
  type: "control_request";
  requestId: string; // top-level request_id
  subtype: string; // request.subtype: "hook_callback" | "can_use_tool" | ...
  request: Record<string, unknown>;
  raw: unknown;
}
export interface ControlResponseEvent {
  type: "control_response";
  requestId?: string; // response.request_id
  subtype?: string; // response.subtype: "success" | "error"
  response: Record<string, unknown>;
  raw: unknown;
}
export interface RateLimitEvent { type: "rate_limit_event"; raw: unknown; }
export interface UnknownEvent { type: "unknown"; rawType?: string; raw: unknown; }

export type InboundEvent =
  | SystemEvent
  | StreamEvent
  | AssistantEvent
  | UserEvent
  | ResultEvent
  | ControlRequestEvent
  | ControlResponseEvent
  | RateLimitEvent
  | UnknownEvent;
```

- [ ] **Step 4: Write the parser**

`packages/protocol/src/parse.ts`:
```ts
import type { InboundEvent } from "./types.js";

export class ProtocolParseError extends Error {
  constructor(message: string, readonly line: string) {
    super(message);
    this.name = "ProtocolParseError";
  }
}

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const rec = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};

export function parseLine(line: string): InboundEvent | null {
  if (!line.trim()) return null;
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(line) as Record<string, unknown>;
  } catch (err) {
    throw new ProtocolParseError(`invalid JSON: ${(err as Error).message}`, line);
  }
  switch (str(obj.type)) {
    case "system":
      return {
        type: "system",
        subtype: str(obj.subtype) ?? "",
        sessionId: str(obj.session_id),
        model: str(obj.model),
        tools: Array.isArray(obj.tools) ? (obj.tools as string[]) : undefined,
        cwd: str(obj.cwd),
        raw: obj,
      };
    case "stream_event":
      return { type: "stream_event", event: obj.event, sessionId: str(obj.session_id), raw: obj };
    case "assistant":
      return { type: "assistant", message: obj.message, sessionId: str(obj.session_id), raw: obj };
    case "user":
      return { type: "user", message: obj.message, sessionId: str(obj.session_id), raw: obj };
    case "result":
      return {
        type: "result",
        subtype: str(obj.subtype),
        isError: typeof obj.is_error === "boolean" ? obj.is_error : undefined,
        result: str(obj.result),
        sessionId: str(obj.session_id),
        totalCostUsd: typeof obj.total_cost_usd === "number" ? obj.total_cost_usd : undefined,
        permissionDenials: Array.isArray(obj.permission_denials) ? obj.permission_denials : undefined,
        raw: obj,
      };
    case "control_request": {
      const request = rec(obj.request);
      return { type: "control_request", requestId: str(obj.request_id) ?? "", subtype: str(request.subtype) ?? "", request, raw: obj };
    }
    case "control_response": {
      const response = rec(obj.response);
      return { type: "control_response", requestId: str(response.request_id), subtype: str(response.subtype), response, raw: obj };
    }
    case "rate_limit_event":
      return { type: "rate_limit_event", raw: obj };
    default:
      return { type: "unknown", rawType: str(obj.type), raw: obj };
  }
}
```

- [ ] **Step 5: Export from index**

`packages/protocol/src/index.ts` (replace contents):
```ts
export const PROTOCOL_PACKAGE = "@roamcode/protocol";
export * from "./types.js";
export { parseLine, ProtocolParseError } from "./parse.js";
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm test -- parse`
Expected: PASS (all parse tests, including both golden tests). If a golden assertion fails, reconcile field names against `docs/protocol-notes.md` and re-run — the notes are authoritative.

- [ ] **Step 7: Commit**

```bash
git add packages/protocol/src packages/protocol/test
git commit -m "feat(protocol): typed inbound event parser with golden fixture tests"
```

---

### Task 4: `protocol` — outbound serializers + permission helpers

**Files:**
- Create: `packages/protocol/src/serialize.ts`
- Modify: `packages/protocol/src/types.ts` (add content-block + permission types)
- Modify: `packages/protocol/src/index.ts`
- Test: `packages/protocol/test/serialize.test.ts`

**Canonical shapes:** `docs/protocol-notes.md` §5 (control protocol) and §6 (user-message envelope).

**Interfaces (used by `claude-process` in Plan 2):**
- `type ContentBlock = TextBlock | ImageBlock`; `function buildImageBlock(mediaType: string, base64Data: string): ImageBlock`.
- `function serializeUserMessage(content: string | ContentBlock[]): string` — `{type:"user",message:{role:"user",content:[…]}}`, single line.
- `function serializeInitialize(opts?: { requestId?: string; hookCallbackId?: string }): string` — the `initialize` `control_request` registering a `PreToolUse` hook. Defaults: `requestId` = `"init-" + randomUUID()`, `hookCallbackId` = `"hook_0"`.
- `type HookPermissionDecision = "allow" | "deny"`; `function serializeHookPermissionResponse(requestId: string, decision: HookPermissionDecision, reason?: string): string` — the `control_response` answering a `hook_callback` (payload `{async:false, hookSpecificOutput:{hookEventName:"PreToolUse", permissionDecision, permissionDecisionReason}}`).
- `type CanUseToolResult = { behavior: "allow"; updatedInput?: unknown } | { behavior: "deny" | "ask"; message: string }`; `function serializeCanUseToolResponse(requestId: string, result: CanUseToolResult): string` — the `control_response` answering a `can_use_tool` (interactive transport).
- `function classifyPermissionRequest(ev: ControlRequestEvent): { kind: "hook_callback" | "can_use_tool"; toolName?: string; toolInput?: unknown; toolUseId?: string } | null` — extracts tool info regardless of which permission shape arrived (`hook_callback`: under `request.input.{tool_name,tool_input,tool_use_id}`; `can_use_tool`: under `request.{tool_name,input,tool_use_id}`). Returns `null` for non-permission control requests.

- [ ] **Step 1: Write the failing test**

`packages/protocol/test/serialize.test.ts`:
```ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import {
  buildImageBlock, serializeUserMessage, serializeInitialize,
  serializeHookPermissionResponse, serializeCanUseToolResponse,
  classifyPermissionRequest, parseLine, type ControlRequestEvent,
} from "../src/index.js";

test("serializeUserMessage wraps a string as a text block (single line)", () => {
  const line = serializeUserMessage("hi");
  expect(line).not.toContain("\n");
  expect(JSON.parse(line)).toEqual({ type: "user", message: { role: "user", content: [{ type: "text", text: "hi" }] } });
});

test("buildImageBlock embeds a base64 image", () => {
  const line = serializeUserMessage([{ type: "text", text: "see:" }, buildImageBlock("image/png", "QUJD")]);
  expect(JSON.parse(line).message.content[1]).toEqual({ type: "image", source: { type: "base64", media_type: "image/png", data: "QUJD" } });
});

test("serializeInitialize registers a PreToolUse hook", () => {
  const obj = JSON.parse(serializeInitialize({ requestId: "init-1", hookCallbackId: "hook_0" }));
  expect(obj.type).toBe("control_request");
  expect(obj.request_id).toBe("init-1");
  expect(obj.request.subtype).toBe("initialize");
  expect(obj.request.hooks.PreToolUse[0].hookCallbackIds).toContain("hook_0");
});

test("serializeHookPermissionResponse(allow) matches the captured accepted envelope", () => {
  const obj = JSON.parse(serializeHookPermissionResponse("r1", "allow", "ok"));
  expect(obj).toEqual({
    type: "control_response",
    response: { subtype: "success", request_id: "r1", response: { async: false, hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", permissionDecisionReason: "ok" } } },
  });
});

test("serializeCanUseToolResponse(deny) carries the message at response.response", () => {
  const obj = JSON.parse(serializeCanUseToolResponse("r2", { behavior: "deny", message: "no" }));
  expect(obj.response.request_id).toBe("r2");
  expect(obj.response.response).toEqual({ behavior: "deny", message: "no" });
});

test("classifyPermissionRequest extracts tool info from a hook_callback", () => {
  const ev = parseLine(JSON.stringify({ type: "control_request", request_id: "r", request: { subtype: "hook_callback", input: { tool_name: "Write", tool_input: { file_path: "/a" }, tool_use_id: "t1" } } })) as ControlRequestEvent;
  expect(classifyPermissionRequest(ev)).toEqual({ kind: "hook_callback", toolName: "Write", toolInput: { file_path: "/a" }, toolUseId: "t1" });
});

test("golden: an allow response built from the captured hook_callback matches the captured accepted control_response", () => {
  const path = fileURLToPath(new URL("../fixtures/permission-turn.jsonl", import.meta.url));
  const events = readFileSync(path, "utf8").split("\n").map(parseLine).filter((e) => e !== null);
  const req = events.find((e) => e!.type === "control_request" && (e as ControlRequestEvent).subtype === "hook_callback") as ControlRequestEvent;
  const accepted = events.find((e) => e!.type === "control_response" && (e!.raw as { _dir?: string })._dir === "out");
  expect(req).toBeTruthy();
  expect(accepted).toBeTruthy();
  const built = JSON.parse(serializeHookPermissionResponse(req.requestId, "allow", "x"));
  const acc = (accepted!.raw as { response: { response: { hookSpecificOutput: { permissionDecision: string } } } });
  expect(built.response.request_id).toBe((accepted as { requestId?: string }).requestId);
  expect(built.response.response.hookSpecificOutput.permissionDecision).toBe(acc.response.response.hookSpecificOutput.permissionDecision);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- serialize`
Expected: FAIL — functions not exported.

- [ ] **Step 3: Add content-block + permission types**

Append to `packages/protocol/src/types.ts`:
```ts
export interface TextBlock { type: "text"; text: string; }
export interface ImageBlock { type: "image"; source: { type: "base64"; media_type: string; data: string }; }
export type ContentBlock = TextBlock | ImageBlock;

export type HookPermissionDecision = "allow" | "deny";
export type CanUseToolResult =
  | { behavior: "allow"; updatedInput?: unknown }
  | { behavior: "deny" | "ask"; message: string };
```

- [ ] **Step 4: Write the serializers**

`packages/protocol/src/serialize.ts`:
```ts
import { randomUUID } from "node:crypto";
import type { CanUseToolResult, ContentBlock, ControlRequestEvent, HookPermissionDecision, ImageBlock } from "./types.js";

export function buildImageBlock(mediaType: string, base64Data: string): ImageBlock {
  return { type: "image", source: { type: "base64", media_type: mediaType, data: base64Data } };
}

export function serializeUserMessage(content: string | ContentBlock[]): string {
  const blocks: ContentBlock[] = typeof content === "string" ? [{ type: "text", text: content }] : content;
  return JSON.stringify({ type: "user", message: { role: "user", content: blocks } });
}

export function serializeInitialize(opts: { requestId?: string; hookCallbackId?: string } = {}): string {
  const requestId = opts.requestId ?? `init-${randomUUID()}`;
  const hookCallbackId = opts.hookCallbackId ?? "hook_0";
  return JSON.stringify({
    type: "control_request",
    request_id: requestId,
    request: { subtype: "initialize", hooks: { PreToolUse: [{ matcher: "", hookCallbackIds: [hookCallbackId] }] } },
  });
}

export function serializeHookPermissionResponse(requestId: string, decision: HookPermissionDecision, reason = ""): string {
  return JSON.stringify({
    type: "control_response",
    response: {
      subtype: "success",
      request_id: requestId,
      response: { async: false, hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: decision, permissionDecisionReason: reason } },
    },
  });
}

export function serializeCanUseToolResponse(requestId: string, result: CanUseToolResult): string {
  return JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: requestId, response: result } });
}

export function classifyPermissionRequest(
  ev: ControlRequestEvent,
): { kind: "hook_callback" | "can_use_tool"; toolName?: string; toolInput?: unknown; toolUseId?: string } | null {
  if (ev.subtype === "hook_callback") {
    const input = (ev.request.input ?? {}) as Record<string, unknown>;
    return { kind: "hook_callback", toolName: input.tool_name as string, toolInput: input.tool_input, toolUseId: input.tool_use_id as string };
  }
  if (ev.subtype === "can_use_tool") {
    return { kind: "can_use_tool", toolName: ev.request.tool_name as string, toolInput: ev.request.input, toolUseId: ev.request.tool_use_id as string };
  }
  return null;
}
```

- [ ] **Step 5: Export from index**

Append to `packages/protocol/src/index.ts`:
```ts
export {
  buildImageBlock, serializeUserMessage, serializeInitialize,
  serializeHookPermissionResponse, serializeCanUseToolResponse, classifyPermissionRequest,
} from "./serialize.js";
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm test -- serialize`
Expected: PASS. The golden test confirms the serializer matches the envelope the real binary accepted.

- [ ] **Step 7: Commit**

```bash
git add packages/protocol/src packages/protocol/test
git commit -m "feat(protocol): outbound serializers (initialize, user message, permission responses) + helpers"
```

---

### Task 5: Mock `claude` binary

**Files:**
- Create: `packages/protocol/src/mock-claude.ts`
- Create: `packages/protocol/bin/mock-claude.mjs`
- Modify: `packages/protocol/package.json` (add `bin`)
- Test: `packages/protocol/test/mock-claude.test.ts`

**Interfaces (used by Plan 2/3 CI):** an executable `mock-claude` that replays the **CLI-emitted** lines of a fixture (the untagged lines — it skips the fixture's `"_dir":"out"` client lines and strips any `_dir` field), in order, optional delay, then exits 0. Fixture path via env `MOCK_CLAUDE_FIXTURE`. This gives later plans a deterministic, **credit-free** stand-in for `claude` stdout. (An interactive mock that pauses for a `control_response` is a Plan 2 concern; this one is a pure ordered replay.)

- [ ] **Step 1: Write the failing test**

`packages/protocol/test/mock-claude.test.ts`:
```ts
import { expect, test } from "vitest";
import { replayFixture } from "../src/index.js";

test("replayFixture emits CLI lines in order, skipping outbound and stripping _dir", async () => {
  const fixture = [
    JSON.stringify({ _dir: "out", type: "control_request", request: { subtype: "initialize" } }),
    JSON.stringify({ type: "control_response", response: { subtype: "success" } }),
    JSON.stringify({ _dir: "out", type: "user", message: { role: "user", content: [] } }),
    "",
    JSON.stringify({ type: "system", subtype: "init", session_id: "s1" }),
    JSON.stringify({ type: "result", subtype: "success" }),
  ].join("\n");

  const out: string[] = [];
  await replayFixture(fixture, (line) => out.push(line), { delayMs: 0 });

  expect(out).toHaveLength(3); // control_response, system/init, result — the two _dir:"out" and the blank dropped
  for (const line of out) expect(JSON.parse(line)._dir).toBeUndefined();
  expect(JSON.parse(out[0]!).type).toBe("control_response");
  expect(JSON.parse(out[1]!)).toMatchObject({ type: "system", subtype: "init" });
  expect(JSON.parse(out[2]!).type).toBe("result");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- mock-claude`
Expected: FAIL — `replayFixture` not exported.

- [ ] **Step 3: Implement the replay core**

`packages/protocol/src/mock-claude.ts`:
```ts
export interface ReplayOptions { delayMs?: number; }

export async function replayFixture(
  fixture: string,
  emit: (line: string) => void,
  opts: ReplayOptions = {},
): Promise<void> {
  const delay = opts.delayMs ?? 0;
  for (const raw of fixture.split("\n")) {
    if (!raw.trim()) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      continue; // skip non-JSON lines defensively
    }
    if (obj._dir === "out") continue; // client-sent line; the CLI did not emit it
    delete obj._dir; // fixture-only annotation, never on the wire
    emit(JSON.stringify(obj));
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
  }
}
```

Add to `packages/protocol/src/index.ts`:
```ts
export { replayFixture, type ReplayOptions } from "./mock-claude.js";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- mock-claude`
Expected: PASS.

- [ ] **Step 5: Add the executable wrapper**

`packages/protocol/bin/mock-claude.mjs`:
```js
#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { env, stdout, exit, stderr } from "node:process";
import { replayFixture } from "../dist/index.js";

const fixturePath = env.MOCK_CLAUDE_FIXTURE;
if (!fixturePath) {
  stderr.write("MOCK_CLAUDE_FIXTURE env var is required\n");
  exit(2);
}
const fixture = readFileSync(fixturePath, "utf8");
const delayMs = env.MOCK_CLAUDE_DELAY_MS ? Number(env.MOCK_CLAUDE_DELAY_MS) : 0;
await replayFixture(fixture, (line) => stdout.write(line + "\n"), { delayMs });
exit(0);
```

Add to `packages/protocol/package.json` (top level):
```json
  "bin": { "mock-claude": "./bin/mock-claude.mjs" },
```

- [ ] **Step 6: Build and smoke-test the binary end-to-end**

Run:
```bash
pnpm -C packages/protocol build
MOCK_CLAUDE_FIXTURE=packages/protocol/fixtures/simple-turn.jsonl node packages/protocol/bin/mock-claude.mjs | head -3
```
Expected: prints the first CLI-emitted lines (the `initialize` `control_response`, then a `system` line), no `_dir` fields, exits 0.

- [ ] **Step 7: Commit**

```bash
git add packages/protocol
git commit -m "feat(protocol): mock claude binary that replays captured CLI output"
```

---

## Self-Review

**1. Spec coverage (vs the design spec §3, §11, §6.4, and `docs/protocol-notes.md`):**
- Subscription auth / no API key / no SDK dep → Global Constraints; Task 2 captured under subscription (`apiKeySource:"none"`). ✓
- Real stream-json + control protocol → Task 2 captured it to `docs/protocol-notes.md`; Tasks 3–4 encode it (initialize handshake, hook_callback permission, envelope rules, can_use_tool modeled too). ✓
- Image input content blocks → Task 4 `buildImageBlock`. ✓
- "All schema knowledge isolated in one `protocol` module" → enforced. ✓
- Mock claude for CI-safe tests (§11) → Task 5 (ordered replay; interactive mock deferred to Plan 2, noted). ✓
- Defensive parsing ("parser never crashes") → `parseLine` throws a typed error for the consumer to catch; unknown types pass through as `UnknownEvent`; `replayFixture` skips non-JSON. The catch-and-skip *policy* lives in `claude-process` (Plan 2). ✓
- Deferred to later plans (correctly): `claude-process`, `session-manager`, `transport`, `auth`, `fs-service`, `persistence`, `push`, PWA, distribution.

**2. Placeholder scan:** No "TBD/TODO". All code is concrete and reconciled against the captured fixtures/notes. ✓

**3. Type consistency:** `parseLine`, `ProtocolParseError`, `InboundEvent` + members (incl. `ControlRequestEvent`, `ControlResponseEvent`), `ContentBlock`/`ImageBlock`/`TextBlock`, `HookPermissionDecision`, `CanUseToolResult`, `buildImageBlock`, `serializeUserMessage`, `serializeInitialize`, `serializeHookPermissionResponse`, `serializeCanUseToolResponse`, `classifyPermissionRequest`, `replayFixture`/`ReplayOptions` — names consistent across tasks and re-exported from `index.ts`. ✓

---

## Notes carried to Plan 2 (session engine)

- The full session lifecycle (`initialize` → user message → answer `hook_callback` → on `result` close stdin) is implemented in `claude-process` using these `protocol` functions. The invocation flags are in `docs/protocol-notes.md` ("How `claude` is invoked").
- Plan 2 will need an **interactive** mock `claude` (emits a `hook_callback`, waits for the `control_response`, then continues to `tool_result` + `result`) to test the permission round-trip. The Task 5 replay mock is the non-interactive base for it.
- The two Task 1 Minor findings (`composite: true`, unused `prettier`) are in the ledger for the final whole-branch review.
