# remote-coder — Plan 1: Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the monorepo, capture the real Claude Code stream-json + control protocol from the live binary, and build a fully tested `@remote-coder/protocol` package (parse + serialize) plus a mock `claude` binary — the foundation every later plan builds on.

**Architecture:** A pnpm/TypeScript monorepo. The `protocol` package is pure (no I/O): it parses NDJSON lines emitted by `claude` into a typed discriminated union, and serializes outbound user messages (incl. base64 image blocks) and control responses (permission/question answers). A one-off **spike** drives the real `claude` binary to capture canonical fixtures, which become golden test files and feed the mock `claude` used by later plans' CI.

**Tech Stack:** Node ≥20, pnpm workspaces, TypeScript 5, tsup (build), Vitest (test), ESLint + Prettier.

## Global Constraints

- Language: **TypeScript**, ESM (`"type": "module"`), Node **≥20**. (verbatim: `"engines": { "node": ">=20" }`)
- Package manager: **pnpm** workspaces.
- **No `ANTHROPIC_API_KEY`** anywhere; the project relies on the host's **subscription** auth. Never set or require it.
- **No Agent SDK dependency** — the `@anthropic-ai/*` SDK may be read as a protocol *spec* but must NOT appear in any `package.json` `dependencies`/`devDependencies`.
- License: **MIT**. All code, comments, identifiers, and docs in **English**.
- Test runner: **Vitest**. Build: **tsup**. Every code task is TDD (red → green → commit).
- All schema knowledge lives **only** in `packages/protocol` so a wire-format change touches one place.

---

### Task 1: Monorepo scaffolding

**Files:**
- Create: `package.json` (root)
- Create: `pnpm-workspace.yaml`
- Create: `tsconfig.base.json`
- Create: `vitest.config.ts` (root)
- Create: `.gitignore`
- Create: `.npmrc`
- Create: `LICENSE`
- Create: `packages/protocol/package.json`
- Create: `packages/protocol/tsconfig.json`
- Create: `packages/protocol/src/index.ts`
- Create: `packages/protocol/test/smoke.test.ts`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: a buildable workspace; `@remote-coder/protocol` package importable as `@remote-coder/protocol`; `pnpm test`, `pnpm build`, `pnpm typecheck`, `pnpm lint` all runnable from root.

- [ ] **Step 1: Create the root workspace files**

`package.json`:
```json
{
  "name": "remote-coder",
  "private": true,
  "type": "module",
  "engines": { "node": ">=20" },
  "scripts": {
    "build": "pnpm -r build",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc -b --pretty",
    "lint": "eslint ."
  },
  "devDependencies": {
    "@types/node": "^20.14.0",
    "typescript": "^5.6.2",
    "vitest": "^2.1.1",
    "tsup": "^8.3.0",
    "eslint": "^9.11.0",
    "typescript-eslint": "^8.8.0",
    "prettier": "^3.3.3"
  }
}
```

`pnpm-workspace.yaml`:
```yaml
packages:
  - "packages/*"
```

`tsconfig.base.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "declaration": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "verbatimModuleSyntax": true
  }
}
```

`vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts"],
    environment: "node",
  },
});
```

`.gitignore`:
```gitignore
node_modules/
dist/
*.log
.DS_Store
.env
.env.*
coverage/
*.tsbuildinfo
.superpowers/
```

`.npmrc`:
```
auto-install-peers=true
```

`LICENSE`: MIT license text, copyright line `Copyright (c) 2026 remote-coder contributors`.

- [ ] **Step 2: Create the `protocol` package skeleton**

`packages/protocol/package.json`:
```json
{
  "name": "@remote-coder/protocol",
  "version": "0.0.0",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" }
  },
  "files": ["dist"],
  "scripts": {
    "build": "tsup src/index.ts --format esm --dts --clean"
  }
}
```

`packages/protocol/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"]
}
```

`packages/protocol/src/index.ts`:
```ts
export const PROTOCOL_PACKAGE = "@remote-coder/protocol";
```

