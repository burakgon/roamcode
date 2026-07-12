# Provider Capabilities and Session UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Populate session-start model and effort pickers from live Claude/Codex metadata and explain each selected setting through a compact, future-compatible UI.

**Architecture:** Add an auxiliary, bounded Claude initialization probe beside the existing Codex metadata service, while keeping both independent from tmux/TUI startup. Adapt provider-specific catalogs into a shared browser picker view model, retain provider-native launch contracts, and put uncommon controls under an Advanced disclosure.

**Tech Stack:** TypeScript 6, Node child processes, Zod, Fastify, React 19, Testing Library, Vitest.

## Global Constraints

- Every new session must still require an explicit Claude Code or Codex choice; never persist provider selection.
- Metadata failure must never disable tmux/TUI session launch or existing sessions.
- Keep `GET /providers/:provider/models` backward compatible; response changes are additive.
- Preserve bounded custom-model support under Advanced.
- Preserve the dangerous-option two-step confirmation and keep an already-enabled dangerous state visible.
- Derive effort choices from the selected model and accept future bounded provider-advertised values.
- Do not send a Claude user prompt or create a persistent Claude session while probing metadata.
- Apply TDD: every production behavior starts with a focused failing test whose expected failure is observed.

---

### Task 1: Bounded Claude model metadata service

**Files:**
- Create: `packages/server/src/providers/claude-metadata-service.ts`
- Test: `packages/server/test/providers/claude-metadata-service.test.ts`
- Modify: `packages/server/src/index.ts`

**Interfaces:**
- Produces:

```ts
export interface ClaudeModelCatalogItem {
  value: string;
  displayName: string;
  description?: string;
  supportedEffortLevels: string[];
  isDefault: boolean;
}

export interface ClaudeMetadataRunner {
  run(): Promise<unknown>;
  dispose?(): void | Promise<void>;
}

export class ClaudeMetadataService {
  constructor(
    runner: ClaudeMetadataRunner,
    options?: { now?: () => number; ttlMs?: number },
  );
  getModels(force?: boolean): Promise<ClaudeModelCatalogItem[]>;
  validateModelSelection(model: string, effort?: string): Promise<void>;
  dispose(): void | Promise<void>;
}

export function createClaudeMetadataRunner(options: {
  claudeBin: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxOutputBytes?: number;
}): ClaudeMetadataRunner;
```

- Consumes: `ProviderError` from `packages/server/src/providers/types.ts` for known model/effort incompatibility.

- [ ] **Step 1: Write parser, cache, and validation tests**

Create tests that pass a fake runner returning the exact initialization envelope:

```ts
const envelope = {
  response: {
    response: {
      models: [
        {
          value: "sonnet",
          displayName: "Sonnet",
          description: "Balanced model",
          supportedEffortLevels: ["low", "medium", "high"],
          isDefault: true,
        },
      ],
    },
  },
};
```

