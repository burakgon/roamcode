# First-Class Codex Provider Integration Design

**Date:** 2026-07-11
**Status:** Approved design, pending implementation plan
**Product:** RoamCode
**Scope:** First-class OpenAI Codex CLI support alongside the existing Claude Code CLI

## Summary

RoamCode will support both Claude Code and Codex as first-class providers while continuing to stream each provider's real terminal UI through the existing tmux, PTY, WebSocket, and PWA stack. A user must explicitly choose **Claude Code** or **Codex** for every new session. RoamCode will not remember or infer the provider choice.

The server will introduce a provider boundary rather than spreading `provider === "codex"` branches through Claude-specific code. Shared session infrastructure will own terminal lifecycle, persistence, transport, files, push delivery, limits, and reconnection. `ClaudeProvider` and `CodexProvider` will own provider-native validation, launch/resume commands, metadata, authentication, usage, version probing, MCP wiring, and activity signals.

Codex support includes:

- the real interactive Codex TUI;
- provider-native model, reasoning, sandbox, approval, profile, web-search, additional-directory, and dangerous-bypass options;
- device-code ChatGPT authentication from the RoamCode PWA;
- Codex account, model catalog, and rate-limit metadata;
- exact Codex conversation identity and resume;
- RoamCode MCP file/image delivery;
- provider-aware working, needs-you, idle, and ended states;
- diagnostics, preflight, version reporting, documentation, and regression coverage equivalent to Claude's supported product surfaces.

Ollama and LM Studio through `codex --oss` are explicitly deferred.

## User Decisions

1. The new-session flow asks whether to start Claude or Codex.
2. Provider selection is required for every session and is never remembered.
3. Codex authentication is manageable from the PWA; SSH or a host terminal is not required.
4. Codex exposes Codex-native controls rather than translating Claude permission concepts into misleading approximations.
5. Claude's existing behavior remains supported and backward compatible.
6. OSS/local Codex providers are outside this delivery and may be added later through the provider boundary.

## Goals

- Make Claude and Codex equal first-class choices in every user-facing session flow.
- Preserve the defining product behavior: the browser displays the provider's real TUI rather than a reimplemented chat protocol.
- Keep provider-specific CLI behavior isolated, typed, testable, and replaceable.
- Preserve existing Claude sessions, settings, authentication, usage, notifications, and attachments across the migration.
- Use official Codex CLI and app-server surfaces where available, with runtime capability checks and explicit degradation when auxiliary metadata is unavailable.
- Never guess a provider, resume identity, security mode, or unsupported flag.
- Keep secrets out of argv, logs, API payloads, persisted session launch data, and browser storage.

## Non-Goals

- Ollama, LM Studio, or other `codex --oss` providers.
- Codex Cloud task orchestration or ChatGPT web tasks.
- Reimplementing either provider's transcript, permission UI, tool UI, or composer.
- Migrating an existing Claude conversation into Codex or vice versa.
- Accepting or storing an OpenAI API key in RoamCode. Existing Codex CLI authentication methods are recognized, but the PWA only initiates ChatGPT device-code login.
- Changing RoamCode's remote-access trust boundary or adding an agent sandbox around the host process.
- Unrelated refactors outside the provider integration and the Claude defects directly exposed by that work.

## Current-State Findings

The existing implementation is intentionally terminal-first but provider-specific:

- `TerminalManager` stores `claudeArgs`, derives metadata from Claude flags, and always launches `claudeBin`.
- `TerminalProcess` is conceptually generic but its public options and environment handling are named for Claude.
- Claude MCP and hook settings are generated as Claude JSON files and appended with `--mcp-config` and `--settings`.
- `pane-status.ts` recognizes English Claude TUI markers.
- create-session validation accepts Claude models, efforts, permission modes, and dangerous skip only.
- the session schema has no provider discriminator.
- auth, usage, latest-version, diagnostics, preflight, settings copy, onboarding, help, security documentation, and marketing copy are Claude-specific.
- the web client already asks the server for models, but no server `GET /models` route currently provides the intended catalog.
- `addDirs` is present in the web request type and wizard but is not applied by the server create route.
- `permissionMode` exists in client session types but is not consistently persisted and returned by the server.

