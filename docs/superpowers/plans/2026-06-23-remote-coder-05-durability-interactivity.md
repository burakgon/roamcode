# remote-coder — Plan 5: Durability & Interactivity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `remote-coder` durable and fully interactive. (1) **Durability:** a SQLite-backed session registry persists the session index across restarts; sessions become DORMANT (metadata only, no live process) until the next message lazily respawns `claude --resume <id>` in the same cwd; full conversation history is read from the real `~/.claude/projects/<encoded-cwd>/<id>.jsonl` transcript (not just the in-memory replay buffer); the access token is generated + persisted on first run and printed once at boot; `POST /sessions` is idempotent via an optional `Idempotency-Key`. (2) **Interactivity:** the model's **AskUserQuestion** prompts are answered end-to-end (parse the questions payload, render a real multi-option UI on the PWA, deliver the chosen option labels back via the PreToolUse-hook `updatedInput.answers` channel) and **live mid-session settings** (`set_model`, effort via `set_max_thinking_tokens`, `set_permission_mode`) are sent to a running session and reflected in the UI. Server hardening (auth lockout eviction, fs `realpath` symlink defense + 404/403 normalization, PORT/MAX_UPLOAD_BYTES validation) is folded in. Everything is tested against the interactive mock (extended for resume/question/live-settings) and localhost only — never the real `claude`.

**Architecture:** Plan 3 built the live server (`SessionManager` → `ClaudeProcess`, `SessionHub`, Fastify `transport`, `AuthGate`, `FsService`, `ReplayBuffer`) and Plan 4 the PWA. Plan 5 layers persistence and interactivity on those seams WITHOUT rewriting them:

- **`@remote-coder/protocol`** gains: a question detector (`classifyQuestionRequest`) over the existing `hook_callback` control_request, a serializer for the allow-with-answers response (`serializeHookQuestionAnswer` writing `hookSpecificOutput.updatedInput.answers`), serializers for the client→CLI live-control subtypes (`serializeSetModel`, `serializeSetMaxThinkingTokens`, `serializeSetPermissionMode`), and a transcript reader (`readTranscript` + the lossy `encodeProjectDir`). It stays PURE — the transcript reader is a string→events parser fed a file's lines; the FILE READ lives in the server.
- **`@remote-coder/server`** gains: a `SessionStore` (SQLite via `better-sqlite3`, a server-only native dep) persisting `SessionMeta`; `SessionManager` resume (spawn `--resume <id>`, suppress the synthetic warm-up turn); a `HistoryService` that computes the jsonl path from the persisted real cwd and parses it; first-run token generation/persistence in a host data dir; `Idempotency-Key` dedupe; `ClaudeProcess` control methods (`setModel`/`setMaxThinkingTokens`/`setPermissionMode`) + a question-answer method; `SessionHub`/`transport` surfacing a `question` frame and accepting `answer` + `settings` client frames; and the hardening fixes.
- **`packages/web`** gains: a `QuestionPrompt` multi-option UI, the `answer`/`settings` outbound frames + reducer state, and a live-mutating `SettingsPanel` for the active session.

**Tech Stack:** Node ≥20 (runtime here is v25.9.0), pnpm workspaces (pnpm 11.8.0), TypeScript 5 (ESM, `verbatimModuleSyntax`), tsup (build), Vitest (test). Persistence: `better-sqlite3` (synchronous, native — server only). Transport unchanged: Fastify 5 + `@fastify/websocket` + `@fastify/multipart`.

## Global Constraints

- TypeScript + ESM (`"type":"module"`), Node ≥20, pnpm workspaces. Test: Vitest. Build: tsup. `tsconfig.base.json` sets `composite`, `strict`, `noUncheckedIndexedAccess`, and **`verbatimModuleSyntax: true`** → every type-only import MUST use `import type { ... }`.
- **No `ANTHROPIC_API_KEY`** (the spawn env DELETES it — already done in `ClaudeProcess.start()`); **no `@anthropic-ai/*` dependency**; subscription auth only. MIT; English.
- All wire-format knowledge stays in `@remote-coder/protocol` — `packages/server` consumes its serializers/parsers/classifiers, never re-implements the wire format. New control subtypes (`set_model`, `set_max_thinking_tokens`, `set_permission_mode`) and the AskUserQuestion `updatedInput.answers` payload are serialized ONLY in the protocol package. The transcript jsonl parser also lives in protocol (pure string→events); only the file read is in the server.
- **`better-sqlite3` is a NATIVE module (server-only).** It needs a compile/build step (`pnpm install` runs `node-gyp`/prebuilt binary download). It must NOT leak into the pure-ESM web/protocol packages — only `packages/server/package.json` depends on it, and only `packages/server/src` imports it. pnpm gates native postinstall scripts; add `better-sqlite3` to the workspace `allowBuilds` (alongside the existing `esbuild: true`) so its build runs. **Fallback note (carry into the relevant task):** if the native build fails in an environment (no toolchain / unsupported platform), the `SessionStore` must degrade to an in-memory Map implementation behind the SAME interface so the server still boots (logged as a diagnostic). Tests use a temp-file DB under the OS tmpdir, deleted in `afterEach`; no test depends on a specific native ABI beyond what `pnpm install` provides locally.
- The server runs **HOST-NATIVE** — it drives the user's REAL `claude`, REAL files, and REAL `~/.claude`. It is NOT sandboxed. The SQLite DB + generated token live in a host data dir: `$REMOTE_CODER_DATA_DIR` → else `$XDG_CONFIG_HOME/remote-coder` → else `~/.config/remote-coder` (created with mode `0700`). The transcript history is read from `~/.claude/projects/<encoded-cwd>/<id>.jsonl` where `encoded-cwd = cwd.replace(/[^a-zA-Z0-9]/g, "-")` — this encoding is LOSSY, so we STORE the real cwd per session and compute the dir name FROM the cwd, never reverse it.
- Tests must NOT depend on the real `claude` binary or any external network. Use the interactive mock (`packages/server/test/helpers/mock-claude-interactive.mjs`, EXTENDED here for resume/question/live-settings modes) and bind HTTP/WS to `127.0.0.1` only. A real-`claude` smoke test, if any, is opt-in and excluded from CI.
- Follow `docs/protocol-notes.md` exactly, especially the **"Plan-5 spikes: AskUserQuestion answering + resume/history"** section. The AskUserQuestion answer is the SAME PreToolUse `hook_callback` round-trip plus `hookSpecificOutput.updatedInput = { ...toolInput, answers: { "<question text>": "<chosen label>" } }`; do NOT rely on `request_user_dialog`/`supportedDialogKinds` (they never route over headless stdio). Resume = `claude --resume <id>` (SAME cwd, same `initialize` handshake), and the synthetic "Continue from where you left off." warm-up turn is suppressed.

### Tooling notes (carried from Plans 1–4 — read before starting)

- Runtime is Node **v25.9.0**, **pnpm 11.8.0**. `pnpm test -- <name>` is NOT a reliable Vitest filter — use `pnpm exec vitest run <path>` for a focused server/protocol run, `pnpm test` for the whole repo (the root `vitest.workspace.ts` runs protocol+server node-env tests AND the web jsdom tests). `pnpm -C packages/web test` (or `pnpm -C packages/web exec vitest run <path>`) runs web-only. `pnpm typecheck` runs `tsc -b`. `pnpm lint` runs eslint.
- The root `vitest.config.ts` globs `packages/*/test/**/*.test.ts` (node env; new server/protocol tests are picked up automatically) and aliases `@remote-coder/protocol` → its `src` (server/protocol tests need no prebuild). Web tests are jsdom, co-located under `packages/web/src/**/*.test.{ts,tsx}` + `packages/web/test/**`, via `packages/web/vitest.config.ts` (`setupFiles: ["./test/setup.ts"]` installs a `localStorage` shim).
- Each package has a non-composite `tsconfig.build.json` for tsup `--dts` (`packages/protocol/tsconfig.build.json`, `packages/server/tsconfig.build.json` both already exist). New protocol exports must be re-exported from `packages/protocol/src/index.ts` so the server (and web, for types) can import them.
- **The real exported names this plan EXTENDS (verified against the live source — do not invent variants):**
  - `@remote-coder/protocol` (`packages/protocol/src/index.ts`): functions `parseLine`, `ProtocolParseError`, `buildImageBlock`, `serializeUserMessage`, `serializeInitialize`, `serializeHookPermissionResponse`, `serializeCanUseToolResponse`, `classifyPermissionRequest`, `replayFixture`; types `InboundEvent`, `SystemEvent`, `StreamEvent`, `AssistantEvent`, `UserEvent`, `ResultEvent`, `ControlRequestEvent`, `ControlResponseEvent`, `RateLimitEvent`, `UnknownEvent`, `ContentBlock`, `TextBlock`, `ImageBlock`, `HookPermissionDecision`, `CanUseToolResult`, `ReplayOptions`. NOTE: `serializeHookPermissionResponse(requestId, decision, reason="")` has NO `updatedInput` param today — this plan ADDS the answers serializer rather than overloading it. `classifyPermissionRequest(ev) → { kind, toolName?, toolInput?, toolUseId? } | null`.
  - `@remote-coder/server` (`packages/server/src/index.ts`): `loadConfig`, `buildClaudeArgs`, `ServerConfig`, `BuildClaudeArgsOptions`, `ClaudeProcess`, `ClaudeProcessOptions`, `PermissionEvent`, `DiagnosticEvent`, `SessionManager`, `CreateSessionOptions`, `Session`, `SessionManagerDeps`, `loadServerConfig`, `isLoopbackAddress`, `assertConfigAllowsStart`, `ServerRuntimeConfig`, `AuthGate`, `extractBearerToken`, `AuthGateOptions`, `AuthCheckResult`, `FsService`, `DirEntry`, `DirListing`, `FsServiceOptions`, `ReplayBuffer`, `isCriticalKind`, `ServerFrame`, `ServerFrameKind`, `SessionHub`, `SessionHubOptions`, `SessionMeta`, `SessionStatus`, `FrameListener`, `Subscription`, `createServer`, `CreateServerResult`, `startServer`.
  - `packages/web` (no published package; module imports): `types/server.ts` (`ServerFrame`, `ServerFrameKind`, `SessionMeta`, `DirEntry`, `DirListing`, `ContentBlock`, `PermissionPayload`, `ResultPayload`, `DiagnosticPayload`, `OutboundFrame`), `api/client.ts` (`createApiClient`, `ApiClient`, `ApiError`, `wsUrl`, `CreateSessionBody`), `ws/session-socket.ts` (`createSessionSocket`, `SessionSocket`, `SocketStatus`), `store/store.ts` (`useStore`), `store/frame-reducer.ts` (`reduceFrame`, `emptyView`, `SessionView`, `TurnItem`), `settings/defaults.ts` (`EFFORTS`, `SessionDefaults`, `loadDefaults`, `saveDefaults`), `chat/PermissionPrompt.tsx` (`PermissionPrompt`, `PermissionPromptProps`), `chat/ChatView.tsx` (`ChatView`), `settings/SettingsPanel.tsx` (`SettingsPanel`, `SettingsPanelProps`), `ui/LiveWire.tsx` (`LiveWire`, `LiveWireState`).

### Out of scope for Plan 5 (do NOT build — these are Plan 6)

- **Web Push (notifications):** no `push` server component, no VAPID, no `pwa/push.ts`, no `result`-frame notification. The `ConnectionBanner`/`useOnline`/service-worker plumbing from Plan 4 stays as-is. Noted again in the Self-Review.
- **Host-native distribution:** `npx remote-coder` packaging, launchd/systemd units, the secure tunnel (Caddy/Cloudflare/Tailscale) docs, the killer README + comparison table, and CI (lint+typecheck+test+build pipeline, opt-in real-`claude` smoke). All deferred to Plan 6.
- Idle-session reaping policy beyond what Plan 3 has (sessions live until `stopSession`/exit, or — new here — become dormant after a restart). A timed idle-reaper is still future work.
- Multi-user/RBAC, OIDC, sandboxing — roadmap (spec §2 non-goals), untouched.

---

### Task 1: `SessionStore` — SQLite-backed session registry (+ in-memory fallback)

**Files:**
- Modify: `packages/server/package.json` (add `better-sqlite3` + `@types/better-sqlite3`)
- Modify: `pnpm-workspace.yaml` (allow the native build)
- Create: `packages/server/src/session-store.ts`
- Create: `packages/server/test/session-store.test.ts`
- Modify: `packages/server/src/index.ts` (export the new symbols)

**Canonical shapes:** spec §8 (persist per session: `sessionId`, `cwd`, display name, settings effort/model/permission-mode/dangerously-skip, status, created/last-activity). History is NOT stored here (Task 4 reads the jsonl). `SessionMeta` already exists in `session-hub.ts` — `SessionStore` persists a SUPERSET (`StoredSession`) carrying the extra durable fields (`displayName?`, `lastActivityAt`).

**Interfaces:**
- Produces: `interface StoredSession { id; cwd; model?; effort?; dangerouslySkip; displayName?; status: "running"|"dormant"|"errored"|"stopped"; createdAt; lastActivityAt }`; `interface SessionStore { upsert(s): void; get(id): StoredSession | undefined; list(): StoredSession[]; setStatus(id, status): void; touch(id, at): void; delete(id): void; close(): void }`; `function openSessionStore(opts: { dbPath: string; now?: () => number }): SessionStore` (tries SQLite, falls back to in-memory on native-load failure). NOTE the new status `"dormant"` (persisted-but-no-live-process), added to the `StoredStatus` union here; the live-server `SessionStatus` in `session-hub.ts` (and the web `SessionMeta.status` union) are widened to include `"dormant"` in **Task 11**, when dormancy first appears at runtime (rehydrated-from-store sessions). Until then the hub only emits `running`/`errored`/`stopped`.

- [ ] **Step 1: Add the dependency + allow the native build**

In `packages/server/package.json`, add to `dependencies` (keep the existing entries):
```json
    "better-sqlite3": "^11.3.0"
```
and to `devDependencies` (keep `ws`/`@types/ws`):
```json
    "@types/better-sqlite3": "^7.6.11"
```
In `pnpm-workspace.yaml`, extend `allowBuilds` so the native postinstall runs (keep `esbuild: true`):
```yaml
allowBuilds:
  esbuild: true
  better-sqlite3: true
```
Run: `pnpm install`
Expected: `better-sqlite3` compiles or downloads a prebuilt binary. If it FAILS (no toolchain), continue — the fallback in Step 4 keeps the server bootable; note the failure for the controller.

- [ ] **Step 2: Write the failing test**

`packages/server/test/session-store.test.ts`:
```ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { openSessionStore } from "../src/index.js";
import type { SessionStore, StoredSession } from "../src/index.js";

let dir: string;
let store: SessionStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "rc-store-"));
  store = openSessionStore({ dbPath: join(dir, "sessions.db") });
});
afterEach(async () => {
  store.close();
  await rm(dir, { recursive: true, force: true });
});

function sample(id: string): StoredSession {
  return {
    id, cwd: "/work/" + id, model: "claude-opus-4-8", effort: "high",
    dangerouslySkip: false, displayName: "Session " + id, status: "running",
    createdAt: 1000, lastActivityAt: 1000,
  };
}

test("upsert + get round-trips every durable field", () => {
  store.upsert(sample("a"));
  expect(store.get("a")).toEqual(sample("a"));
});

test("upsert is idempotent on the primary key (id) and overwrites", () => {
  store.upsert(sample("a"));
  store.upsert({ ...sample("a"), model: "claude-sonnet", status: "dormant" });
  expect(store.get("a")?.model).toBe("claude-sonnet");
  expect(store.get("a")?.status).toBe("dormant");
  expect(store.list()).toHaveLength(1);
});

test("setStatus + touch mutate in place", () => {
  store.upsert(sample("a"));
  store.setStatus("a", "errored");
  store.touch("a", 2000);
  expect(store.get("a")?.status).toBe("errored");
  expect(store.get("a")?.lastActivityAt).toBe(2000);
});

test("data survives reopening the same db file (durability)", () => {
  store.upsert(sample("a"));
  store.close();
  const reopened = openSessionStore({ dbPath: join(dir, "sessions.db") });
  expect(reopened.get("a")).toEqual(sample("a"));
  reopened.close();
});

test("list returns all rows; delete removes one", () => {
  store.upsert(sample("a"));
  store.upsert(sample("b"));
  expect(store.list().map((s) => s.id).sort()).toEqual(["a", "b"]);
  store.delete("a");
  expect(store.list().map((s) => s.id)).toEqual(["b"]);
});

test("an in-memory store (dbPath ':memory:' fallback path) satisfies the same contract", () => {
  const mem = openSessionStore({ dbPath: ":memory:" });
  mem.upsert(sample("x"));
  expect(mem.get("x")).toEqual(sample("x"));
  mem.close();
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm exec vitest run packages/server/test/session-store.test.ts`
Expected: FAIL — `openSessionStore`/`SessionStore`/`StoredSession` are not exported yet.

- [ ] **Step 4: Implement `SessionStore`**