Assert that concurrent `getModels()` calls invoke the runner once, returned arrays are cloned, successful data is TTL-cached, `force=true` refreshes, malformed/oversized/duplicate model and effort values reject with the generic metadata error, and a known `sonnet + max` selection throws `INVALID_PROVIDER_OPTIONS`. Assert an unknown bounded model remains launchable because only the CLI can authoritatively reject a custom future model.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
pnpm vitest run packages/server/test/providers/claude-metadata-service.test.ts
```

Expected: FAIL because `claude-metadata-service.ts` does not exist.

- [ ] **Step 3: Implement strict catalog normalization and cache coalescing**

Implement these exact rules:

```ts
const SAFE_VALUE = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
const MAX_MODELS = 64;
const MAX_EFFORTS = 32;
const MAX_TOKEN = 128;
const DEFAULT_TTL_MS = 5 * 60_000;
```

Normalize only `response.response.models`; reject any non-array, empty array, more than 64 items, duplicate model values, invalid tokens, duplicate effort values, or more than 32 effort values. Bound display names to 512 characters and descriptions to 4096 characters. Clone arrays on every public return. Store one in-flight promise so concurrent callers coalesce, and clear it in `finally`.

- [ ] **Step 4: Add the real short-lived runner and its lifecycle tests**

Inject a `spawnProcess` seam into the runner factory for tests. Spawn the configured binary with fixed arguments only:

```ts
[
  "--print",
  "--input-format", "stream-json",
  "--output-format", "stream-json",
  "--verbose",
  "--no-session-persistence",
  "--permission-mode", "plan",
]
```

Write one newline-delimited initialize request to stdin:

```ts
{
  type: "control_request",
  request_id: `roamcode-models-${randomUUID()}`,
  request: {
    subtype: "initialize",
    hooks: { PreToolUse: [{ matcher: "", hookCallbackIds: ["roamcode-metadata"] }] },
  },
}
```

Read newline-delimited JSON until the matching `control_response`; enforce a 10-second default timeout and 1 MiB combined stdout/stderr cap. Delete `ANTHROPIC_API_KEY` from the copied environment, never log output, and terminate the child plus remove listeners/timers on every settlement path. Tests must assert argv, environment sanitization, matching-request filtering, byte limit, timeout, early exit, and exactly-once cleanup.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run:

```bash
pnpm vitest run packages/server/test/providers/claude-metadata-service.test.ts
```

Expected: PASS with no leaked child/timer handles.

- [ ] **Step 6: Export the service and commit**

Export the public service/factory/types from `packages/server/src/index.ts`, then run:

```bash
git add packages/server/src/providers/claude-metadata-service.ts packages/server/test/providers/claude-metadata-service.test.ts packages/server/src/index.ts
git commit -m "feat(server): add bounded Claude model metadata"
```

---

### Task 2: Provider routes, validation, and lifecycle wiring

**Files:**
- Modify: `packages/server/src/start.ts`
- Modify: `packages/server/src/transport.ts`
- Modify: `packages/server/src/providers/options.ts`
- Modify: `packages/server/src/providers/types.ts`
- Modify: `packages/server/src/providers/codex-metadata-service.ts`
- Test: `packages/server/test/transport.providers.test.ts`
- Test: `packages/server/test/providers/options.test.ts`
- Test: `packages/server/test/providers/codex-metadata-service.test.ts`

**Interfaces:**
- Consumes: `ClaudeMetadataService` and `createClaudeMetadataRunner` from Task 1.
- Produces: `CreateServerDeps.claudeMetadata?: ClaudeMetadataService` and an additive Claude model route response carrying `supportedEffortLevels` and `isDefault`.

- [ ] **Step 1: Write route and option-contract tests**

Add transport tests with an injected fake service:

```ts
const claudeMetadata = {
  getModels: vi.fn().mockResolvedValue([
    {
      value: "sonnet",
      displayName: "Sonnet",
      description: "Balanced model",
      supportedEffortLevels: ["low", "medium", "future-depth"],
      isDefault: true,
    },
  ]),
  validateModelSelection: vi.fn().mockResolvedValue(undefined),
  dispose: vi.fn(),
};
```

Assert `GET /providers/claude/models` returns the live list, a probe failure returns the existing metadata-unavailable status/code, and a known incompatible session selection returns 400. Add option parser tests proving bounded `future-depth` is accepted as a single argv value while whitespace, leading dash, control characters, and values over 128 characters are rejected.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
pnpm vitest run packages/server/test/transport.providers.test.ts packages/server/test/providers/options.test.ts
```

Expected: FAIL because Claude routes still return an empty list and effort schemas are closed enums.

- [ ] **Step 3: Wire the service without coupling terminal availability**

Add `claudeMetadata` to `CreateServerDeps`; change only the Claude models route to call it. In session creation, validate a Claude model/effort combination when both metadata and a model are available. Treat metadata failure as `PROVIDER_METADATA_UNAVAILABLE` warning, not provider unavailability. Instantiate the runner/service in `start.ts` using the configured Claude binary, filesystem root, and server environment. Include disposal in the existing provider shutdown callback.

- [ ] **Step 4: Future-proof bounded effort transport**

Replace closed effort enums in provider option parsing and provider option types with a safe effort token:

```ts
const effortToken = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "must be a safe effort token");
```

Keep the UI baseline labels but do not reject a value advertised by a newer provider. Retain known-model compatibility checks in each metadata service.

- [ ] **Step 5: Preserve Codex effort descriptions and future tokens**

Extend `CodexModel` with additive effort option descriptions:

```ts
readonly reasoningOptions: ReadonlyArray<{
  value: string;
  description: string;
  isDefault: boolean;
}>;
```

Map every validated app-server option into this property while retaining `supportedReasoningEfforts` and `defaultReasoningEffort` for stale clients. Add a test using `future-depth` to prove it survives normalization.

- [ ] **Step 6: Run focused and server tests and verify GREEN**

Run:

```bash
pnpm vitest run packages/server/test/transport.providers.test.ts packages/server/test/providers/options.test.ts packages/server/test/providers/claude-metadata-service.test.ts packages/server/test/providers/codex-metadata-service.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/server/src/start.ts packages/server/src/transport.ts packages/server/src/providers packages/server/test/transport.providers.test.ts packages/server/test/providers
git commit -m "feat(server): expose live provider model capabilities"
```

---

### Task 3: Picker-first, explained session configuration UI

**Files:**
- Create: `packages/web/src/providers/SessionModelPicker.tsx`
- Create: `packages/web/src/providers/setting-copy.ts`
- Create: `packages/web/src/providers/SessionModelPicker.test.tsx`
- Modify: `packages/web/src/types/server.ts`
- Modify: `packages/web/src/providers/types.ts`
- Modify: `packages/web/src/providers/ClaudeSessionOptions.tsx`
- Modify: `packages/web/src/providers/CodexSessionOptions.tsx`
- Modify: `packages/web/src/session/NewSessionWizard.tsx`
- Modify: `packages/web/src/App.tsx`
- Test: `packages/web/src/providers/ClaudeSessionOptions.test.tsx`
- Test: `packages/web/src/providers/CodexSessionOptions.test.tsx`
- Test: `packages/web/src/session/NewSessionWizard.test.tsx`

