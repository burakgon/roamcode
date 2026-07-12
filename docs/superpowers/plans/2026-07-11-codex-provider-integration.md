# First-Class Codex Provider Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add complete, first-class Codex CLI sessions beside Claude Code while preserving the real TUI, existing Claude behavior, exact provider-native resume, safe authentication, attachments, status, diagnostics, and documentation.

**Architecture:** Introduce a server-side provider registry whose Claude and Codex adapters generate typed process specifications for the shared tmux/PTY runtime. Keep the current `sessions` table as the rollback-readable Claude store and add a separate `provider_sessions` table for Codex; expose both through one store/API union. Use a narrow, runtime-validated Codex app-server client only for account, model, rate-limit, and exact-thread metadata—the browser still streams the real Codex TUI.

**Tech Stack:** TypeScript 6, Node.js 24, Fastify 5, Zod 4, better-sqlite3, node-pty/tmux, React 19, Zustand, Vitest 4, Testing Library, Vite 8, pnpm 11.

**Canonical Spec:** `docs/superpowers/specs/2026-07-11-codex-provider-integration-design.md`

## Global Constraints

- Every new session requires an explicit `claude` or `codex` choice; never remember or infer it.
- Keep the real Claude/Codex TUI; do not implement a provider transcript or permission UI.
- Keep Ollama, LM Studio, and `codex --oss` out of scope; reject profiles that switch away from OpenAI.
- Never put RoamCode/account tokens in argv, logs, REST payloads, browser storage, or persisted launch options.
- Never resume Codex with `--last`; require an exact persisted provider session id.
- Preserve existing Claude rows and live tmux sessions. Store Codex only in `provider_sessions` so rollback builds cannot delete or launch them as Claude.
- Keep `/auth/*`, `/usage`, and `/claude/version` as Claude compatibility aliases for this release.
- Prefer explicit degradation over silent fallback; refuse unsafe or ambiguous start/resume operations.
- Apply TDD strictly: add one focused failing test, confirm the expected failure, implement minimally, and rerun the focused and affected suites before each commit.
- Final verification requires `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, and `pnpm build` with exit code 0.

---

## File Structure

### Server files to create

- `packages/server/src/providers/types.ts` — provider ids, discriminated options, process/runtime contracts, normalized capabilities/errors.
- `packages/server/src/providers/options.ts` — Zod trust-boundary schemas and legacy Claude argv parsing.
- `packages/server/src/providers/registry.ts` — exact provider lookup and availability aggregation.
- `packages/server/src/providers/claude-provider.ts` — current Claude flags, resume, MCP/hooks, metadata extraction, and cleanup behind the provider contract.
- `packages/server/src/providers/codex-provider.ts` — Codex argv/config/MCP generation and provider-native resume.
- `packages/server/src/providers/codex-activity.ts` — streaming OSC 9 parser plus captured-pane fallback.
- `packages/server/src/providers/codex-app-server-client.ts` — bounded JSON-RPC stdio client with runtime validation.
- `packages/server/src/providers/codex-metadata-service.ts` — account, device auth, models, rate limits, profiles, and version normalization.
- `packages/server/src/providers/codex-thread-resolver.ts` — serialized snapshot/poll/cross-check of exact Codex thread identity.
- `packages/server/src/providers/codex-latest-service.ts` — installation-aware latest-version/update hint.
- `packages/server/test/providers/*.test.ts` — focused provider and metadata tests.
- `packages/server/test/fixtures/codex/*.txt` — redacted terminal/app-server fixtures only.

### Server files to modify

- `packages/server/src/session-store.ts` — union store over legacy Claude `sessions` and new Codex `provider_sessions`.
- `packages/server/src/terminal-process.ts` — generic executable/args/env names.
- `packages/server/src/terminal-manager.ts` — provider-neutral records, async spawn hooks, exact provider resume, provider activity.
- `packages/server/src/config.ts` — retain Claude integration builders; export shared attachment context types without Claude naming.
- `packages/server/src/server-config.ts` — add `CODEX_BIN` and provider configuration.
- `packages/server/src/transport.ts` — discriminated create route, provider routes, metadata in list/create, compatibility aliases.
- `packages/server/src/start.ts` — build registry/services, dual preflight, metadata client lifecycle, diagnostics wiring.
- `packages/server/src/diag.ts` — generic cached binary probe and provider diagnostics.
- `packages/server/src/index.ts` and `packages/server/tsup.config.ts` — exports and bundled helper entrypoints.
- Existing server tests/helpers — inject providers and update provider-aware contracts.

### Web files to create

- `packages/web/src/providers/types.ts` — browser provider/capability/option types.
- `packages/web/src/providers/ProviderPicker.tsx` — required, accessible provider choice.
- `packages/web/src/providers/ClaudeSessionOptions.tsx` — extracted current Claude fields.
- `packages/web/src/providers/CodexSessionOptions.tsx` — Codex model/reasoning/sandbox/approval/profile/search/danger fields.
- `packages/web/src/providers/provider-options.test.tsx` — focused provider control tests.
- `packages/web/src/settings/CodexAuthSection.tsx` — device-code flow.
- `packages/web/src/settings/ProviderAccounts.tsx` — separate provider account/usage/version cards.

### Web files to modify

- `packages/web/src/types/server.ts` — provider-aware REST mirrors.
- `packages/web/src/api/client.ts` and `client.test.ts` — new provider endpoints and discriminated create body.
- `packages/web/src/settings/defaults.ts` — provider-neutral appearance defaults only; no remembered provider.
- `packages/web/src/session/NewSessionWizard.tsx` and tests — required provider step and option components.
- `packages/web/src/App.tsx` and tests — fetch provider capabilities; remove Claude-global auth assumptions.
- `packages/web/src/session/SessionList.tsx`, `packages/web/src/chat/ChatHeader.tsx`, and tests — provider badge/safety metadata.
- `packages/web/src/settings/SettingsPanel.tsx`, `ClaudeAuthSection.tsx`, and tests — provider account cards and generic copy.
- `packages/web/src/session/UsageBars.tsx` and tests — provider-labeled normalized limits.
- `packages/web/src/chat/HelpSheet.tsx`, `packages/web/src/pwa/manifest.ts`, and onboarding copy — dual-provider wording.

### Documentation and product files to modify

- `README.md`, `SECURITY.md`, `CONTRIBUTING.md`, `CHANGELOG.md`.
- `packages/cli/src/args.ts`, `packages/cli/src/install.ts`, and tests.
- `site/src/main.ts`, `site/src/playground.ts`, `site/src/styles.css`, and `site/index.html`.
- Create `packages/web/src/screenshot/codex-mobile.ansi` and `docs/media/codex-mobile.png`; modify `packages/web/src/screenshot/scenes.tsx` and `packages/web/scripts/make-mockups.mjs` to generate the Codex visual.

---

### Task 1: Provider Contracts and Trust-Boundary Schemas

**Files:**
- Create: `packages/server/src/providers/types.ts`
- Create: `packages/server/src/providers/options.ts`
- Create: `packages/server/test/providers/options.test.ts`
- Modify: `packages/server/src/index.ts`

**Interfaces:**
- Produces: `ProviderId`, `ProviderSessionOptions`, `ProcessSpec`, `ProviderProcessContext`, `ProviderAvailability`, `ProviderRuntimeSignal`, `AgentProvider`, `parseProviderOptions(provider, raw)`, and `parseLegacyClaudeArgs(args)`.
- Consumes: Zod from the existing server dependency set.

- [ ] **Step 1: Write failing option-schema tests**

```ts
import { describe, expect, test } from "vitest";
import { parseProviderOptions, parseLegacyClaudeArgs } from "../../src/providers/options.js";

describe("provider option schemas", () => {
  test("accepts native Codex values and rejects unknown keys", () => {
    expect(
      parseProviderOptions("codex", {
        model: "gpt-5.6",
        reasoningEffort: "high",
        sandbox: "workspace-write",
        approvalPolicy: "on-request",
        webSearch: true,
        addDirs: ["/tmp/work"],
      }),
    ).toMatchObject({ provider: "codex", reasoningEffort: "high" });
    expect(() => parseProviderOptions("codex", { permissionMode: "plan" })).toThrow(/invalid provider options/i);
  });

  test("dangerous Codex bypass cannot carry ordinary safety fields", () => {
    expect(() =>
      parseProviderOptions("codex", {
        dangerouslyBypassApprovalsAndSandbox: true,
        sandbox: "workspace-write",
      }),
    ).toThrow(/mutually exclusive/i);
  });

  test("parses legacy Claude argv without accepting arbitrary new argv", () => {
    expect(parseLegacyClaudeArgs(["--model", "opus", "--effort", "max", "--add-dir", "/x"])).toEqual({
      provider: "claude",
      model: "opus",
      effort: "max",
      addDirs: ["/x"],
    });
  });
});
```

- [ ] **Step 2: Run the test and confirm RED**

Run: `pnpm vitest run packages/server/test/providers/options.test.ts`
Expected: FAIL because `providers/options.js` does not exist.

- [ ] **Step 3: Implement the contracts and strict schemas**

```ts
// providers/types.ts
export type ProviderId = "claude" | "codex";

export interface ProviderAvailability {
  terminalAvailable: boolean;
  metadataAvailable: boolean;
  version?: string;
  detail?: string;
}

export class ProviderError extends Error {
  constructor(
    readonly code: "PROVIDER_UNAVAILABLE" | "INVALID_PROVIDER_OPTIONS" | "RESUME_IDENTITY_UNAVAILABLE",
    message: string,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export type ClaudeSessionOptions = {
  provider: "claude";
  model?: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  permissionMode?: "default" | "acceptEdits" | "plan" | "bypassPermissions";
  dangerouslySkip?: boolean;
  addDirs?: string[];
  legacyArgs?: string[];
};

export type CodexSessionOptions = {
  provider: "codex";
  model?: string;
  reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh";
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  approvalPolicy?: "untrusted" | "on-request" | "never";
  profile?: string;
  webSearch?: boolean;
  dangerouslyBypassApprovalsAndSandbox?: boolean;
  addDirs?: string[];
};

export type ProviderSessionOptions = ClaudeSessionOptions | CodexSessionOptions;
export type LaunchIntent = "fresh" | "resume";

export interface ProcessSpec {
  executable: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cleanupPaths: string[];
}

export interface ProviderProcessContext {
  roamSessionId: string;
  cwd: string;
  intent: LaunchIntent;
  options: ProviderSessionOptions;
  providerSessionId?: string;
}

export type ProviderRuntimeSignal =
  | { type: "working" }
  | { type: "blocked" }
  | { type: "idle" }
  | { type: "provider-session-id"; id: string };

export interface AgentProvider {
  readonly id: ProviderId;
  readonly displayName: string;
  probe(): Promise<ProviderAvailability>;
  buildProcess(context: ProviderProcessContext): Promise<ProcessSpec>;
  runtimeSignals(chunk: string): ProviderRuntimeSignal[];
  classifyPane(pane: string): "working" | "blocked" | "idle";
  cleanup(paths: readonly string[]): void;
}
```

Implement `options.ts` with `.strict()`, bounded model/profile/path tokens, mutually exclusive danger refinements, and a flag-by-flag legacy Claude parser. Wrap Zod errors in `ProviderOptionsError` with stable code `INVALID_PROVIDER_OPTIONS`.

- [ ] **Step 4: Run focused tests and typecheck**

Run: `pnpm vitest run packages/server/test/providers/options.test.ts && pnpm --filter @roamcode/server build`
Expected: PASS; server package builds.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/providers packages/server/test/providers packages/server/src/index.ts
git commit -m "feat(server): define agent provider contracts"
```

### Task 2: Rollback-Safe Union Session Store

**Files:**
- Modify: `packages/server/src/session-store.ts`
- Modify: `packages/server/test/session-store.test.ts`
- Modify: `packages/server/test/session-store.migration.test.ts`

**Interfaces:**
- Consumes: `ProviderId`, `ProviderSessionOptions` from Task 1.
- Produces: `StoredSession` discriminated by `provider`; `setProviderSessionId(id, value)`; transparent `get/list/upsert/touch/setName/delete` routing across both tables.

- [ ] **Step 1: Add failing SQLite and fallback-store tests**

```ts
test("keeps legacy sessions as Claude and stores Codex in provider_sessions", () => {
  const store = openSessionStore({ dbPath: ":memory:" });
  store.upsert(claudeStored({ id: "c1", cwd: "/work" }));
  store.upsert(codexStored({ id: "x1", cwd: "/work", providerSessionId: "thread-1" }));

  expect(store.list().map((s) => [s.id, s.provider])).toEqual([
    ["c1", "claude"],
    ["x1", "codex"],
  ]);
  expect(store.get("x1")?.providerSessionId).toBe("thread-1");
});

test("migration leaves the legacy sessions table byte-for-byte readable", () => {
  const db = seedLegacyDatabase();
  const store = openSessionStore({ dbPath: db.path });
  expect(store.get("old")?.provider).toBe("claude");
  expect(readLegacyRow(db.path, "old").mode).toBe("terminal");
  expect(listProviderRows(db.path)).toEqual([]);
});
```

- [ ] **Step 2: Run and confirm RED**

Run: `pnpm vitest run packages/server/test/session-store.test.ts packages/server/test/session-store.migration.test.ts`
Expected: FAIL because `StoredSession.provider` and `provider_sessions` do not exist.

- [ ] **Step 3: Implement the union store**

Add a Codex-only table:

```sql
CREATE TABLE IF NOT EXISTS provider_sessions (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider = 'codex'),
  cwd TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_activity_at INTEGER NOT NULL,
  name TEXT,
  provider_session_id TEXT,
  launch_options_json TEXT NOT NULL,
  integration_status_json TEXT
);
CREATE INDEX IF NOT EXISTS provider_sessions_activity_idx
  ON provider_sessions(last_activity_at DESC);
```

Use a discriminated `StoredSession` union. Keep every existing legacy-table migration and row shape intact, interpret it as Claude on read, and route Codex mutations only to the new statements. Merge lists with a stable `createdAt`, then id order. Add `setProviderSessionId` only for Codex and mirror it in the memory fallback.

- [ ] **Step 4: Verify GREEN and regression safety**

Run: `pnpm vitest run packages/server/test/session-store.test.ts packages/server/test/session-store.migration.test.ts packages/server/test/data-dir.test.ts`
Expected: PASS, including forced memory fallback.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/session-store.ts packages/server/test/session-store.test.ts packages/server/test/session-store.migration.test.ts
git commit -m "feat(server): persist Codex sessions safely"
```

### Task 3: Provider-Neutral Terminal Runtime

**Files:**
- Modify: `packages/server/src/terminal-process.ts`
- Modify: `packages/server/src/terminal-manager.ts`
- Create: `packages/server/src/providers/registry.ts`
- Modify: `packages/server/test/terminal-process.test.ts`
- Modify: `packages/server/test/terminal-manager.test.ts`
- Create: `packages/server/test/providers/registry.test.ts`

**Interfaces:**
- Consumes: Task 1 contracts and Task 2 store.
- Produces: `ProviderRegistry.get(id)`, provider-neutral `TerminalManager.create({provider, options})`, async `attach`, and exact provider-owned fresh/resume process creation.

- [ ] **Step 1: Write failing generic-process and registry tests**

```ts
test("spawns the executable returned by the owning provider", async () => {
  const provider = fakeProvider("codex", { executable: "/bin/codex", args: ["--model", "gpt"] });
  const manager = makeManager({ providers: new ProviderRegistry([provider]) });
  manager.create({ id: "x", cwd: "/w", provider: "codex", options: codexOptions() });
  await manager.attach("x", handlers());
  expect(fakePty.lastSpawn().shellCommand).toContain("/bin/codex");
});

test("resume delegates to the provider with the persisted exact id", async () => {
  // create, force exit, persist thread-123, attach with respawn=continue
  expect(provider.buildCalls.at(-1)).toMatchObject({ intent: "resume", providerSessionId: "thread-123" });
});
```

- [ ] **Step 2: Run and confirm RED**

Run: `pnpm vitest run packages/server/test/providers/registry.test.ts packages/server/test/terminal-process.test.ts packages/server/test/terminal-manager.test.ts`
Expected: FAIL because the manager still owns `claudeBin/claudeArgs`.

- [ ] **Step 3: Generalize runtime names and spawn flow**

Change `TerminalProcessOptions` to:

```ts
export interface TerminalProcessOptions {
  sessionId: string;
  cwd: string;
  executable: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  // existing tmux/pty/size seams unchanged
}
```

Change manager records to store `provider`, typed `options`, `providerSessionId`, and cleanup paths. Make `attach` async so it can await `provider.buildProcess`. After spawn, feed PTY chunks to `provider.runtimeSignals`; map signals into existing activity/awaiting/push behavior. Resume must error with `RESUME_IDENTITY_UNAVAILABLE` when the provider requires an id and none exists.

Implement `ProviderRegistry`:

```ts
export class ProviderRegistry {
  private readonly byId: ReadonlyMap<ProviderId, AgentProvider>;
  constructor(providers: readonly AgentProvider[]) { /* reject duplicate ids */ }
  get(id: ProviderId): AgentProvider {
    const provider = this.byId.get(id);
    if (!provider) throw new ProviderError("PROVIDER_UNAVAILABLE", `provider unavailable: ${id}`);
    return provider;
  }
}
```

- [ ] **Step 4: Run manager/process suites**

Run: `pnpm vitest run packages/server/test/providers/registry.test.ts packages/server/test/terminal-process.test.ts packages/server/test/terminal-manager.test.ts packages/server/test/terminal-real-tmux.integration.test.ts`
Expected: PASS; real-tmux test uses only its isolated socket.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/terminal-process.ts packages/server/src/terminal-manager.ts packages/server/src/providers/registry.ts packages/server/test
git commit -m "refactor(server): make terminal runtime provider-neutral"
```

