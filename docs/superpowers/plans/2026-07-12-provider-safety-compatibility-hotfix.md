# Provider Safety and Compatibility Hotfix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the RoamCode bearer token from the main Codex environment, restore omitted-provider compatibility, and make ended-session controls reflect exact provider identity.

**Architecture:** A shared provider-artifact helper owns mode-0600 session files and cleanup. Codex forwards only a token-file path to its MCP subprocess; the server keeps legacy API fallback at the transport boundary; TerminalView derives resume availability and copy from `SessionMeta` while the server remains the final enforcement boundary.

**Tech Stack:** TypeScript, Node.js filesystem APIs, Fastify, React, Vitest, tmux/node-pty integration tests.

## Global Constraints

- The current new-session PWA must still ask Claude Code or Codex for every wizard instance.
- The bearer token must not enter Codex argv, the main Codex environment, persistence, logs, diagnostics, or terminal transcript.
- Provider artifact paths must be registered before writes, mode 0600, bounded, and removed on every existing manager cleanup path.
- Claude's current attachment and hook behavior must remain byte-compatible.
- Codex resume remains exact-ID-only; the UI may not weaken server enforcement.
- Each production change starts with a focused failing test.

---

### Task 1: File-backed Codex MCP token

**Files:**
- Create: `packages/server/src/providers/provider-artifacts.ts`
- Create: `packages/server/test/providers/provider-artifacts.test.ts`
- Modify: `packages/server/src/providers/claude-provider.ts`
- Modify: `packages/server/src/providers/codex-provider.ts`
- Modify: `packages/server/src/config.ts`
- Modify: `packages/server/src/mcp-send.ts`
- Modify: `packages/server/test/providers/claude-provider.test.ts`
- Modify: `packages/server/test/providers/codex-provider.test.ts`
- Modify: `packages/server/test/mcp-send.test.ts`
- Modify: `packages/server/test/terminal-providers.integration.test.ts`
- Modify: `packages/server/test/fixtures/fake-codex.mjs`

**Interfaces:**
- Produces `writeProviderArtifact0600(path, content, context, ownedPaths)` and `cleanupProviderArtifacts(paths)`.
- Produces `codexMcpTokenPathFor(dataDir, sessionId)`.
- Extends `McpEnv` with `RC_TOKEN_FILE?: string`; direct `RC_TOKEN` remains supported for Claude.

- [ ] **Step 1: Write failing provider and MCP tests**

```ts
expect(spec.env.RC_TOKEN).toBeUndefined();
expect(spec.env.RC_TOKEN_FILE).toBe(tokenPath);
expect(readFileSync(tokenPath, "utf8")).toBe("attachment-token");
expect(statSync(tokenPath).mode & 0o777).toBe(0o600);
expect(spec.args).toContain('mcp_servers.roamcode.env_vars=["RC_BASE_URL","RC_SESSION_ID","RC_TOKEN_FILE"]');
```

Add MCP tests proving a secure regular token file supplies the Authorization header, while a symlink,
group/world-readable file, empty file, control-bearing content, or file larger than 4096 bytes fails with the
existing generic “not configured” result and never reveals the path/error.

- [ ] **Step 2: Run the tests and confirm RED**

Run:

```bash
pnpm vitest run packages/server/test/providers/provider-artifacts.test.ts packages/server/test/providers/claude-provider.test.ts packages/server/test/providers/codex-provider.test.ts packages/server/test/mcp-send.test.ts
```

Expected: FAIL because the helper, token path, and `RC_TOKEN_FILE` behavior do not exist and Codex still exposes `RC_TOKEN`.

- [ ] **Step 3: Implement the shared artifact boundary**