The provider refactor will correct the last three gaps because they directly affect accurate provider-native session creation and display.

## Architecture

### Component Map

```text
React PWA
  ├─ required provider choice
  ├─ provider-native session settings
  ├─ provider-scoped auth / models / usage / version
  └─ shared terminal, files, sessions, push, update UI
            │
Provider-aware REST contract + existing terminal WebSocket
            │
Shared TerminalManager / TerminalProcess / SessionStore
            │
ProviderRegistry
  ├─ ClaudeProvider
  └─ CodexProvider
       └─ CodexAppServerClient (metadata/auth only; never replaces the TUI)
```

### Provider Contract

The server adds a focused provider package, expected under `packages/server/src/providers/`:

```ts
export type ProviderId = "claude" | "codex";

export interface ProcessSpec {
  executable: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  integration: {
    attachments: "ready" | "degraded";
    activity: "ready" | "degraded";
    detail?: string;
  };
}

export interface ProviderSessionContext {
  roamSessionId: string;
  cwd: string;
  options: ProviderSessionOptions;
  providerSessionId?: string;
}

export interface AgentProvider {
  readonly id: ProviderId;
  readonly displayName: string;
  probe(): Promise<ProviderAvailability>;
  validateOptions(input: unknown): ProviderSessionOptions;
  buildFreshProcess(context: ProviderSessionContext): Promise<ProcessSpec>;
  buildResumeProcess(context: ProviderSessionContext): Promise<ProcessSpec>;
  parseRuntimeSignal(input: ProviderRuntimeInput): ProviderRuntimeSignal[];
  cleanup(roamSessionId: string): void;
}
```

Authentication, model catalogs, usage, and version metadata are exposed through optional typed capability services owned by a provider. Terminal launch never depends on another provider's capability service.

### Provider Registry

`ProviderRegistry` is the only lookup from `ProviderId` to an implementation. The transport rejects an unknown provider before a session row or tmux process is created. The registry is injected in tests so provider behavior can be verified without live CLIs.

### Shared Runtime Refactor

`TerminalManager` and `TerminalProcess` become provider-neutral:

- `claudeBin` becomes a process spec's `executable`.
- `claudeArgs` becomes a typed, persisted provider option document plus a generated runtime `ProcessSpec`.
- resume delegates to the owning provider rather than appending `--continue` globally.
- per-provider temporary artifacts are created and cleaned through the provider.
- session activity accepts structured runtime signals and a provider-specific pane fallback.
- tmux naming, PTY framing, WebSocket tickets, resizing, scrollback, upload/download, attachment replay, idle reaping, push dispatch, and exit behavior stay shared.

The tmux session name remains `rc-<roam-session-id>`. This preserves live Claude sessions across an OTA restart and avoids changing the existing dedicated tmux socket.

## Session Options

The REST body is a discriminated union. `provider` is required.

```ts
type CreateSessionBody =
  | {
      provider: "claude";
      cwd: string;
      options: {
        model?: string;
        effort?: "low" | "medium" | "high" | "xhigh" | "max";
        permissionMode?: "default" | "acceptEdits" | "plan" | "bypassPermissions";
        dangerouslySkip?: boolean;
        addDirs?: string[];
      };
    }
  | {
      provider: "codex";
      cwd: string;
      options: {
        model?: string;
        reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh";
        sandbox?: "read-only" | "workspace-write" | "danger-full-access";
        approvalPolicy?: "untrusted" | "on-request" | "never";
        profile?: string;
        webSearch?: boolean;
        dangerouslyBypassApprovalsAndSandbox?: boolean;
        addDirs?: string[];
      };
    };
```

Rules:

- The server validates every field, even if the PWA already constrained it.
- Model, path, and profile strings are bounded and allow-listed for safe direct argv use.
- Every `cwd` and `addDirs` entry must exist and be a directory.
- Claude dangerous skip and permission mode remain mutually exclusive.
- Codex dangerous bypass suppresses `sandbox` and `approvalPolicy`; the UI shows this as a distinct armed state.
- Codex reasoning options come from the selected model's advertised `supportedReasoningEfforts`. A stale or incompatible combination is rejected rather than silently changed.
- Explicit UI values override a selected Codex profile for that invocation, matching Codex CLI precedence.
- Missing `provider` returns an actionable client-upgrade error. The server does not silently create Claude sessions for stale clients.