### Task 4: Claude Adapter Without Behavior Regression

**Files:**
- Create: `packages/server/src/providers/claude-provider.ts`
- Modify: `packages/server/src/config.ts`
- Modify: `packages/server/src/pane-status.ts`
- Create: `packages/server/test/providers/claude-provider.test.ts`
- Modify: `packages/server/test/config.test.ts`
- Modify: `packages/server/test/pane-status.test.ts`

**Interfaces:**
- Consumes: `AgentProvider`, attachment context, current Claude config builders/classifier.
- Produces: `createClaudeProvider({claudeBin, env, attach})`.

- [ ] **Step 1: Write failing parity tests**

```ts
test("fresh Claude spec preserves every supported option", async () => {
  const spec = await provider.buildProcess({
    roamSessionId: "c1",
    cwd: "/w",
    intent: "fresh",
    options: {
      provider: "claude", model: "opus", effort: "max", permissionMode: "plan", addDirs: ["/extra"],
    },
  });
  expect(spec.args).toEqual(expect.arrayContaining([
    "--model", "opus", "--effort", "max", "--permission-mode", "plan", "--add-dir", "/extra",
  ]));
  expect(spec.args).toContain("--mcp-config");
  expect(spec.args).toContain("--settings");
  expect(spec.env.ANTHROPIC_API_KEY).toBeUndefined();
});

test("Claude resume adds continue once", async () => {
  expect((await build("resume")).args.filter((x) => x === "--continue")).toHaveLength(1);
});
```

