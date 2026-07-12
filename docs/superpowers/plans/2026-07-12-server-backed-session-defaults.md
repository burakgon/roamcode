# Server-backed Session Defaults Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make one validated session-defaults profile authoritative for every browser connected to the same RoamCode server, with safe first-device migration and conflict handling.

**Architecture:** Store a typed, revisioned defaults document in the existing session SQLite database and expose authenticated compare-and-swap GET/PUT endpoints. Let `App` own synchronized defaults state; localStorage becomes an offline cache and one-time migration source rather than an independent source of truth.

**Tech Stack:** TypeScript 6, Zod, better-sqlite3, Fastify, React 19, Testing Library, Vitest.

## Global Constraints

- One defaults profile is shared by all clients of one RoamCode server.
- Never store or infer a default provider; every wizard still starts with no provider selected.
- The server is authoritative after the first successful migration or save.
- A stale device must never silently overwrite a newer revision.
- Keep the existing `roamcode.defaults` localStorage key as normalized cache and migration input.
- Reject unknown keys and bound every string/array on the server before persistence.
- Dangerous values require existing explicit UI confirmation and may not be introduced by malformed data.
- SQLite migration is additive; existing sessions and provider tables remain untouched.
- Apply TDD: every production behavior starts with a focused failing test whose expected failure is observed.

---

### Task 1: Typed defaults codec and durable revisioned storage

**Files:**
- Create: `packages/server/src/session-defaults.ts`
- Modify: `packages/server/src/session-store.ts`
- Modify: `packages/server/src/index.ts`
- Test: `packages/server/test/session-defaults.test.ts`
- Test: `packages/server/test/session-store.test.ts`
- Test: `packages/server/test/session-store.migration.test.ts`

**Interfaces:**
- Produces:

```ts
export interface SessionDefaults {
  effort: string;
  model?: string;
  dangerouslySkip: boolean;
  permissionMode?: string;
  codex?: {
    model?: string;
    reasoningEffort?: string;
    sandbox?: "read-only" | "workspace-write" | "danger-full-access";
    approvalPolicy?: "untrusted" | "on-request" | "never";
    profile?: string;
    webSearch?: boolean;
    addDirs?: string[];
    dangerouslyBypassApprovalsAndSandbox?: boolean;
  };
}

export interface StoredSessionDefaults {
  defaults: SessionDefaults;
  revision: number;
  updatedAt: number;
}

export class SessionDefaultsConflictError extends Error {
  constructor(readonly current: StoredSessionDefaults | undefined);
}

export function normalizeSessionDefaults(value: unknown): SessionDefaults;
```

Extend `SessionStore` with:

```ts
getSessionDefaults(): StoredSessionDefaults | undefined;
putSessionDefaults(
  defaults: SessionDefaults,
  expectedRevision: number,
  updatedAt: number,
): StoredSessionDefaults;
```

- [ ] **Step 1: Write codec tests**

Cover the default fallback `{ effort: "medium", dangerouslySkip: false }`, valid Claude/Codex values, mutually exclusive dangerous vs permission/sandbox fields, bounded model/profile/path tokens, maximum 32 Codex additional directories, unknown-key rejection, and defensive cloning. Assert a missing dangerous field defaults to `false`, while a present non-boolean dangerous value is rejected and can never become `true`.

- [ ] **Step 2: Run codec test and verify RED**

Run:

```bash
pnpm vitest run packages/server/test/session-defaults.test.ts
```

Expected: FAIL because the codec does not exist.

- [ ] **Step 3: Implement the strict codec**

Use a `.strict()` Zod object for the outer document and nested Codex document. Reuse safe token/path patterns from provider options, with these bounds:

```ts
const MAX_MODEL = 128;
const MAX_PROFILE = 128;
const MAX_PATH = 4096;
const MAX_ADD_DIRS = 32;
const SAFE_EFFORT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
```

Default missing effort to `medium`, missing danger to `false`, and remove permission mode when Claude danger is true. Remove sandbox/approval when Codex bypass is true. Throw on unknown keys or invalid present values; only an entirely absent document receives fallback defaults.

- [ ] **Step 4: Write store persistence and compare-and-swap tests**

Assert:

- unset store returns `undefined`;
- first `expectedRevision: 0` write returns revision 1;
- revision 1 write returns revision 2;
- stale expected revision throws `SessionDefaultsConflictError` carrying a clone of current data;
- close/reopen preserves the document;
- malformed manually inserted JSON reads as unset;
- in-memory fallback has identical revision/conflict behavior;
- caller mutation cannot mutate stored or returned values.

- [ ] **Step 5: Run store tests and verify RED**

Run:

```bash
pnpm vitest run packages/server/test/session-store.test.ts packages/server/test/session-store.migration.test.ts
```

Expected: FAIL because `SessionStore` has no defaults methods/table.

- [ ] **Step 6: Add the additive table and atomic writes**

Create exactly:

```sql
CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  updated_at INTEGER NOT NULL
)
```

Use the fixed key `session_defaults`. For SQLite, perform update/insert and revision comparison in one `better-sqlite3` transaction. For memory fallback, keep one cloned record. On parse/validation failure return `undefined` without deleting the diagnostic row.

- [ ] **Step 7: Run focused tests and verify GREEN**

Run:

```bash
pnpm vitest run packages/server/test/session-defaults.test.ts packages/server/test/session-store.test.ts packages/server/test/session-store.migration.test.ts
```

Expected: PASS.

- [ ] **Step 8: Export and commit**

```bash
git add packages/server/src/session-defaults.ts packages/server/src/session-store.ts packages/server/src/index.ts packages/server/test/session-defaults.test.ts packages/server/test/session-store.test.ts packages/server/test/session-store.migration.test.ts
git commit -m "feat(server): persist revisioned session defaults"
```

---

### Task 2: Authenticated defaults API and browser client contract

**Files:**
- Modify: `packages/server/src/transport.ts`
- Test: `packages/server/test/transport.settings.test.ts`
- Modify: `packages/web/src/types/server.ts`
- Modify: `packages/web/src/api/client.ts`
- Test: `packages/web/src/api/client.test.ts`

**Interfaces:**
- Consumes: store/codec from Task 1.
- Produces:

```ts
export interface SessionDefaultsEnvelope {
  defaults: SessionDefaults | null;
  revision: number;
  updatedAt?: number;
}

ApiClient.getSessionDefaults(): Promise<SessionDefaultsEnvelope>;
ApiClient.putSessionDefaults(
  defaults: SessionDefaults,
  expectedRevision: number,
): Promise<SessionDefaultsEnvelope>;
```

On conflict, the API throws an extended `ApiError` whose parsed `body` contains:

```ts
{
  code: "SETTINGS_CONFLICT";
  error: string;
  current: SessionDefaultsEnvelope;
}
```

- [ ] **Step 1: Write authenticated route tests**

Test unauthenticated GET/PUT rejection, unset GET response, normalized successful PUT, revision increment, invalid/unknown payload 400, stale PUT 409 with current document, payload size bounds, and that the route uses the injected store rather than another database connection.

- [ ] **Step 2: Run route tests and verify RED**

Run:

```bash
pnpm vitest run packages/server/test/transport.settings.test.ts
```

Expected: FAIL with 404 for both routes.

- [ ] **Step 3: Implement GET/PUT routes**

Register authenticated routes:

```ts
GET /settings/session-defaults
PUT /settings/session-defaults
```

GET maps unset to `{ defaults: null, revision: 0 }`. PUT requires `expectedRevision` as a safe non-negative integer and normalizes `defaults`; use `Date.now()` for `updatedAt`. Map `SessionDefaultsConflictError` to status 409 and code `SETTINGS_CONFLICT`, including the current envelope.

- [ ] **Step 4: Write API client tests and verify RED**

Assert exact methods, headers, bodies, return values, and parsed 409 body. Run:

```bash
pnpm vitest run packages/web/src/api/client.test.ts
```

Expected: FAIL because methods/types are missing.

- [ ] **Step 5: Implement client methods and structured API errors**

Extend `ApiError` with `body?: unknown`; make the shared request helper preserve parsed JSON error bodies. Add GET/PUT methods using the existing authorization/header helpers. Do not special-case localStorage in the API layer.

- [ ] **Step 6: Run focused tests and verify GREEN**

```bash
pnpm vitest run packages/server/test/transport.settings.test.ts packages/web/src/api/client.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/server/src/transport.ts packages/server/test/transport.settings.test.ts packages/web/src/types/server.ts packages/web/src/api/client.ts packages/web/src/api/client.test.ts
git commit -m "feat(api): synchronize session defaults"
```