## Persistence and Migration

### Stored Data

The existing `sessions` table remains the durable Claude table so an older RoamCode build can still read and operate Claude sessions after a rollback. A new `provider_sessions` table stores Codex sessions and contains:

- `id`, `cwd`, status, timestamps, and display name;
- `provider`, constrained to `codex` in this delivery;
- `provider_session_id`, the exact resumable Codex conversation id when known;
- `launch_options_json`, the validated Codex option document, containing no secrets;
- `integration_status_json`, last known attachment/activity degradation, containing no secrets.

The new `SessionStore` presents a single `StoredSession` union over both tables. Claude continues to use its bounded legacy `spawn_args` representation, parsed into typed Claude options at the provider boundary. Codex runtime argv is always regenerated from typed options.

### Migration Rules

1. The migration only creates the new `provider_sessions` table and indexes; it is additive and idempotent.
2. Existing `sessions` rows and their `mode = "terminal"` values are not rewritten. The new store and API interpret every row from that legacy table as `provider = "claude"`.
3. Existing Claude `spawn_args` are parsed into typed Claude options on read. Unrecognized legacy flags are preserved in a bounded `legacyArgs` field for existing sessions only; new API requests cannot submit arbitrary args.
4. New Claude sessions continue writing the existing `sessions` table and remain readable by the previous build.
5. New Codex sessions write only `provider_sessions`. An older build does not query or prune that table, so rollback cannot delete a Codex row or launch it as Claude.
6. The new store merges both tables by creation/activity time and routes mutations back to the owning table.
7. An unknown provider or corrupt Codex option document is retained for diagnostics but never spawned.

### Session API Shape

`SessionMeta` always includes `provider` on a new server. The new client treats a missing provider from an older server as `claude` for display only. It never uses that fallback when creating a session.

Provider-specific runtime metadata is namespaced:

```ts
interface SessionMeta {
  id: string;
  provider: ProviderId;
  providerLabel: string;
  cwd: string;
  mode: "terminal";
  status: "running" | "ended";
  activity: "working" | "blocked" | "idle";
  model?: string;
  reasoning?: string;
  safety: {
    label: string;
    dangerous: boolean;
  };
  integration?: {
    attachments: "ready" | "degraded";
    activity: "ready" | "degraded";
    detail?: string;
  };
}
```

## Claude Provider

`ClaudeProvider` preserves existing behavior while moving it behind the provider contract:

- executable from `CLAUDE_BIN`, default `claude`;
- current model, effort, permission-mode, dangerous-skip, and additional-directory flags;
- current per-session MCP config and Stop/UserPromptSubmit settings files;
- current Claude auth flow and usage parser;
- current installed/latest version services;
- current pane classifier and version warning;
- fresh start with `claude`, resume with Claude's native continuation behavior;
- `ANTHROPIC_API_KEY` stripping remains unchanged so managed Claude sessions use subscription authentication.

The refactor adds consistent persistence and response fields for Claude `permissionMode` and applies validated Claude `addDirs` flags, closing the current gaps without changing defaults.

## Codex Provider

### CLI Launch

`CodexProvider` launches the configured `CODEX_BIN`, default `codex`, inside the same tmux/PTY runtime. Dedicated flags are preferred:

- `--model <model>`;
- `--profile <profile>`;
- `--sandbox <mode>`;
- `--ask-for-approval <policy>`;
- `--search`;
- repeated `--add-dir <path>`;
- `--dangerously-bypass-approvals-and-sandbox` only when explicitly armed.

Reasoning effort is passed through a one-run config override because Codex exposes it as configuration:

```text
-c model_reasoning_effort="<validated-value>"
```

RoamCode does not pass `--oss`, `--local-provider`, `--remote`, or non-interactive `exec` options in this scope. It does not force `--no-alt-screen`, because the product intentionally streams the real fullscreen TUI.

### Codex Conversation Identity and Resume

RoamCode must persist the exact Codex session/thread id and must never use an ambiguous global `--last` resume.