- [ ] **Step 2: Run and confirm RED**

Run: `pnpm vitest run packages/server/test/providers/claude-provider.test.ts`
Expected: FAIL because the adapter does not exist.

- [ ] **Step 3: Implement Claude adapter by moving, not rewriting, behavior**

Build argv only from `ClaudeSessionOptions`; call the existing 0600 MCP/hooks builders; strip `ANTHROPIC_API_KEY`; delegate pane classification to `classifyPaneStatus`; return cleanup paths. Preserve `--dangerously-skip-permissions` precedence and append `--continue` only for resume.

Do not remove compatibility exports from `config.ts` or `pane-status.ts` in this task.

- [ ] **Step 4: Run all Claude-focused regressions**

Run: `pnpm vitest run packages/server/test/providers/claude-provider.test.ts packages/server/test/config.test.ts packages/server/test/pane-status.test.ts packages/server/test/claude-auth-service.test.ts packages/server/test/usage-service.test.ts`
Expected: PASS with unchanged Claude fixtures.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/providers/claude-provider.ts packages/server/src/config.ts packages/server/src/pane-status.ts packages/server/test
git commit -m "refactor(server): move Claude into provider adapter"
```

### Task 5: Codex CLI, MCP, Safety, and Activity Adapter

**Files:**
- Create: `packages/server/src/providers/codex-provider.ts`
- Create: `packages/server/src/providers/codex-activity.ts`
- Create: `packages/server/test/providers/codex-provider.test.ts`
- Create: `packages/server/test/providers/codex-activity.test.ts`
- Create: `packages/server/test/fixtures/codex/idle-pane.txt`
- Create: `packages/server/test/fixtures/codex/approval-pane.txt`
- Create: `packages/server/test/fixtures/codex/working-pane.txt`

**Interfaces:**
- Consumes: Task 1 contracts and shared attachment context.
- Produces: `createCodexProvider`, `buildCodexArgs`, `parseCodexOscNotifications`, `classifyCodexPane`.

- [ ] **Step 1: Write failing argv/security tests**

```ts
test("builds native Codex flags and secret-safe MCP overrides", async () => {
  const spec = await provider.buildProcess(codexContext({
    model: "gpt-5.6", reasoningEffort: "high", sandbox: "workspace-write",
    approvalPolicy: "on-request", webSearch: true, addDirs: ["/extra"],
  }));
  expect(spec.args).toEqual(expect.arrayContaining([
    "--model", "gpt-5.6", "--sandbox", "workspace-write",
    "--ask-for-approval", "on-request", "--search", "--add-dir", "/extra",
  ]));
  expect(spec.args.join(" ")).toContain("mcp_servers.roamcode.env_vars");
  expect(spec.args.join(" ")).not.toContain("test-roam-token");
  expect(spec.env.RC_TOKEN).toBe("test-roam-token");
});

