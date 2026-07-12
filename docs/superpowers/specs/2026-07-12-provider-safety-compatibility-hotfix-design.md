# Provider Safety and Compatibility Hotfix Design

**Date:** 2026-07-12
**Status:** Approved

## Goal

Close three release-blocking gaps in the first-class provider integration without changing the product rule that
the current new-session UI asks the user to choose Claude Code or Codex every time.

## 1. Keep the RoamCode token out of the Codex process environment

The Codex adapter currently places the bearer token in `RC_TOKEN` on the main Codex process. Codex normally
filters token-like variables from model-generated shell subprocesses, but that policy is user-configurable and
must not be RoamCode's secret boundary.

RoamCode will instead write the bearer token to a per-session regular file under the mode-0700 data directory:

- the file is registered for cleanup before it is written;
- it is created with mode 0600 and bounded, newline-free contents;
- Codex receives only `RC_TOKEN_FILE`, `RC_BASE_URL`, and `RC_SESSION_ID`;
- `mcp_servers.roamcode.env_vars` forwards those names to the MCP subprocess;
- the main Codex environment explicitly deletes `RC_TOKEN`, including a same-named inherited host variable;
- `mcp-send` keeps direct `RC_TOKEN` support for Claude compatibility and otherwise reads `RC_TOKEN_FILE` using
  a fail-closed regular-file, owner, mode, and size check;
- raw paths, token contents, and filesystem errors are never returned to the model or diagnostics;
- all natural exit, stop, build failure, cancellation, and stale-build paths use the existing provider artifact
  cleanup lifecycle.

This matches the existing Claude boundary: the provider root process does not receive the bearer token, while a
mode-0600 provider-owned artifact supplies the attachment subprocess.

## 2. Preserve legacy session creation compatibility

`POST /sessions` will interpret an omitted `provider` as `claude` at the server compatibility boundary. An
explicit invalid provider remains a 400, and an explicit unavailable provider remains a provider-scoped 503.
Legacy flat Claude fields continue to be normalized exactly as before.

The current PWA behavior does not change: every newly opened wizard starts without a provider and requires an
explicit Claude Code or Codex choice. The fallback exists only for cached older clients and external automation
that predates the provider field. Server responses and stored rows always expose the resolved provider.

## 3. Make resume controls reflect exact Codex identity

The ended overlay will derive provider-native presentation from `SessionMeta`.

- Claude and legacy sessions retain an enabled **Resume conversation** action.
- Codex enables resume only when `identityState === "exact"` and a bounded `providerSessionId` is present.
- For pending, ambiguous, or missing Codex identity, the resume button remains visible but disabled and an
  explanatory message directs the user to **Start fresh**.
- The ended title, quick-exit authentication hint, and helper copy use the actual provider rather than hard-coded
  Claude wording.
- The server remains the final enforcement boundary and continues rejecting unsafe resume attempts.

## Testing and release

Each behavior begins with a focused failing regression test:

1. Codex provider and real-tmux tests prove the token value is absent from Codex env/argv while the MCP tool can
   still deliver an attachment through the 0600 token file, and every cleanup path removes it.
2. Transport tests prove omitted provider creates a Claude session while the web wizard tests continue to prove
   a fresh explicit choice is mandatory.
3. TerminalView tests cover exact, ambiguous, pending, legacy, and provider-specific ended copy.

After focused tests, run the complete root test, typecheck, lint, format, and build sequence. An independent
review must approve the diff before a single `burakgon`-authored hotfix commit is pushed to `main`.

## Deferred hardening

A least-privilege, session-scoped attachment capability token would further reduce impact if a local same-user
process reads the 0600 artifact. That requires a versioned auth/rotation/rehydration contract and is deliberately
separate from this compatibility hotfix.