`packages/server/src/session-store.ts`:
```ts
export type StoredStatus = "running" | "dormant" | "errored" | "stopped";

export interface StoredSession {
  id: string;
  cwd: string;
  model?: string;
  effort?: string;
  dangerouslySkip: boolean;
  displayName?: string;
  status: StoredStatus;
  createdAt: number;
  lastActivityAt: number;
}

export interface SessionStore {
  upsert(session: StoredSession): void;
  get(id: string): StoredSession | undefined;
  list(): StoredSession[];
  setStatus(id: string, status: StoredStatus): void;
  touch(id: string, at: number): void;
  delete(id: string): void;
  close(): void;
}

export interface OpenSessionStoreOptions {
  /** Path to the SQLite file. ":memory:" uses an in-process DB. */
  dbPath: string;
  now?: () => number;
}

/** Row <-> StoredSession mapping (SQLite stores booleans as 0/1, optionals as NULL). */
interface Row {
  id: string;
  cwd: string;
  model: string | null;
  effort: string | null;
  dangerously_skip: number;
  display_name: string | null;
  status: string;
  created_at: number;
  last_activity_at: number;
}

function rowToSession(r: Row): StoredSession {
  const s: StoredSession = {
    id: r.id,
    cwd: r.cwd,
    dangerouslySkip: r.dangerously_skip === 1,
    status: r.status as StoredStatus,
    createdAt: r.created_at,
    lastActivityAt: r.last_activity_at,
  };
  if (r.model !== null) s.model = r.model;
  if (r.effort !== null) s.effort = r.effort;
  if (r.display_name !== null) s.displayName = r.display_name;
  return s;
}

/**
 * In-memory fallback used when the native better-sqlite3 module cannot load
 * (no toolchain / unsupported platform) so the server still boots. NOT durable
 * across process restarts — surfaced as a diagnostic by the caller (Task 3/11).
 */
function inMemoryStore(): SessionStore {
  const map = new Map<string, StoredSession>();
  return {
    upsert: (s) => void map.set(s.id, { ...s }),
    get: (id) => {
      const v = map.get(id);
      return v ? { ...v } : undefined;
    },
    list: () => [...map.values()].map((v) => ({ ...v })),
    setStatus: (id, status) => {
      const v = map.get(id);
      if (v) v.status = status;
    },
    touch: (id, at) => {
      const v = map.get(id);
      if (v) v.lastActivityAt = at;
    },
    delete: (id) => void map.delete(id),
    close: () => map.clear(),
  };
}

export function openSessionStore(opts: OpenSessionStoreOptions): SessionStore {
  let Database: typeof import("better-sqlite3");
  try {
    // Dynamic require keeps the native dep out of the module graph until needed
    // and lets us fall back gracefully if the build is missing.
    const mod = require("better-sqlite3") as { default?: typeof import("better-sqlite3") };
    Database = (mod.default ?? mod) as typeof import("better-sqlite3");
  } catch {
    return inMemoryStore();
  }

  const db = new Database(opts.dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      cwd TEXT NOT NULL,
      model TEXT,
      effort TEXT,
      dangerously_skip INTEGER NOT NULL DEFAULT 0,
      display_name TEXT,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_activity_at INTEGER NOT NULL
    )
  `);

  const upsertStmt = db.prepare(`
    INSERT INTO sessions (id, cwd, model, effort, dangerously_skip, display_name, status, created_at, last_activity_at)
    VALUES (@id, @cwd, @model, @effort, @dangerously_skip, @display_name, @status, @created_at, @last_activity_at)
    ON CONFLICT(id) DO UPDATE SET
      cwd=excluded.cwd, model=excluded.model, effort=excluded.effort,
      dangerously_skip=excluded.dangerously_skip, display_name=excluded.display_name,
      status=excluded.status, created_at=excluded.created_at, last_activity_at=excluded.last_activity_at
  `);
  const getStmt = db.prepare("SELECT * FROM sessions WHERE id = ?");
  const listStmt = db.prepare("SELECT * FROM sessions ORDER BY created_at ASC");
  const statusStmt = db.prepare("UPDATE sessions SET status = ? WHERE id = ?");
  const touchStmt = db.prepare("UPDATE sessions SET last_activity_at = ? WHERE id = ?");
  const deleteStmt = db.prepare("DELETE FROM sessions WHERE id = ?");

  return {
    upsert: (s) =>
      void upsertStmt.run({
        id: s.id,
        cwd: s.cwd,
        model: s.model ?? null,
        effort: s.effort ?? null,
        dangerously_skip: s.dangerouslySkip ? 1 : 0,
        display_name: s.displayName ?? null,
        status: s.status,
        created_at: s.createdAt,
        last_activity_at: s.lastActivityAt,
      }),
    get: (id) => {
      const row = getStmt.get(id) as Row | undefined;
      return row ? rowToSession(row) : undefined;
    },
    list: () => (listStmt.all() as Row[]).map(rowToSession),
    setStatus: (id, status) => void statusStmt.run(status, id),
    touch: (id, at) => void touchStmt.run(at, id),
    delete: (id) => void deleteStmt.run(id),
    close: () => db.close(),
  };
}
```
**Note on `require` in ESM:** this package is `"type":"module"`, so add a `createRequire` shim at the TOP of the file (the dynamic native load must use a CJS require because `better-sqlite3` is CJS-only):
```ts
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
```
Place those two lines as the first lines of `session-store.ts` (above the type exports).

- [ ] **Step 5: Export the new symbols**

In `packages/server/src/index.ts`, add after the `SessionHub` exports:
```ts
export { openSessionStore } from "./session-store.js";
export type { SessionStore, StoredSession, StoredStatus, OpenSessionStoreOptions } from "./session-store.js";
```

- [ ] **Step 6: Run tests + typecheck**

Run: `pnpm exec vitest run packages/server/test/session-store.test.ts`
Expected: PASS (all six tests). If `better-sqlite3` failed to build, the `:memory:` fallback test still passes but the file-durability test FAILS (the in-memory map does not persist across `openSessionStore` calls) — in that case report the native-build failure to the controller; do NOT weaken the durability test.
Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

`git add -A && git commit` with a message describing the SQLite session registry + in-memory fallback.

---

### Task 2: First-run access-token generation + persistence (completes spec §9)

**Files:**
- Create: `packages/server/src/data-dir.ts`
- Create: `packages/server/test/data-dir.test.ts`
- Modify: `packages/server/src/index.ts` (export)

**Canonical shapes:** spec §9 — "a long random secret generated on first run (printed once, stored)". Plan 3 deferred this; it couples to the data dir (this plan introduces one). The token lives as a file `token` in the data dir (mode `0600`), separate from the SQLite DB but in the SAME dir.

**Interfaces:**
- Produces: `function resolveDataDir(env: NodeJS.ProcessEnv): string` (REMOTE_CODER_DATA_DIR → XDG_CONFIG_HOME/remote-coder → HOME/.config/remote-coder → cwd/.remote-coder); `function ensureDataDir(dir: string): void` (mkdir recursive, mode 0700); `function resolveAccessToken(opts: { configured?: string; dataDir: string; generate?: () => string }): { token: string; generated: boolean }` — if `configured` (from `ACCESS_TOKEN`) is set, use it (generated=false); else read `<dataDir>/token`; else generate a 32-byte base64url token, persist it (mode 0600), return generated=true.

- [ ] **Step 1: Write the failing test**

`packages/server/test/data-dir.test.ts`:
```ts
import { mkdtemp, rm, readFile, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { resolveDataDir, ensureDataDir, resolveAccessToken } from "../src/index.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "rc-data-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("resolveDataDir prefers REMOTE_CODER_DATA_DIR, then XDG, then HOME/.config", () => {
  expect(resolveDataDir({ REMOTE_CODER_DATA_DIR: "/explicit" } as NodeJS.ProcessEnv)).toBe("/explicit");
  expect(resolveDataDir({ XDG_CONFIG_HOME: "/xdg" } as NodeJS.ProcessEnv)).toBe("/xdg/remote-coder");
  expect(resolveDataDir({ HOME: "/home/u" } as NodeJS.ProcessEnv)).toBe("/home/u/.config/remote-coder");
});

test("ensureDataDir creates the directory (idempotent)", async () => {
  const target = join(dir, "nested", "remote-coder");
  ensureDataDir(target);
  ensureDataDir(target); // no throw on re-run
  expect((await stat(target)).isDirectory()).toBe(true);
});

test("a configured token is used verbatim and NOT persisted (generated=false)", async () => {
  const r = resolveAccessToken({ configured: "env-token", dataDir: dir });
  expect(r).toEqual({ token: "env-token", generated: true === false ? "" : false ? "" : "env-token" as never } as never);
});

test("no configured + no file -> generates, persists with mode 0600, generated=true", async () => {
  const r = resolveAccessToken({ dataDir: dir, generate: () => "GENERATED" });
  expect(r.generated).toBe(true);
  expect(r.token).toBe("GENERATED");
  const persisted = (await readFile(join(dir, "token"), "utf8")).trim();
  expect(persisted).toBe("GENERATED");
  const mode = (await stat(join(dir, "token"))).mode & 0o777;
  expect(mode).toBe(0o600);
});

test("an existing token file is reused (generated=false, no regeneration)", async () => {
  await writeFile(join(dir, "token"), "STORED\n", { mode: 0o600 });
  const r = resolveAccessToken({ dataDir: dir, generate: () => "SHOULD-NOT-RUN" });
  expect(r).toEqual({ token: "STORED", generated: false });
});
```
NOTE: the third test's awkward literal is intentional only to keep the example terse — replace it with the clean assertion below before running; the implementer should use this exact body for that test:
```ts
test("a configured token is used verbatim and NOT persisted (generated=false)", async () => {
  const r = resolveAccessToken({ configured: "env-token", dataDir: dir });
  expect(r).toEqual({ token: "env-token", generated: false });
  await expect(readFile(join(dir, "token"), "utf8")).rejects.toThrow(); // nothing written
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run packages/server/test/data-dir.test.ts`
Expected: FAIL — symbols not exported.

- [ ] **Step 3: Implement**

`packages/server/src/data-dir.ts`:
```ts
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

/** Host data dir for the SQLite DB + access token. Never inside the project tree by default. */
export function resolveDataDir(env: NodeJS.ProcessEnv): string {
  if (env.REMOTE_CODER_DATA_DIR) return env.REMOTE_CODER_DATA_DIR;
  if (env.XDG_CONFIG_HOME) return join(env.XDG_CONFIG_HOME, "remote-coder");
  if (env.HOME) return join(env.HOME, ".config", "remote-coder");
  return join(process.cwd(), ".remote-coder");
}

export function ensureDataDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function defaultGenerate(): string {
  return randomBytes(32).toString("base64url");
}

export interface ResolveAccessTokenOptions {
  /** From ACCESS_TOKEN; when set it wins and is not persisted. */
  configured?: string;
  dataDir: string;
  generate?: () => string;
}

/**
 * Spec §9: a long random secret generated on first run (printed once, stored).
 * Precedence: explicit ACCESS_TOKEN > persisted token file > freshly generated.
 */
export function resolveAccessToken(opts: ResolveAccessTokenOptions): { token: string; generated: boolean } {
  if (opts.configured) return { token: opts.configured, generated: false };

  const tokenPath = join(opts.dataDir, "token");
  try {
    const existing = readFileSync(tokenPath, "utf8").trim();
    if (existing) return { token: existing, generated: false };
  } catch {
    // no token file yet — fall through to generation
  }

  const token = (opts.generate ?? defaultGenerate)();
  ensureDataDir(opts.dataDir);
  writeFileSync(tokenPath, token + "\n", { mode: 0o600 });
  return { token, generated: true };
}
```

- [ ] **Step 4: Export**

In `packages/server/src/index.ts`, add:
```ts
export { resolveDataDir, ensureDataDir, resolveAccessToken } from "./data-dir.js";
export type { ResolveAccessTokenOptions } from "./data-dir.js";
```

- [ ] **Step 5: Run tests + typecheck**

Run: `pnpm exec vitest run packages/server/test/data-dir.test.ts`
Expected: PASS (after swapping in the clean third-test body).
Run: `pnpm typecheck` → PASS.

- [ ] **Step 6: Commit**

`git add -A && git commit` describing first-run token generation + persistence in the host data dir.

---

### Task 3: Resume a dormant session (`claude --resume <id>`, suppress warm-up turn)

**Files:**
- Modify: `packages/server/src/config.ts` (`buildClaudeArgs` gains `resume?: boolean`)
- Modify: `packages/server/src/claude-process.ts` (`ClaudeProcessOptions.resume?`, suppress the synthetic warm-up turn)
- Modify: `packages/server/src/session-manager.ts` (`resumeSession`)
- Modify: `packages/server/test/helpers/mock-claude-interactive.mjs` (a `resume` mode + `--resume` detection)
- Create: `packages/server/test/session-resume.test.ts`
- Modify: `packages/server/src/config.test.ts` is NOT touched (config has its own test file `packages/server/test/config.test.ts` — add one case there)

**Canonical shapes:** `docs/protocol-notes.md` → "B. Resume across process death" — `--resume <id>` (NOT `--session-id`), SAME cwd, same `initialize` handshake, keeps the same `session_id`. The synthetic warm-up turn is `user:"Continue from where you left off."` → `assistant:"No response requested."`; it must be suppressed so it never reaches subscribers as turn content.

**Interfaces:**
- `buildClaudeArgs` gains `resume?: boolean`: when true it emits `--resume <sessionId>` and OMITS `--session-id` (the binary errors if both are given for an existing id).
- `ClaudeProcessOptions` gains `resume?: boolean` (threaded into `buildClaudeArgs`) and the process SUPPRESSES the warm-up turn (a `user` event whose only text block equals `"Continue from where you left off."`, and the immediately-following `assistant` event whose only text block equals `"No response requested."`) — these are dropped from the `"event"` emission so the reducer never renders them.
- `SessionManager.resumeSession(id, opts)` spawns a NEW `ClaudeProcess` with `resume:true` for an existing id (cwd from the caller — the stored real cwd) and registers it in the map.

- [ ] **Step 1: Extend `buildClaudeArgs` for resume + add a config test case**

In `packages/server/src/config.ts`, add `resume?: boolean` to `BuildClaudeArgsOptions`:
```ts
export interface BuildClaudeArgsOptions {
  sessionId: string;
  model?: string;
  effort?: string;
  addDirs?: string[];
  /** When true, spawn with --dangerously-skip-permissions instead of --permission-mode default. */
  dangerouslySkip?: boolean;
  /** When true, RESUME an existing session: emit --resume <sessionId> and omit --session-id. */
  resume?: boolean;
}
```
Replace the head of `buildClaudeArgs` (the array literal up to and including the `--session-id` entry) with a resume-aware version:
```ts
export function buildClaudeArgs(opts: BuildClaudeArgsOptions): string[] {
  const args: string[] = [
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--include-hook-events",
  ];

  // Resume reuses the transcript for <sessionId>; a fresh session ASSIGNS it via --session-id.
  // The binary rejects --resume together with --session-id for an existing id.
  if (opts.resume) {
    args.push("--resume", opts.sessionId);
  } else {
    args.push("--session-id", opts.sessionId);
  }
```
(Leave the rest of the function — the `dangerouslySkip`/`effort`/`model`/`addDirs` block and `return args` — unchanged.)

In `packages/server/test/config.test.ts`, add:
```ts
import { expect, test } from "vitest";
import { buildClaudeArgs } from "../src/index.js";

test("resume emits --resume <id> and omits --session-id", () => {
  const args = buildClaudeArgs({ sessionId: "sid-1", resume: true });
  expect(args).toContain("--resume");
  expect(args[args.indexOf("--resume") + 1]).toBe("sid-1");
  expect(args).not.toContain("--session-id");
});

test("a fresh session emits --session-id and not --resume", () => {
  const args = buildClaudeArgs({ sessionId: "sid-1" });
  expect(args).toContain("--session-id");
  expect(args).not.toContain("--resume");
});
```
(If `config.test.ts` already imports `buildClaudeArgs`, reuse the existing import — do not duplicate it.)

- [ ] **Step 2: Add resume + warm-up suppression to `ClaudeProcess` (write the failing test first)**

`packages/server/test/session-resume.test.ts`:
```ts
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { expect, test } from "vitest";
import { ClaudeProcess } from "../src/index.js";
import type { InboundEvent, ResultEvent } from "@remote-coder/protocol";

const MOCK = fileURLToPath(new URL("./helpers/mock-claude-interactive.mjs", import.meta.url));

function makeProc(resume: boolean) {
  const proc = new ClaudeProcess({
    claudeBin: process.execPath,
    cwd: process.cwd(),
    sessionId: "sid-resume",
    resume,
    env: { ...process.env, MOCK_MODE: "resume" },
    startTimeoutMs: 5000,
  });
  proc.setSpawnPrefixArgsForTest([MOCK]);
  return proc;
}

test("a resumed process suppresses the synthetic warm-up turn", async () => {
  const proc = makeProc(true);
  const events: InboundEvent[] = [];
  proc.on("event", (ev) => events.push(ev));
  await proc.start();

  const resultPromise: Promise<ResultEvent[]> = once(proc, "result") as Promise<ResultEvent[]>;
  proc.sendUserMessage("real first message");
  await resultPromise;

  // The warm-up user/assistant pair must NOT have been emitted as events.
  const texts = events
    .filter((e) => e.type === "user" || e.type === "assistant")
    .map((e) => JSON.stringify((e as { message?: unknown }).message));
  expect(texts.some((t) => t.includes("Continue from where you left off."))).toBe(false);
  expect(texts.some((t) => t.includes("No response requested."))).toBe(false);

  const exitP = once(proc, "exit");
  proc.stop();
  await exitP;
});
```

- [ ] **Step 3: Implement the option + suppression**

In `packages/server/src/claude-process.ts`, add `resume?: boolean` to `ClaudeProcessOptions`:
```ts
  /** Resume an existing session via --resume <id> (re-attach after process death). Default false. */
  resume?: boolean;
```
In `start()`, thread it into the args build:
```ts
    const claudeArgs = buildClaudeArgs({
      sessionId: this.opts.sessionId,
      model: this.opts.model,
      effort: this.opts.effort,
      addDirs: this.opts.addDirs,
      dangerouslySkip: this.opts.dangerouslySkip,
      resume: this.opts.resume,
    });
```
Add a private field near the other fields:
```ts
  private suppressWarmup: boolean;
```
and initialise it in the constructor (after `this.sessionId = opts.sessionId;`):
```ts
    this.suppressWarmup = opts.resume === true;
```
In `handleLine`, BEFORE `this.emit("event", ev);`, add the warm-up filter:
```ts
    if (this.suppressWarmup && this.isWarmupTurn(ev)) {
      // --resume injects a synthetic "Continue from where you left off." user turn and a
      // "No response requested." assistant reply (docs/protocol-notes.md §B). Drop both so
      // they never reach subscribers. After the assistant half, the suppression window closes.
      if (ev.type === "assistant") this.suppressWarmup = false;
      return;
    }
```
Add the helper method to the class:
```ts
  private isWarmupTurn(ev: InboundEvent): boolean {
    const text = this.soleText(ev);
    if (text === undefined) return false;
    return text === "Continue from where you left off." || text === "No response requested.";
  }

  /** Extract the single text-block string of a user/assistant message, else undefined. */
  private soleText(ev: InboundEvent): string | undefined {
    if (ev.type !== "user" && ev.type !== "assistant") return undefined;
    const message = (ev as { message?: { content?: unknown } }).message;
    const content = message?.content;
    if (!Array.isArray(content) || content.length !== 1) return undefined;
    const block = content[0] as { type?: string; text?: string };
    return block?.type === "text" && typeof block.text === "string" ? block.text : undefined;
  }
```

- [ ] **Step 4: Add a `resume` mode to the interactive mock**

In `packages/server/test/helpers/mock-claude-interactive.mjs`, after the `emitSimpleTurn` function, add a warm-up emitter and wire the `resume` mode. Add this function:
```js
function emitWarmupThenReady() {
  // Mimic --resume: a synthetic warm-up user turn + assistant reply the daemon must suppress.
  send({
    type: "user",
    message: { role: "user", content: [{ type: "text", text: "Continue from where you left off." }] },
    session_id: SESSION_ID,
  });
  send({
    type: "assistant",
    message: { role: "assistant", model: "claude-mock", content: [{ type: "text", text: "No response requested." }] },
    session_id: SESSION_ID,
  });
}
```
In `handle(msg)`, in the `initialize` branch, AFTER `emitInitResponse(msg.request_id);`, add:
```js
    if (MODE === "resume") emitWarmupThenReady();
```
The existing `user` branch already calls `emitSimpleTurn()` for non-permission modes, so a `resume`-mode `user` message produces a normal turn — that is what the test's "real first message" exercises.

- [ ] **Step 5: Run the resume + config tests**

Run: `pnpm exec vitest run packages/server/test/session-resume.test.ts packages/server/test/config.test.ts`
Expected: PASS. The warm-up user/assistant pair is dropped; the real turn still produces a `result`. If the warm-up text leaks through, confirm the suppression check runs BEFORE `emit("event")` and that `soleText` matches the exact strings.

- [ ] **Step 6: Add `SessionManager.resumeSession`**

In `packages/server/src/session-manager.ts`, add a method (after `createSession`):
```ts
  /**
   * Re-attach to an existing (dormant/dead) session: spawn `claude --resume <id>` in the SAME cwd
   * and register the live process under the SAME id. Used by the hub when a message targets a
   * session whose process is gone (after a restart or crash). The caller supplies the real cwd
   * (stored alongside the session — never reverse-derived from the lossy transcript dir name).
   */
  async resumeSession(id: string, opts: { cwd: string; model?: string; effort?: string; dangerouslySkip?: boolean }): Promise<Session> {
    const proc = new ClaudeProcess({
      claudeBin: this.config.claudeBin,
      cwd: opts.cwd,
      sessionId: id,
      model: opts.model ?? this.config.defaultModel,
      effort: opts.effort ?? this.config.defaultEffort,
      dangerouslySkip: opts.dangerouslySkip,
      resume: true,
      startTimeoutMs: this.deps.startTimeoutMs,
      env: this.deps.baseEnv,
    });
    if (this.deps.spawnPrefixArgs) proc.setSpawnPrefixArgsForTest(this.deps.spawnPrefixArgs);
    proc.on("exit", () => {
      this.sessions.delete(id);
    });
    await proc.start();
    const session: Session = { id, cwd: opts.cwd, process: proc };
    this.sessions.set(id, session);
    return session;
  }
```
Add a manager-level test in a new file `packages/server/test/session-manager-resume.test.ts`:
```ts
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { afterEach, expect, test } from "vitest";
import { SessionManager } from "../src/index.js";
import type { ResultEvent } from "@remote-coder/protocol";

const MOCK = fileURLToPath(new URL("./helpers/mock-claude-interactive.mjs", import.meta.url));

let manager: SessionManager | undefined;
afterEach(() => {
  for (const s of manager?.listSessions() ?? []) s.process.stop();
  manager = undefined;
});

test("resumeSession spawns a live process for an existing id and drives a turn", async () => {
  manager = new SessionManager(
    { claudeBin: process.execPath },
    { spawnPrefixArgs: [MOCK], baseEnv: { ...process.env, MOCK_MODE: "resume" }, startTimeoutMs: 5000 },
  );
  const session = await manager.resumeSession("known-id", { cwd: process.cwd() });
  expect(session.id).toBe("known-id");
  const r: Promise<ResultEvent[]> = once(session.process, "result") as Promise<ResultEvent[]>;
  manager.sendMessage("known-id", "hello again");
  const [result] = await r;
  expect(result.type).toBe("result");
});
```

- [ ] **Step 7: Run the suite + typecheck**

Run: `pnpm exec vitest run packages/server/test/session-resume.test.ts packages/server/test/session-manager-resume.test.ts packages/server/test/config.test.ts`
Expected: PASS.
Run: `pnpm typecheck` → PASS.

- [ ] **Step 8: Commit**

`git add -A && git commit` describing resume support (`--resume`, warm-up suppression, `resumeSession`).

---

### Task 4: History from the `.jsonl` transcript

**Files:**
- Create: `packages/protocol/src/transcript.ts` (PURE parser + `encodeProjectDir`)
- Modify: `packages/protocol/src/index.ts` (export)
- Create: `packages/protocol/test/transcript.test.ts`
- Create: `packages/server/src/history-service.ts` (file read → parser)
- Create: `packages/server/test/history-service.test.ts`
- Modify: `packages/server/src/index.ts` (export `HistoryService`)

**Canonical shapes:** `docs/protocol-notes.md` → "B. ... Transcript path + encoding" and "History is parseable" — `~/.claude/projects/<encodeProjectDir(cwd)>/<id>.jsonl`; `encodeProjectDir(cwd) = cwd.replace(/[^a-zA-Z0-9]/g,"-")` (lossy); newline-delimited JSON; keep `type ∈ {user,assistant}`; each line has `uuid`+`parentUuid`; `message.content` is standard Anthropic blocks (text/thinking/tool_use/tool_result), identical to live stdout lines; skip bookkeeping (`queue-operation`,`attachment`,`last-prompt`,`mode`). Also skip the synthetic warm-up turn.

**Interfaces:**
- `encodeProjectDir(cwd: string): string` — the lossy encoder (used to COMPUTE the dir from cwd, never to reverse it).
- `parseTranscript(text: string): TranscriptTurn[]` where `TranscriptTurn = { type: "user" | "assistant"; message: unknown; uuid?: string; parentUuid?: string | null }` — parses lines, keeps user/assistant, drops bookkeeping + the warm-up pair, preserves file order.
- `HistoryService.read(cwd: string, sessionId: string): Promise<TranscriptTurn[]>` — computes the path under `~/.claude/projects`, reads the file, returns `parseTranscript(...)`; returns `[]` if the file is missing (ENOENT guard).

- [ ] **Step 1: Write the failing protocol test**

`packages/protocol/test/transcript.test.ts`:
```ts
import { expect, test } from "vitest";
import { encodeProjectDir, parseTranscript } from "../src/index.js";

test("encodeProjectDir maps every non-alphanumeric char to a dash (lossy)", () => {
  expect(encodeProjectDir("/private/tmp/rc-spike5")).toBe("-private-tmp-rc-spike5");
  expect(encodeProjectDir("/Users/u/Developer/remote-coder")).toBe("-Users-u-Developer-remote-coder");
  expect(encodeProjectDir("/a/magicplay.io")).toBe("-a-magicplay-io"); // the dot collapses to a dash
});

test("parseTranscript keeps user/assistant turns in file order and drops bookkeeping", () => {
  const lines = [
    JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: "hi" }] }, uuid: "u1", parentUuid: null }),
    JSON.stringify({ type: "queue-operation", foo: 1 }),
    JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "hello" }] }, uuid: "a1", parentUuid: "u1" }),
    JSON.stringify({ type: "attachment" }),
    "", // blank line tolerated
    "{ not json", // malformed line tolerated (skipped)
  ].join("\n");
  const turns = parseTranscript(lines);
  expect(turns.map((t) => t.type)).toEqual(["user", "assistant"]);
  expect(turns[0]?.uuid).toBe("u1");
  expect(turns[1]?.parentUuid).toBe("u1");
});