test("resume uses the exact id and never --last", async () => {
  const spec = await provider.buildProcess(codexResumeContext("thread-123"));
  expect(spec.args[0]).toBe("resume");
  expect(spec.args).toContain("thread-123");
  expect(spec.args).not.toContain("--last");
});
```

- [ ] **Step 2: Write failing OSC/pane tests and confirm RED**

```ts
test("parses split OSC 9 approval and completion notifications", () => {
  const parser = createCodexOscParser();
  expect(parser.push("\u001b]9;Codex approval req")).toEqual([]);
  expect(parser.push("uested\u0007")).toEqual([{ type: "blocked" }]);
  expect(parser.push("\u001b]9;Codex turn complete\u001b\\")).toEqual([{ type: "idle" }]);
});
```

Run: `pnpm vitest run packages/server/test/providers/codex-provider.test.ts packages/server/test/providers/codex-activity.test.ts`
Expected: FAIL because Codex provider/activity modules do not exist.

- [ ] **Step 3: Implement Codex process generation**

Use direct argv and TOML-safe `-c key=<value>` helpers. Required overrides:

```ts
const overrides = [
  configArg("mcp_servers.roamcode.command", process.execPath),
  configArg("mcp_servers.roamcode.args", [attach.mcpScriptPath]),
  configArg("mcp_servers.roamcode.env_vars", ["RC_BASE_URL", "RC_SESSION_ID", "RC_TOKEN"]),
  configArg("tui.notifications", ["agent-turn-complete", "approval-requested"]),
  configArg("tui.notification_method", "osc9"),
  configArg("tui.notification_condition", "always"),
];
```

Preserve user MCP and `notify` config by setting only the `roamcode` server and TUI keys. Do not add hooks or `--dangerously-bypass-hook-trust`. Dangerous bypass emits only `--dangerously-bypass-approvals-and-sandbox`, not ordinary safety flags.

- [ ] **Step 4: Implement streaming activity parser and fallback classifier**

Support BEL and ST OSC terminators across chunk boundaries, bound carry to 8 KiB, strip OSC frames before terminal forwarding only if xterm would visibly render them, and map recognized approval/completion text. Build fallback patterns from redacted real captures and add a `CODEX_CLASSIFIER_TESTED_UP_TO` warning equivalent to Claude's.

- [ ] **Step 5: Run focused and terminal regressions**

Run: `pnpm vitest run packages/server/test/providers/codex-provider.test.ts packages/server/test/providers/codex-activity.test.ts packages/server/test/terminal-manager.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/providers/codex-provider.ts packages/server/src/providers/codex-activity.ts packages/server/test/providers packages/server/test/fixtures/codex
git commit -m "feat(server): add Codex terminal provider"
```

### Task 6: Bounded Codex App-Server JSON-RPC Client

**Files:**
- Create: `packages/server/src/providers/codex-app-server-client.ts`
- Create: `packages/server/test/providers/codex-app-server-client.test.ts`

**Interfaces:**
- Produces: `CodexAppServerClient.start()`, `request(method, params, schema)`, `onNotification`, `stop`, and injected `spawnTransport` seam.
- Consumers: Tasks 7 and 8 only; terminal streaming never depends on this class.

- [ ] **Step 1: Write failing protocol tests over a fake transport**

```ts
test("initializes, correlates out-of-order responses, and validates payloads", async () => {
  const transport = fakeJsonLineTransport();
  const client = new CodexAppServerClient({ transport, timeoutMs: 100 });
  const started = client.start();
  transport.receive({ id: 1, result: { userAgent: "fake" } });
  await started;

  const a = client.request("account/read", {}, AccountResponseSchema);
  const b = client.request("model/list", {}, ModelListResponseSchema);
  transport.respondTo("model/list", { data: [], nextCursor: null });
  transport.respondTo("account/read", { account: null, requiresOpenaiAuth: true });
  await expect(Promise.all([a, b])).resolves.toHaveLength(2);
});