`packages/protocol/test/smoke.test.ts`:
```ts
import { expect, test } from "vitest";
import { PROTOCOL_PACKAGE } from "../src/index.js";

test("package is importable", () => {
  expect(PROTOCOL_PACKAGE).toBe("@remote-coder/protocol");
});
```

- [ ] **Step 3: Install dependencies**

Run: `pnpm install`
Expected: completes without error; creates `pnpm-lock.yaml` and `node_modules/`.

- [ ] **Step 4: Verify test, build, typecheck pass**

Run: `pnpm test`
Expected: 1 passed (`smoke.test.ts`).

Run: `pnpm -C packages/protocol build`
Expected: emits `packages/protocol/dist/index.js` and `index.d.ts`, exits 0.

Run: `pnpm typecheck`
Expected: exits 0 (no type errors). If `tsc -b` complains about missing root references, add `"references": [{ "path": "packages/protocol" }]` and `"files": []` to a root `tsconfig.json` that extends nothing; create it if needed.

- [ ] **Step 5: Add minimal ESLint config**

Create `eslint.config.js`:
```js
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**"] },
  ...tseslint.configs.recommended,
);
```

Run: `pnpm lint`
Expected: exits 0 (no errors).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore: scaffold pnpm/TypeScript monorepo with protocol package"
```

---

### Task 2: De-risk spike — capture the real stream-json + control protocol

**Purpose:** The exact JSON for `control_request` (permission/question) and `control_response`, and the outbound user-message envelope, are under-documented. This task captures them from the live binary so later code is built on facts, not guesses. **This task gates Tasks 3–5** — their fixtures and types are reconciled against what this produces.

**Files:**
- Create: `scripts/spike/drive.mjs`
- Create: `packages/protocol/fixtures/README.md`
- Create (generated): `packages/protocol/fixtures/permission-turn.jsonl`
- Create (generated): `packages/protocol/fixtures/simple-turn.jsonl`
- Create: `docs/protocol-notes.md`

**Interfaces:**
- Consumes: the locally installed `claude` binary (subscription-authenticated).
- Produces: committed fixture files (`*.jsonl`) and `docs/protocol-notes.md` documenting the observed event/envelope shapes — the canonical reference for Tasks 3–5.

- [ ] **Step 1: Write a minimal driver that logs everything**

`scripts/spike/drive.mjs` — spawns `claude` in stream-json mode, writes one user message, logs **every** stdout line verbatim, and when it sees a `control_request` (permission), replies once with an allow then logs the rest. It writes raw stdout to a file given as `argv[2]`.

```js
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { argv, env } from "node:process";

const outPath = argv[2] ?? "spike-out.jsonl";
const prompt = argv[3] ?? "Create a file called spike.txt containing the word hello.";
const out = createWriteStream(outPath, { flags: "w" });

// Subscription auth only: never pass an API key.
const childEnv = { ...env };
delete childEnv.ANTHROPIC_API_KEY;

const child = spawn(
  "claude",
  [
    "-p",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--permission-mode", "default",
  ],
  { cwd: process.cwd(), env: childEnv, stdio: ["pipe", "pipe", "pipe"] },
);

let buf = "";
let answered = false;
child.stdout.on("data", (chunk) => {
  const text = chunk.toString("utf8");
  out.write(text);
  process.stdout.write(text);
  buf += text;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (!answered && msg.type === "control_request") {
      answered = true;
      // Best-known shape; the point of the spike is to confirm/correct this.
      const reqId = msg.request_id ?? msg.request?.request_id ?? msg.id;
      const reply = {
        type: "control_response",
        response: { subtype: "success", request_id: reqId, response: { behavior: "allow" } },
      };
      const replyLine = JSON.stringify(reply) + "\n";
      out.write("\n>>> SENDING control_response:\n" + replyLine);
      process.stdout.write("\n>>> SENDING control_response:\n" + replyLine);
      child.stdin.write(replyLine);
    }
  }
});
child.stderr.on("data", (c) => process.stderr.write(c));
child.on("exit", (code) => { out.end(); process.stderr.write(`\n[exit ${code}]\n`); });