The Codex launch coordinator:

1. snapshots the visible Codex thread inventory through the app-server protocol;
2. serializes the short identity-discovery window for RoamCode-managed Codex launches;
3. starts the TUI;
4. observes the newly created CLI thread matching the exact cwd and launch time;
5. persists the exact thread id immediately;
6. cross-checks the id against a later app-server thread inventory read before enabling resume.

If zero or multiple candidates remain, the terminal may stay attached, but `Resume conversation` remains disabled and the session shows an identity diagnostic. RoamCode never guesses. A resolved ended session resumes with:

```text
codex resume <exact-session-id> [the same validated overrides]
```

`--last` is forbidden in provider code and covered by a regression test.

### Codex Metadata Client

`CodexAppServerClient` is a narrow JSON-RPC client over `codex app-server --stdio`. It is auxiliary; it does not render or proxy the conversation. It supports only the methods RoamCode needs:

- initialization and capability detection;
- `account/read`;
- `account/login/start` with `chatgptDeviceCode`;
- `account/login/cancel` and login-completed notification handling;
- `model/list` with pagination;
- `account/rateLimits/read`;
- thread inventory reads needed for exact identity.

The app-server command is currently marked experimental by the Codex CLI. Therefore:

- responses are runtime-validated with narrow Zod schemas;
- request ids, timeouts, stderr bounds, subprocess exit, malformed frames, and unknown fields are tested;
- protocol failure is contained to Codex metadata and reported explicitly;
- the metadata client is restartable and TTL-cached;
- the live Codex TUI does not depend on a long-lived metadata client after exact identity has been captured;
- no generated full protocol binding is committed.

There is no hard-coded Codex version floor. Preflight checks both `--version` and required app-server capabilities. The provider can report `terminalAvailable: true` and `metadataAvailable: false` separately.

### Authentication

Codex authentication status comes from `account/read` and recognizes existing ChatGPT or API-key authentication. RoamCode never reads or returns raw credentials.

The PWA login flow is:

1. request `chatgptDeviceCode` login;
2. show the verification URL and one-time user code;
3. offer open-link and copy-code actions;
4. poll/listen for the login-completed notification;
5. refresh account status and model/rate-limit data;
6. allow cancellation and expire abandoned flows.

The PWA does not accept an API key. A user already authenticated by API key can use Codex, and the account card labels the method accurately.

### Models and Reasoning

The model picker uses the paginated Codex model catalog. It displays `displayName`, description, default status, and supported reasoning efforts. Hidden models are excluded from the normal picker. A bounded custom model escape hatch remains available for forward compatibility, but the server still validates the token shape.

Selecting a model recalculates valid reasoning values. If the previous reasoning value is unsupported, the UI returns to the model's advertised default and tells the user; the server independently rejects stale invalid combinations.

A selected profile is capability-checked with the same cwd before launch. Profiles whose effective model provider is Ollama, LM Studio, or another non-OpenAI provider are rejected in this scope with an explicit `OSS_PROVIDER_DEFERRED` error. The profile file is never copied or exposed to the browser.

### Usage and Rate Limits

Codex `account/rateLimits/read` is normalized into the shared usage presentation without relabeling Codex limits as Claude limits. Primary and secondary windows preserve their backend-provided reset timestamps and used percentages. Multiple rate-limit buckets are provider-labeled. Credits are shown only when the protocol provides a displayable balance/status.

Failure returns `usage: null` plus a provider diagnostic; it does not break session creation.

### MCP Attachments

Codex receives the existing RoamCode stdio MCP server through one-run `-c` overrides:

- `mcp_servers.roamcode.command` points to the current Node executable;
- `mcp_servers.roamcode.args` contains the built `mcp-send.js` path;
- `mcp_servers.roamcode.env_vars` allow-lists `RC_BASE_URL`, `RC_SESSION_ID`, and `RC_TOKEN` from the Codex process environment;
- the per-session process environment carries those values.

The access token never appears in Codex argv or a browser-visible payload. Existing user MCP servers are not replaced. If the MCP override cannot initialize, the session starts only if the failure can be surfaced as `attachments: degraded`; the UI and diagnostics must not claim attachment support.