test("times out, bounds stderr, and rejects malformed JSON without leaking it", async () => {
  // assert stable CODEX_METADATA_UNAVAILABLE errors and redacted diagnostics
});
```

- [ ] **Step 2: Run and confirm RED**

Run: `pnpm vitest run packages/server/test/providers/codex-app-server-client.test.ts`
Expected: FAIL because the client does not exist.

- [ ] **Step 3: Implement the minimal JSON-lines client**

Spawn `codex app-server --stdio`, send `initialize`, then `initialized`; allocate monotonic numeric ids; keep `Map<id, pending>`; parse one JSON object per line; cap stdout line length and stderr buffer; reject pending requests on timeout/exit; support restart after exit. Define narrow Zod schemas beside the client for envelopes only and pass method result schemas from callers.

- [ ] **Step 4: Run focused tests**

Run: `pnpm vitest run packages/server/test/providers/codex-app-server-client.test.ts`
Expected: PASS with no live Codex process.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/providers/codex-app-server-client.ts packages/server/test/providers/codex-app-server-client.test.ts
git commit -m "feat(server): add bounded Codex metadata client"
```

### Task 7: Codex Account, Models, Usage, Profiles, Version, and Exact Thread Resolver

**Files:**
- Create: `packages/server/src/providers/codex-metadata-service.ts`
- Create: `packages/server/src/providers/codex-thread-resolver.ts`
- Create: `packages/server/src/providers/codex-latest-service.ts`
- Create: `packages/server/test/providers/codex-metadata-service.test.ts`
- Create: `packages/server/test/providers/codex-thread-resolver.test.ts`
- Create: `packages/server/test/providers/codex-latest-service.test.ts`

**Interfaces:**
- Consumes: Task 6 client.
- Produces: normalized `getAccount`, `startDeviceLogin`, `cancelLogin`, `getModels`, `getUsage`, `listProfiles`, `getVersion`, and `CodexThreadResolver.resolveAfterSpawn`.

- [ ] **Step 1: Write failing metadata normalization tests**

```ts
test("normalizes ChatGPT device login and rate limits", async () => {
  rpc.reply("account/login/start", {
    type: "chatgptDeviceCode", loginId: "l1", userCode: "ABCD-EFGH", verificationUrl: "https://example.test/device",
  });
  await expect(service.startDeviceLogin()).resolves.toMatchObject({ loginId: "l1", userCode: "ABCD-EFGH" });

  rpc.reply("account/rateLimits/read", {
    rateLimits: { primary: { usedPercent: 42, resetsAt: 1783800000 }, secondary: null },
  });
  expect((await service.getUsage())?.bars[0]).toMatchObject({ percent: 42, label: "Primary" });
});

test("paginates model/list and retains advertised reasoning values", async () => {
  expect((await service.getModels())[0]).toMatchObject({ value: "gpt-5.6", supportedReasoningEfforts: ["low", "high"] });
});
```

- [ ] **Step 2: Write failing exact-thread tests**

```ts
test("resolves the only new CLI thread and rejects ambiguity", async () => {
  const resolver = new CodexThreadResolver(fakeInventory([
    snapshot([]),
    snapshot([{ id: "t1", cwd: "/w", source: "cli", createdAt: 101 }]),
  ]));
  await expect(resolver.resolveAfterSpawn({ cwd: "/w", startedAt: 100 })).resolves.toBe("t1");

  await expect(ambiguousResolver.resolveAfterSpawn({ cwd: "/w", startedAt: 100 })).rejects.toMatchObject({
    code: "RESUME_IDENTITY_UNAVAILABLE",
  });
});
```

- [ ] **Step 3: Run and confirm RED**

Run: `pnpm vitest run packages/server/test/providers/codex-metadata-service.test.ts packages/server/test/providers/codex-thread-resolver.test.ts packages/server/test/providers/codex-latest-service.test.ts`
Expected: FAIL because services do not exist.

- [ ] **Step 4: Implement services with caches and capability checks**

Use narrow Zod schemas copied from the installed generated contract shape, not generated source files. Paginate models until `nextCursor` is null with a page/count cap. Normalize timestamps to milliseconds. Device login waits for `account/login/completed`, supports TTL/cancel, and never exposes tokens.

List profiles by bounded filenames under `CODEX_HOME`; validate names and use app-server effective config/capabilities to reject non-OpenAI providers with `OSS_PROVIDER_DEFERRED`.

Thread resolver uses a process-wide mutex for the snapshot/spawn/discovery window, polls with a hard deadline, matches new id + exact cwd + CLI source + creation window, persists one id, and rejects zero/multiple candidates. Add an explicit assertion/helper that no generated resume args contain `--last`.

Version service parses `codex --version`; only compare `@openai/codex` latest for compatible install provenance, otherwise return an update hint.

- [ ] **Step 5: Run focused tests**

Run: `pnpm vitest run packages/server/test/providers/codex-metadata-service.test.ts packages/server/test/providers/codex-thread-resolver.test.ts packages/server/test/providers/codex-latest-service.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/providers/codex-metadata-service.ts packages/server/src/providers/codex-thread-resolver.ts packages/server/src/providers/codex-latest-service.ts packages/server/test/providers
git commit -m "feat(server): add Codex account and thread metadata"
```

### Task 8: Provider-Aware Server Routes, Startup, Preflight, and Diagnostics

