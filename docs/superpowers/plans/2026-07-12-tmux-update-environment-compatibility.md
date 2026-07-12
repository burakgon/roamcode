# tmux update-environment Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make tmux update-environment normalization work on tmux 3.4 without losing unrelated names or exposing secret values.

**Architecture:** Read the existing global array through `show-options -gv`, normalize exact RoamCode names in Node, and write the resulting names through the existing pre-session tmux command chain without format expansion. Use an injectable reader to make the tmux 3.4 behavior deterministic in unit tests while retaining the real-tmux integration test.

**Tech Stack:** TypeScript, Node.js `child_process`, tmux, Vitest, pnpm.

## Global Constraints

- Preserve unrelated `update-environment` entries and their order.
- Emit `RC_BASE_URL`, `RC_SESSION_ID`, `RC_TOKEN`, and `RC_TOKEN_FILE` exactly once.
- Never place any environment variable value in tmux argv.
- Do not require a tmux upgrade; GitHub Actions tmux 3.4 must be supported.
- Keep the change confined to terminal-process behavior and its tests.

---

### Task 1: Add deterministic tmux 3.4 regression coverage

**Files:**
- Modify: `packages/server/test/terminal-process.test.ts`

**Interfaces:**
- Consumes: `TerminalProcess` and its PTY spawn argument contract.
- Produces: A failing behavioral test for a `readTmuxUpdateEnvironment` dependency returning variable names.

- [ ] **Step 1: Extend the existing environment-refresh test**

Inject a reader returning `DISPLAY`, duplicated required names, `OTHER_RC_TOKEN_X`, and
`SSH_AUTH_SOCK`. Assert that the final `update-environment` value is exactly:

```ts
[
  "DISPLAY",
  "OTHER_RC_TOKEN_X",
  "SSH_AUTH_SOCK",
  "RC_BASE_URL",
  "RC_SESSION_ID",
  "RC_TOKEN",
  "RC_TOKEN_FILE",
]
```

Also assert that the command uses `set-option -g`, does not use `-F`, and does not contain secret canary
values.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
pnpm test packages/server/test/terminal-process.test.ts
```

Expected: the environment-refresh assertion fails because the current command still contains `-Fg` and a
`#{update-environment}` format expression.

### Task 2: Implement version-independent normalization

**Files:**
- Modify: `packages/server/src/terminal-process.ts`
- Modify: `packages/server/test/terminal-process.test.ts`

**Interfaces:**
- Consumes: `readTmuxUpdateEnvironment?: () => readonly string[] | undefined` on
  `TerminalProcessOptions`.
- Produces: A name-only, normalized `update-environment` value in the tmux command chain.

- [ ] **Step 1: Add constants and pure normalization**

Define the four required RoamCode names and tmux's default update list. Normalize by filtering exact required
names from the current list and appending the required names once.

- [ ] **Step 2: Add the default tmux reader**

Use `spawnSync` with:

```ts
["-L", tmuxSocket, "show-options", "-gv", "update-environment"]
```

Return trimmed non-empty stdout lines on success and `undefined` on failure. Do not invoke a shell and do not
read any environment values.

- [ ] **Step 3: Emit a literal name list in the command chain**

Replace `set-option -Fg` plus the nested format with `set-option -g` plus the normalized, space-separated
name list. Keep the command before the session create/attach command.

- [ ] **Step 4: Add fallback coverage**

Inject a reader returning `undefined` and assert that the emitted list contains tmux's default names followed
by each required RoamCode name once.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run:

```bash
pnpm test packages/server/test/terminal-process.test.ts packages/server/test/terminal-real-tmux.integration.test.ts
```

Expected: 2 files pass with all tests green.

### Task 3: Verify and release the CI fix

**Files:**
- Verify: `.github/workflows/ci.yml`
- Verify: all repository packages

**Interfaces:**
- Consumes: the completed terminal-process change.
- Produces: a verified commit on `main` and a successful GitHub Actions CI run.

- [ ] **Step 1: Run repository verification**

```bash
pnpm test
pnpm typecheck
pnpm lint
pnpm format:check
pnpm build
git diff --check origin/main...HEAD
```

Expected: every command exits zero.

- [ ] **Step 2: Commit the focused fix**

```bash
git add packages/server/src/terminal-process.ts packages/server/test/terminal-process.test.ts docs/superpowers
git commit -m "fix: support tmux 3.4 environment refresh"
```

- [ ] **Step 3: Push normally to main**

Fetch `origin/main`, verify the branch is a direct descendant, push without force, then verify the remote SHA
matches the local release commit.

- [ ] **Step 4: Verify GitHub Actions**

Watch the new CI run to completion with `gh run watch --exit-status`. If it fails, inspect the exact failing
job and logs before making any further change.