---

### Task 3: Deterministic browser migration and conflict-aware synchronization

**Files:**
- Modify: `packages/web/src/settings/defaults.ts`
- Create: `packages/web/src/settings/defaults-sync.ts`
- Create: `packages/web/src/settings/defaults-sync.test.ts`
- Modify: `packages/web/src/App.tsx`
- Test: `packages/web/src/App.test.tsx`

**Interfaces:**
- Consumes: `ApiClient.getSessionDefaults` and `putSessionDefaults` from Task 2.
- Produces:

```ts
export type DefaultsSyncState =
  | { status: "loading"; defaults: SessionDefaults; revision: number }
  | { status: "synced"; defaults: SessionDefaults; revision: number }
  | { status: "unsynced"; defaults: SessionDefaults; revision: number; error: string };

export async function hydrateSessionDefaults(options: {
  api: Pick<ApiClient, "getSessionDefaults" | "putSessionDefaults">;
  local: SessionDefaults;
}): Promise<DefaultsSyncState>;

export async function persistSessionDefaults(options: {
  api: Pick<ApiClient, "putSessionDefaults">;
  defaults: SessionDefaults;
  revision: number;
}): Promise<DefaultsSyncState>;
```

- [ ] **Step 1: Export browser normalization and write synchronization tests**

Make `normalizeDefaults` public as `normalizeSessionDefaults` while retaining `loadDefaults` and `saveDefaults`. Test these exact hydration cases:

1. server value exists: server wins and local cache is refreshed;
2. server unset: normalized local value is uploaded with revision 0;
3. migration PUT conflicts: conflict document wins and refreshes cache;
4. GET fails: local value remains with `unsynced` status;
5. successful save: returned server normalization and revision win;
6. save conflict: current server document wins with a user-visible conflict error;
7. generic save failure: previous authoritative state remains and reports unsynced.

- [ ] **Step 2: Run sync tests and verify RED**

```bash
pnpm vitest run packages/web/src/settings/defaults-sync.test.ts
```

Expected: FAIL because sync helpers do not exist.

- [ ] **Step 3: Implement pure synchronization helpers**

Use `ApiError.status === 409`, validate the structured conflict body before adopting it, normalize every server/local document before use, and call `saveDefaults` only after a valid authoritative document is chosen. Never use a separate migration flag: revision 0 is the idempotent migration gate.

- [ ] **Step 4: Write App ownership tests and verify RED**

Assert `App` hydrates after authentication, passes one state object to every settings/wizard surface, no longer recomputes defaults from panel-open booleans, and does not render “Saved” before a server PUT resolves. Assert logout clears in-memory sync state but does not erase local cache.

- [ ] **Step 5: Move authoritative state into App**

Replace:

```ts
const settingsDefaults = useMemo(() => loadDefaults(), [globalSettingsOpen, sessionSettingsOpen]);
```

with a `DefaultsSyncState` initialized from local cache and hydrated once per authenticated API/token lifecycle. Pass `defaultsSync.defaults` to `NewSessionWizard` as a required prop and to both settings panels. Provide one async save callback that uses the current revision and updates state only from the server result.

- [ ] **Step 6: Run focused tests and verify GREEN**

```bash
pnpm vitest run packages/web/src/settings/defaults-sync.test.ts packages/web/src/App.test.tsx
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/web/src/settings/defaults.ts packages/web/src/settings/defaults-sync.ts packages/web/src/settings/defaults-sync.test.ts packages/web/src/App.tsx packages/web/src/App.test.tsx
git commit -m "feat(web): sync defaults across devices"
```

---

### Task 4: Settings and wizard consume synchronized provider defaults

**Files:**
- Modify: `packages/web/src/settings/SettingsPanel.tsx`
- Modify: `packages/web/src/settings/SettingsPanel.test.tsx`
- Modify: `packages/web/src/session/NewSessionWizard.tsx`
- Modify: `packages/web/src/session/NewSessionWizard.test.tsx`
- Modify: `packages/web/src/App.tsx`

**Interfaces:**
- Consumes: app-owned `SessionDefaults`, async save state, Claude/Codex model metadata from the provider-capabilities plan.
- Produces:

```ts
onSaveDefaults: (defaults: SessionDefaults) => Promise<void>;
defaultsSaveState: "idle" | "saving" | "saved" | "error" | "conflict";
defaultsSaveError?: string;
```

- [ ] **Step 1: Write settings save-state and provider-default tests**

Assert:

- Save shows `Saving…` while pending and only `Saved ✓` after resolution;
- rejection leaves the draft intact and shows retryable error copy;
- conflict copy says settings changed on another device and reseeds the draft from new props;
- Claude and Codex defaults are editable in compact provider-labelled subsections;
- changing Codex model constrains its default reasoning effort;
- provider choice is absent from the saved document;
- dangerous defaults retain two-step confirmation;
- sync status explains when local fallback is not yet saved to the server.

- [ ] **Step 2: Run settings tests and verify RED**

```bash
pnpm vitest run packages/web/src/settings/SettingsPanel.test.tsx
```

Expected: FAIL because save is synchronous/local-only and Codex defaults have no editor.

- [ ] **Step 3: Implement compact provider-labelled defaults editing**

Keep one “Defaults for new sessions” section with two collapsed subsections, `Claude Code` and `Codex`. Reuse the session option picker/copy helpers; do not duplicate model/effort compatibility logic. Keep dangerous controls visible whenever armed/enabled. Await `onSaveDefaults`, disable duplicate saves during flight, retain draft on failure, and reset the draft when authoritative defaults props change after a conflict.

- [ ] **Step 4: Write wizard seeding regression tests**

Pass explicit defaults into the wizard and assert drafts match them. Remove the internal `loadDefaults()` call. Re-render/reopen with changed server defaults and assert a fresh wizard uses the new defaults while provider remains undefined.

- [ ] **Step 5: Run wizard tests and verify RED**

```bash
pnpm vitest run packages/web/src/session/NewSessionWizard.test.tsx
```

Expected: FAIL because the wizard still reads localStorage itself.

- [ ] **Step 6: Make wizard defaults a required input**

Add `defaults: SessionDefaults` to `NewSessionWizardProps`, seed both drafts from that prop once per wizard mount, and remove the `loadDefaults` import. `chooseProvider` resets only to the same authoritative seed captured for that wizard instance.

- [ ] **Step 7: Run focused tests and verify GREEN**

```bash
pnpm vitest run packages/web/src/settings/SettingsPanel.test.tsx packages/web/src/session/NewSessionWizard.test.tsx packages/web/src/App.test.tsx
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/web/src/settings/SettingsPanel.tsx packages/web/src/settings/SettingsPanel.test.tsx packages/web/src/session/NewSessionWizard.tsx packages/web/src/session/NewSessionWizard.test.tsx packages/web/src/App.tsx
git commit -m "feat(web): manage shared provider defaults"
```

---

### Task 5: Whole-feature verification and browser smoke test

**Files:**
- Modify only files required by failures discovered in this task.
- Test: existing server/web test suites plus the focused tests added above.

**Interfaces:**
- Consumes: both implementation plans in full.
- Produces: a release-ready branch with no known regressions.

- [ ] **Step 1: Run static and full automated verification**

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Expected: all commands exit 0. Existing documented jsdom `scrollTo` warnings and Vite chunk-size warning may appear; no new warnings are accepted.

- [ ] **Step 2: Run browser smoke scenarios**

Start the built server/web app and verify at 390×844 and a desktop viewport:

1. wizard asks for provider every time;
2. Claude model/effort pickers populate and descriptions change;
3. Codex model/reasoning pickers populate and descriptions change;
4. Advanced expands and the modal body scrolls without moving the page beneath it;
5. metadata failure still permits provider-default session creation;
6. saving defaults in one browser context appears in a second fresh context;
7. a simulated revision conflict never displays a false Saved state.

Capture screenshots only as temporary QA artifacts; do not commit them unless a test fixture explicitly requires one.

- [ ] **Step 3: Run final diff hygiene checks**

```bash
git diff --check origin/main...HEAD
git status --short
git log --format='%h %s%n%b' origin/main..HEAD
```

Expected: no whitespace errors, no uncommitted production/test changes, and no contributor/co-author trailers.

- [ ] **Step 4: Commit any verified cleanup**

If verification required tracked fixes, commit only those exact files:

```bash
git add packages/server packages/web
git commit -m "fix: harden session setup synchronization"
```

If no tracked fixes were required, do not create an empty commit.