**Files:**
- Modify: `packages/server/src/server-config.ts`
- Modify: `packages/server/src/start.ts`
- Modify: `packages/server/src/transport.ts`
- Modify: `packages/server/src/diag.ts`
- Modify: `packages/server/src/index.ts`
- Modify: `packages/server/tsup.config.ts`
- Modify: `packages/server/test/helpers/test-server.ts`
- Modify: `packages/server/test/transport.rest.test.ts`
- Create: `packages/server/test/transport.providers.test.ts`
- Modify: `packages/server/test/start.preflight.test.ts`
- Modify: `packages/server/test/diag.test.ts`

**Interfaces:**
- Consumes: all server provider services.
- Produces: required provider create contract, `/providers/*` routes, provider diagnostics, dual preflight, compatibility aliases.

- [ ] **Step 1: Write failing transport tests**

```ts
test("POST /sessions requires an explicit provider", async () => {
  const res = await app.inject({ method: "POST", url: "/sessions", headers: auth, payload: { cwd } });
  expect(res.statusCode).toBe(409);
  expect(res.json()).toMatchObject({ code: "PROVIDER_REQUIRED" });
});

test("creates and lists provider-native sessions", async () => {
  const res = await app.inject({
    method: "POST", url: "/sessions", headers: auth,
    payload: { provider: "codex", cwd, options: { sandbox: "workspace-write", approvalPolicy: "on-request" } },
  });
  expect(res.statusCode).toBe(201);
  expect(res.json().session).toMatchObject({ provider: "codex", mode: "terminal" });
});

test("provider metadata failure does not disable another provider", async () => {
  expect((await getProviders()).providers).toMatchObject({
    claude: { terminalAvailable: true }, codex: { terminalAvailable: true, metadataAvailable: false },
  });
});
```

- [ ] **Step 2: Run and confirm RED**

Run: `pnpm vitest run packages/server/test/transport.providers.test.ts packages/server/test/start.preflight.test.ts packages/server/test/diag.test.ts`
Expected: FAIL because provider routes/config do not exist.

- [ ] **Step 3: Wire configuration and startup**

Add `codexBin: env.CODEX_BIN ?? "codex"`. Build cached probes and both provider implementations, start the metadata client lazily, inject registry/services into `createServer`, and close metadata/auth children on Fastify close. Replace Claude-only boot warning with provider-labelled warnings while retaining the Claude export as a compatibility wrapper until tests/callers migrate.

- [ ] **Step 4: Implement provider routes and aliases**

Validate create body with provider schemas, stat cwd/addDirs, check session cap, create typed manager record, and return normalized session metadata. Add:

```text
GET  /providers
GET  /providers/:provider/auth/status
POST /providers/:provider/auth/login/start
POST /providers/:provider/auth/login/cancel
GET  /providers/:provider/models
GET  /providers/:provider/usage
GET  /providers/:provider/version
```

Keep existing Claude endpoints delegating to the same Claude services. Add stable error `{ code, error, hint? }` shapes. Extend `/diag.providers` with redacted capability state.

- [ ] **Step 5: Update async terminal WebSocket attach**

Await `terminalManager.attach`; map provider errors to the existing close/error path without leaking internal argv. Ensure Codex identity resolution updates `SessionStore.setProviderSessionId` and list metadata.

- [ ] **Step 6: Run server transport/security suites**

Run: `pnpm vitest run packages/server/test/transport.providers.test.ts packages/server/test/transport.rest.test.ts packages/server/test/transport.terminal-ws.test.ts packages/server/test/transport.security.test.ts packages/server/test/start.preflight.test.ts packages/server/test/diag.test.ts`
Expected: PASS; auth/default-deny routes remain protected.

- [ ] **Step 7: Commit**

```bash
git add packages/server/src packages/server/test packages/server/tsup.config.ts
git commit -m "feat(server): expose Claude and Codex providers"
```

### Task 9: Provider-Aware Web Types and API Client

**Files:**
- Create: `packages/web/src/providers/types.ts`
- Modify: `packages/web/src/types/server.ts`
- Modify: `packages/web/src/api/client.ts`
- Modify: `packages/web/src/api/client.test.ts`
- Modify: `packages/web/src/settings/defaults.ts`
- Modify: `packages/web/src/settings/defaults.test.ts`

**Interfaces:**
- Consumes: Task 8 REST shapes.
- Produces: discriminated `CreateSessionBody`, `ProviderSummary`, provider metadata client methods, and defaults that never contain provider.

- [ ] **Step 1: Write failing client/default tests**

```ts
it("POSTs a discriminated Codex create body", async () => {
  await api.createSession({
    provider: "codex", cwd: "/x",
    options: { sandbox: "workspace-write", approvalPolicy: "on-request", reasoningEffort: "high" },
  });
  expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toEqual({
    provider: "codex", cwd: "/x",
    options: { sandbox: "workspace-write", approvalPolicy: "on-request", reasoningEffort: "high" },
  });
});

it("never persists a provider choice in defaults", () => {
  localStorage.setItem("rc-session-defaults", JSON.stringify({ provider: "codex", model: "x" }));
  expect(loadDefaults()).not.toHaveProperty("provider");
});
```

- [ ] **Step 2: Run and confirm RED**

Run: `pnpm vitest run packages/web/src/api/client.test.ts packages/web/src/settings/defaults.test.ts`
Expected: FAIL because the client uses the flat Claude body and has no provider API.

- [ ] **Step 3: Implement browser contracts and API methods**

Add `getProviders`, `getProviderModels`, `getProviderUsage`, `getProviderVersion`, `getProviderAuthStatus`, `startProviderLogin`, and `cancelProviderLogin`. Keep old methods temporarily as Claude wrappers only where existing components still need them during this task. Add `provider?: ProviderId` to incoming session types so older-server payloads display as Claude; require provider in outgoing create types.

Split session defaults into provider-specific option defaults keyed by controls, but do not save a selected provider. Ignore a stale stored `provider` key on load.

- [ ] **Step 4: Run focused web tests/typecheck**

Run: `pnpm vitest run packages/web/src/api/client.test.ts packages/web/src/settings/defaults.test.ts && pnpm --filter @roamcode/web typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/providers/types.ts packages/web/src/types/server.ts packages/web/src/api packages/web/src/settings/defaults.ts packages/web/src/settings/defaults.test.ts
git commit -m "feat(web): add provider-aware API contracts"
```