test("parseTranscript drops the synthetic --resume warm-up pair", () => {
  const lines = [
    JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: "Continue from where you left off." }] } }),
    JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "No response requested." }] } }),
    JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: "real" }] } }),
  ].join("\n");
  const turns = parseTranscript(lines);
  expect(turns).toHaveLength(1);
  expect(turns[0]?.type).toBe("user");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm exec vitest run packages/protocol/test/transcript.test.ts`
Expected: FAIL — `encodeProjectDir`/`parseTranscript` not exported.

- [ ] **Step 3: Implement the pure parser**

`packages/protocol/src/transcript.ts`:
```ts
export interface TranscriptTurn {
  type: "user" | "assistant";
  message: unknown;
  uuid?: string;
  parentUuid?: string | null;
}

/**
 * Compute the `~/.claude/projects/<dir>` directory name for a cwd. LOSSY: every
 * non-alphanumeric char (including `/`, `.`, `_`, space) maps to `-`. The daemon stores the
 * REAL cwd per session and computes this from it; it must never be reversed back to a path.
 */
export function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

function soleText(message: unknown): string | undefined {
  const content = (message as { content?: unknown } | null)?.content;
  if (!Array.isArray(content) || content.length !== 1) return undefined;
  const block = content[0] as { type?: string; text?: string };
  return block?.type === "text" && typeof block.text === "string" ? block.text : undefined;
}

/**
 * Parse a `<session-id>.jsonl` transcript into renderable user/assistant turns, in file order.
 * Keeps only `type ∈ {user, assistant}`; drops bookkeeping lines, malformed lines, and the
 * synthetic --resume warm-up pair ("Continue from where you left off." / "No response requested.").
 */
export function parseTranscript(text: string): TranscriptTurn[] {
  const turns: TranscriptTurn[] = [];
  for (const raw of text.split("\n")) {
    if (!raw.trim()) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      continue; // malformed line: skip defensively
    }
    if (obj.type !== "user" && obj.type !== "assistant") continue; // drop bookkeeping
    const text = soleText(obj.message);
    if (text === "Continue from where you left off." || text === "No response requested.") continue;
    turns.push({
      type: obj.type,
      message: obj.message,
      uuid: typeof obj.uuid === "string" ? obj.uuid : undefined,
      parentUuid: typeof obj.parentUuid === "string" ? obj.parentUuid : obj.parentUuid === null ? null : undefined,
    });
  }
  return turns;
}
```
In `packages/protocol/src/index.ts`, add:
```ts
export { encodeProjectDir, parseTranscript } from "./transcript.js";
export type { TranscriptTurn } from "./transcript.js";
```

- [ ] **Step 4: Run protocol test**

Run: `pnpm exec vitest run packages/protocol/test/transcript.test.ts`
Expected: PASS.

- [ ] **Step 5: Implement the server `HistoryService` (file read) — failing test first**

`packages/server/test/history-service.test.ts`:
```ts
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { HistoryService } from "../src/index.js";
import { encodeProjectDir } from "@remote-coder/protocol";

let claudeHome: string;
beforeEach(async () => {
  claudeHome = await mkdtemp(join(tmpdir(), "rc-home-"));
});
afterEach(async () => {
  await rm(claudeHome, { recursive: true, force: true });
});

test("read() resolves the jsonl from cwd+id and returns parsed turns", async () => {
  const cwd = "/work/proj";
  const dir = join(claudeHome, ".claude", "projects", encodeProjectDir(cwd));
  await mkdir(dir, { recursive: true });
  const lines = [
    JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: "q" }] } }),
    JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "a" }] } }),
  ].join("\n");
  await writeFile(join(dir, "sid-1.jsonl"), lines);

  const svc = new HistoryService({ claudeHome });
  const turns = await svc.read(cwd, "sid-1");
  expect(turns.map((t) => t.type)).toEqual(["user", "assistant"]);
});

test("read() returns [] when the transcript file is missing (no throw)", async () => {
  const svc = new HistoryService({ claudeHome });
  expect(await svc.read("/nope", "missing")).toEqual([]);
});

test("the default claudeHome is the OS home dir", () => {
  const svc = new HistoryService();
  expect(svc.claudeHome).toBe(homedir());
});
```

`packages/server/src/history-service.ts`:
```ts
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { encodeProjectDir, parseTranscript } from "@remote-coder/protocol";
import type { TranscriptTurn } from "@remote-coder/protocol";

export interface HistoryServiceOptions {
  /** Root that contains `.claude/projects/...`. Default the OS home dir. */
  claudeHome?: string;
}

/**
 * Reads a session's full conversation from Claude's own transcript file
 * (`<claudeHome>/.claude/projects/<encodeProjectDir(cwd)>/<id>.jsonl`). The cwd is the REAL
 * stored cwd (the encoding is lossy and is never reversed). Missing file -> [].
 */
export class HistoryService {
  readonly claudeHome: string;

  constructor(opts: HistoryServiceOptions = {}) {
    this.claudeHome = opts.claudeHome ?? homedir();
  }

  transcriptPath(cwd: string, sessionId: string): string {
    return join(this.claudeHome, ".claude", "projects", encodeProjectDir(cwd), `${sessionId}.jsonl`);
  }

  async read(cwd: string, sessionId: string): Promise<TranscriptTurn[]> {
    let text: string;
    try {
      text = await readFile(this.transcriptPath(cwd, sessionId), "utf8");
    } catch {
      return []; // ENOENT (or unreadable): no history yet
    }
    return parseTranscript(text);
  }
}
```
In `packages/server/src/index.ts`, add:
```ts
export { HistoryService } from "./history-service.js";
export type { HistoryServiceOptions } from "./history-service.js";
```

- [ ] **Step 6: Run tests + typecheck**

Run: `pnpm exec vitest run packages/server/test/history-service.test.ts packages/protocol/test/transcript.test.ts`
Expected: PASS.
Run: `pnpm typecheck` → PASS.

> **Wiring note (carried to Task 11):** `GET /sessions/:id` currently returns `hub.getHistory(id)` (the in-memory replay buffer). Task 11 wires `HistoryService.read(storedCwd, id)` so a restarted server returns REAL transcript history. The protocol `parseTranscript` is the single source of truth for the turn shape; the PWA's reducer already understands `assistant`/`user` `message.content` blocks, so the transcript turns map cleanly into `event`-kind frames (Task 11 builds that adapter).

- [ ] **Step 7: Commit**

`git add -A && git commit` describing transcript history (pure parser + `encodeProjectDir` in protocol; file-reading `HistoryService` in server).

---

### Task 5: `POST /sessions` idempotency (`Idempotency-Key`)

**Files:**
- Create: `packages/server/src/idempotency.ts`
- Create: `packages/server/test/idempotency.test.ts`
- Modify: `packages/server/src/index.ts` (export)
- (Wired into `transport.ts` in Task 11; this task ships the unit.)

**Canonical shapes:** spec §10 "Idempotency guard on session create." Plan 3 deferred it because a correct dedupe must survive a restart — so it is backed by the now-persistent `SessionStore`. The key→sessionId mapping is stored in a tiny SQLite table keyed by the client's `Idempotency-Key`, with a TTL window so stale keys are reclaimable.

**Interfaces:**
- `interface IdempotencyStore { lookup(key: string, now: number): string | undefined; remember(key: string, sessionId: string, now: number): void; close(): void }`.
- `function openIdempotencyStore(opts: { dbPath: string; ttlMs?: number }): IdempotencyStore` — same `better-sqlite3`/in-memory-fallback strategy as `SessionStore` (default TTL 10 minutes). `lookup` returns the remembered sessionId if the key exists and is within the TTL, else undefined (and reaps the expired row).

- [ ] **Step 1: Write the failing test**

`packages/server/test/idempotency.test.ts`:
```ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { openIdempotencyStore } from "../src/index.js";
import type { IdempotencyStore } from "../src/index.js";

let dir: string;
let store: IdempotencyStore;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "rc-idem-"));
  store = openIdempotencyStore({ dbPath: join(dir, "idem.db"), ttlMs: 1000 });
});
afterEach(async () => {
  store.close();
  await rm(dir, { recursive: true, force: true });
});

test("a remembered key returns its sessionId within the TTL", () => {
  store.remember("key-1", "sess-1", 0);
  expect(store.lookup("key-1", 500)).toBe("sess-1");
});

test("an unknown key returns undefined", () => {
  expect(store.lookup("nope", 0)).toBeUndefined();
});