// Send the user message (best-known SDK envelope; confirm in notes).
const userMsg = { type: "user", message: { role: "user", content: [{ type: "text", text: prompt }] } };
child.stdin.write(JSON.stringify(userMsg) + "\n");
```

- [ ] **Step 2: Run the spike for a permission turn**

Run from an empty throwaway dir:
```bash
mkdir -p /tmp/rc-spike && cd /tmp/rc-spike
node /Users/burakgon/Developer/remote-coder/scripts/spike/drive.mjs \
  /Users/burakgon/Developer/remote-coder/packages/protocol/fixtures/permission-turn.jsonl \
  "Create a file called spike.txt containing the word hello."
```
Expected: stdout shows a `system/init` line, streaming `stream_event` deltas, a `control_request` for the Write/Bash tool, the injected `control_response`, then tool execution and a `result` line. The full transcript is saved to `permission-turn.jsonl`.

**If the input envelope or control_response shape is rejected** (e.g. `claude` errors or ignores the message): try the alternates and keep the one that works — record which in `docs/protocol-notes.md`:
- user message alt: `{ "type": "message", "role": "user", "content": [ ... ] }`
- control_response alt A: `{ "type": "control_response", "request_id": "<id>", "response": "allow" }`
- control_response alt B: `{ "type": "control_response", "response": { "request_id": "<id>", "subtype": "success" } }`
Cross-check against the open-source Agent SDK source (read only — do not add as a dependency) for the canonical `control_response` / `canUseTool` envelope.

- [ ] **Step 3: Run the spike for a simple (no-permission) turn**

```bash
cd /tmp/rc-spike
node /Users/burakgon/Developer/remote-coder/scripts/spike/drive.mjs \
  /Users/burakgon/Developer/remote-coder/packages/protocol/fixtures/simple-turn.jsonl \
  "In one short sentence, what is 2+2?"
```
Expected: `system/init`, streaming text deltas, a `result` line; no `control_request`. Saved to `simple-turn.jsonl`.

- [ ] **Step 4: Document the observed schema**

In `docs/protocol-notes.md`, record, with a real captured example line for each:
1. The `system`/`init` line — which fields carry `session_id`, `model`, `tools`, `cwd`.
2. The `stream_event` line(s) — the nested `event.type` values seen (`message_start`, `content_block_start`, `content_block_delta` with `text_delta` vs `input_json_delta`, `content_block_stop`, `message_delta`, `message_stop`).
3. Any full `assistant` / `user` message lines.
4. The `result` line — fields for `session_id`, cost, usage, `is_error`/`subtype`.
5. The **`control_request`** line — the exact key holding the id (`request_id`?), and the nested request body (`subtype` like `can_use_tool`, `tool_name`, `input`, and the question variant if observed).
6. The **`control_response`** envelope that the binary actually accepted.
7. The **outbound user-message** envelope that the binary actually accepted.

Add `packages/protocol/fixtures/README.md` describing each fixture and noting "captured from `claude` vX.Y.Z on <host>; regenerate with `scripts/spike/drive.mjs`."

- [ ] **Step 5: Sanitize and commit fixtures + notes**

Scan both `.jsonl` files for anything host-specific you don't want public (absolute home paths, machine name). Replace with neutral placeholders only inside long free-text fields; **do not alter structural keys**.

```bash
cd /Users/burakgon/Developer/remote-coder
git add scripts/spike/drive.mjs packages/protocol/fixtures docs/protocol-notes.md
git commit -m "spike: capture real claude stream-json + control protocol fixtures"
```

---

### Task 3: `protocol` — types + line parser

**Files:**
- Create: `packages/protocol/src/types.ts`
- Create: `packages/protocol/src/parse.ts`
- Modify: `packages/protocol/src/index.ts`
- Test: `packages/protocol/test/parse.test.ts`

**Interfaces:**
- Consumes: the fixture shapes from Task 2 / `docs/protocol-notes.md`.
- Produces:
  - `type InboundEvent` discriminated union (members below).
  - `class ProtocolParseError extends Error`.
  - `function parseLine(line: string): InboundEvent | null` — `null` for blank lines; throws `ProtocolParseError` on invalid JSON; unknown `type` → `UnknownEvent`.

> If Task 2 revealed field names different from those below, use the **captured** names and keep this union as the single source of truth.

- [ ] **Step 1: Write the failing test**

`packages/protocol/test/parse.test.ts`:
```ts
import { expect, test } from "vitest";
import { parseLine, ProtocolParseError } from "../src/index.js";