### Task 10: Required Provider Choice and Native Session Controls

**Files:**
- Create: `packages/web/src/providers/ProviderPicker.tsx`
- Create: `packages/web/src/providers/ClaudeSessionOptions.tsx`
- Create: `packages/web/src/providers/CodexSessionOptions.tsx`
- Create: `packages/web/src/providers/provider-options.test.tsx`
- Modify: `packages/web/src/session/NewSessionWizard.tsx`
- Create: `packages/web/src/session/NewSessionWizard.test.tsx`
- Modify: `packages/web/src/App.tsx`
- Modify: `packages/web/src/App.test.tsx`

**Interfaces:**
- Consumes: provider summaries/models/profiles and API client.
- Produces: accessible required provider step and exact provider create bodies.

- [ ] **Step 1: Write failing UX tests**

```tsx
test("requires a fresh provider choice every time", async () => {
  const { unmount } = renderWizard();
  expect(screen.getByRole("button", { name: /start session/i })).toBeDisabled();
  await user.click(screen.getByRole("radio", { name: /codex/i }));
  expect(screen.getByRole("button", { name: /start session/i })).toBeEnabled();
  unmount();
  renderWizard();
  expect(screen.getByRole("radio", { name: /codex/i })).not.toBeChecked();
});

test("shows only Codex-native controls and serializes them", async () => {
  await choose("codex");
  expect(screen.getByLabelText(/sandbox/i)).toBeVisible();
  expect(screen.queryByLabelText(/permission mode/i)).toBeNull();
  await start();
  expect(api.createSession).toHaveBeenCalledWith(expect.objectContaining({ provider: "codex" }));
});
```

- [ ] **Step 2: Run and confirm RED**

Run: `pnpm vitest run packages/web/src/providers/provider-options.test.tsx packages/web/src/session/NewSessionWizard.test.tsx packages/web/src/App.test.tsx`
Expected: FAIL because provider controls do not exist.

- [ ] **Step 3: Extract Claude controls without behavior changes**

Move existing model/effort/permission/add-dir/danger UI into `ClaudeSessionOptions`. Preserve labels, defaults, inline confirmation, and tests.

- [ ] **Step 4: Implement provider picker and Codex controls**

Use a radio group with no initial value. Provider cards show CLI/auth/metadata availability. Disable unavailable providers with a visible hint. Codex controls use the account model catalog, constrain reasoning by selected model, list valid sandbox/approval/profile values, and keep dangerous bypass in a separate two-step confirm that disables ordinary safety fields.

On provider switch, discard the previous provider's in-memory option state; never translate it. On wizard close/reopen, reset provider to undefined. “New session in this folder” passes cwd only.

- [ ] **Step 5: Run wizard/App tests**

Run: `pnpm vitest run packages/web/src/providers/provider-options.test.tsx packages/web/src/session/NewSessionWizard.test.tsx packages/web/src/App.test.tsx`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/providers packages/web/src/session/NewSessionWizard.tsx packages/web/src/session/NewSessionWizard.test.tsx packages/web/src/App.tsx packages/web/src/App.test.tsx
git commit -m "feat(web): require Claude or Codex per session"
```

### Task 11: Provider Accounts, Session Badges, Usage, Safety, and Notifications

**Files:**
- Create: `packages/web/src/settings/CodexAuthSection.tsx`
- Create: `packages/web/src/settings/CodexAuthSection.test.tsx`
- Create: `packages/web/src/settings/ProviderAccounts.tsx`
- Create: `packages/web/src/settings/ProviderAccounts.test.tsx`
- Modify: `packages/web/src/settings/SettingsPanel.tsx`
- Modify: `packages/web/src/settings/SettingsPanel.test.tsx`
- Modify: `packages/web/src/settings/ClaudeAuthSection.tsx`
- Modify: `packages/web/src/session/SessionList.tsx`
- Modify: `packages/web/src/session/SessionList.test.tsx`
- Modify: `packages/web/src/chat/ChatHeader.tsx`
- Modify: `packages/web/src/chat/ChatHeader.test.tsx`
- Modify: `packages/web/src/session/UsageBars.tsx`
- Modify: `packages/web/src/session/UsageBars.test.tsx`
- Modify: `packages/web/src/App.tsx`

**Interfaces:**
- Consumes: provider auth/usage/version/session metadata.
- Produces: separate account cards, device-code login, provider badges, normalized limit bars, provider-labelled alerts.

- [ ] **Step 1: Write failing device-code/account tests**

```tsx
test("completes Codex device login without accepting secrets", async () => {
  api.startProviderLogin.mockResolvedValue({
    type: "device-code", loginId: "l1", userCode: "ABCD-EFGH", verificationUrl: "https://example.test/device",
  });
  render(<CodexAuthSection api={api} />);
  await user.click(screen.getByRole("button", { name: /sign in/i }));
  expect(screen.getByText("ABCD-EFGH")).toBeVisible();
  expect(screen.getByRole("link", { name: /open/i })).toHaveAttribute("href", "https://example.test/device");
  expect(screen.queryByLabelText(/api key/i)).toBeNull();
});

test("labels each session and dangerous state by provider", () => {
  render(<SessionList sessions={[codexSession({ dangerous: true }), claudeSession()]} />);
  expect(screen.getByText("Codex")).toBeVisible();
  expect(screen.getByText(/bypass approvals.*sandbox/i)).toBeVisible();
  expect(screen.getByText("Claude")).toBeVisible();
});
```

- [ ] **Step 2: Run and confirm RED**

Run: `pnpm vitest run packages/web/src/settings/CodexAuthSection.test.tsx packages/web/src/settings/ProviderAccounts.test.tsx packages/web/src/session/SessionList.test.tsx packages/web/src/chat/ChatHeader.test.tsx packages/web/src/session/UsageBars.test.tsx`
Expected: FAIL because provider UI does not exist.

- [ ] **Step 3: Implement provider account/settings UI**

Render Claude and Codex cards independently. Codex device auth shows link, copy-code, cancel, expiry/error, and polls account status until complete. Provider errors are scoped. Normalize usage bars with provider/limit labels; retain current Claude warning behavior without Claude wording on Codex limits.

- [ ] **Step 4: Implement badges, safety, and alert copy**

Session rows/header show provider, model/reasoning, and exact safety label. Treat missing provider from an older server as Claude for display. Include provider in needs-you foreground/push copy. Never copy provider into a new-session shortcut.

- [ ] **Step 5: Run affected web suites**

Run: `pnpm vitest run packages/web/src/settings packages/web/src/session packages/web/src/chat/ChatHeader.test.tsx packages/web/src/App.test.tsx`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/settings packages/web/src/session packages/web/src/chat/ChatHeader.tsx packages/web/src/chat/ChatHeader.test.tsx packages/web/src/App.tsx
git commit -m "feat(web): surface provider accounts and session state"
```