```ts
export function writeProviderArtifact0600(
  path: string,
  content: string,
  context: ProviderProcessContext,
  ownedPaths: string[],
): boolean {
  try {
    context.registerCleanupPaths?.([path]);
  } catch (error) {
    cleanupProviderArtifacts([path]);
    throw error;
  }
  ownedPaths.push(path);
  try {
    writeFileSync(path, content, { mode: 0o600 });
    chmodSync(path, 0o600);
    return true;
  } catch {
    cleanupProviderArtifacts([path]);
    return false;
  }
}
```

Move Claude's existing helper behavior without changing its generated argv/config bytes. In Codex, write a
bounded token file, delete inherited `RC_TOKEN`/`RC_TOKEN_FILE` first, set only the file path for a configured
attachment, forward `RC_TOKEN_FILE` in `env_vars`, return the artifact in `cleanupPaths`, and use the shared
cleanup function.

- [ ] **Step 4: Implement fail-closed MCP token-file loading**

```ts
function readTokenFile(path: string): string | undefined {
  if (!isAbsolute(path)) return undefined;
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 || info.size < 1 || info.size > 4096)
    return undefined;
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) return undefined;
  const token = readFileSync(path, "utf8");
  return token.length <= 4096 && !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(token) ? token : undefined;
}
```

Resolve direct `RC_TOKEN` first for Claude compatibility, otherwise read `RC_TOKEN_FILE`. Catch every filesystem
error and preserve redacted tool errors.

- [ ] **Step 5: Make focused and integration tests GREEN**

Run:

```bash
pnpm vitest run packages/server/test/providers/provider-artifacts.test.ts packages/server/test/providers/claude-provider.test.ts packages/server/test/providers/codex-provider.test.ts packages/server/test/mcp-send.test.ts packages/server/test/terminal-manager.test.ts packages/server/test/terminal-providers.integration.test.ts
```

Expected: PASS; fake Codex records `hasRcToken:false` and `hasRcTokenFile:true`; attachment roundtrip still passes; cleanup leaves no artifact.

- [ ] **Step 6: Commit**

```bash
git add packages/server/src packages/server/test
git commit -m "fix: isolate provider attachment credentials"
```

---

### Task 2: Legacy omitted-provider compatibility

**Files:**
- Modify: `packages/server/src/transport.ts`
- Modify: `packages/server/test/transport.providers.test.ts`
- Modify: `packages/server/test/transport.rest.test.ts`
- Verify: `packages/web/src/session/NewSessionWizard.test.tsx`

**Interfaces:**
- `POST /sessions` resolves `body.provider ?? "claude"` internally and always persists/returns the resolved provider.
- Explicit provider validation and availability remain unchanged.

- [ ] **Step 1: Replace the breaking-contract test with a failing compatibility regression**

```ts
test("POST /sessions treats an omitted legacy provider as Claude", async () => {
  const response = await app.inject({ method: "POST", url: "/sessions", headers: auth, payload: { cwd } });
  expect(response.statusCode).toBe(201);
  expect(response.json().session.provider).toBe("claude");
});
```

Also cover legacy flat Claude model/effort/permission fields and prove an explicit invalid provider is still 400.

- [ ] **Step 2: Run and confirm RED**

Run:

```bash
pnpm vitest run packages/server/test/transport.providers.test.ts packages/server/test/transport.rest.test.ts
```

Expected: FAIL with `409 PROVIDER_REQUIRED`.

- [ ] **Step 3: Resolve provider once at the transport boundary**

```ts
const provider: ProviderId = body.provider ?? "claude";
if (provider !== "claude" && provider !== "codex") { /* existing 400 */ }
```

Use `provider` for probe, legacy option normalization, validation, manager create, response metadata, and warnings.
Do not change wizard defaults or browser storage.

- [ ] **Step 4: Run server and wizard suites**

Run:

```bash
pnpm vitest run packages/server/test/transport.providers.test.ts packages/server/test/transport.rest.test.ts packages/web/src/session/NewSessionWizard.test.tsx packages/web/src/providers/provider-options.test.tsx
```