### Activity and Notifications

Codex activity uses a layered signal strategy:

1. user terminal input optimistically enters `working`;
2. Codex TUI terminal notifications are enabled for `agent-turn-complete` and `approval-requested`, emitted as OSC 9 for the managed TUI, and parsed from PTY output;
3. `approval-requested` enters `blocked` and may trigger needs-you push when detached;
4. `agent-turn-complete` enters `idle` and may trigger completion push when detached;
5. a Codex-specific captured-pane classifier provides a tested fallback when terminal notifications are unavailable;
6. process exit enters `ended` and clears `awaiting`.

This design does not install project hooks, bypass Codex hook trust, or overwrite the user's external `notify` command. User Codex hooks, profiles, MCP servers, and notification commands continue to load normally.

## Provider-Aware API

New routes:

- `GET /providers` — availability and capability summary for Claude and Codex;
- `GET /providers/:provider/auth/status`;
- `POST /providers/:provider/auth/login/start`;
- `POST /providers/:provider/auth/login/cancel`;
- `GET /providers/:provider/models`;
- `GET /providers/:provider/usage`;
- `GET /providers/:provider/version`.

`POST /sessions` requires the discriminated provider body. `GET /sessions` includes provider and integration metadata.

For one compatibility window, existing Claude-only routes remain aliases:

- `/auth/*` delegates to Claude auth;
- `/usage` delegates to Claude usage;
- `/claude/version` delegates to Claude version.

Aliases are documented as deprecated internally but are not removed in this change, preventing an OTA server/client skew from breaking the current PWA while the new bundle activates.

All new routes remain behind the existing token, origin, rate-limit, and default-deny gates.

## PWA Design

### New-Session Wizard

The flow is:

1. choose or prefill the working directory;
2. choose Claude Code or Codex from two provider cards;
3. configure only the selected provider's native options;
4. review dangerous state, if any;
5. start.

No provider card is preselected, including after closing/reopening the wizard or creating a previous session. The continue/start action is disabled until a provider is selected.

Provider cards show:

- installed/available state;
- sign-in state where known;
- an actionable install or sign-in hint;
- metadata-degraded state without pretending the CLI itself is unavailable.

Claude keeps its current controls. Codex shows:

- model;
- reasoning effort constrained by model;
- sandbox;
- approval policy;
- optional profile;
- web search;
- additional writable directories;
- dangerous bypass with a separate two-step confirmation.

### Session List and Header

Every session row and terminal header shows a compact Claude or Codex label. Provider is never inferred from model text. The header shows the provider-relevant model/reasoning and safety label. Dangerous sessions retain a loud warning after reload and rehydrate.

Push and foreground needs-you messages include the provider and session label. Ended-session actions call provider-native fresh/resume behavior without asking the user to choose the provider again.

### Settings and Authentication

Global settings contains separate Claude and Codex account cards. Each card owns its account status, login action, usage, installed/latest version, and error/degraded state.

The Codex dialog shows the verification link and copyable device code and completes automatically after browser authorization. Claude keeps its current paste-code flow.

Provider-specific session settings are read-only after spawn, matching the actual CLI process. “New session in this folder” returns to the wizard with the cwd only; provider is intentionally not copied or remembered.

### Copy and Accessibility

- Generic product copy says “coding agent” or “Claude Code or Codex” where both are meant.
- Provider-specific error and auth copy names the provider.
- Provider selection uses real radio semantics and keyboard navigation.
- Availability, auth, and dangerous states are not communicated by color alone.
- Dialog focus trapping, escape handling, minimum tap sizes, and reduced-motion behavior follow existing components.

## Configuration, Diagnostics, and Installation

Server configuration adds:

| Variable | Default | Meaning |
| --- | --- | --- |
| `CLAUDE_BIN` | `claude` | Claude Code executable, unchanged |
| `CODEX_BIN` | `codex` | Codex CLI executable |

Service PATH generation must include the locations needed to resolve either CLI. Startup performs non-blocking probes for both. Missing Claude does not disable Codex; missing Codex does not disable Claude. If neither provider is available, startup remains possible for diagnostics but the PWA cannot create sessions.