### Task 12: Cross-Provider Integration, Product Copy, Documentation, and Release Verification

**Files:**
- Create: `packages/server/test/terminal-providers.integration.test.ts`
- Create: `packages/server/test/fixtures/fake-codex.mjs`
- Modify: `packages/cli/src/args.ts`
- Modify: `packages/cli/test/args.test.ts`
- Modify: `packages/cli/src/install.ts`
- Modify: `packages/cli/test/install.test.ts`
- Modify: `README.md`
- Modify: `SECURITY.md`
- Modify: `CONTRIBUTING.md`
- Modify: `CHANGELOG.md`
- Modify: `packages/web/src/chat/HelpSheet.tsx`
- Modify: `packages/web/src/pwa/manifest.ts`
- Modify: `packages/web/src/pwa/manifest.test.ts`
- Modify: `site/src/main.ts`
- Modify: `site/src/playground.ts`
- Modify: `site/index.html`
- Create: `packages/web/src/screenshot/codex-mobile.ansi`
- Modify: `packages/web/src/screenshot/scenes.tsx`
- Modify: `packages/web/scripts/make-mockups.mjs`
- Create: `docs/media/codex-mobile.png` from the deterministic screenshot scene.

**Interfaces:**
- Consumes: completed server/web integration.
- Produces: CI-safe end-to-end proof, accurate install/security/docs/marketing surfaces, final clean build.

- [ ] **Step 1: Write failing fake-binary acceptance test**

```ts
test("runs Claude and Codex concurrently in one cwd and resumes exact Codex id", async () => {
  const server = await providerFixtureServer();
  const claude = await server.create({ provider: "claude", cwd });
  const codex = await server.create({ provider: "codex", cwd });
  await Promise.all([server.attach(claude.id), server.attach(codex.id)]);
  expect(server.spawnFor(claude.id).executable).toMatch(/fake-claude/);
  expect(server.spawnFor(codex.id).executable).toMatch(/fake-codex/);

  server.fakeCodex.discoverThread(codex.id, "thread-exact");
  server.exit(codex.id);
  await server.resume(codex.id);
  expect(server.spawnFor(codex.id).args).toContain("thread-exact");
  expect(server.spawnFor(codex.id).args).not.toContain("--last");
});
```

Also cover MCP attachment callback, detached needs-you/completion push, metadata degradation, dual rehydrate, and missing-one-provider behavior.

- [ ] **Step 2: Run and confirm RED**

Run: `pnpm vitest run packages/server/test/terminal-providers.integration.test.ts`
Expected: FAIL until all acceptance fixture seams are wired.

- [ ] **Step 3: Complete fixture seams and make acceptance test GREEN**

Implement the fake Codex JSON-lines app-server and TUI behavior without network or account use. Reuse the real terminal manager, transport, MCP callback, store, and push seams; mock only the external binaries and Web Push sender.

- [ ] **Step 4: Update CLI/install copy and tests**

Change help/service comments from “Claude sessions” to “Claude Code or Codex sessions”; document `CODEX_BIN`; ensure generated service PATH remains unchanged except wording. Add test assertions for both executable env variables and dual-provider description.

- [ ] **Step 5: Update product/docs/security surfaces**

Document:

- both real TUIs and required per-session choice;
- installation/auth prerequisites for both CLIs;
- `CLAUDE_BIN` and `CODEX_BIN`;
- device-code Codex reauthentication;
- provider-specific safety controls;
- the unchanged host-RCE trust boundary;
- diagnostics/provider degradation;
- OSS providers as deferred.

Update PWA/site copy and metadata. Keep existing Claude screenshots but add or regenerate at least one Codex-labelled terminal/wizard visual; do not mislabel a Claude screenshot as Codex.

- [ ] **Step 6: Run targeted static/copy/build tests**

Run: `pnpm vitest run packages/cli/test packages/web/src/pwa/manifest.test.ts packages/server/test/static-live-assets.test.ts packages/server/test/terminal-providers.integration.test.ts`
Expected: PASS.

- [ ] **Step 7: Run fresh full verification**

Run in order:

```bash
pnpm test
pnpm typecheck
pnpm lint
pnpm format:check
pnpm build
```

Expected: every command exits 0. Read the full output; do not infer build success from tests or typecheck.

- [ ] **Step 8: Run non-credit real-CLI smoke checks when Codex is installed**

```bash
codex --version
codex login status
codex doctor --json
codex debug models
```

Expected: commands return parseable installed/account/catalog diagnostics. Do not send a prompt, change login, or consume credits. If Codex is absent, verify the provider-unavailable UI and record the skipped smoke explicitly.

- [ ] **Step 9: Audit requirements and secrets**

Run:

```bash
rg -n --hidden -g '!node_modules' -g '!.git' 'ANTHROPIC_API_KEY|OPENAI_API_KEY|RC_TOKEN|--last|provider_sessions' packages README.md SECURITY.md
git diff --check
git status --short
```

Expected: API-key mentions are documentation/intentional stripping only; `RC_TOKEN` appears only in secret-safe env plumbing; no provider code uses Codex `--last`; persistence references match the two-table design; diff check is clean.

- [ ] **Step 10: Commit**

```bash
git add packages site README.md SECURITY.md CONTRIBUTING.md CHANGELOG.md
git commit -m "feat: ship first-class Codex support"
```

---

## Plan Self-Review Checklist

- Every design requirement maps to Tasks 1–12.
- Every production behavior begins with a focused failing test.
- Provider/session/option names are consistent across server and web contracts.
- Codex persistence never enters the legacy Claude table.
- Codex resume never uses `--last`.
- User Codex hooks, external `notify`, profiles, and MCP servers are not overwritten.
- The app-server client is auxiliary and runtime-validated.
- Claude compatibility routes and existing tmux socket remain intact.
- Full verification and non-credit smoke checks are explicit.