**Interfaces:**
- Consumes: additive model fields from Task 2.
- Produces:

```ts
export interface SessionModelChoice {
  value: string;
  displayName: string;
  description?: string;
  isDefault?: boolean;
}

export function SessionModelPicker(props: {
  providerLabel: string;
  value: string;
  models: SessionModelChoice[];
  metadataState: "loading" | "ready" | "unavailable";
  onChange(value: string): void;
  onRetry?(): void;
  customValue: string;
  onCustomValueChange(value: string): void;
}): JSX.Element;
```

- [ ] **Step 1: Write shared picker tests**

Assert the default option appears first, account models render as options, the selected model's description is the only model help shown, loading and unavailable/retry states are announced, and custom input is absent until Advanced/Custom is selected. Assert a custom model keeps the bounded input attributes and never silently replaces a known selection.

- [ ] **Step 2: Run picker tests and verify RED**

Run:

```bash
pnpm vitest run packages/web/src/providers/SessionModelPicker.test.tsx
```

Expected: FAIL because the component does not exist.

- [ ] **Step 3: Implement the picker and selected-value copy table**

Implement friendly effort labels/copy for known values and a safe fallback:

```ts
export const effortCopy: Record<string, { label: string; help: string }> = {
  minimal: { label: "Minimal", help: "Fastest response with the lightest reasoning." },
  low: { label: "Low", help: "Fast response for clear, well-scoped work." },
  medium: { label: "Medium", help: "Balanced speed and depth for everyday work." },
  high: { label: "High", help: "Deeper reasoning for difficult, multi-step work." },
  xhigh: { label: "Extra high", help: "Very deep reasoning for the hardest standard tasks." },
  max: { label: "Max", help: "Maximum supported reasoning; expect the longest response time." },
};

export function copyForEffort(value: string, providerDescription?: string) {
  return effortCopy[value] ?? {
    label: value,
    help: providerDescription || "Provider-advertised reasoning level.",
  };
}
```

Add equally explicit maps for Codex sandbox/approval and Claude permission values using the approved design wording.

- [ ] **Step 4: Write provider option behavior tests**

For Claude and Codex, assert:

- effort options match the selected model;
- selecting the catalog default model works when model value is blank;
- changing model resets an incompatible effort to the advertised default and announces it;
- an unknown advertised effort token renders with provider copy;
- sandbox, approval, permission, and effort helper text changes with the current value;
- Advanced starts collapsed, contains profile/web/additional directories/custom model/danger control, and opens automatically if danger is already enabled;
- no catalog produces provider-default plus retry, not a primary free-text box.
- an `INVALID_PROVIDER_OPTIONS` response after a catalog changed keeps the draft, refreshes metadata, and explains that the model/effort choice must be reviewed.

- [ ] **Step 5: Run provider option tests and verify RED**

Run:

```bash
pnpm vitest run packages/web/src/providers/ClaudeSessionOptions.test.tsx packages/web/src/providers/CodexSessionOptions.test.tsx
```

Expected: FAIL on the current datalist/static-effort UI and missing contextual copy.

- [ ] **Step 6: Implement dynamic provider controls and progressive disclosure**

Extend `ModelInfo` with `supportedEffortLevels?: string[]` and `isDefault?: boolean`; extend `CodexModel` with the additive reasoning option objects. Replace the Codex datalist and Claude fallback text input in the primary flow with `SessionModelPicker`. Resolve effort options from the selected model or catalog default. Keep sandbox/approval visible; wrap profile, web search, additional directories, custom model, and dangerous bypass inside one `<details className="rc-wizard__advanced">` per provider.

- [ ] **Step 7: Keep retry and wizard loading coherent**

Update `App` so provider retry reloads Claude models, Codex models, profiles, and summaries together. Pass provider-specific metadata state into the option components. Keep `provider` initial state `undefined` in `NewSessionWizard` and add a regression assertion that reopening never preselects the prior provider.

When session creation returns `INVALID_PROVIDER_OPTIONS` for a selected model/effort, preserve the wizard draft, trigger the same provider metadata reload, and show compatibility copy instead of closing the wizard.

- [ ] **Step 8: Verify mobile scroll containment**

Add a wizard test that expands Advanced in a constrained viewport and asserts the dialog card stays `overflow: hidden`, `.rc-wizard__body` remains the `overflow-y: auto` scroll container, and wheel/touch scroll does not target the page beneath the modal.

- [ ] **Step 9: Run web tests and verify GREEN**

Run:

```bash
pnpm vitest run packages/web/src/providers packages/web/src/session/NewSessionWizard.test.tsx
```

Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add packages/web/src/providers packages/web/src/types/server.ts packages/web/src/session/NewSessionWizard.tsx packages/web/src/session/NewSessionWizard.test.tsx packages/web/src/App.tsx
git commit -m "feat(web): add provider-aware session pickers"
```