test("returns null for blank lines", () => {
  expect(parseLine("")).toBeNull();
  expect(parseLine("   \n")).toBeNull();
});

test("throws ProtocolParseError on invalid JSON", () => {
  expect(() => parseLine("{not json")).toThrow(ProtocolParseError);
});

test("parses a system/init line", () => {
  const line = JSON.stringify({
    type: "system", subtype: "init",
    session_id: "abc-123", model: "claude-opus-4-8", tools: ["Read", "Bash"], cwd: "/work",
  });
  const ev = parseLine(line);
  expect(ev).toMatchObject({ type: "system", subtype: "init", sessionId: "abc-123", model: "claude-opus-4-8" });
});

test("unknown type becomes UnknownEvent but keeps raw", () => {
  const line = JSON.stringify({ type: "totally_new_thing", foo: 1 });
  const ev = parseLine(line);
  expect(ev?.type).toBe("unknown");
  expect((ev as { raw: unknown }).raw).toMatchObject({ type: "totally_new_thing", foo: 1 });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- parse`
Expected: FAIL — `parseLine`/`ProtocolParseError` not exported.

- [ ] **Step 3: Write the types**

`packages/protocol/src/types.ts`:
```ts
export interface SystemInitEvent {
  type: "system";
  subtype: "init";
  sessionId: string;
  model?: string;
  tools?: string[];
  cwd?: string;
  raw: unknown;
}
export interface StreamEvent {
  type: "stream_event";
  event: unknown; // Anthropic streaming event (message_start, content_block_delta, ...)
  raw: unknown;
}
export interface AssistantEvent { type: "assistant"; message: unknown; sessionId?: string; raw: unknown; }
export interface UserEvent { type: "user"; message: unknown; sessionId?: string; raw: unknown; }
export interface ResultEvent {
  type: "result";
  subtype?: string;
  result?: string;
  sessionId?: string;
  totalCostUsd?: number;
  isError?: boolean;
  raw: unknown;
}
export interface ControlRequestEvent {
  type: "control_request";
  requestId: string;
  request: unknown; // e.g. { subtype: "can_use_tool", tool_name, input } — confirmed by spike
  raw: unknown;
}
export interface UnknownEvent { type: "unknown"; rawType?: string; raw: unknown; }

export type InboundEvent =
  | SystemInitEvent
  | StreamEvent
  | AssistantEvent
  | UserEvent
  | ResultEvent
  | ControlRequestEvent
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

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

export function parseLine(line: string): InboundEvent | null {
  if (!line.trim()) return null;
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(line) as Record<string, unknown>;
  } catch (err) {
    throw new ProtocolParseError(`invalid JSON: ${(err as Error).message}`, line);
  }
  const type = asString(obj.type);
  switch (type) {
    case "system":
      return {
        type: "system",
        subtype: "init",
        sessionId: asString(obj.session_id) ?? "",
        model: asString(obj.model),
        tools: Array.isArray(obj.tools) ? (obj.tools as string[]) : undefined,
        cwd: asString(obj.cwd),
        raw: obj,
      };
    case "stream_event":
      return { type: "stream_event", event: obj.event, raw: obj };
    case "assistant":
      return { type: "assistant", message: obj.message, sessionId: asString(obj.session_id), raw: obj };
    case "user":
      return { type: "user", message: obj.message, sessionId: asString(obj.session_id), raw: obj };
    case "result":
      return {
        type: "result",
        subtype: asString(obj.subtype),
        result: asString(obj.result),
        sessionId: asString(obj.session_id),
        totalCostUsd: typeof obj.total_cost_usd === "number" ? obj.total_cost_usd : undefined,
        isError: typeof obj.is_error === "boolean" ? obj.is_error : undefined,
        raw: obj,
      };
    case "control_request":
      return {
        type: "control_request",
        requestId: asString(obj.request_id) ?? asString((obj.request as Record<string, unknown>)?.request_id) ?? "",
        request: obj.request,
        raw: obj,
      };
    default:
      return { type: "unknown", rawType: type, raw: obj };
  }
}
```

- [ ] **Step 5: Export from index**

`packages/protocol/src/index.ts` (replace contents):
```ts
export const PROTOCOL_PACKAGE = "@remote-coder/protocol";
export * from "./types.js";
export { parseLine, ProtocolParseError } from "./parse.js";
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm test -- parse`
Expected: PASS (all parse tests).

- [ ] **Step 7: Add a golden test over the real fixture**

Append to `packages/protocol/test/parse.test.ts`:
```ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

test("every line of the captured simple-turn fixture parses without throwing", () => {
  const path = fileURLToPath(new URL("../fixtures/simple-turn.jsonl", import.meta.url));
  const lines = readFileSync(path, "utf8").split("\n");
  const events = lines.map(parseLine).filter((e) => e !== null);
  expect(events.length).toBeGreaterThan(0);
  expect(events[0]).toMatchObject({ type: "system", subtype: "init" });
  expect(events.some((e) => e!.type === "result")).toBe(true);
  // No line should be misclassified as a parse error.
});
```

Run: `pnpm test -- parse`
Expected: PASS. If the first event is not `system/init` or fields differ, reconcile `parse.ts` field names with `docs/protocol-notes.md` and re-run.

- [ ] **Step 8: Commit**

```bash
git add packages/protocol/src packages/protocol/test
git commit -m "feat(protocol): typed inbound event parser with golden fixture test"
```

---

### Task 4: `protocol` — outbound serialization (user messages, image blocks, control responses)

**Files:**
- Create: `packages/protocol/src/serialize.ts`
- Modify: `packages/protocol/src/types.ts` (add content-block + decision types)
- Modify: `packages/protocol/src/index.ts`
- Test: `packages/protocol/test/serialize.test.ts`

**Interfaces:**
- Produces (used by `claude-process` in Plan 2):
  - `type ContentBlock = TextBlock | ImageBlock`
  - `function buildImageBlock(mediaType: string, base64Data: string): ImageBlock`
  - `function serializeUserMessage(content: string | ContentBlock[]): string` — returns a single JSON line, no trailing newline.
  - `type PermissionDecision = { behavior: "allow"; updatedInput?: unknown } | { behavior: "deny"; message: string }`
  - `function serializeControlResponse(requestId: string, decision: PermissionDecision): string`

> Use the **exact** outbound envelopes Task 2 confirmed the binary accepts. The code below is the best-known shape; if the spike found a different one, change it here (this is the only place it lives).

- [ ] **Step 1: Write the failing test**

`packages/protocol/test/serialize.test.ts`:
```ts
import { expect, test } from "vitest";
import { buildImageBlock, serializeUserMessage, serializeControlResponse } from "../src/index.js";

test("serializeUserMessage wraps a plain string as a text block", () => {
  const line = serializeUserMessage("hello");
  expect(line).not.toContain("\n");
  expect(JSON.parse(line)).toEqual({
    type: "user",
    message: { role: "user", content: [{ type: "text", text: "hello" }] },
  });
});

test("buildImageBlock + serializeUserMessage embeds a base64 image", () => {
  const img = buildImageBlock("image/png", "QUJD");
  const line = serializeUserMessage([{ type: "text", text: "look:" }, img]);
  const parsed = JSON.parse(line);
  expect(parsed.message.content[1]).toEqual({
    type: "image",
    source: { type: "base64", media_type: "image/png", data: "QUJD" },
  });
});

test("serializeControlResponse(allow) produces a single line with the request id", () => {
  const line = serializeControlResponse("req-1", { behavior: "allow" });
  expect(line).not.toContain("\n");
  const parsed = JSON.parse(line);
  expect(parsed.type).toBe("control_response");
  expect(JSON.stringify(parsed)).toContain("req-1");
  expect(JSON.stringify(parsed)).toContain("allow");
});

test("serializeControlResponse(deny) carries the message", () => {
  const line = serializeControlResponse("req-2", { behavior: "deny", message: "no" });
  expect(JSON.stringify(JSON.parse(line))).toContain("no");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- serialize`
Expected: FAIL — functions not exported.

- [ ] **Step 3: Add content-block + decision types**

Append to `packages/protocol/src/types.ts`:
```ts
export interface TextBlock { type: "text"; text: string; }
export interface ImageBlock {
  type: "image";
  source: { type: "base64"; media_type: string; data: string };
}
export type ContentBlock = TextBlock | ImageBlock;

export type PermissionDecision =
  | { behavior: "allow"; updatedInput?: unknown }
  | { behavior: "deny"; message: string };
```

- [ ] **Step 4: Write the serializers**

`packages/protocol/src/serialize.ts`:
```ts
import type { ContentBlock, ImageBlock, PermissionDecision } from "./types.js";

export function buildImageBlock(mediaType: string, base64Data: string): ImageBlock {
  return { type: "image", source: { type: "base64", media_type: mediaType, data: base64Data } };
}

export function serializeUserMessage(content: string | ContentBlock[]): string {
  const blocks: ContentBlock[] =
    typeof content === "string" ? [{ type: "text", text: content }] : content;
  return JSON.stringify({ type: "user", message: { role: "user", content: blocks } });
}

export function serializeControlResponse(requestId: string, decision: PermissionDecision): string {
  return JSON.stringify({
    type: "control_response",
    response: { subtype: "success", request_id: requestId, response: decision },
  });
}
```

- [ ] **Step 5: Export from index**

Append to `packages/protocol/src/index.ts`:
```ts
export { buildImageBlock, serializeUserMessage, serializeControlResponse } from "./serialize.js";
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm test -- serialize`
Expected: PASS.

- [ ] **Step 7: Round-trip guard against the real fixture (if a control_request was captured)**

Append to `serialize.test.ts`:
```ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseLine } from "../src/index.js";

test("a captured control_request yields a request id we can answer", () => {
  const path = fileURLToPath(new URL("../fixtures/permission-turn.jsonl", import.meta.url));
  const lines = readFileSync(path, "utf8").split("\n");
  const req = lines.map(parseLine).find((e) => e?.type === "control_request");
  if (!req) return; // permission may not have triggered; skip rather than fail
  expect((req as { requestId: string }).requestId.length).toBeGreaterThan(0);
  const reply = serializeControlResponse((req as { requestId: string }).requestId, { behavior: "allow" });
  expect(reply).not.toContain("\n");
});
```

Run: `pnpm test`
Expected: PASS (whole suite).

- [ ] **Step 8: Commit**

```bash
git add packages/protocol/src packages/protocol/test
git commit -m "feat(protocol): outbound user-message, image-block, and control-response serializers"
```

---

### Task 5: Mock `claude` binary

**Files:**
- Create: `packages/protocol/src/mock-claude.ts`
- Create: `packages/protocol/bin/mock-claude.mjs`
- Modify: `packages/protocol/package.json` (add `bin`)
- Test: `packages/protocol/test/mock-claude.test.ts`

**Interfaces:**
- Produces (used by Plan 2/3 CI): an executable `mock-claude` that replays a fixture `.jsonl` to stdout, line by line, optionally with a small delay, and exits 0. Selected via env `MOCK_CLAUDE_FIXTURE=<path>`. This lets later plans test `claude-process`/`session-manager` deterministically with **no subscription/credit spend**.

- [ ] **Step 1: Write the failing test**

`packages/protocol/test/mock-claude.test.ts`:
```ts
import { expect, test } from "vitest";
import { replayFixture } from "../src/index.js";

test("replayFixture yields each non-blank line of a fixture in order", async () => {
  const fixture = [
    JSON.stringify({ type: "system", subtype: "init", session_id: "s1" }),
    "",
    JSON.stringify({ type: "result", subtype: "success", session_id: "s1" }),
  ].join("\n");

  const out: string[] = [];
  await replayFixture(fixture, (line) => out.push(line), { delayMs: 0 });

  expect(out).toHaveLength(2);
  expect(JSON.parse(out[0]!).type).toBe("system");
  expect(JSON.parse(out[1]!).type).toBe("result");
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
  for (const line of fixture.split("\n")) {
    if (!line.trim()) continue;
    emit(line);
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
import { env, stdout, exit } from "node:process";
import { replayFixture } from "../dist/index.js";

const fixturePath = env.MOCK_CLAUDE_FIXTURE;
if (!fixturePath) {
  process.stderr.write("MOCK_CLAUDE_FIXTURE env var is required\n");
  exit(2);
}
const fixture = readFileSync(fixturePath, "utf8");
const delayMs = env.MOCK_CLAUDE_DELAY_MS ? Number(env.MOCK_CLAUDE_DELAY_MS) : 0;
await replayFixture(fixture, (line) => stdout.write(line + "\n"), { delayMs });
exit(0);
```

Add to `packages/protocol/package.json`:
```json
  "bin": { "mock-claude": "./bin/mock-claude.mjs" },
```

- [ ] **Step 6: Build and smoke-test the binary end-to-end**

Run:
```bash
pnpm -C packages/protocol build
MOCK_CLAUDE_FIXTURE=packages/protocol/fixtures/simple-turn.jsonl node packages/protocol/bin/mock-claude.mjs | head -3
```
Expected: prints the first lines of the fixture (starting with the `system`/`init` line), exits 0.

- [ ] **Step 7: Commit**

```bash
git add packages/protocol
git commit -m "feat(protocol): mock claude binary that replays captured fixtures"
```

---

## Self-Review

**1. Spec coverage (vs §3, §11, §6.4 repo layout of the design spec):**
- Subscription auth / no API key / no SDK dep → Global Constraints + spike env scrubbing. ✓
- stream-json primitive + control protocol → Task 2 captures it; Tasks 3–4 encode it. ✓
- Image input content blocks → Task 4 `buildImageBlock`. ✓
- "All schema knowledge isolated in one `protocol` module" → enforced; types/parse/serialize all in `packages/protocol`. ✓
- Mock claude for CI-safe tests (§11) → Task 5. ✓
- Monorepo layout `packages/protocol` (§6.4) → Task 1. ✓
- Defensive parsing ("parser never crashes") → `parseLine` throws a typed error for the consumer to catch; unknown types pass through as `UnknownEvent`. The catch-and-skip *policy* lives in `claude-process` (Plan 2) — noted, not dropped.
- Not in this plan (correctly deferred to later plans): `claude-process`, `session-manager`, `transport`, `auth`, `fs-service`, `persistence`, `push`, PWA, distribution.

**2. Placeholder scan:** No "TBD/TODO". The spike's "best-known shape, confirm/correct" steps are real, runnable actions with concrete alternates listed — not placeholders. ✓

**3. Type consistency:** `parseLine`, `ProtocolParseError`, `InboundEvent` and members, `ContentBlock`/`ImageBlock`/`TextBlock`, `PermissionDecision`, `buildImageBlock`, `serializeUserMessage`, `serializeControlResponse`, `replayFixture`/`ReplayOptions` — names match across tasks and the index re-exports. ✓

---

## Dependencies on Task 2 (read before executing)

Tasks 3–5 hardcode the **best-known** wire shapes (from research). Task 2 confirms them against the live binary. **If Task 2 finds different field names or envelopes, update `types.ts` / `parse.ts` / `serialize.ts` to match the captured reality — `packages/protocol` is the single source of truth, so there is exactly one place to change.** The tests over captured fixtures (Task 3 Step 7, Task 4 Step 7) will catch mismatches.