Expected: PASS; server compatibility is restored and every fresh wizard still requires a choice.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/transport.ts packages/server/test packages/web/src/session/NewSessionWizard.test.tsx packages/web/src/providers/provider-options.test.tsx
git commit -m "fix: preserve legacy session creation"
```

---

### Task 3: Exact-identity resume and provider-aware ended UI

**Files:**
- Modify: `packages/web/src/chat/TerminalView.tsx`
- Modify: `packages/web/src/chat/TerminalView.test.tsx`

**Interfaces:**
- `canResumeConversation(session: SessionMeta)` is true for Claude/legacy sessions and only exact, bounded Codex identities.
- Server WebSocket enforcement remains unchanged.

- [ ] **Step 1: Write failing UI regressions**

```tsx
const ambiguous = { ...SESSION, provider: "codex", identityState: "ambiguous", providerSessionId: undefined };
render(<TerminalView session={ambiguous} createSocket={h.createSocket} />);
act(() => h.statusCbs[0]!("ended"));
expect(screen.getByRole("button", { name: "Resume conversation" })).toBeDisabled();
expect(screen.getByText(/exact Codex conversation.*unavailable/i)).toBeVisible();
```

Add exact Codex enabled/click behavior; pending Codex disabled; missing-provider legacy Claude enabled; provider-native
ended title and quick-exit auth copy.

- [ ] **Step 2: Run and confirm RED**

Run:

```bash
pnpm vitest run packages/web/src/chat/TerminalView.test.tsx
```

Expected: FAIL because resume is unconditional and ended copy is hard-coded to Claude.

- [ ] **Step 3: Implement the minimal identity-aware presentation**

```ts
const isCodex = session.provider === "codex";
const canResume = !isCodex || (session.identityState === "exact" && Boolean(session.providerSessionId));
const providerLabel = isCodex ? "Codex" : "Claude Code";
```

Keep the resume button visible, set `disabled={!canResume}`, do not call `restart("continue")` while disabled,
and render a provider-specific explanation. Replace hard-coded title, quick-exit hint, comments, and helper copy.

- [ ] **Step 4: Run focused web suites**

Run:

```bash
pnpm vitest run packages/web/src/chat/TerminalView.test.tsx packages/web/src/chat/ChatHeader.test.tsx packages/web/src/App.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/chat/TerminalView.tsx packages/web/src/chat/TerminalView.test.tsx
git commit -m "fix: gate resume on provider identity"
```

---

### Task 4: Release verification and main delivery

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `SECURITY.md`

- [ ] **Step 1: Document the corrected boundary**

Add an Unreleased security/fix note stating that Codex attachment credentials are now file-backed and that
provider-less legacy session creation remains Claude-compatible. Update the security boundary to say the main
Codex process receives a mode-0600 token-file path rather than the bearer token.

- [ ] **Step 2: Audit secrets and compatibility**

Run:

```bash
rg -n 'RC_TOKEN|RC_TOKEN_FILE|PROVIDER_REQUIRED|Resume conversation' packages README.md SECURITY.md
git diff --check origin/main...HEAD
```

Expected: no Codex root env assignment for `RC_TOKEN`; token-file references are bounded; no provider-required break;
resume UI and server enforcement agree.

- [ ] **Step 3: Run fresh full verification**

```bash
pnpm build
pnpm test
pnpm typecheck
pnpm lint
pnpm format:check
pnpm build
```

Expected: all commands exit 0 with no lint warnings.

- [ ] **Step 4: Independent review**

Reviewer checks token lifecycle and local-shell threat model, legacy request behavior, disabled resume accessibility,
provider copy, cleanup races, and the complete diff against `origin/main`.

- [ ] **Step 5: Push one user-authored hotfix commit to main**

After approval, squash the hotfix branch onto fresh `origin/main`, verify again, and push normally (never force).
The commit author/committer is `burakgon`; no Codex contributor trailer is added.