Codex version reporting always includes the installed value from `codex --version`. A best-effort latest-version lookup uses the official `@openai/codex` release channel only when the detected installation provenance is compatible with that channel. Bundled ChatGPT-app builds and unknown installation methods show their installed version plus an appropriate update hint instead of making a misleading npm comparison.

`GET /diag` gains a `providers` object containing availability, installed version, metadata capability, and last integration error for each provider. It never includes account tokens, login codes, full environment variables, or raw app-server frames.

The CLI help, installation preflight, README, SECURITY document, contributing guidance, PWA manifest/onboarding/help, site copy, environment table, screenshots where applicable, and changelog entry are updated to describe both providers. The security wording continues to state that either agent runs as the host user and `FS_ROOT` does not sandbox it.

## Error Handling

### Fail Closed

The server refuses to create or resume when:

- provider is absent or unknown;
- the selected provider binary is missing;
- cwd/additional directories are invalid;
- a provider option is invalid or mutually inconsistent;
- dangerous state in the request does not match the explicit dangerous flag;
- a Codex resume id is missing or ambiguous;
- persisted provider data is corrupt or from an unknown provider.

Errors use stable machine codes plus actionable messages, for example `PROVIDER_REQUIRED`, `PROVIDER_UNAVAILABLE`, `INVALID_PROVIDER_OPTIONS`, `AUTH_REQUIRED`, and `RESUME_IDENTITY_UNAVAILABLE`.

### Explicit Degradation

The live terminal may remain usable while an auxiliary feature is degraded:

- model catalog unavailable → bounded custom/default model input with warning;
- usage unavailable → hide bars and show provider-scoped status in settings;
- latest version unavailable → show installed only;
- Codex metadata client unavailable after session start → existing terminal remains connected;
- attachment MCP unavailable → show `attachments: degraded` in the session and diagnostics;
- terminal notification parsing unavailable → use pane fallback and label activity confidence as degraded.

No degradation is silent, and no degraded capability is advertised as ready.

### Cleanup and Bounds

- All spawned metadata/auth processes have hard timeouts, bounded stdout/stderr, and kill-on-cancel/expiry.
- Per-session secrets and temporary artifacts are mode 0600 inside the mode 0700 data directory.
- Provider cleanup is idempotent and runs on close, spawn failure, and reaped sessions.
- Metadata caches collapse concurrent requests and retain the last good bounded value where safe.
- Unknown JSON-RPC notifications and fields are ignored after envelope validation; malformed envelopes are logged as redacted diagnostics.

## Testing Strategy

### Unit Tests

- Provider registry lookup and unknown-provider rejection.
- Claude and Codex option schemas, including every allowed value and invalid combination.
- Exact executable/argv/env generation for fresh and resume paths.
- Assertions that secrets never appear in argv, stored options, logs, or API shapes.
- Claude legacy-argv migration into typed options.
- Additive database migration, idempotence, old-row default to Claude, two-table union behavior, and rollback-safe Codex isolation.
- Codex JSON-RPC framing, request correlation, pagination, login notifications, timeouts, malformed frames, restarts, and Zod validation.
- Codex model/reasoning normalization and rate-limit normalization.
- Claude and Codex version parsing/probing.
- Codex OSC notification parser and captured-pane fallback using recorded fixtures.
- Provider integration cleanup and diagnostic shaping.

### Server Integration Tests

Use fake executable fixtures for both `claude` and `codex`; CI never consumes a subscription or API credit.

Cover:

- create/list/delete for each provider;
- simultaneous Claude and Codex sessions, including the same cwd;
- provider-specific options reaching only the correct executable;
- invalid and stale client requests rejected at the transport boundary;
- exact Codex identity capture and `codex resume <id>`;
- explicit proof that `--last` is never used;
- detach/reconnect and server rehydrate;
- existing live Claude tmux session survival;
- MCP send-image/send-file round trips for each provider;
- working/blocked/idle/ended transitions and away push gates;
- missing one provider while the other remains usable;
- metadata client failure with a still-usable Codex terminal;
- auth device-code start, completion, cancellation, expiry, and redaction;
- old Claude compatibility aliases.

### Web Tests