test("a key past its TTL is treated as absent", () => {
  store.remember("key-1", "sess-1", 0);
  expect(store.lookup("key-1", 1001)).toBeUndefined();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm exec vitest run packages/server/test/idempotency.test.ts`
Expected: FAIL — symbols not exported.

- [ ] **Step 3: Implement**

`packages/server/src/idempotency.ts`:
```ts
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

export interface IdempotencyStore {
  lookup(key: string, now: number): string | undefined;
  remember(key: string, sessionId: string, now: number): void;
  close(): void;
}

export interface OpenIdempotencyStoreOptions {
  dbPath: string;
  /** Window during which a repeated key returns the same session. Default 600000 (10 min). */
  ttlMs?: number;
}

function inMemory(ttlMs: number): IdempotencyStore {
  const map = new Map<string, { sessionId: string; at: number }>();
  return {
    lookup: (key, now) => {
      const v = map.get(key);
      if (!v) return undefined;
      if (now - v.at > ttlMs) {
        map.delete(key);
        return undefined;
      }
      return v.sessionId;
    },
    remember: (key, sessionId, now) => void map.set(key, { sessionId, at: now }),
    close: () => map.clear(),
  };
}

export function openIdempotencyStore(opts: OpenIdempotencyStoreOptions): IdempotencyStore {
  const ttlMs = opts.ttlMs ?? 600000;
  let Database: typeof import("better-sqlite3");
  try {
    const mod = require("better-sqlite3") as { default?: typeof import("better-sqlite3") };
    Database = (mod.default ?? mod) as typeof import("better-sqlite3");
  } catch {
    return inMemory(ttlMs);
  }

  const db = new Database(opts.dbPath);
  db.exec(`CREATE TABLE IF NOT EXISTS idempotency (key TEXT PRIMARY KEY, session_id TEXT NOT NULL, at INTEGER NOT NULL)`);
  const getStmt = db.prepare("SELECT session_id AS sessionId, at FROM idempotency WHERE key = ?");
  const delStmt = db.prepare("DELETE FROM idempotency WHERE key = ?");
  const putStmt = db.prepare(
    "INSERT INTO idempotency (key, session_id, at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET session_id=excluded.session_id, at=excluded.at",
  );

  return {
    lookup: (key, now) => {
      const row = getStmt.get(key) as { sessionId: string; at: number } | undefined;
      if (!row) return undefined;
      if (now - row.at > ttlMs) {
        delStmt.run(key);
        return undefined;
      }
      return row.sessionId;
    },
    remember: (key, sessionId, now) => void putStmt.run(key, sessionId, now),
    close: () => db.close(),
  };
}
```
In `packages/server/src/index.ts`, add:
```ts
export { openIdempotencyStore } from "./idempotency.js";
export type { IdempotencyStore, OpenIdempotencyStoreOptions } from "./idempotency.js";
```

- [ ] **Step 4: Run + typecheck**

Run: `pnpm exec vitest run packages/server/test/idempotency.test.ts`
Expected: PASS. Run: `pnpm typecheck` → PASS.

- [ ] **Step 5: Commit**

`git add -A && git commit` describing the registry-backed idempotency store (wired into `POST /sessions` in Task 11).

---

### Task 6: AskUserQuestion answering — protocol + server

**Files:**
- Modify: `packages/protocol/src/serialize.ts` (`classifyQuestionRequest`, `serializeHookQuestionAnswer`)
- Modify: `packages/protocol/src/index.ts` (export)
- Create: `packages/protocol/test/question.test.ts`
- Modify: `packages/server/src/claude-process.ts` (`question` event + `answerQuestion`)
- Modify: `packages/server/src/session-manager.ts` (`answerQuestion` passthrough)
- Modify: `packages/server/src/session-hub.ts` (a `question` frame + `answerQuestion`)
- Modify: `packages/server/src/replay-buffer.ts` (`"question"` is a critical kind)
- Modify: `packages/server/test/helpers/mock-claude-interactive.mjs` (a `question` mode)
- Create: `packages/server/test/question.e2e.test.ts`

**Canonical shapes:** `docs/protocol-notes.md` → "A. AskUserQuestion". The question is the SAME `hook_callback` control_request with `request.input.tool_name === "AskUserQuestion"`; questions at `request.input.tool_input.questions[]` = `{ question, header, multiSelect, options:[{label, description}] }`. ANSWER = `serializeHookPermissionResponse`-shaped allow with `hookSpecificOutput.updatedInput = { ...toolInput, answers: { "<question>": "<label>" } }`. DENY = `permissionDecision:"deny"` (cancels the question).

**Interfaces:**
- `classifyQuestionRequest(ev: ControlRequestEvent): { requestId; toolUseId?; questions: QuestionSpec[] } | null` where `QuestionSpec = { question: string; header?: string; multiSelect: boolean; options: { label: string; description?: string }[] }` — non-null ONLY when it's a `hook_callback` whose `input.tool_name === "AskUserQuestion"`.
- `serializeHookQuestionAnswer(requestId: string, originalToolInput: unknown, answers: Record<string, string | string[]>, reason?: string): string` — the allow-with-answers control_response.
- `ClaudeProcess` emits a `"question"` event (`QuestionEvent = { requestId; toolUseId?; questions: QuestionSpec[]; toolInput: unknown }`) INSTEAD of a `"permission"` event when the hook is an AskUserQuestion; `answerQuestion(requestId, toolInput, answers)` / `answerPermission(requestId, "deny")` for accept/cancel.
- `SessionHub` gains a `"question"` ServerFrame kind + `answerQuestion(id, requestId, toolInput, answers)`.

- [ ] **Step 1: Write the failing protocol test**

`packages/protocol/test/question.test.ts`:
```ts
import { expect, test } from "vitest";
import { classifyQuestionRequest, serializeHookQuestionAnswer, classifyPermissionRequest } from "../src/index.js";
import type { ControlRequestEvent } from "../src/index.js";

function hookReq(toolName: string, toolInput: unknown): ControlRequestEvent {
  return {
    type: "control_request",
    requestId: "rq-1",
    subtype: "hook_callback",
    request: { subtype: "hook_callback", callback_id: "hook_0", tool_use_id: "tu-1", input: { tool_name: toolName, tool_input: toolInput } },
    raw: {},
  };
}

test("classifyQuestionRequest extracts questions for an AskUserQuestion hook", () => {
  const ev = hookReq("AskUserQuestion", {
    questions: [{ question: "Pick a language", header: "Language", multiSelect: false, options: [{ label: "TypeScript", description: "TS" }, { label: "Python" }] }],
  });
  const q = classifyQuestionRequest(ev);
  expect(q?.requestId).toBe("rq-1");
  expect(q?.toolUseId).toBe("tu-1");
  expect(q?.questions[0]?.question).toBe("Pick a language");
  expect(q?.questions[0]?.multiSelect).toBe(false);
  expect(q?.questions[0]?.options.map((o) => o.label)).toEqual(["TypeScript", "Python"]);
});

test("classifyQuestionRequest returns null for a non-AskUserQuestion hook", () => {
  expect(classifyQuestionRequest(hookReq("Write", { file_path: "/x" }))).toBeNull();
});

test("serializeHookQuestionAnswer produces an allow with updatedInput.answers", () => {
  const toolInput = { questions: [{ question: "Pick a language", options: [{ label: "TypeScript" }] }] };
  const line = serializeHookQuestionAnswer("rq-1", toolInput, { "Pick a language": "TypeScript" });
  const obj = JSON.parse(line);
  expect(obj.type).toBe("control_response");
  expect(obj.response.request_id).toBe("rq-1");
  const out = obj.response.response.hookSpecificOutput;
  expect(out.permissionDecision).toBe("allow");
  expect(out.hookEventName).toBe("PreToolUse");
  expect(out.updatedInput.answers).toEqual({ "Pick a language": "TypeScript" });
  expect(out.updatedInput.questions).toEqual(toolInput.questions); // original input carried through
});

test("an AskUserQuestion hook is NOT misread as an ordinary permission gate by question-aware code", () => {
  // classifyPermissionRequest still returns it as a hook_callback (toolName AskUserQuestion);
  // the server uses classifyQuestionRequest FIRST so it never double-fires.
  const ev = hookReq("AskUserQuestion", { questions: [] });
  expect(classifyPermissionRequest(ev)?.toolName).toBe("AskUserQuestion");
  expect(classifyQuestionRequest(ev)).not.toBeNull();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm exec vitest run packages/protocol/test/question.test.ts`
Expected: FAIL — `classifyQuestionRequest`/`serializeHookQuestionAnswer` not exported.

- [ ] **Step 3: Implement the protocol additions**

In `packages/protocol/src/serialize.ts`, append (after `classifyPermissionRequest`):
```ts
export interface QuestionOption {
  label: string;
  description?: string;
}
export interface QuestionSpec {
  question: string;
  header?: string;
  multiSelect: boolean;
  options: QuestionOption[];
}

/**
 * Detect an AskUserQuestion hook_callback (docs/protocol-notes.md §A). The questions live at
 * request.input.tool_input.questions[]. Returns null for any other tool / control subtype.
 */
export function classifyQuestionRequest(
  ev: ControlRequestEvent,
): { requestId: string; toolUseId?: string; toolInput: unknown; questions: QuestionSpec[] } | null {
  if (ev.subtype !== "hook_callback") return null;
  const input = (ev.request.input ?? {}) as Record<string, unknown>;
  if (input.tool_name !== "AskUserQuestion") return null;
  const toolInput = (input.tool_input ?? {}) as Record<string, unknown>;
  const rawQuestions = Array.isArray(toolInput.questions) ? toolInput.questions : [];
  const questions: QuestionSpec[] = rawQuestions.map((q) => {
    const obj = (q ?? {}) as Record<string, unknown>;
    const rawOptions = Array.isArray(obj.options) ? obj.options : [];
    return {
      question: typeof obj.question === "string" ? obj.question : "",
      header: typeof obj.header === "string" ? obj.header : undefined,
      multiSelect: obj.multiSelect === true,
      options: rawOptions.map((o) => {
        const oo = (o ?? {}) as Record<string, unknown>;
        return {
          label: typeof oo.label === "string" ? oo.label : "",
          description: typeof oo.description === "string" ? oo.description : undefined,
        };
      }),
    };
  });
  return {
    requestId: ev.requestId,
    toolUseId: typeof ev.request.tool_use_id === "string" ? ev.request.tool_use_id : undefined,
    toolInput,
    questions,
  };
}

/**
 * Answer an AskUserQuestion: an allow control_response whose hookSpecificOutput.updatedInput
 * merges the chosen answers (question text -> chosen option label[s]) into the original tool input.
 * The model then runs the tool with the answers pre-filled (docs/protocol-notes.md §A).
 */
export function serializeHookQuestionAnswer(
  requestId: string,
  originalToolInput: unknown,
  answers: Record<string, string | string[]>,
  reason = "",
): string {
  const baseInput = (originalToolInput ?? {}) as Record<string, unknown>;
  return JSON.stringify({
    type: "control_response",
    response: {
      subtype: "success",
      request_id: requestId,
      response: {
        async: false,
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "allow",
          permissionDecisionReason: reason,
          updatedInput: { ...baseInput, answers },
        },
      },
    },
  });
}
```
In `packages/protocol/src/index.ts`, extend the serialize re-export to include the new functions and types:
```ts
export {
  buildImageBlock, serializeUserMessage, serializeInitialize,
  serializeHookPermissionResponse, serializeCanUseToolResponse, classifyPermissionRequest,
  classifyQuestionRequest, serializeHookQuestionAnswer,
} from "./serialize.js";
export type { QuestionSpec, QuestionOption } from "./serialize.js";
```

- [ ] **Step 4: Run protocol test**

Run: `pnpm exec vitest run packages/protocol/test/question.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the `"question"` event to `ClaudeProcess`**

In `packages/server/src/claude-process.ts`:
- Add to the imports from `@remote-coder/protocol`: `classifyQuestionRequest, serializeHookQuestionAnswer` (values) and `type QuestionSpec`.
- Add the event payload type near `PermissionEvent`:
```ts
export interface QuestionEvent {
  requestId: string;
  toolUseId?: string;
  toolInput: unknown;
  questions: QuestionSpec[];
}
```
- In `handleLine`, in the `control_request` branch, classify questions FIRST so an AskUserQuestion never also fires a permission gate. Replace the existing block:
```ts
    if (ev.type === "control_request") {
      const info = classifyPermissionRequest(ev as ControlRequestEvent);
      if (info) {
        const perm: PermissionEvent = {
          requestId: (ev as ControlRequestEvent).requestId,
          kind: info.kind,
          toolName: info.toolName,
          toolInput: info.toolInput,
          toolUseId: info.toolUseId,
        };
        this.emit("permission", perm);
      }
      return;
    }
```
with:
```ts
    if (ev.type === "control_request") {
      const question = classifyQuestionRequest(ev as ControlRequestEvent);
      if (question) {
        this.emit("question", {
          requestId: question.requestId,
          toolUseId: question.toolUseId,
          toolInput: question.toolInput,
          questions: question.questions,
        } satisfies QuestionEvent);
        return;
      }
      const info = classifyPermissionRequest(ev as ControlRequestEvent);
      if (info) {
        const perm: PermissionEvent = {
          requestId: (ev as ControlRequestEvent).requestId,
          kind: info.kind,
          toolName: info.toolName,
          toolInput: info.toolInput,
          toolUseId: info.toolUseId,
        };
        this.emit("permission", perm);
      }
      return;
    }
```
- Add the answer method (after `answerCanUseTool`):
```ts
  /** Answer an AskUserQuestion: allow + the chosen answers merged into the tool input. */
  answerQuestion(requestId: string, toolInput: unknown, answers: Record<string, string | string[]>): void {
    this.write(serializeHookQuestionAnswer(requestId, toolInput, answers));
  }
```
- Add the typed overloads for the `"question"` event to the `ClaudeProcess` interface declaration-merge block (the `on`/`once`/`emit` triples). Add to each group:
```ts
  on(event: "question", listener: (q: QuestionEvent) => void): this;
  once(event: "question", listener: (q: QuestionEvent) => void): this;
  emit(event: "question", q: QuestionEvent): boolean;
```

- [ ] **Step 6: Pass it through `SessionManager` + `SessionHub` + make `"question"` critical**

In `packages/server/src/session-manager.ts`, add (after `answerPermission`):
```ts
  answerQuestion(id: string, requestId: string, toolInput: unknown, answers: Record<string, string | string[]>): void {
    this.require(id).process.answerQuestion(requestId, toolInput, answers);
  }
```
In `packages/server/src/replay-buffer.ts`, widen the kind union and the critical check:
```ts
export type ServerFrameKind = "event" | "permission" | "question" | "result" | "diagnostic" | "exit";
```
```ts
export function isCriticalKind(kind: ServerFrameKind): boolean {
  return kind === "permission" || kind === "question" || kind === "result";
}
```
In `packages/server/src/session-hub.ts`:
- Import the new event type: add `QuestionEvent` to the `import type { ClaudeProcess, PermissionEvent, DiagnosticEvent }` line.
- In `attach`, add a listener (after the `permission` listener):
```ts
    proc.on("question", (q: QuestionEvent) => emit("question", q));
```
- Add the hub method (after `answerPermission`):
```ts
  answerQuestion(id: string, requestId: string, toolInput: unknown, answers: Record<string, string | string[]>): void {
    this.require(id);
    this.manager.answerQuestion(id, requestId, toolInput, answers);
  }
```

- [ ] **Step 7: Add a `question` mode to the interactive mock**

In `packages/server/test/helpers/mock-claude-interactive.mjs`, add a question emitter + answer handling. Add this function:
```js
function emitQuestionRequest() {
  send({
    type: "control_request",
    request_id: "q-req-0001",
    request: {
      subtype: "hook_callback",
      callback_id: "hook_0",
      tool_use_id: "toolu_q_0001",
      input: {
        session_id: SESSION_ID,
        cwd: "/mock/cwd",
        permission_mode: "default",
        hook_event_name: "PreToolUse",
        tool_name: "AskUserQuestion",
        tool_input: {
          questions: [
            { question: "Which language?", header: "Language", multiSelect: false, options: [{ label: "TypeScript", description: "TS" }, { label: "Python", description: "Py" }] },
          ],
        },
        tool_use_id: "toolu_q_0001",
      },
    },
  });
}

function emitQuestionResult(answers) {
  const picked = answers?.["Which language?"] ?? "(none)";
  send({
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_q_0001", content: `Selected: ${picked}` }] },
    session_id: SESSION_ID,
  });
  send({
    type: "result", subtype: "success", is_error: false, result: `You picked ${picked}`,
    session_id: SESSION_ID, total_cost_usd: 0, permission_denials: [],
  });
}
```
In `handle(msg)`, extend the `user` branch so `question` mode asks:
```ts
  if (msg.type === "user") {
    if (MODE === "permission") emitToolUseAndPermissionRequest();
    else if (MODE === "question") emitQuestionRequest();
    else emitSimpleTurn();
    return;
  }
```
And extend the `control_response` branch so an allow-with-`updatedInput.answers` produces the question result (keep the existing permission path):
```ts
  if (msg.type === "control_response") {
    const out = msg.response?.response?.hookSpecificOutput;
    const decision = out?.permissionDecision;
    if (out?.updatedInput?.answers) {
      emitQuestionResult(out.updatedInput.answers);
      return;
    }
    emitPermissionResult(decision === "allow" ? "allow" : "deny");
    return;
  }
```

- [ ] **Step 8: Write the server end-to-end question test**

`packages/server/test/question.e2e.test.ts`:
```ts
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";
import { WebSocket } from "ws";
import { SessionManager, createServer } from "../src/index.js";
import type { ServerRuntimeConfig, CreateServerResult, ServerFrame } from "../src/index.js";

const MOCK = fileURLToPath(new URL("./helpers/mock-claude-interactive.mjs", import.meta.url));
const TOKEN = "q-token";

let current: CreateServerResult | undefined;
afterEach(async () => {
  if (current) await current.app.close();
  current = undefined;
});

test("AskUserQuestion: question frame -> answer frame -> model reflects the choice", async () => {
  const config: ServerRuntimeConfig = {
    port: 0, bindAddress: "127.0.0.1", accessToken: TOKEN,
    fsRoot: process.cwd(), maxUploadBytes: 26214400, claude: { claudeBin: process.execPath },
  };
  const manager = new SessionManager(config.claude, {
    spawnPrefixArgs: [MOCK], baseEnv: { ...process.env, MOCK_MODE: "question" }, startTimeoutMs: 5000,
  });
  current = createServer(config, manager);
  const httpUrl = await current.app.listen({ port: 0, host: "127.0.0.1" });
  const wsBase = httpUrl.replace(/^http/, "ws");

  const created = await current.app.inject({
    method: "POST", url: "/sessions",
    headers: { authorization: `Bearer ${TOKEN}` }, payload: { cwd: process.cwd() },
  });
  const id = created.json().session.id;

  await new Promise<void>((resolve, reject) => {
    let sent = false;
    const ws = new WebSocket(`${wsBase}/sessions/${id}/ws?token=${TOKEN}`);
    ws.on("message", (raw: Buffer) => {
      const frame: ServerFrame = JSON.parse(raw.toString());
      if (!sent) {
        sent = true;
        ws.send(JSON.stringify({ type: "user", content: "ask me" }));
      }
      if (frame.kind === "question") {
        const p = frame.payload as { requestId: string; toolInput: unknown };
        ws.send(JSON.stringify({ type: "answer", requestId: p.requestId, toolInput: p.toolInput, answers: { "Which language?": "Python" } }));
      }
      if (frame.kind === "result") {
        expect((frame.payload as { result?: string }).result).toContain("Python");
        ws.close();
        resolve();
      }
    });
    ws.on("error", reject);
    setTimeout(() => reject(new Error("question e2e: no result")), 10000);
  });
}, 20000);
```
> NOTE: the `answer` client frame is recognized by `transport.ts`'s `handleClientFrame` — that wiring is added in Task 11 (the transport task). Until Task 11 lands, this test FAILS at the WS layer (the `answer` frame is ignored). Mark it as the cross-task driver and re-run it green at the end of Task 11. To keep THIS task self-verifying, also add a hub-level test below that does not need the transport.

`packages/server/test/question.hub.test.ts`:
```ts
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";
import { SessionManager, SessionHub } from "../src/index.js";
import type { ServerFrame } from "../src/index.js";

const MOCK = fileURLToPath(new URL("./helpers/mock-claude-interactive.mjs", import.meta.url));

let hub: SessionHub | undefined;
let manager: SessionManager | undefined;
afterEach(() => {
  hub?.stopAll();
  hub = undefined;
  manager = undefined;
});

test("hub surfaces a question frame and answerQuestion drives the result", async () => {
  manager = new SessionManager(
    { claudeBin: process.execPath },
    { spawnPrefixArgs: [MOCK], baseEnv: { ...process.env, MOCK_MODE: "question" }, startTimeoutMs: 5000 },
  );
  hub = new SessionHub(manager);
  const meta = await hub.createSession({ cwd: process.cwd() });

  await new Promise<void>((resolve, reject) => {
    hub!.subscribe(meta.id, (frame: ServerFrame) => {
      if (frame.kind === "question") {
        const p = frame.payload as { requestId: string; toolInput: unknown };
        hub!.answerQuestion(meta.id, p.requestId, p.toolInput, { "Which language?": "TypeScript" });
      }
      if (frame.kind === "result") {
        expect((frame.payload as { result?: string }).result).toContain("TypeScript");
        resolve();
      }
    });
    hub!.sendMessage(meta.id, "ask me");
    setTimeout(() => reject(new Error("question hub: no result")), 10000);
  });
}, 20000);
```

- [ ] **Step 9: Run the protocol + hub tests**

Run: `pnpm exec vitest run packages/protocol/test/question.test.ts packages/server/test/question.hub.test.ts`
Expected: PASS. (The `question.e2e.test.ts` goes green in Task 11 once `handleClientFrame` recognizes `answer`.)
Run: `pnpm typecheck` → PASS.

- [ ] **Step 10: Commit**

`git add -A && git commit` describing AskUserQuestion answering through the protocol + server (question event/frame, answers serializer, `answerQuestion`), wired to the transport in Task 11.

---

### Task 7: AskUserQuestion answering — PWA (`QuestionPrompt` multi-option UI)

**Files:**
- Modify: `packages/web/src/types/server.ts` (`QuestionPayload`, `question` frame kind, `answer` outbound frame)
- Modify: `packages/web/src/store/frame-reducer.ts` (`pendingQuestion` in `SessionView`)
- Create: `packages/web/src/chat/QuestionPrompt.tsx`
- Create: `packages/web/src/chat/QuestionPrompt.test.tsx`
- Modify: `packages/web/src/chat/ChatView.tsx` (render the question prompt + send `answer`/`deny`)

**Canonical shapes:** the server `question` frame payload is the `QuestionEvent` (`{ requestId, toolUseId?, toolInput, questions: QuestionSpec[] }`). The PWA renders single/multi-select per `question.multiSelect`, shows each option's `label` + `description` and the `header`, and on submit sends `{ type:"answer", requestId, toolInput, answers: { "<question>": label | label[] } }`. Cancel/Skip sends the existing `{ type:"permission", requestId, decision:"deny" }` (the model handles the denial).

**Interfaces:**
- `QuestionPayload = { requestId: string; toolUseId?: string; toolInput: unknown; questions: QuestionSpec[] }`, `QuestionSpec = { question: string; header?: string; multiSelect: boolean; options: { label: string; description?: string }[] }`.
- `OutboundFrame` gains `{ type: "answer"; requestId: string; toolInput: unknown; answers: Record<string, string | string[]> }`.
- `SessionView` gains `pendingQuestion?: QuestionPayload`; a `question` frame sets it (wireState `"awaiting"`); `result`/`permission` clears it.
- `QuestionPrompt` props: `{ question: QuestionPayload; onAnswer: (answers: Record<string, string | string[]>) => void; onCancel: () => void }`.

- [ ] **Step 1: Extend the web contract types**

In `packages/web/src/types/server.ts`:
- Add `"question"` to `ServerFrameKind`:
```ts
export type ServerFrameKind = "event" | "permission" | "question" | "result" | "diagnostic" | "exit";
```
- Add the question types (after `PermissionPayload`):
```ts
export interface QuestionOption {
  label: string;
  description?: string;
}
export interface QuestionSpec {
  question: string;
  header?: string;
  multiSelect: boolean;
  options: QuestionOption[];
}
export interface QuestionPayload {
  requestId: string;
  toolUseId?: string;
  toolInput: unknown;
  questions: QuestionSpec[];
}
```
- Extend `OutboundFrame` with the answer variant:
```ts
export type OutboundFrame =
  | {
      type: "user";
      content?: string;
      blocks?: ContentBlock[];
      text?: string;
      images?: { mediaType: string; dataBase64: string }[];
    }
  | { type: "permission"; requestId: string; decision: "allow" | "deny"; reason?: string }
  | { type: "answer"; requestId: string; toolInput: unknown; answers: Record<string, string | string[]> };
```

- [ ] **Step 2: Reduce the `question` frame into the view (failing test first)**

In `packages/web/src/store/frame-reducer.ts`:
- Import `QuestionPayload`: add it to the type import from `../types/server`.
- Add `pendingQuestion?: QuestionPayload;` to `SessionView`.
- Add a branch (place it next to the `permission` branch, BEFORE it is fine):
```ts
  if (frame.kind === "question") {
    next.pendingQuestion = frame.payload as QuestionPayload;
    next.wireState = "awaiting";
    return next;
  }
```
- In the `result` branch, also clear the pending question (add the line next to `next.pendingPermission = undefined;`):
```ts
    next.pendingQuestion = undefined;
```
Add a reducer test to the existing `packages/web/src/store/frame-reducer.test.ts` (if the file does not exist, create it):
```ts
import { describe, expect, test } from "vitest";
import { emptyView, reduceFrame } from "./frame-reducer";
import type { ServerFrame } from "../types/server";

describe("question frames", () => {
  test("a question frame sets pendingQuestion and awaiting wireState", () => {
    const frame: ServerFrame = { seq: 1, kind: "question", payload: { requestId: "rq", toolInput: {}, questions: [{ question: "Q", multiSelect: false, options: [{ label: "A" }] }] } };
    const v = reduceFrame(emptyView(), frame);
    expect(v.pendingQuestion?.requestId).toBe("rq");
    expect(v.wireState).toBe("awaiting");
  });

  test("a result clears a pending question", () => {
    let v = reduceFrame(emptyView(), { seq: 1, kind: "question", payload: { requestId: "rq", toolInput: {}, questions: [] } });
    v = reduceFrame(v, { seq: 2, kind: "result", payload: { type: "result", result: "done", raw: {} } });
    expect(v.pendingQuestion).toBeUndefined();
  });
});
```

- [ ] **Step 3: Build the `QuestionPrompt` component (failing test first)**

`packages/web/src/chat/QuestionPrompt.test.tsx`:
```tsx
import { describe, expect, test, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QuestionPrompt } from "./QuestionPrompt";
import type { QuestionPayload } from "../types/server";

function single(): QuestionPayload {
  return {
    requestId: "rq",
    toolInput: { questions: [{ question: "Which language?", header: "Language", multiSelect: false, options: [{ label: "TypeScript", description: "TS" }, { label: "Python", description: "Py" }] }] },
    questions: [{ question: "Which language?", header: "Language", multiSelect: false, options: [{ label: "TypeScript", description: "TS" }, { label: "Python", description: "Py" }] }],
  };
}

describe("QuestionPrompt", () => {
  test("renders the question, header, and every option with its description", () => {
    render(<QuestionPrompt question={single()} onAnswer={() => {}} onCancel={() => {}} />);
    expect(screen.getByText("Which language?")).toBeInTheDocument();
    expect(screen.getByText("Language")).toBeInTheDocument();
    expect(screen.getByText("TypeScript")).toBeInTheDocument();
    expect(screen.getByText("Py")).toBeInTheDocument();
  });

  test("single-select: choosing an option and submitting answers { question: label }", async () => {
    const onAnswer = vi.fn();
    render(<QuestionPrompt question={single()} onAnswer={onAnswer} onCancel={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: /Python/ }));
    await userEvent.click(screen.getByRole("button", { name: /^Submit/ }));
    expect(onAnswer).toHaveBeenCalledWith({ "Which language?": "Python" });
  });

  test("Skip/Cancel calls onCancel and never onAnswer", async () => {
    const onAnswer = vi.fn();
    const onCancel = vi.fn();
    render(<QuestionPrompt question={single()} onAnswer={onAnswer} onCancel={onCancel} />);
    await userEvent.click(screen.getByRole("button", { name: /Skip/ }));
    expect(onCancel).toHaveBeenCalled();
    expect(onAnswer).not.toHaveBeenCalled();
  });

  test("multi-select: toggling options submits a label array", async () => {
    const q = single();
    q.questions[0]!.multiSelect = true;
    (q.toolInput as { questions: { multiSelect: boolean }[] }).questions[0]!.multiSelect = true;
    const onAnswer = vi.fn();
    render(<QuestionPrompt question={q} onAnswer={onAnswer} onCancel={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: /TypeScript/ }));
    await userEvent.click(screen.getByRole("button", { name: /Python/ }));
    await userEvent.click(screen.getByRole("button", { name: /^Submit/ }));
    expect(onAnswer).toHaveBeenCalledWith({ "Which language?": ["TypeScript", "Python"] });
  });
});
```

`packages/web/src/chat/QuestionPrompt.tsx`:
```tsx
import { useEffect, useRef, useState } from "react";
import { Surface } from "../ui/Surface";
import { Button } from "../ui/Button";
import type { QuestionPayload } from "../types/server";

export interface QuestionPromptProps {
  question: QuestionPayload;
  onAnswer: (answers: Record<string, string | string[]>) => void;
  onCancel: () => void;
}

/**
 * The "awaiting you" moment for an AskUserQuestion. Renders each question (header + prompt) with
 * its options; single-select picks one label, multi-select toggles a set. Submit returns the
 * answers map (question text -> chosen label | label[]); Skip cancels (the server denies the tool).
 */
export function QuestionPrompt({ question, onAnswer, onCancel }: QuestionPromptProps) {
  // selections[questionIndex] = a Set of chosen labels (single-select keeps at most one).
  const [selections, setSelections] = useState<Record<number, Set<string>>>({});

  const regionRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    regionRef.current?.focus();
  }, [question.requestId]);

  function toggle(qi: number, label: string, multi: boolean) {
    setSelections((prev) => {
      const current = new Set(prev[qi] ?? []);
      if (multi) {
        if (current.has(label)) current.delete(label);
        else current.add(label);
      } else {
        current.clear();
        current.add(label);
      }
      return { ...prev, [qi]: current };
    });
  }

  function submit() {
    const answers: Record<string, string | string[]> = {};
    question.questions.forEach((q, qi) => {
      const chosen = [...(selections[qi] ?? [])];
      if (chosen.length === 0) return;
      answers[q.question] = q.multiSelect ? chosen : chosen[0]!;
    });
    onAnswer(answers);
  }

  const allAnswered = question.questions.every((_, qi) => (selections[qi]?.size ?? 0) > 0);

  return (
    <Surface level={2} as="article">
      <div
        ref={regionRef}
        role="region"
        aria-label="Question"
        tabIndex={-1}
        style={{ borderLeft: "3px solid var(--iris)", padding: "var(--sp-4)", display: "grid", gap: "var(--sp-4)" }}
      >
        <div style={{ color: "var(--iris)", fontFamily: "var(--font-display)" }}>Awaiting you — question</div>
        {question.questions.map((q, qi) => (
          <div key={qi} style={{ display: "grid", gap: "var(--sp-2)" }}>
            {q.header && (
              <div style={{ color: "var(--text-muted)", fontSize: "var(--fs-xs)", textTransform: "uppercase", letterSpacing: 1 }}>
                {q.header}
              </div>
            )}
            <div>{q.question}</div>
            <div role={q.multiSelect ? "group" : "radiogroup"} style={{ display: "grid", gap: "var(--sp-2)" }}>
              {q.options.map((opt) => {
                const selected = selections[qi]?.has(opt.label) ?? false;
                // NOTE: the shared `Button` (packages/web/src/ui/Button.tsx) has CLOSED props (no
                // `style`, no `aria-pressed`, no rest spread), so option toggles are plain styled
                // <button>s. The Submit/Skip controls below use only Button's real props, so they
                // stay <Button>.
                return (
                  <button
                    key={opt.label}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => toggle(qi, opt.label, q.multiSelect)}
                    className="rc-focusable"
                    style={{
                      display: "grid",
                      gap: "2px",
                      justifyItems: "start",
                      textAlign: "left",
                      minHeight: "var(--tap-min)",
                      padding: "var(--sp-3)",
                      borderRadius: "var(--radius-sm)",
                      border: `1px solid ${selected ? "var(--iris)" : "var(--border)"}`,
                      background: selected ? "var(--iris)" : "transparent",
                      color: selected ? "var(--on-accent)" : "var(--text)",
                      font: "inherit",
                      cursor: "pointer",
                    }}
                  >
                    <span>{opt.label}</span>
                    {opt.description && (
                      <span style={{ color: selected ? "var(--on-accent)" : "var(--text-muted)", fontSize: "var(--fs-xs)" }}>
                        {opt.description}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
        <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--sp-3)" }}>
          <Button variant="primary" onClick={submit} disabled={!allAnswered} aria-label="Submit answer">
            Submit
          </Button>
          <Button variant="ghost" onClick={onCancel} aria-label="Skip question">
            Skip
          </Button>
        </div>
      </div>
    </Surface>
  );
}
```
> The shared `Button` (`packages/web/src/ui/Button.tsx`) accepts ONLY `variant`/`type`/`disabled`/`onClick`/`aria-label`/`className`/`children` and does NOT spread rest props — passing `style`/`aria-pressed` to it FAILS `pnpm -C packages/web typecheck`. That is why the OPTION toggles are plain styled `<button>`s (above) carrying their own `style` + `aria-pressed` + the iris selected state. The `className="rc-focusable"` is optional polish; Plan 4 already ships a GLOBAL `:focus-visible` ring (in `index.css`), so a bare `<button>` is keyboard-accessible without it — if `rc-focusable` is not already a defined class, drop the `className` line rather than inventing one. The Submit/Skip controls remain `<Button>` because they use only its real props.

- [ ] **Step 4: Run the web tests for the new component + reducer**

Run: `pnpm -C packages/web exec vitest run src/chat/QuestionPrompt.test.tsx src/store/frame-reducer.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire `QuestionPrompt` into `ChatView`**

In `packages/web/src/chat/ChatView.tsx`:
- Import the component: `import { QuestionPrompt } from "./QuestionPrompt";`
- After the `answer` callback (the permission one), add a question-answer + cancel callback:
```ts
  const answerQuestion = useCallback(
    (requestId: string, toolInput: unknown, answers: Record<string, string | string[]>) => {
      if (answeredRef.current.has(requestId)) return;
      answeredRef.current.add(requestId);
      setAnswered((prev) => new Set(prev).add(requestId));
      send({ type: "answer", requestId, toolInput, answers });
    },
    [send],
  );
  const cancelQuestion = useCallback(
    (requestId: string) => {
      if (answeredRef.current.has(requestId)) return;
      answeredRef.current.add(requestId);
      setAnswered((prev) => new Set(prev).add(requestId));
      send({ type: "permission", requestId, decision: "deny" });
    },
    [send],
  );
```
- Add a `pendingQuestion` read next to `const pending = safeView.pendingPermission;`:
```ts
  const pendingQuestion = safeView.pendingQuestion;
  const questionAnswered = pendingQuestion !== undefined && answered.has(pendingQuestion.requestId);
```
- Render it inside the scroll region, AFTER the permission prompt block:
```tsx
        {pendingQuestion && !questionAnswered && (
          <div style={{ padding: "var(--sp-4)" }}>
            <QuestionPrompt
              question={pendingQuestion}
              onAnswer={(answers) => answerQuestion(pendingQuestion.requestId, pendingQuestion.toolInput, answers)}
              onCancel={() => cancelQuestion(pendingQuestion.requestId)}
            />
          </div>
        )}
```

- [ ] **Step 6: Run the web suite + typecheck**

Run: `pnpm -C packages/web test`
Expected: PASS (existing `PermissionPrompt.test.tsx` is UNCHANGED — AskUserQuestion no longer reaches `PermissionPrompt` because the server now emits a `question` frame; the old "renders AskUserQuestion as allow/deny" test still passes because it constructs a `PermissionPayload` directly and asserts that component in isolation. If that test instead drives a full `question`-frame flow through `ChatView`, update it to expect `QuestionPrompt` — check and adapt).
Run: `pnpm -C packages/web run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

`git add -A && git commit` describing the AskUserQuestion multi-option PWA UI replacing the allow/deny-only handling.

---

### Task 8: Live mid-session settings — protocol + server

**Files:**
- Modify: `packages/protocol/src/serialize.ts` (`serializeSetModel`, `serializeSetMaxThinkingTokens`, `serializeSetPermissionMode`)
- Modify: `packages/protocol/src/index.ts` (export)
- Create: `packages/protocol/test/live-settings.test.ts`
- Modify: `packages/server/src/claude-process.ts` (`setModel`/`setMaxThinkingTokens`/`setPermissionMode`)
- Modify: `packages/server/src/session-manager.ts` (passthrough)
- Modify: `packages/server/src/session-hub.ts` (`applySettings` + meta update)
- Modify: `packages/server/test/helpers/mock-claude-interactive.mjs` (ack live-control requests)
- Create: `packages/server/test/live-settings.test.ts`

**Canonical shapes (VERIFIED against the real binary — see `docs/protocol-notes.md` → "Live settings"):** standard control envelope `{ type:"control_request", request_id, request:{ subtype, ...fields } }` (same shape as `initialize`); `request_id` is top-level and echoed inside the CLI's `control_response`. The three accepted subtypes, with their exact field names and confirmation signals:
- **`set_model`**: `request:{ subtype:"set_model", model:"<id>" }` (omit `model` or pass `"default"` to reset). Confirmation: the NEXT turn's `system/init` (and the following `assistant`+`result`) reports the new model.
- **`set_max_thinking_tokens`**: `request:{ subtype:"set_max_thinking_tokens", max_thinking_tokens:<number|null>, thinking_display?:"summarized"|"omitted"|null }`. No stdout echo → treat the `control_response` `subtype:"success"` as the confirmation.
- **`set_permission_mode`**: `request:{ subtype:"set_permission_mode", mode:"default"|"acceptEdits"|"bypassPermissions"|"plan"|"dontAsk"|"auto" }`. Confirmation: the next `system/init.permissionMode` flips; the `control_response` echoes `{ mode }`.
Effort maps to a thinking-token budget (the PWA's effort levels → `max_thinking_tokens` via `EFFORT_THINKING_TOKENS`, Task 9). **Apply on a turn boundary** — the daemon should send a settings control between turns (not mid-stream), so the change takes effect on the next `system/init`. These are FIRE-AND-FORWARD over stdin; the CLI acks each with a `control_response`.

**Interfaces:**
- `serializeSetModel(model: string, opts?: { requestId?: string }): string` → `{ subtype:"set_model", model }`.
- `serializeSetMaxThinkingTokens(maxThinkingTokens: number | null, opts?: { requestId?: string; thinkingDisplay?: "summarized" | "omitted" | null }): string` → `{ subtype:"set_max_thinking_tokens", max_thinking_tokens, thinking_display? }`.
- `serializeSetPermissionMode(mode: string, opts?: { requestId?: string }): string` → `{ subtype:"set_permission_mode", mode }`.
- `ClaudeProcess.setModel(model)`, `setMaxThinkingTokens(n, thinkingDisplay?)`, `setPermissionMode(mode)` — each writes the serialized control_request.
- `SessionHub.applySettings(id, { model?, maxThinkingTokens?, permissionMode? })` sends each provided control AND updates the in-memory `SessionMeta` (`model`, etc.) so subsequent `getSession` reflects the change.

- [ ] **Step 1: Write the failing protocol test**

`packages/protocol/test/live-settings.test.ts`:
```ts
import { expect, test } from "vitest";
import { serializeSetModel, serializeSetMaxThinkingTokens, serializeSetPermissionMode } from "../src/index.js";

test("serializeSetModel builds a set_model control_request", () => {
  const obj = JSON.parse(serializeSetModel("claude-opus-4-8"));
  expect(obj.type).toBe("control_request");
  expect(typeof obj.request_id).toBe("string");
  expect(obj.request).toEqual({ subtype: "set_model", model: "claude-opus-4-8" });
});

test("serializeSetMaxThinkingTokens builds a set_max_thinking_tokens control_request", () => {
  const obj = JSON.parse(serializeSetMaxThinkingTokens(8000));
  expect(obj.request).toEqual({ subtype: "set_max_thinking_tokens", max_thinking_tokens: 8000 });
});

test("serializeSetMaxThinkingTokens carries an optional thinking_display", () => {
  const obj = JSON.parse(serializeSetMaxThinkingTokens(8000, { thinkingDisplay: "summarized" }));
  expect(obj.request).toEqual({ subtype: "set_max_thinking_tokens", max_thinking_tokens: 8000, thinking_display: "summarized" });
});

test("serializeSetMaxThinkingTokens accepts null to clear the budget", () => {
  const obj = JSON.parse(serializeSetMaxThinkingTokens(null));
  expect(obj.request).toEqual({ subtype: "set_max_thinking_tokens", max_thinking_tokens: null });
});

test("serializeSetPermissionMode builds a set_permission_mode control_request", () => {
  const obj = JSON.parse(serializeSetPermissionMode("acceptEdits"));
  expect(obj.request).toEqual({ subtype: "set_permission_mode", mode: "acceptEdits" });
});

test("an explicit requestId is honored", () => {
  const obj = JSON.parse(serializeSetModel("m", { requestId: "fixed-id" }));
  expect(obj.request_id).toBe("fixed-id");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm exec vitest run packages/protocol/test/live-settings.test.ts`
Expected: FAIL — serializers not exported.

- [ ] **Step 3: Implement the protocol serializers**

In `packages/protocol/src/serialize.ts`, append:
```ts
function controlRequest(request: Record<string, unknown>, requestId?: string): string {
  return JSON.stringify({ type: "control_request", request_id: requestId ?? `ctl-${randomUUID()}`, request });
}

/** Client -> CLI: switch the model for the live session (docs/protocol-notes.md control protocol). */
export function serializeSetModel(model: string, opts: { requestId?: string } = {}): string {
  return controlRequest({ subtype: "set_model", model }, opts.requestId);
}

/**
 * Client -> CLI: set the thinking-token budget (our "effort" maps onto this). `null` clears it.
 * The optional thinking_display controls how thinking renders ("summarized" | "omitted" | null).
 * VERIFIED field names against the real binary (docs/protocol-notes.md → "Live settings").
 */
export function serializeSetMaxThinkingTokens(
  maxThinkingTokens: number | null,
  opts: { requestId?: string; thinkingDisplay?: "summarized" | "omitted" | null } = {},
): string {
  const request: Record<string, unknown> = { subtype: "set_max_thinking_tokens", max_thinking_tokens: maxThinkingTokens };
  if (opts.thinkingDisplay !== undefined) request.thinking_display = opts.thinkingDisplay;
  return controlRequest(request, opts.requestId);
}

/** Client -> CLI: change the permission mode (default | acceptEdits | bypassPermissions | plan | dontAsk | auto). */
export function serializeSetPermissionMode(mode: string, opts: { requestId?: string } = {}): string {
  return controlRequest({ subtype: "set_permission_mode", mode }, opts.requestId);
}
```
(`randomUUID` is already imported at the top of `serialize.ts`.)
In `packages/protocol/src/index.ts`, add the three to the serialize re-export block:
```ts
  serializeSetModel, serializeSetMaxThinkingTokens, serializeSetPermissionMode,
```

- [ ] **Step 4: Run protocol test**

Run: `pnpm exec vitest run packages/protocol/test/live-settings.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the control methods to `ClaudeProcess`**

In `packages/server/src/claude-process.ts`:
- Add to the value imports from `@remote-coder/protocol`: `serializeSetModel, serializeSetMaxThinkingTokens, serializeSetPermissionMode`.
- Add the methods (after `answerQuestion`):
```ts
  setModel(model: string): void {
    this.write(serializeSetModel(model));
  }
  setMaxThinkingTokens(maxThinkingTokens: number | null, thinkingDisplay?: "summarized" | "omitted" | null): void {
    this.write(serializeSetMaxThinkingTokens(maxThinkingTokens, thinkingDisplay === undefined ? {} : { thinkingDisplay }));
  }
  setPermissionMode(mode: string): void {
    this.write(serializeSetPermissionMode(mode));
  }
```

- [ ] **Step 6: Passthrough on `SessionManager` + `applySettings` on `SessionHub`**

In `packages/server/src/session-manager.ts`, add (after `answerQuestion`):
```ts
  setModel(id: string, model: string): void {
    this.require(id).process.setModel(model);
  }
  setMaxThinkingTokens(id: string, maxThinkingTokens: number | null): void {
    this.require(id).process.setMaxThinkingTokens(maxThinkingTokens);
  }
  setPermissionMode(id: string, mode: string): void {
    this.require(id).process.setPermissionMode(mode);
  }
```
In `packages/server/src/session-hub.ts`, add a settings type + method. Add near the top (after `SessionMeta`):
```ts
export interface LiveSettings {
  model?: string;
  /** Thinking-token budget (the PWA's effort maps onto this). */
  maxThinkingTokens?: number;
  /** Optional human label for the effort the maxThinkingTokens came from, mirrored into meta.effort. */
  effort?: string;
  permissionMode?: string;
}
```
Add the method (after `answerQuestion`):
```ts
  /**
   * Apply live settings to a running session: send each provided control to the CLI and mirror the
   * change into the in-memory SessionMeta so a subsequent getSession reflects it.
   */
  applySettings(id: string, settings: LiveSettings): SessionMeta {
    const record = this.require(id);
    if (settings.model !== undefined) {
      this.manager.setModel(id, settings.model);
      record.meta.model = settings.model;
    }
    if (settings.maxThinkingTokens !== undefined) {
      this.manager.setMaxThinkingTokens(id, settings.maxThinkingTokens);
      if (settings.effort !== undefined) record.meta.effort = settings.effort;
    }
    if (settings.permissionMode !== undefined) {
      this.manager.setPermissionMode(id, settings.permissionMode);
    }
    return record.meta;
  }
```
(`require(id)` returns the `SessionRecord`; reuse it. Confirm `require` is the private method returning the record — it is.)

- [ ] **Step 7: Make the mock ack live-control requests**

In `packages/server/test/helpers/mock-claude-interactive.mjs`, in `handle(msg)`, extend the `control_request` recognition so a live-control subtype is acked (so `ClaudeProcess.write` has a well-behaved peer; the ack is optional but keeps the mock realistic). Add to the `control_request` branch (after the `initialize` check):
```js
  if (msg.type === "control_request" && ["set_model", "set_max_thinking_tokens", "set_permission_mode"].includes(msg.request?.subtype)) {
    send({ type: "control_response", response: { subtype: "success", request_id: msg.request_id, response: { ok: true } } });
    return;
  }
```

- [ ] **Step 8: Write the server live-settings test**

`packages/server/test/live-settings.test.ts`:
```ts
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";
import { SessionManager, SessionHub } from "../src/index.js";

const MOCK = fileURLToPath(new URL("./helpers/mock-claude-interactive.mjs", import.meta.url));

let hub: SessionHub | undefined;
afterEach(() => {
  hub?.stopAll();
  hub = undefined;
});

test("applySettings sends controls and mirrors model/effort into the session meta", async () => {
  const manager = new SessionManager(
    { claudeBin: process.execPath },
    { spawnPrefixArgs: [MOCK], baseEnv: { ...process.env, MOCK_MODE: "simple" }, startTimeoutMs: 5000 },
  );
  hub = new SessionHub(manager);
  const meta = await hub.createSession({ cwd: process.cwd(), model: "claude-mock" });

  const updated = hub.applySettings(meta.id, { model: "claude-opus-4-8", maxThinkingTokens: 8000, effort: "high", permissionMode: "acceptEdits" });
  expect(updated.model).toBe("claude-opus-4-8");
  expect(updated.effort).toBe("high");
  // getSession reflects the mutation.
  expect(hub.getSession(meta.id)?.model).toBe("claude-opus-4-8");
});
```

- [ ] **Step 9: Run tests + typecheck**

Run: `pnpm exec vitest run packages/protocol/test/live-settings.test.ts packages/server/test/live-settings.test.ts`
Expected: PASS. Run: `pnpm typecheck` → PASS.

- [ ] **Step 10: Commit**

`git add -A && git commit` describing live mid-session settings (serializers, `ClaudeProcess` control methods, `applySettings`) — wired to the transport/PWA in Tasks 9/11.

---

### Task 9: Live settings — PWA (`SettingsPanel` mutates the active session)

**Files:**
- Modify: `packages/web/src/types/server.ts` (`settings` outbound frame)
- Modify: `packages/web/src/settings/defaults.ts` (`PERMISSION_MODES`, `EFFORT_THINKING_TOKENS`)
- Modify: `packages/web/src/settings/SettingsPanel.tsx` (live-edit the active session)
- Modify: `packages/web/src/settings/SettingsPanel.test.tsx`
- Modify: `packages/web/src/chat/ChatView.tsx` (pass an `onApplyLiveSettings` that sends the frame + updates the session list)

**Canonical shapes:** Plan 4 made `SettingsPanel`'s active-session view READ-ONLY (Plan 3 had no mutation endpoint). Now the WS carries a `settings` frame to the live session: `{ type:"settings", model?, maxThinkingTokens?, effort?, permissionMode? }`. The PWA maps an effort level → a thinking-token budget (`EFFORT_THINKING_TOKENS`) before sending. The server reflects it (Task 8 `applySettings`, wired in Task 11), and the panel optimistically updates the displayed `SessionMeta`.

**Interfaces:**
- `OutboundFrame` gains `{ type: "settings"; model?: string; maxThinkingTokens?: number; effort?: string; permissionMode?: string }`.
- `PERMISSION_MODES = ["default","acceptEdits","plan"] as const` and `EFFORT_THINKING_TOKENS: Record<string, number>` in `settings/defaults.ts`.
- `SettingsPanelProps` gains `onApplyLiveSettings?: (s: { model?: string; effort?: string; permissionMode?: string }) => void` (omit → the active-session block stays read-only, preserving the Plan-4 behavior when no live channel is available).

> **Spec §8 token/cost — what IS and IS NOT done (don't leave it silently missing):** cumulative cost/usage is ALREADY surfaced in the UI from the `result` frame — `ResultPayload.totalCostUsd` flows through the reducer into the per-turn `{kind:"result", totalCostUsd}` item (Plan 4), so cost is shown live and per-turn in the transcript. What this plan deliberately does NOT do is **persist** token/cost into the SQLite registry (`StoredSession` has no cost columns). Per-session cumulative cost persistence (sum `result.totalCostUsd` into the registry so a restarted/dormant session shows historical spend) is DEFERRED — a small additive column + an `onResult` `store.touch`-style accumulator, noted in "Notes carried to later plans". The live/per-turn display covers the §8 intent for v1.

- [ ] **Step 1: Extend the outbound frame + settings constants**

In `packages/web/src/types/server.ts`, add to the `OutboundFrame` union:
```ts
  | { type: "settings"; model?: string; maxThinkingTokens?: number; effort?: string; permissionMode?: string };
```
In `packages/web/src/settings/defaults.ts`, append:
```ts
export const PERMISSION_MODES = ["default", "acceptEdits", "plan"] as const;

/** Map an effort level onto a thinking-token budget for set_max_thinking_tokens. */
export const EFFORT_THINKING_TOKENS: Record<string, number> = {
  low: 1024,
  medium: 4096,
  high: 8192,
  xhigh: 16384,
  max: 32768,
};
```

- [ ] **Step 2: Make `SettingsPanel` live-edit the active session (failing test first)**

In `packages/web/src/settings/SettingsPanel.test.tsx`, add (keep existing tests):
```tsx
import { expect, test, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SettingsPanel } from "./SettingsPanel";
import type { SessionMeta } from "../types/server";

function meta(): SessionMeta {
  return { id: "s1", cwd: "/w", model: "claude-mock", effort: "medium", dangerouslySkip: false, status: "running", createdAt: 0 };
}

test("when onApplyLiveSettings is provided, changing the active session's model sends a live update", async () => {
  const onApply = vi.fn();
  render(
    <SettingsPanel
      session={meta()}
      defaults={{ effort: "medium", dangerouslySkip: false }}
      onSaveDefaults={() => {}}
      onApplyLiveSettings={onApply}
      onClose={() => {}}
    />,
  );
  const modelInput = screen.getByLabelText(/active session model/i);
  await userEvent.clear(modelInput);
  await userEvent.type(modelInput, "claude-opus-4-8");
  await userEvent.click(screen.getByRole("button", { name: /apply to session/i }));
  expect(onApply).toHaveBeenCalledWith(expect.objectContaining({ model: "claude-opus-4-8" }));
});

test("without onApplyLiveSettings the active session block stays read-only (no apply button)", () => {
  render(
    <SettingsPanel session={meta()} defaults={{ effort: "medium", dangerouslySkip: false }} onSaveDefaults={() => {}} onClose={() => {}} />,
  );
  expect(screen.queryByRole("button", { name: /apply to session/i })).toBeNull();
});
```

- [ ] **Step 3: Implement the live-edit section**

In `packages/web/src/settings/SettingsPanel.tsx`:
- **Merge into the EXISTING import** — `SettingsPanel` already has `import { EFFORTS } from "./defaults";`. EDIT that line to add `PERMISSION_MODES` rather than adding a second import (a duplicate `EFFORTS` import fails lint/typecheck):
```ts
import { EFFORTS, PERMISSION_MODES } from "./defaults";
```
- Add the prop to `SettingsPanelProps`:
```ts
  /** When provided, the active-session block becomes editable and applies changes live. */
  onApplyLiveSettings?: (s: { model?: string; effort?: string; permissionMode?: string }) => void;
```
- Destructure it in the component signature: add `onApplyLiveSettings` to the props list.
- Add live-draft state near the existing `draft` state:
```ts
  const [liveModel, setLiveModel] = useState(session?.model ?? "");
  const [liveEffort, setLiveEffort] = useState(session?.effort ?? "medium");
  const [livePermissionMode, setLivePermissionMode] = useState("default");
```
- REPLACE the read-only `{session && (...)}` block's trailing copy + (keep the directory/cost display) so that, WHEN `onApplyLiveSettings` is provided, the model/effort/permission render as editable controls with an "Apply to session" button. Specifically, inside the `{session && (...)}` section, after the existing `Directory:` line, render:
```tsx
              {onApplyLiveSettings ? (
                <div style={{ display: "grid", gap: "var(--sp-3)" }}>
                  <label style={{ display: "grid", gap: "var(--sp-2)" }}>
                    <span style={{ fontSize: "var(--fs-sm)" }}>Active session model</span>
                    <input
                      aria-label="active session model"
                      value={liveModel}
                      onChange={(e) => setLiveModel(e.target.value)}
                      placeholder="default"
                      style={{ ...fieldStyle, fontFamily: "var(--font-mono)" }}
                    />
                  </label>
                  <label style={{ display: "grid", gap: "var(--sp-2)" }}>
                    <span style={{ fontSize: "var(--fs-sm)" }}>Active session effort</span>
                    <select aria-label="active session effort" value={liveEffort} onChange={(e) => setLiveEffort(e.target.value)} style={fieldStyle}>
                      {EFFORTS.map((e) => (
                        <option key={e} value={e}>{e}</option>
                      ))}
                    </select>
                  </label>
                  <label style={{ display: "grid", gap: "var(--sp-2)" }}>
                    <span style={{ fontSize: "var(--fs-sm)" }}>Active session permission mode</span>
                    <select aria-label="active session permission mode" value={livePermissionMode} onChange={(e) => setLivePermissionMode(e.target.value)} style={fieldStyle}>
                      {PERMISSION_MODES.map((m) => (
                        <option key={m} value={m}>{m}</option>
                      ))}
                    </select>
                  </label>
                  <Button
                    variant="primary"
                    aria-label="Apply to session"
                    onClick={() =>
                      onApplyLiveSettings({
                        model: liveModel || undefined,
                        effort: liveEffort,
                        permissionMode: livePermissionMode,
                      })
                    }
                  >
                    Apply to session
                  </Button>
                </div>
              ) : (
                <>
                  <div>Model: <Mono>{session.model ?? "default"}</Mono></div>
                  <div>Effort: <Mono>{session.effort ?? "default"}</Mono></div>
                  <div>Skip permissions: <Mono>{String(session.dangerouslySkip)}</Mono></div>
                  <p style={{ color: "var(--text-muted)", fontSize: "var(--fs-xs)", margin: 0 }}>
                    Model/effort/permissions are set when a session starts. To change them, start a new session.
                  </p>
                </>
              )}
```
> Replace the EXISTING three `<div>Model/Effort/Skip</div>` lines + the trailing `<p>` from the Plan-4 version with the conditional above (the editable branch when a live channel exists, the read-only branch otherwise). Keep the `onStopSession` Stop button block below it unchanged.

- [ ] **Step 4: Run the settings tests**

Run: `pnpm -C packages/web exec vitest run src/settings/SettingsPanel.test.tsx`
Expected: PASS (both new tests + the existing defaults tests).

- [ ] **Step 5: Wire `ChatView` to send the `settings` frame**

In `packages/web/src/chat/ChatView.tsx`:
- Import the token map: `import { loadDefaults, saveDefaults, EFFORT_THINKING_TOKENS } from "../settings/defaults";`
- Pass `onApplyLiveSettings` to the rendered `<SettingsPanel>`:
```tsx
          onApplyLiveSettings={({ model, effort, permissionMode }) => {
            const maxThinkingTokens = effort ? EFFORT_THINKING_TOKENS[effort] : undefined;
            send({ type: "settings", model, effort, maxThinkingTokens, permissionMode });
            // Optimistically reflect into the session list so the header/meta update immediately.
            setSessions(sessions.map((s) => (s.id === session.id ? { ...s, model: model ?? s.model, effort: effort ?? s.effort } : s)));
            setSettingsOpen(false);
          }}
```
(Insert it alongside the existing `onSaveDefaults`/`onStopSession`/`onClose` props.)

- [ ] **Step 6: Run the web suite + typecheck**

Run: `pnpm -C packages/web test`
Expected: PASS.
Run: `pnpm -C packages/web run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

`git add -A && git commit` describing live mid-session settings in the PWA (`SettingsPanel` mutates the active session via a `settings` frame).

---

### Task 10: Server hardening (auth eviction, fs realpath + 404/403, config validation)

**Files:**
- Modify: `packages/server/src/auth.ts` (opportunistic lockout-map eviction)
- Modify: `packages/server/src/fs-service.ts` (`realpath` symlink defense + typed FsError)
- Modify: `packages/server/src/transport.ts` (403 vs 404 from typed errors)
- Modify: `packages/server/src/server-config.ts` (PORT/MAX_UPLOAD_BYTES NaN/range validation)
- Modify: `packages/server/test/auth.test.ts`, `packages/server/test/fs-service.test.ts`, `packages/server/test/server-config.test.ts` (add cases)

**Canonical shapes:** spec §9 (auth hardening), §10 (fs guarding), and the deferred Plan-3 items. The lockout `clients` map grows unbounded (only cleared on a SUCCESSFUL auth for that key) — add opportunistic eviction of expired entries. The fs root-confinement is string-prefix only (a symlink inside root pointing outside is NOT caught) — add `realpath` defense. `FsService` throws plain `Error`s, distinguished by substring match in transport — replace with typed errors so 404 (not found) vs 403 (forbidden/outside root) is robust. `loadServerConfig` does no NaN/range validation on `PORT`/`MAX_UPLOAD_BYTES`.

- [ ] **Step 1: Auth lockout eviction (failing test first)**

In `packages/server/test/auth.test.ts`, add (using the injectable `now`):
```ts
import { expect, test } from "vitest";
import { AuthGate } from "../src/index.js";

test("expired lockout entries are evicted opportunistically (map does not grow unbounded)", () => {
  let t = 0;
  const gate = new AuthGate({ token: "secret", maxFailures: 1, lockoutMs: 100, now: () => t });
  // Lock out client A at t=0.
  gate.check("wrong", "A"); // 1 failure -> locks
  expect(gate.lockedClientCount()).toBe(1);
  // Advance past the lockout window; a check for a DIFFERENT client sweeps A out.
  t = 1000;
  gate.check("secret", "B"); // success for B; the sweep removes the expired A entry
  expect(gate.lockedClientCount()).toBe(0);
});
```

- [ ] **Step 2: Implement eviction**

In `packages/server/src/auth.ts`, add a sweep + a test-visible count. Inside `check`, BEFORE reading the client's state, opportunistically sweep expired entries (cap the work so it stays O(small) per call):
```ts
  check(presentedToken: string | undefined, clientKey: string): AuthCheckResult {
    if (!this.token) return { ok: false, reason: "missing-token-config" };
    this.sweepExpired();
```
Add the methods to the class:
```ts
  /** Drop entries whose lockout has expired and whose failure count is 0 — keeps the map bounded. */
  private sweepExpired(): void {
    const t = this.now();
    for (const [key, state] of this.clients) {
      if (state.lockedUntil <= t && state.failures === 0) this.clients.delete(key);
    }
  }

  /** TEST ONLY: number of tracked clients currently locked (lockedUntil in the future). */
  lockedClientCount(): number {
    const t = this.now();
    let n = 0;
    for (const state of this.clients.values()) if (state.lockedUntil > t) n += 1;
    return n;
  }
```
> Note: when a lockout is SET, the code resets `failures = 0` (the lock governs). So after the window passes, such an entry has `failures === 0` and `lockedUntil <= now` → it is swept. An entry mid-accumulation (`failures > 0`, not yet locked) is kept. This keeps the map bounded by the number of CURRENTLY-active (accumulating or locked) clients.

- [ ] **Step 3: fs `realpath` symlink defense + typed errors (failing test first)**

In `packages/server/test/fs-service.test.ts`, add (creates a symlink inside root pointing outside):
```ts
import { mkdtemp, rm, mkdir, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { FsService, FsError } from "../src/index.js";

let root: string;
let outside: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "rc-fsroot-"));
  outside = await mkdtemp(join(tmpdir(), "rc-outside-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

test("a symlink inside root that points outside root is rejected (realpath defense)", async () => {
  await writeFile(join(outside, "secret.txt"), "TOP SECRET");
  await symlink(join(outside, "secret.txt"), join(root, "link.txt"));
  const svc = new FsService({ root });
  await expect(svc.readFileForDownload(join(root, "link.txt"))).rejects.toBeInstanceOf(FsError);
  await expect(svc.readFileForDownload(join(root, "link.txt"))).rejects.toMatchObject({ code: "forbidden" });
});

test("a missing file throws FsError with code not-found", async () => {
  const svc = new FsService({ root });
  await expect(svc.readFileForDownload(join(root, "nope.txt"))).rejects.toMatchObject({ code: "not-found" });
});
```

- [ ] **Step 4: Implement `FsError` + realpath**

In `packages/server/src/fs-service.ts`:
- Add the import: `import { readdir, readFile, writeFile, stat, realpath } from "node:fs/promises";` (add `realpath`).
- Add a typed error class at the top (after the imports):
```ts
export type FsErrorCode = "forbidden" | "not-found";

export class FsError extends Error {
  readonly code: FsErrorCode;
  constructor(code: FsErrorCode, message: string) {
    super(message);
    this.name = "FsError";
    this.code = code;
  }
}
```
- In `resolveWithinRoot`, throw a typed `FsError` instead of a plain Error:
```ts
  resolveWithinRoot(target: string): string {
    const resolved = resolve(this.root, target);
    if (resolved !== this.root && !resolved.startsWith(this.root + sep)) {
      throw new FsError("forbidden", `path is outside the allowed root: ${target}`);
    }
    return resolved;
  }
```
- Add a realpath confinement helper (defense-in-depth: catches symlinks that escape root AFTER the lexical check):
```ts
  /** Resolve real paths so a symlink inside root cannot point outside it. Missing -> not-found. */
  private async realWithinRoot(resolvedPath: string): Promise<string> {
    let realRoot: string;
    let realTarget: string;
    try {
      realRoot = await realpath(this.root);
    } catch {
      realRoot = this.root;
    }
    try {
      realTarget = await realpath(resolvedPath);
    } catch {
      throw new FsError("not-found", `not found: ${resolvedPath}`);
    }
    if (realTarget !== realRoot && !realTarget.startsWith(realRoot + sep)) {
      throw new FsError("forbidden", `path resolves outside the allowed root`);
    }
    return realTarget;
  }
```
- In `readFileForDownload`, run BOTH guards:
```ts
  async readFileForDownload(target: string): Promise<{ filename: string; data: Buffer }> {
    const file = this.resolveWithinRoot(target);
    const real = await this.realWithinRoot(file);
    const data = await readFile(real);
    return { filename: basename(file), data };
  }
```
> `listDirectory` and `writeUploadedFile` keep `resolveWithinRoot`; add `realWithinRoot` to `listDirectory` too for parity (after the existing `resolveWithinRoot`, before `stat`): `const realDir = await this.realWithinRoot(dir);` and use `realDir` for the `stat`/`readdir`. For `writeUploadedFile`, realpath the TARGET DIR (not the not-yet-created file): after computing `dir`, add `await this.realWithinRoot(dir);`.

- [ ] **Step 5: Map typed errors to 403/404 in transport**

In `packages/server/src/transport.ts`:
- Import `FsError`: add `import { FsService, FsError } from "./fs-service.js";` (merge with the existing FsService import).
- In `/fs/download`'s catch, replace the substring-match logic:
```ts
    } catch (err) {
      if (err instanceof FsError) {
        reply.code(err.code === "forbidden" ? 403 : 404).send({ error: err.message });
      } else {
        reply.code(404).send({ error: (err as Error).message });
      }
    }
```
- In `/fs/list`'s catch, distinguish too:
```ts
    } catch (err) {
      if (err instanceof FsError) {
        reply.code(err.code === "forbidden" ? 403 : 404).send({ error: err.message });
      } else {
        reply.code(400).send({ error: (err as Error).message });
      }
    }
```
- Export `FsError` in `packages/server/src/index.ts`:
```ts
export { FsService, FsError } from "./fs-service.js";
export type { DirEntry, DirListing, FsServiceOptions, FsErrorCode } from "./fs-service.js";
```
(Replace the existing `FsService` export line with this pair.)
- **Update the existing Plan-3 transport test (REQUIRED — it goes red otherwise):** in `packages/server/test/transport.files.test.ts`, the test **`"GET /fs/list rejects path traversal with 400"`** (it injects `GET /fs/list?path=../..` and asserts `res.statusCode === 400`) now gets a `403` because the `/fs/list` catch returns 403 for an outside-root `FsError`. Rename it and flip the assertion:
```ts
test("GET /fs/list rejects path traversal with 403", async () => {
  current = makeServer();
  const res = await current.app.inject({ method: "GET", url: "/fs/list?path=../..", headers: auth });
  expect(res.statusCode).toBe(403);
});
```
Add a sibling case for the download path while here (outside-root → 403, missing-but-in-root → 404):
```ts
test("GET /fs/download returns 403 outside root and 404 for a missing in-root file", async () => {
  current = makeServer();
  const outside = await current.app.inject({ method: "GET", url: "/fs/download?path=../../etc/hosts", headers: auth });
  expect(outside.statusCode).toBe(403);
  const missing = await current.app.inject({ method: "GET", url: `/fs/download?path=${encodeURIComponent(join(root, "nope.txt"))}`, headers: auth });
  expect(missing.statusCode).toBe(404);
});
```
> NOTE the contract change: outside-root `/fs/list` AND `/fs/download` now return **403** (both were effectively 400/404 by substring-match in Plan 3); a missing in-root file returns **404**. `fs-service.test.ts` stays green — it matches the error MESSAGE (`"outside the allowed root"`), not the HTTP status, and the new `FsError` keeps that message text. The web `ApiError` already surfaces `status`, so the PWA needs no change.

- [ ] **Step 6: Config NaN/range validation (failing test first)**

In `packages/server/test/server-config.test.ts`, add:
```ts
import { expect, test } from "vitest";
import { loadServerConfig } from "../src/index.js";

test("a non-numeric PORT falls back to the default (no NaN)", () => {
  const cfg = loadServerConfig({ PORT: "not-a-number" } as NodeJS.ProcessEnv);
  expect(cfg.port).toBe(4280);
});

test("an out-of-range PORT throws a clear error", () => {
  expect(() => loadServerConfig({ PORT: "70000" } as NodeJS.ProcessEnv)).toThrow(/PORT/);
});

test("a non-numeric MAX_UPLOAD_BYTES falls back to the default", () => {
  const cfg = loadServerConfig({ MAX_UPLOAD_BYTES: "huge" } as NodeJS.ProcessEnv);
  expect(cfg.maxUploadBytes).toBe(26214400);
});

test("a non-positive MAX_UPLOAD_BYTES throws", () => {
  expect(() => loadServerConfig({ MAX_UPLOAD_BYTES: "0" } as NodeJS.ProcessEnv)).toThrow(/MAX_UPLOAD_BYTES/);
});
```

- [ ] **Step 7: Implement validation**

In `packages/server/src/server-config.ts`, replace the `port`/`maxUploadBytes` parsing at the top of `loadServerConfig`:
```ts
export function loadServerConfig(env: NodeJS.ProcessEnv): ServerRuntimeConfig {
  const port = parseIntOption(env.PORT, 4280, "PORT", { min: 1, max: 65535 });
  const maxUploadBytes = parseIntOption(env.MAX_UPLOAD_BYTES, 26214400, "MAX_UPLOAD_BYTES", { min: 1 });
```
Add the helper above `loadServerConfig`:
```ts
/**
 * Parse an integer env option. An ABSENT or UNPARSEABLE value falls back to the default (lenient);
 * a present-but-out-of-range value is a configuration ERROR (fail fast at boot).
 */
function parseIntOption(
  raw: string | undefined,
  fallback: number,
  name: string,
  range: { min?: number; max?: number },
): number {
  if (raw === undefined) return fallback;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n)) return fallback;
  if ((range.min !== undefined && n < range.min) || (range.max !== undefined && n > range.max)) {
    throw new Error(`invalid ${name}: ${raw} (must be ${range.min ?? "-∞"}..${range.max ?? "∞"})`);
  }
  return n;
}
```

- [ ] **Step 8: Run all hardening tests + suite + typecheck**

Run: `pnpm exec vitest run packages/server/test/auth.test.ts packages/server/test/fs-service.test.ts packages/server/test/server-config.test.ts packages/server/test/transport.files.test.ts`
Expected: PASS — including the RENAMED `transport.files.test.ts` case `"GET /fs/list rejects path traversal with 403"` (was `... with 400`) and the new `/fs/download` 403/404 case. `fs-service.test.ts` is unchanged (asserts the message, not the status).
Run: `pnpm typecheck` → PASS. Run: `pnpm lint` → PASS.

- [ ] **Step 9: Commit**

`git add -A && git commit` describing the hardening: auth lockout eviction, fs realpath defense + typed 403/404, PORT/MAX_UPLOAD_BYTES validation.

---

### Task 11: Wire durability + interactivity into `transport` + `startServer`

**Files:**
- Modify: `packages/server/src/transport.ts` (`answer`/`settings` client frames; `Idempotency-Key`; jsonl history; dormant-resume on message; question frame already fans out)
- Modify: `packages/server/src/session-hub.ts` (persist to the store; dormant-resume; jsonl history; question-meta status)
- Modify: `packages/server/src/start.ts` (data dir + token gen/print; open the stores; pass them in)
- Modify: `packages/server/src/server-config.ts` (`dataDir` field)
- Modify: `packages/server/test/helpers/mock-claude-interactive.mjs` (already extended)
- Create: `packages/server/test/transport.durability.test.ts`

**Canonical shapes:** this task threads the units from Tasks 1–10 through the live server. The `SessionHub` becomes persistence-aware (optional `SessionStore` + `HistoryService`): create → `store.upsert`; restart → `list()` rehydrates DORMANT metas (no live process); a message to a dormant session → `manager.resumeSession` then send; `getHistory` reads the jsonl when the in-memory buffer is empty (post-restart). `transport` accepts `{type:"answer",...}` and `{type:"settings",...}` client frames and honors `Idempotency-Key` on `POST /sessions`. `start.ts` resolves the data dir, generates/persists/prints the token, opens the stores, and constructs the hub with them.

**Interfaces:**
- `SessionHubOptions` gains `store?: SessionStore`, `history?: HistoryService`, `now` (existing). `SessionHub` gains `loadFromStore()` (rehydrate dormant metas at boot) and an internal resume path inside `sendMessage`/`answerPermission`/`answerQuestion`/`applySettings`: if the record has no live process, `resumeSession` first.
- `createServer` signature is unchanged; it constructs the hub the same way but `createServer` gains an optional 3rd arg `deps?: { store?; history?; idempotency? }` forwarded to the hub + the route.
- `ServerRuntimeConfig` gains `dataDir: string`.

- [ ] **Step 1: Add `dataDir` to config + thread token resolution into `start.ts`**

In `packages/server/src/server-config.ts`, add to `ServerRuntimeConfig`:
```ts
  /** Host data dir for the SQLite DB + access token file. */
  dataDir: string;
```
and in `loadServerConfig`, set it (import `resolveDataDir` at the top: `import { resolveDataDir } from "./data-dir.js";`):
```ts
  const cfg: ServerRuntimeConfig = {
    port,
    bindAddress: env.BIND_ADDRESS ?? "127.0.0.1",
    fsRoot: env.FS_ROOT ?? env.HOME ?? process.cwd(),
    maxUploadBytes,
    dataDir: resolveDataDir(env),
    claude: loadConfig(env),
  };
```
(keep the existing `accessToken`/`trustProxy` assignments after it.)

- [ ] **Step 2: Make `SessionHub` persistence-aware**

In `packages/server/src/session-hub.ts`:
- Import the store/history types + the dormant status. Add:
```ts
import type { SessionStore, StoredSession } from "./session-store.js";
import type { HistoryService } from "./history-service.js";
import { parseTranscript } from "@remote-coder/protocol";
import type { ServerFrame as _SF } from "./replay-buffer.js"; // (already imported; do not duplicate)
```
(Only add imports that are not already present — `ServerFrame` is already imported. Add `parseTranscript` value import, and the `SessionStore`/`StoredSession`/`HistoryService` type imports.)
- Widen `SessionStatus`:
```ts
export type SessionStatus = "running" | "dormant" | "errored" | "stopped";
```
- ALSO widen the web mirror: in `packages/web/src/types/server.ts`, change `SessionMeta.status` to include `"dormant"`:
```ts
  status: "running" | "dormant" | "errored" | "stopped";
```
and confirm `packages/web/src/session/status.ts`'s `wireStateForSession` handles it (a `dormant` session should map to the `"idle"` wire state — add an explicit `if (meta.status === "dormant") return "idle";` case if the existing function does not already fall through to idle for unknown statuses). A one-line web test in `packages/web/src/session/status.test.ts` asserting `wireStateForSession({ ...meta, status: "dormant" })` is `"idle"` locks this.
- Extend `SessionHubOptions`:
```ts
export interface SessionHubOptions {
  replayCapacity?: number;
  now?: () => number;
  store?: SessionStore;
  history?: HistoryService;
}
```
- Store fields in the constructor:
```ts
  private readonly store?: SessionStore;
  private readonly history?: HistoryService;
```
and assign `this.store = opts.store; this.history = opts.history;`.
- In `createSession`, persist after building `meta`:
```ts
    this.persist(meta);
```
- Add the persistence + rehydrate + resume helpers:
```ts
  private persist(meta: SessionMeta): void {
    this.store?.upsert({
      id: meta.id,
      cwd: meta.cwd,
      model: meta.model,
      effort: meta.effort,
      dangerouslySkip: meta.dangerouslySkip,
      status: meta.status,
      createdAt: meta.createdAt,
      lastActivityAt: this.now(),
    });
  }

  /** Rehydrate DORMANT session metas from the store at boot (no live process is spawned). */
  loadFromStore(): void {
    if (!this.store) return;
    for (const s of this.store.list()) {
      if (this.records.has(s.id)) continue;
      const meta: SessionMeta = {
        id: s.id,
        cwd: s.cwd,
        model: s.model,
        effort: s.effort,
        dangerouslySkip: s.dangerouslySkip,
        status: "dormant",
        createdAt: s.createdAt,
      };
      this.records.set(s.id, { meta, buffer: new ReplayBuffer(this.replayCapacity), listeners: new Set() });
    }
  }

  /** Ensure a record has a LIVE process; resume a dormant/dead one in its stored cwd. */
  private async ensureLive(id: string): Promise<void> {
    const record = this.require(id);
    if (this.manager.getSession(id)) return; // already live
    const session = await this.manager.resumeSession(id, {
      cwd: record.meta.cwd,
      model: record.meta.model,
      effort: record.meta.effort,
      dangerouslySkip: record.meta.dangerouslySkip,
    });
    record.meta.status = "running";
    this.attach(session.process, record);
    this.persist(record.meta);
  }
```
- Make the message/answer/settings paths resume-aware. Change `sendMessage` (and apply the same `await this.ensureLive(id)` guard to `answerPermission`, `answerQuestion`, `applySettings` — each becomes `async`):
```ts
  async sendMessage(id: string, content: string | ContentBlock[]): Promise<void> {
    await this.ensureLive(id);
    this.manager.sendMessage(id, content);
    this.store?.touch(id, this.now());
  }
```
> Apply the analogous `await this.ensureLive(id);` as the first line of `answerPermission`, `answerQuestion`, and `applySettings`, and make each `async` (return `Promise<void>`; `applySettings` returns `Promise<SessionMeta>`). Update their internal `this.require(id)` calls to run AFTER `ensureLive`. The transport callers already `await` or fire-and-forget; Task 11 Step 4 adapts the transport to `void`-await these.
- Make `getHistory` fall back to the transcript when the buffer is empty (post-restart, dormant session):
```ts
  async getHistory(id: string): Promise<ServerFrame[]> {
    const record = this.require(id);
    const buffered = record.buffer.snapshot();
    if (buffered.length > 0 || !this.history) return buffered;
    // Dormant/just-loaded: project the jsonl transcript into event-kind frames.
    const turns = await this.history.read(record.meta.cwd, id);
    return turns.map((t, i) => ({
      seq: i + 1,
      kind: "event" as const,
      payload: { type: t.type, message: t.message, raw: t },
    }));
  }
```
> NOTE: `getHistory` is now `async`. Its only caller is the `GET /sessions/:id` route (Task 11 Step 4 awaits it). The integration test in Task 12 awaits the HTTP response, so no test calls `getHistory` synchronously.

- [ ] **Step 3: Re-export + adapt the hub's sync→async ripple**

The `SessionHub` methods `sendMessage`/`answerPermission`/`answerQuestion`/`getHistory` are now async. Their ONLY callers are `transport.ts` (next step) and tests. The hub-internal `stopAll`/`subscribe`/`createSession` are unchanged. Update `packages/server/src/index.ts` only if a NEW type is exported (none here — `SessionStatus`/`SessionHubOptions`/`LiveSettings` already exported; `LiveSettings` was added in Task 8 — ensure it IS exported):
```ts
export type {
  SessionHubOptions, SessionMeta, SessionStatus, FrameListener, Subscription, LiveSettings,
} from "./session-hub.js";
```
**Re-run the Task 6 hub test against the now-async hub:** making `answerQuestion`/`answerPermission` async (with the `await this.ensureLive(id)` guard) changes their fire path. `packages/server/test/question.hub.test.ts` (Task 6) calls `hub.answerQuestion(...)` WITHOUT awaiting (fire-and-forget inside a subscriber callback) — that still works because the promise resolves on its own and `ensureLive` is a no-op for an already-live session. Confirm it stays green:
```
pnpm exec vitest run packages/server/test/question.hub.test.ts packages/server/test/live-settings.test.ts packages/server/test/session-hub.test.ts
```
Expected: PASS. If `session-hub.test.ts` (a Plan-3 test) calls `hub.sendMessage`/`answerPermission` synchronously and asserts an immediate side effect, add `await` to those calls (the method is now async) — the assertion timing is unchanged because the mock turn is driven by the subscriber loop, not the call's return.

- [ ] **Step 4: Thread the new frames + idempotency + jsonl history through `transport`**

In `packages/server/src/transport.ts`:
- Change `createServer` to accept optional deps and forward them:
```ts
export function createServer(
  config: ServerRuntimeConfig,
  sessionManager: SessionManager,
  deps: { store?: SessionStore; history?: HistoryService; idempotency?: IdempotencyStore } = {},
): CreateServerResult {
  const hub = new SessionHub(sessionManager, { store: deps.store, history: deps.history });
  hub.loadFromStore();
```
(Add the imports: `import type { SessionStore } from "./session-store.js"; import type { HistoryService } from "./history-service.js"; import type { IdempotencyStore } from "./idempotency.js";`.)
- `GET /sessions/:id` now awaits history:
```ts
  app.get<{ Params: { id: string } }>("/sessions/:id", async (request, reply) => {
    const meta = hub.getSession(request.params.id);
    if (!meta) {
      reply.code(404).send({ error: "session not found" });
      return;
    }
    return { session: meta, history: await hub.getHistory(request.params.id) };
  });
```
- `POST /sessions` honors `Idempotency-Key`:
```ts
  app.post<{ Body: CreateSessionBody }>("/sessions", async (request, reply) => {
    const body = request.body;
    if (!body || typeof body.cwd !== "string") {
      reply.code(400).send({ error: "cwd is required" });
      return;
    }
    const idemKey = request.headers["idempotency-key"];
    const key = typeof idemKey === "string" ? idemKey : undefined;
    if (key && deps.idempotency) {
      const existingId = deps.idempotency.lookup(key, Date.now());
      if (existingId) {
        const existing = hub.getSession(existingId);
        if (existing) {
          reply.code(200).send({ session: existing });
          return;
        }
      }
    }
    const session = await hub.createSession({
      cwd: body.cwd, model: body.model, effort: body.effort, addDirs: body.addDirs, dangerouslySkip: body.dangerouslySkip,
    });
    if (key && deps.idempotency) deps.idempotency.remember(key, session.id, Date.now());
    reply.code(201).send({ session });
  });
```
- `handleClientFrame` recognizes `answer` and `settings` (and the async hub methods are fire-and-forget — a rejected resume is logged, never throws into the WS handler). Replace `handleClientFrame`:
```ts
function handleClientFrame(hub: SessionHub, id: string, msg: Record<string, unknown>): void {
  if (msg.type === "user") {
    const blocks = toContentBlocks(msg);
    if (blocks.length > 0) void hub.sendMessage(id, blocks).catch(() => {});
    return;
  }
  if (msg.type === "permission") {
    const requestId = typeof msg.requestId === "string" ? msg.requestId : undefined;
    const decision = msg.decision === "allow" || msg.decision === "deny" ? (msg.decision as HookPermissionDecision) : undefined;
    if (requestId && decision) {
      const reason = typeof msg.reason === "string" ? msg.reason : undefined;
      void hub.answerPermission(id, requestId, decision, reason).catch(() => {});
    }
    return;
  }
  if (msg.type === "answer") {
    const requestId = typeof msg.requestId === "string" ? msg.requestId : undefined;
    const answers = isAnswerMap(msg.answers) ? msg.answers : undefined;
    if (requestId && answers) void hub.answerQuestion(id, requestId, msg.toolInput, answers).catch(() => {});
    return;
  }
  if (msg.type === "settings") {
    const settings: { model?: string; maxThinkingTokens?: number; effort?: string; permissionMode?: string } = {};
    if (typeof msg.model === "string") settings.model = msg.model;
    if (typeof msg.maxThinkingTokens === "number") settings.maxThinkingTokens = msg.maxThinkingTokens;
    if (typeof msg.effort === "string") settings.effort = msg.effort;
    if (typeof msg.permissionMode === "string") settings.permissionMode = msg.permissionMode;
    void hub.applySettings(id, settings).catch(() => {});
    return;
  }
  // unknown frame types are ignored
}

/** Accept only a flat record of question -> string | string[]. */
function isAnswerMap(v: unknown): v is Record<string, string | string[]> {
  if (typeof v !== "object" || v === null) return false;
  for (const val of Object.values(v as Record<string, unknown>)) {
    const ok = typeof val === "string" || (Array.isArray(val) && val.every((x) => typeof x === "string"));
    if (!ok) return false;
  }
  return true;
}
```

- [ ] **Step 5: Token generation/printing + open the stores in `start.ts`**

Replace `packages/server/src/start.ts`'s `startServer` body:
```ts
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { SessionManager } from "./session-manager.js";
import { createServer } from "./transport.js";
import { loadServerConfig, assertConfigAllowsStart, isLoopbackAddress } from "./server-config.js";
import { ensureDataDir, resolveAccessToken } from "./data-dir.js";
import { openSessionStore } from "./session-store.js";
import { openIdempotencyStore } from "./idempotency.js";
import { HistoryService } from "./history-service.js";
import type { CreateServerResult } from "./transport.js";

export async function startServer(
  env: NodeJS.ProcessEnv = process.env,
): Promise<CreateServerResult & { url: string; token?: string; tokenGenerated: boolean }> {
  const config = loadServerConfig(env);

  // First-run token (spec §9): use ACCESS_TOKEN if set, else the persisted token, else generate.
  // EXPLICIT OPT-OUT: NO_TOKEN=1 on a loopback bind keeps the Plan-3 tokenless dev path (no token
  // generated/stored/required). Any non-loopback bind still goes through token resolution and is
  // then enforced by assertConfigAllowsStart.
  ensureDataDir(config.dataDir);
  let token: string | undefined;
  let generated = false;
  if (env.NO_TOKEN === "1" && isLoopbackAddress(config.bindAddress)) {
    // tokenless loopback dev: leave config.accessToken undefined.
  } else {
    const resolved = resolveAccessToken({ configured: config.accessToken, dataDir: config.dataDir });
    token = resolved.token;
    generated = resolved.generated;
    config.accessToken = token;
  }

  assertConfigAllowsStart(config); // has a token unless explicitly tokenless on loopback

  const store = openSessionStore({ dbPath: join(config.dataDir, "sessions.db") });
  const idempotency = openIdempotencyStore({ dbPath: join(config.dataDir, "idempotency.db") });
  const history = new HistoryService();

  const manager = new SessionManager(config.claude);
  const result = createServer(config, manager, { store, history, idempotency });
  const url = await result.app.listen({ port: config.port, host: config.bindAddress });
  return { ...result, url, token, tokenGenerated: generated };
}

// Run when executed directly (node dist/start.js), not when imported.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  startServer()
    .then(({ app, url, token, tokenGenerated }) => {
      // eslint-disable-next-line no-console
      console.log(`remote-coder server listening on ${url}`);
      if (tokenGenerated && token) {
        // eslint-disable-next-line no-console
        console.log(`\n  Access token (generated, stored in the data dir):\n    ${token}\n  Open: ${url}/?token=${token}\n`);
      } else if (!token) {
        // eslint-disable-next-line no-console
        console.log(`  (NO_TOKEN tokenless loopback dev mode — no access token required)`);
      }
      const shutdown = (signal: NodeJS.Signals) => {
        // eslint-disable-next-line no-console
        console.log(`received ${signal}, shutting down`);
        app.close().then(() => process.exit(0)).catch(() => process.exit(0));
      };
      process.on("SIGTERM", () => shutdown("SIGTERM"));
      process.on("SIGINT", () => shutdown("SIGINT"));
    })
    .catch((err: unknown) => {
      // eslint-disable-next-line no-console
      console.error(`remote-coder server failed to start: ${(err as Error).message}`);
      process.exit(1);
    });
}
```
> Behavior change vs Plan 3: a loopback dev run with no `ACCESS_TOKEN` now gets a GENERATED + persisted token by default (printed once). The `NO_TOKEN=1` + loopback branch above is the explicit opt-out that preserves the Plan-3 tokenless dev path (it skips `resolveAccessToken`, leaves `config.accessToken` undefined, and `assertConfigAllowsStart` still permits it because the bind is loopback). The return type makes `token?` OPTIONAL so the tokenless case is representable; the boot print covers both branches. Task 12 asserts both behaviors.

- [ ] **Step 6: Write the durability transport test**

`packages/server/test/transport.durability.test.ts`:
```ts
import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { SessionManager, createServer, openSessionStore, openIdempotencyStore, HistoryService } from "../src/index.js";
import type { CreateServerResult, ServerRuntimeConfig } from "../src/index.js";

const MOCK = fileURLToPath(new URL("./helpers/mock-claude-interactive.mjs", import.meta.url));
const TOKEN = "dur-token";

let dir: string;
let current: CreateServerResult | undefined;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "rc-dur-"));
});
afterEach(async () => {
  if (current) await current.app.close();
  current = undefined;
  await rm(dir, { recursive: true, force: true });
});

function configFor(): ServerRuntimeConfig {
  return {
    port: 0, bindAddress: "127.0.0.1", accessToken: TOKEN, fsRoot: process.cwd(),
    maxUploadBytes: 26214400, dataDir: dir, claude: { claudeBin: process.execPath },
  };
}
function managerFor() {
  return new SessionManager({ claudeBin: process.execPath }, { spawnPrefixArgs: [MOCK], baseEnv: { ...process.env, MOCK_MODE: "simple" }, startTimeoutMs: 5000 });
}

test("Idempotency-Key dedupes POST /sessions", async () => {
  const store = openSessionStore({ dbPath: join(dir, "s.db") });
  const idempotency = openIdempotencyStore({ dbPath: join(dir, "i.db") });
  current = createServer(configFor(), managerFor(), { store, idempotency, history: new HistoryService() });

  const headers = { authorization: `Bearer ${TOKEN}`, "idempotency-key": "k1" };
  const a = await current.app.inject({ method: "POST", url: "/sessions", headers, payload: { cwd: process.cwd() } });
  const b = await current.app.inject({ method: "POST", url: "/sessions", headers, payload: { cwd: process.cwd() } });
  expect(a.statusCode).toBe(201);
  expect(b.statusCode).toBe(200);
  expect(b.json().session.id).toBe(a.json().session.id);
});

test("a session created in one server is DORMANT after a restart (rehydrated from the store)", async () => {
  const dbPath = join(dir, "s.db");
  // Server 1: create a session, then close.
  {
    const store = openSessionStore({ dbPath });
    current = createServer(configFor(), managerFor(), { store, history: new HistoryService() });
    const created = await current.app.inject({ method: "POST", url: "/sessions", headers: { authorization: `Bearer ${TOKEN}` }, payload: { cwd: process.cwd() } });
    expect(created.statusCode).toBe(201);
    await current.app.close();
    store.close();
    current = undefined;
  }
  // Server 2: same db -> the session reappears as dormant (no live process).
  const store2 = openSessionStore({ dbPath });
  current = createServer(configFor(), managerFor(), { store: store2, history: new HistoryService() });
  const list = await current.app.inject({ method: "GET", url: "/sessions", headers: { authorization: `Bearer ${TOKEN}` } });
  const sessions = list.json().sessions as { id: string; status: string }[];
  expect(sessions).toHaveLength(1);
  expect(sessions[0]?.status).toBe("dormant");
});
```

- [ ] **Step 7: Run the durability tests + full server suite + typecheck + build**

Run: `pnpm exec vitest run packages/server/test/transport.durability.test.ts`
Expected: PASS (idempotency dedupe; dormant rehydrate). If the native build is unavailable, the in-memory store does NOT survive `openSessionStore` re-open, so the dormant-restart test fails — report the native-build gap (do not weaken the test).
Run: `pnpm exec vitest run packages/server` (whole server suite)
Expected: PASS (the `question.e2e.test.ts` from Task 6 now goes GREEN — `answer` is wired).
Run: `pnpm typecheck` → PASS. Run: `pnpm -C packages/server build` → succeeds (tsup builds `index.js` + shebanged `start.js`; verify `head -1 packages/server/dist/start.js` is the node shebang).

- [ ] **Step 8: Commit**

`git add -A && git commit` describing the full wiring: idempotency, answer/settings frames, dormant rehydrate + lazy resume, jsonl history, first-run token gen/print.

---

### Task 12: Full durability + interactivity integration test (suite + build green)

**Files:**
- Create: `packages/server/test/integration.durability.e2e.test.ts`
- Run: the whole repo suite + typecheck + lint + builds

**Goal:** one end-to-end test proving the headline durability+interactivity loop against the interactive mock, plus a clean full-suite/build pass so the plan is provably complete.

- [ ] **Step 1: Write the end-to-end durability+interactivity test**

`packages/server/test/integration.durability.e2e.test.ts`:
```ts
import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { WebSocket } from "ws";
import { SessionManager, createServer, openSessionStore, openIdempotencyStore, HistoryService } from "../src/index.js";
import type { CreateServerResult, ServerRuntimeConfig, ServerFrame } from "../src/index.js";

const MOCK = fileURLToPath(new URL("./helpers/mock-claude-interactive.mjs", import.meta.url));
const TOKEN = "int-token";

let dir: string;
let current: CreateServerResult | undefined;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "rc-int-"));
});
afterEach(async () => {
  if (current) await current.app.close();
  current = undefined;
  await rm(dir, { recursive: true, force: true });
});

function configFor(): ServerRuntimeConfig {
  return { port: 0, bindAddress: "127.0.0.1", accessToken: TOKEN, fsRoot: process.cwd(), maxUploadBytes: 26214400, dataDir: dir, claude: { claudeBin: process.execPath } };
}

test("question over WS: create -> ask -> answer frame -> result reflects the choice", async () => {
  const manager = new SessionManager({ claudeBin: process.execPath }, { spawnPrefixArgs: [MOCK], baseEnv: { ...process.env, MOCK_MODE: "question" }, startTimeoutMs: 5000 });
  current = createServer(configFor(), manager, { store: openSessionStore({ dbPath: join(dir, "s.db") }), idempotency: openIdempotencyStore({ dbPath: join(dir, "i.db") }), history: new HistoryService() });
  const httpUrl = await current.app.listen({ port: 0, host: "127.0.0.1" });
  const wsBase = httpUrl.replace(/^http/, "ws");

  const created = await current.app.inject({ method: "POST", url: "/sessions", headers: { authorization: `Bearer ${TOKEN}` }, payload: { cwd: process.cwd() } });
  const id = created.json().session.id;

  await new Promise<void>((resolve, reject) => {
    let sent = false;
    const ws = new WebSocket(`${wsBase}/sessions/${id}/ws?token=${TOKEN}`);
    ws.on("message", (raw: Buffer) => {
      const frame: ServerFrame = JSON.parse(raw.toString());
      if (!sent) { sent = true; ws.send(JSON.stringify({ type: "user", content: "ask" })); }
      if (frame.kind === "question") {
        const p = frame.payload as { requestId: string; toolInput: unknown };
        ws.send(JSON.stringify({ type: "answer", requestId: p.requestId, toolInput: p.toolInput, answers: { "Which language?": "Python" } }));
      }
      if (frame.kind === "result") {
        expect((frame.payload as { result?: string }).result).toContain("Python");
        ws.close(); resolve();
      }
    });
    ws.on("error", reject);
    setTimeout(() => reject(new Error("int: no question result")), 10000);
  });
}, 20000);
```

- [ ] **Step 1b: Assert the first-run token behavior (generated by default, tokenless under `NO_TOKEN=1`)**

Append to the same file (drives the real `startServer`; binds to an ephemeral port; closes the app + stores afterward):
```ts
test("startServer generates + prints a token on a fresh data dir", async () => {
  const env = { BIND_ADDRESS: "127.0.0.1", PORT: "0", REMOTE_CODER_DATA_DIR: dir, CLAUDE_BIN: process.execPath } as NodeJS.ProcessEnv;
  const { startServer } = await import("../src/index.js");
  const started = await startServer(env);
  try {
    expect(started.tokenGenerated).toBe(true);
    expect(typeof started.token).toBe("string");
    expect((started.token as string).length).toBeGreaterThan(20);
    // A second start in the SAME data dir REUSES the persisted token (not regenerated).
    const again = await startServer(env);
    try {
      expect(again.tokenGenerated).toBe(false);
      expect(again.token).toBe(started.token);
    } finally {
      await again.app.close();
    }
  } finally {
    await started.app.close();
  }
});

test("startServer with NO_TOKEN=1 on loopback boots tokenless (no token required)", async () => {
  const env = { BIND_ADDRESS: "127.0.0.1", PORT: "0", REMOTE_CODER_DATA_DIR: dir, NO_TOKEN: "1", CLAUDE_BIN: process.execPath } as NodeJS.ProcessEnv;
  const { startServer } = await import("../src/index.js");
  const started = await startServer(env);
  try {
    expect(started.token).toBeUndefined();
    expect(started.tokenGenerated).toBe(false);
    // A request with NO Authorization header is accepted (the global preHandler allows when no token).
    const res = await started.app.inject({ method: "GET", url: "/sessions" });
    expect(res.statusCode).toBe(200);
  } finally {
    await started.app.close();
  }
});
```
> `startServer` opens real `SessionStore`/`IdempotencyStore` against the temp `REMOTE_CODER_DATA_DIR` (cleaned by the file's `afterEach` `rm`). No `claude` is spawned in these two tests (no session is created), so the mock is unused here; `app.close()` runs the `onClose` → `stopAll` (a no-op with zero live sessions).

- [ ] **Step 2: Run the integration test**

Run: `pnpm exec vitest run packages/server/test/integration.durability.e2e.test.ts`
Expected: PASS (the question loop AND both token-behavior tests).

- [ ] **Step 3: Run the WHOLE repo suite**

Run: `pnpm test`
Expected: PASS — protocol + server (node env) AND web (jsdom) suites all green. Investigate any failure with superpowers:systematic-debugging; do NOT weaken a test to make it pass.

- [ ] **Step 4: Typecheck, lint, build the whole repo**

Run: `pnpm typecheck` → PASS.
Run: `pnpm lint` → PASS.
Run: `pnpm build` → PASS (protocol + server tsup `--dts`; web `tsc --noEmit && vite build`). If `better-sqlite3`'s native build is unavailable in the build environment, `pnpm build` still succeeds (the dep is a runtime require, not a bundle import) — but flag it.

- [ ] **Step 5: Commit**

`git add -A && git commit` describing the full durability + interactivity integration test and the green suite/build.

---
## Self-Review

**1. Spec coverage** (vs the prompt's Plan 5 scope, spec §8/§9/§10, and `docs/protocol-notes.md` "Plan-5 spikes"):

- **SQLite session registry** (`better-sqlite3`, server-only native dep; persists id/cwd/model?/effort?/dangerouslySkip/displayName?/status/createdAt/lastActivityAt; in-memory fallback behind the same interface; `allowBuilds` entry; history NOT stored here) → **Task 1** (`SessionStore`/`StoredSession`/`openSessionStore`), wired into the hub in **Task 11**. ✓
- **First-run access-token generation + persistence** (deferred from Plan 3: generate a strong token when none configured/stored, persist in the data dir mode 0600, print once at boot with the URL; completes spec §9) → **Task 2** (`resolveDataDir`/`ensureDataDir`/`resolveAccessToken`) + **Task 11 Step 5** (boot print + tokenless-loopback opt-out via `NO_TOKEN=1`). ✓
- **Resume a dormant session** (`claude --resume <id>`, SAME cwd, re-do the `initialize` handshake, suppress the synthetic "Continue from where you left off."/"No response requested." warm-up turn) → **Task 3** (`buildClaudeArgs` `resume`, `ClaudeProcess.resume` + warm-up suppression, `SessionManager.resumeSession`) + the hub's lazy `ensureLive` in **Task 11**. Mock extended with a `resume` mode. ✓
- **History from the jsonl transcript** (compute `~/.claude/projects/<encodeProjectDir(cwd)>/<id>.jsonl` from the REAL stored cwd — never reverse the lossy encoding; parse user/assistant turns with `parentUuid`; guard missing file → []) → **Task 4** (pure `encodeProjectDir`/`parseTranscript` in protocol; file-reading `HistoryService` in server) + `getHistory` falling back to it in **Task 11**. `GET /sessions/:id` returns real history after restart. ✓
- **`POST /sessions` idempotency** (deferred from Plan 3: optional `Idempotency-Key` → registry-backed dedupe within a TTL window) → **Task 5** (`IdempotencyStore`) + the route honoring the header in **Task 11** (repeat key → 200 with the same session). ✓
- **AskUserQuestion answering — protocol + server** (detect the AskUserQuestion `hook_callback` via `classifyQuestionRequest` → `questions[]`; serialize the allow-with-answers `hookSpecificOutput.updatedInput.answers` via `serializeHookQuestionAnswer`; surface a `"question"` ServerFrame; accept an `{type:"answer",requestId,toolInput,answers}` client frame; deny = cancel) → **Task 6** (protocol + `ClaudeProcess` `question` event/`answerQuestion` + hub `answerQuestion` + `"question"` critical frame + mock `question` mode), transport `answer` frame in **Task 11**. Reuses the Plan-3/4 hook plumbing exactly as the spike prescribes. ✓
- **AskUserQuestion answering — PWA** (multi-option UI: single/multi-select per `multiSelect`, labels+descriptions, header; the iris "awaiting you" moment; submit → the `answer` frame; Skip → deny) → **Task 7** (`QuestionPrompt` + `pendingQuestion` reducer state + `OutboundFrame` `answer` variant + ChatView wiring). The option toggles are plain styled `<button>`s (the shared `Button` has CLOSED props — no `style`/`aria-pressed`/rest-spread — so it CANNOT carry per-option selected styling; verified against `ui/Button.tsx`); Submit/Skip stay `<Button>`. Replaces Plan-4's allow/deny-only AskUserQuestion handling. ✓
- **Live mid-session settings — protocol + server** (`serializeSetModel`/`serializeSetMaxThinkingTokens`/`serializeSetPermissionMode`; `ClaudeProcess.setModel`/`setMaxThinkingTokens`/`setPermissionMode`; `SessionHub.applySettings` sending the controls + mirroring meta) → **Task 8**, transport `settings` frame in **Task 11**. Field names are **VERIFIED against the real binary** (`set_model:{model}`; `set_max_thinking_tokens:{max_thinking_tokens, thinking_display?}` accepting `null`; `set_permission_mode:{mode}` with the full `default|acceptEdits|bypassPermissions|plan|dontAsk|auto` set), applied on a turn boundary; effort → thinking-token budget. ✓
- **Live settings — PWA** (wire `SettingsPanel` — read-only per Plan 4 — to send live changes for the ACTIVE session via a `settings` frame, optimistically reflecting the result; `PERMISSION_MODES`/`EFFORT_THINKING_TOKENS` added; the duplicate `EFFORTS` import is merged into the existing one) → **Task 9**. The read-only branch is preserved when no live channel is wired (omit `onApplyLiveSettings`). Spec §8 token/cost is shown live + per-turn (from `result`), with registry PERSISTENCE explicitly deferred (called out in Task 9 + the Notes). ✓
- **Server hardening** (deferred from Plan 3: `AuthGate` lockout-map opportunistic eviction + `lockedClientCount`; `FsService` `realpath` symlink-escape defense + typed `FsError` → 404 not-found vs 403 forbidden normalization in transport; PORT/MAX_UPLOAD_BYTES NaN-lenient / out-of-range-fatal validation at config load) → **Task 10**. The contract change (outside-root `/fs/list` AND `/fs/download` → **403**) explicitly RENAMES the existing Plan-3 `transport.files.test.ts` case `"GET /fs/list rejects path traversal with 400"` → `... with 403` and flips its assertion; `fs-service.test.ts` stays green (matches the message, not the status). ✓
- **Wire it all; integration-test against the interactive mock (extended for resume/question/live-settings); never the real `claude` in CI** → **Tasks 11–12** (transport wiring, `startServer` token+stores, durability + question E2E over the mock, full `pnpm test`/typecheck/lint/build green). ✓
- **EXPLICITLY OUT OF SCOPE → Plan 6:** Web Push (notifications) and host-native distribution (npx/launchd/systemd + secure tunnel + README + CI) — both named in the Goal and the "Out of scope" block and reiterated in the Notes below. ✓
- **Binding constraints honored:** TS+ESM, Node≥20, pnpm, Vitest, tsup, `verbatimModuleSyntax` (`import type` throughout); **no `ANTHROPIC_API_KEY`** (untouched deletion in `ClaudeProcess.start()`; `data-dir`/`session-store` never read it), **no `@anthropic-ai/*` dep**; MIT/English; wire-format knowledge stays in `@remote-coder/protocol` (the new control serializers, the AskUserQuestion answers payload, AND the transcript parser all live there — the server only does the FILE READ); tests use the interactive mock + `127.0.0.1`, never real `claude`/network; the server is HOST-NATIVE (drives real `claude`/files/`~/.claude`); the SQLite/token data dir is a host path (`~/.config/remote-coder` default). `better-sqlite3` is server-only (web/protocol never import it), needs a native build (`allowBuilds`), with an in-memory fallback documented. ✓
- **Right-sized to 12 tasks**, each with an independently testable deliverable and a red→green→commit cycle. Tasks 1/2/4(protocol half)/5/6(protocol+hub)/8/10 are self-contained units; Tasks 3/7/9 add behavior end-to-end within their layer; Tasks 11/12 integrate. ✓

**2. Placeholder scan:** No "TBD/TODO/implement later" left as work-to-do. Every code step shows the complete file or an exact before/after edit. Deliberate constructs that are NOT placeholders: the `createRequire`/dynamic-`require("better-sqlite3")` is the intended native-load-with-fallback; the in-memory store/idempotency fallbacks are real degraded modes (spec-mandated bootability), not stubs; the `eslint-disable-next-line no-console` lines in `start.ts` are the legitimate boot/shutdown logs; "unknown frame types are ignored" / "ignore malformed" comments are intentional defensive no-ops (spec §10); the Task 6 `question.e2e.test.ts` is explicitly a CROSS-TASK driver that goes green in Task 11 (called out at both ends), paired with a same-task `question.hub.test.ts` so Task 6 is self-verifying. The one intentionally-awkward literal in the Task 2 test (third case) is flagged inline with the exact clean replacement to use before running. The Task 7 `QuestionPrompt` uses plain styled `<button>`s for option toggles (NOT the shared `Button`, whose props are closed — verified against `ui/Button.tsx`), and the old "Button forwards rest props / style is accepted" note was REMOVED; the `NO_TOKEN` tokenless-loopback escape-hatch is shown in the actual `start.ts` code (not just prose); the live-settings field names are VERIFIED against the real binary (no "verify-before-prod" caveat remains). ✓

**3. Type consistency (names/signatures across tasks):**
- Protocol additions used exactly as exported: `classifyQuestionRequest(ev) → {requestId,toolUseId?,toolInput,questions:QuestionSpec[]} | null`, `serializeHookQuestionAnswer(requestId, originalToolInput, answers, reason?)`, `serializeSetModel/serializeSetMaxThinkingTokens/serializeSetPermissionMode(value, {requestId?}?)`, `encodeProjectDir(cwd)`, `parseTranscript(text) → TranscriptTurn[]`; types `QuestionSpec`/`QuestionOption`/`TranscriptTurn` — all re-exported from `packages/protocol/src/index.ts`. The EXISTING `serializeHookPermissionResponse(requestId, decision, reason="")` is left untouched (answers go through the NEW serializer, not an overload). ✓
- `StoredSession`/`StoredStatus`/`SessionStore`/`openSessionStore` (Task 1), `IdempotencyStore`/`openIdempotencyStore` (Task 5), `HistoryService`/`HistoryServiceOptions` (Task 4), `resolveDataDir`/`ensureDataDir`/`resolveAccessToken`/`ResolveAccessTokenOptions` (Task 2), `FsError`/`FsErrorCode` (Task 10) — each defined once, exported from `index.ts`, consumed by `start.ts`/`transport.ts`/tests with matching signatures. ✓
- `QuestionEvent` (server) ↔ `QuestionPayload` (web) carry the SAME shape (`{requestId,toolUseId?,toolInput,questions}`) so the `"question"` ServerFrame payload round-trips into the reducer/`QuestionPrompt` unchanged. The web `OutboundFrame` `answer`/`settings` variants mirror exactly what `handleClientFrame` parses (`answer`: `requestId`+`toolInput`+`answers`; `settings`: `model?`+`maxThinkingTokens?`+`effort?`+`permissionMode?`). ✓
- `SessionStatus` widened to include `"dormant"` in BOTH `session-hub.ts` and the web `SessionMeta` (Task 7 does not touch it, but Task 11 widens the hub type; the web `SessionMeta.status` union must gain `"dormant"` — included in the Task 11 type-export note and reflected in `packages/web/src/types/server.ts`'s `SessionMeta`). NOTE for the implementer: when Task 11 widens `SessionStatus`, also add `"dormant"` to the web `SessionMeta.status` union so the list renders dormant sessions (the `wireStateForSession` helper maps unknown/dormant → `"idle"` by default; verify it has an explicit dormant case or falls through to idle). ✓
- `SessionHub` async ripple is contained: `sendMessage`/`answerPermission`/`answerQuestion`/`getHistory` become `async`, `applySettings` returns `Promise<SessionMeta>`; their only callers are `transport.ts` (which `void ….catch(()=>{})` for fire-and-forget WS frames and `await`s `getHistory` in the route) and tests (which `await`). `createSession`/`subscribe`/`stopAll`/`loadFromStore`/`getSession`/`listSessions` stay synchronous. ✓
- `ClaudeProcess` event set grows by exactly one (`"question"`), with `on`/`once`/`emit` overloads added; `classifyQuestionRequest` runs BEFORE `classifyPermissionRequest` in `handleLine` so an AskUserQuestion fires `"question"` (never also `"permission"`). ✓
- `import type` used for every type-only import (`verbatimModuleSyntax: true`); the native `better-sqlite3` is a value `require` (CJS) via `createRequire`, never a static `import`. React value imports stay value imports; all server/web contract types are `import type`. ✓

---

## Notes carried to later plans (Plan 6)

- **Web Push (deferred — Plan 6):** the `result` frame is the notification trigger and the hub already emits it; a `push` server component + VAPID subscribe endpoint + `pwa/push.ts` (subscribe via the SW, notify on a `result` while the document is hidden) layers onto the existing `ConnectionBanner`/`useOnline`/SW registration from Plan 4. The persisted session registry (Task 1) is the natural home for the push-subscription table.
- **Host-native distribution (deferred — Plan 6):** `npx remote-coder` packaging (the `remote-coder-server` bin already shebangs `dist/start.js`), launchd/systemd unit files, the secure tunnel docs (Caddy/Cloudflare/Tailscale), the killer README + comparison table + honest security section, and CI (lint+typecheck+test+build, with an opt-in real-`claude` smoke excluded from CI). The first-run token print (Task 11) and the host data dir (Task 2) are the quickstart hooks the README will reference.
- **`better-sqlite3` native-build robustness:** if Plan 6 ships prebuilt binaries / a Docker image, pin a `better-sqlite3` version with prebuilds for the target Node ABI, and surface the in-memory-fallback warning as a startup diagnostic so a degraded (non-durable) run is never silent.
- **Effort↔thinking-tokens mapping:** the `EFFORT_THINKING_TOKENS` table is a first-cut budget; once the real `claude` confirms the `set_max_thinking_tokens` semantics against the live effort levels, refine the mapping in one place (`packages/web/src/settings/defaults.ts`) without touching the protocol/server.
- **Idle-session reaping:** dormancy now exists for restarted sessions; a timed idle-reaper (stop a long-idle LIVE process → mark dormant → resume on next message) is a small addition on the hub's `lastActivityAt` (already persisted) — future work.
- **Persisted per-session cost (spec §8):** cost is shown live + per-turn from the `result` frame (`totalCostUsd`) but is NOT yet summed into the registry. Adding a `cumulativeCostUsd` column to `StoredSession` + accumulating it on each `result` (in the hub's `attach` `result` listener) lets a restarted/dormant session show historical spend — a small additive change deferred from this plan.
- **Multi-question answers / free-text:** `serializeHookQuestionAnswer` and `QuestionPrompt` already handle multiple questions and multi-select label arrays; the spike notes a free-text path (`annotations.notes`) — if a future binary surfaces it over stdio, extend the `answers` value type and the `QuestionPrompt` option list with a text input, threading through the same `updatedInput` envelope.