- provider is never preselected or remembered;
- start is disabled until provider selection;
- unavailable and signed-out provider states;
- Claude and Codex controls switch without leaking stale values;
- Codex model changes constrain reasoning effort;
- dangerous confirmation for each provider;
- provider body serialization and server error display;
- provider badges in rail/header/notifications;
- separate account cards and Codex device-code dialog;
- older-server fallback display for sessions missing provider;
- accessibility roles, labels, focus trapping, and keyboard operation.

### Verification Commands

Implementation completion requires fresh successful output from:

```bash
pnpm test
pnpm typecheck
pnpm lint
pnpm format:check
pnpm build
```

Focused real-CLI smoke tests are opt-in and never part of CI. They verify `--version`, Codex app-server initialization/capabilities, model/account reads, and a manually authorized terminal launch without sending a paid prompt.

## Acceptance Criteria

1. A new session cannot start until the user explicitly selects Claude or Codex.
2. Claude sessions behave as before, including auth, usage, version, MCP files, notifications, reconnect, and resume.
3. Codex sessions render the real Codex TUI and support native model, reasoning, sandbox, approval, profile, search, add-dir, and dangerous-bypass options.
4. Claude and Codex can run concurrently in the same directory without identity or resume collisions.
5. An ended Codex session resumes by exact persisted id; RoamCode never uses `--last`.
6. Codex ChatGPT device-code login can be completed from the phone PWA.
7. Codex model and rate-limit data come from Codex's own capability surface and degrade explicitly when unavailable.
8. RoamCode MCP file/image delivery works in Codex without exposing the RoamCode token in argv or persisted metadata.
9. Provider-aware activity and needs-you notifications work while the browser is detached.
10. Existing database rows and live Claude tmux sessions survive the upgrade as Claude sessions; Codex rows remain untouched by an older rollback build.
11. Missing or broken Codex does not impair Claude, and missing or broken Claude does not impair Codex.
12. README, security guidance, diagnostics, CLI help, PWA copy, and site copy consistently describe both providers.
13. Full tests, typecheck, lint, formatting check, and production builds pass with clean output.

## Risks and Mitigations

### Codex app-server protocol maturity

The CLI currently labels app-server experimental. Keep it auxiliary, runtime-validate a narrow method set, probe capabilities, isolate failures, and cover recorded protocol fixtures. The TUI and terminal WebSocket remain independent.

### TUI wording and notification changes

Prefer documented terminal notifications over text scraping, retain a provider-specific pane fallback, store recorded fixtures, and warn when an installed major/minor exceeds the last verified classifier version.

### Resume identity races

Serialize RoamCode's short Codex discovery window, snapshot before spawn, require exact cwd/time/new-id matching, cross-check a later app-server inventory, persist immediately, and reject ambiguity. Never fall back to `--last`.

### OTA client/server skew

Keep Claude compatibility aliases, let the new client display older sessions as Claude, reject provider-less creation with an upgrade error, and rely on the existing stale-client refresh path.

### Security-mode confusion

Persist normalized provider-native safety state, display it on every relevant surface, validate again on the server, and keep dangerous bypass separate from ordinary sandbox/approval choices.

## Official Codex References

- [Codex CLI command reference](https://developers.openai.com/codex/cli/reference)
- [Codex authentication](https://developers.openai.com/codex/auth)
- [Codex configuration reference](https://developers.openai.com/codex/config-reference)
- [Codex advanced configuration and notifications](https://developers.openai.com/codex/config-advanced)
- [Codex MCP configuration](https://developers.openai.com/codex/mcp)
- [Codex hooks](https://developers.openai.com/codex/hooks)
- [Codex app-server integration](https://developers.openai.com/codex/app-server)

## Implementation Sequence

The implementation plan will decompose this design into independently testable TDD tasks in this order:

1. provider types, registry, option schemas, and database migration;
2. provider-neutral terminal runtime and Claude adapter migration;
3. Codex process builder, exact identity, activity signals, and MCP wiring;
4. Codex app-server metadata/auth client;
5. provider-aware transport and compatibility aliases;
6. PWA types, API client, required provider selection, and provider-native settings;
7. provider-aware session/settings/notification UI;
8. diagnostics, preflight, docs, screenshots, and full verification.
