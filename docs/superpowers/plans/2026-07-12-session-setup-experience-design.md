# Session Setup Experience Design

**Date:** 2026-07-12

**Status:** Approved

## Objective

Make new-session configuration understandable and efficient on every device:

- show provider-available models and model-compatible effort levels as pickers;
- explain the selected value of every setting without crowding the screen;
- persist one authoritative defaults profile per RoamCode server so every connected browser sees the same values;
- preserve the existing rule that every new session explicitly asks for Claude Code or Codex;
- keep tmux-backed terminal session startup independent from auxiliary metadata availability.

## Non-goals

- Do not remember or preselect a provider between sessions.
- Do not replace the Claude or Codex terminal TUI with an app-server/chat integration.
- Do not make model metadata a prerequisite for starting or resuming a session.
- Do not remove bounded custom model support; move it out of the primary path.
- Do not merge sandbox and approval policy into one lossy safety preset.

## Reliability Invariants

1. The tmux/TUI launch path remains the functional source of truth. Metadata services may improve selection but may not disable a provider whose terminal CLI is available.
2. Metadata failures are bounded, cached, redacted, and fail open to provider defaults. No raw protocol payload or credential reaches the browser or logs.
3. Existing provider endpoints remain backward compatible for stale PWA clients. New response properties are additive.
4. Server-stored defaults are authoritative after migration. Browser storage is a cache and one-time migration source only.
5. Provider selection is never persisted in defaults.
6. Dangerous bypass controls retain explicit arming/confirmation and are never silently enabled by normalization.
7. All model, effort, profile, path, and defaults payloads remain length-bounded and server-validated before persistence or launch.

## Architecture

### Provider metadata

Codex continues to use the restricted `CodexMetadataService` catalog call. The catalog already returns model descriptions, default-model identity, supported reasoning efforts, and the default effort for each model. The service remains auxiliary to terminal startup and retains its TTL, pagination limits, schema validation, and graceful-unavailable behavior.

Claude gains a focused `ClaudeMetadataService`. It starts a short-lived, non-session-persisting stream-json Claude process, sends only the initialization control request, extracts the account-visible model catalog from the initialization response, and terminates immediately. It never sends a user prompt and therefore does not start an agent turn. The service:

- uses the configured Claude binary and a sanitized copy of the server environment;
- does not accept arbitrary arguments from the browser;
- applies a short timeout, response-size limit, line/object count limit, and strict model-field validation;
- coalesces concurrent requests and caches successful results with a TTL;
- kills the child and clears timers/listeners on success, failure, timeout, or server shutdown;
- reports only a generic metadata-unavailable result on protocol drift.

`GET /providers/claude/models` returns the validated live models, including `supportedEffortLevels` when advertised. `GET /providers/codex/models` retains its current response. The browser adapts both provider-specific shapes into a shared picker view model rather than forcing an incompatible universal wire format.

If Claude's initialization protocol changes, the catalog call degrades to unavailable while normal tmux sessions continue to launch. The UI offers provider default and retry instead of exposing a blank required field.

### Model and effort selection

The session wizard lazily loads both provider summaries and both model catalogs when it opens. It renders:

- `Provider default` first;
- account-visible models as an accessible select/combobox with selected-model description below it;
- effort options derived from the selected model;
- the advertised default effort marked as recommended/default;
- one concise description for the selected effort.

Selecting `Provider default` resolves effort choices from the catalog's default model when known. Changing to a model that does not support the current effort resets effort to that model's advertised default, otherwise its first supported effort, and announces the reset through a status region.

The browser must not discard newly advertised safe effort tokens merely because an older hard-coded UI list does not know them. Known tokens get friendly labels; unknown but bounded catalog tokens use their provider value and provider description. Server launch validation accepts a bounded effort token only when it was advertised for the selected known model; without usable metadata the UI omits an explicit effort and lets the provider default apply.

Custom model entry is available under the collapsed Advanced section. It uses the existing bounded token rules. A custom model cannot claim catalog compatibility, so effort falls back to provider default unless the user explicitly chooses one of the provider's safe baseline values.

### Progressive disclosure and explanations

The primary flow remains short:

1. directory and optional session name;
2. explicit provider choice;
3. model;
4. effort/reasoning;
5. access and approval controls that materially affect safety;
6. start action.

Each field shows one contextual helper sentence for the currently selected value. Options are not followed by a permanently expanded paragraph list.

Codex sandbox and approval policy stay visible because they are independent security layers:

- `read-only`: inspect and plan without file writes;
- `workspace-write`: read, edit, and run inside the active workspace; this is the recommended balanced sandbox;
- `danger-full-access`: remove workspace isolation; only for an externally trusted environment;
- `untrusted`: ask before commands outside Codex's trusted set;
- `on-request`: let Codex request elevation when needed; this is the recommended interactive policy;
- `never`: never ask, while the selected sandbox still applies.

Claude permission copy remains provider-native:

- `default`: ask before tool use when Claude requires approval;
- `acceptEdits`: accept file edits automatically while retaining other prompts;
- `plan`: inspect and plan before making changes.

The collapsed Advanced section contains profile, web search, additional directories, custom-model entry, and the dangerous bypass control. When bypass is already enabled by saved defaults, the Advanced section opens automatically so the risk is never hidden.

### Server-backed defaults

The existing session SQLite database gains one additive `app_settings` table. `SessionStore` exposes typed methods only for session defaults instead of a generic arbitrary key/value API:

```ts
interface StoredSessionDefaults {
  defaults: SessionDefaults;
  revision: number;
  updatedAt: number;
}

getSessionDefaults(): StoredSessionDefaults | undefined;
putSessionDefaults(defaults: SessionDefaults, expectedRevision: number): StoredSessionDefaults;
```

The SQLite write uses one transaction and compare-and-swap revision checking. The in-memory fallback implements identical semantics but remains non-durable, consistent with the existing store-mode warning.

Authenticated endpoints:

- `GET /settings/session-defaults` returns `{ defaults: null, revision: 0 }` when unset, otherwise the normalized document and current revision.
- `PUT /settings/session-defaults` requires `{ defaults, expectedRevision }`, validates and normalizes the complete document, and returns the stored document with its incremented revision.
- a revision mismatch returns `409 SETTINGS_CONFLICT` with the current normalized document; it never silently overwrites another device's newer save.

The settings document stores provider-specific Claude and Codex defaults but no provider id. It uses the same bounded option rules as session launch. Unknown keys are rejected. A malformed row is treated as unset and is never returned to the client.

### Browser synchronization and migration

`App` owns an in-memory defaults state and revision. The wizard and settings panels receive that state through props; they no longer call `loadDefaults()` independently.

After authentication:

1. read the local normalized cache;
2. fetch server defaults;
3. if the server has a value, use it and refresh the local cache;
4. if the server is unset, upload the local value with expected revision `0`;
5. if that first-write races, accept the server's conflict document;
6. if the fetch fails, retain the local cache for display and show a non-blocking unsynced state; session creation remains possible with the in-memory values.

Saving is optimistic only in the panel draft, not in the authoritative app state. The UI sends the current revision, adopts the returned document on success, updates local cache, and displays a clear save/conflict error on failure. On conflict it loads the newer server document so the user never sees a false “Saved” state.

The migration is naturally idempotent: once any server value exists, local storage can no longer overwrite it. No separate browser migration flag is required.

### Error handling

- Metadata loading: show loading, retry, provider-default fallback, and a short generic unavailable message.
- Empty valid catalog: treat as unavailable rather than rendering an empty picker.
- Model disappears between selection and start: known model validation returns a specific compatibility error; the wizard refreshes metadata and keeps the rest of the draft.
- Defaults fetch failure: local cache remains usable and the UI indicates it has not synced.
- Defaults write failure: panel remains open with the draft and retry action.
- Defaults conflict: replace stale authoritative state with the server response and ask the user to reapply any intended edit.
- SQLite fallback: settings work for the process lifetime and `/diag` continues to report the existing non-durable store mode.

## Testing Strategy

### Server

- Claude metadata parser, bounds, timeout, cleanup, coalescing, cache, and protocol-drift tests with a fake child process.
- Provider route tests for live Claude models and metadata-unavailable degradation.
- Codex catalog tests retain arbitrary bounded advertised effort tokens and descriptions.
- Session-store tests for unset/read/write/reopen, normalization, compare-and-swap conflicts, malformed rows, and in-memory parity.
- Transport tests for auth, validation, successful GET/PUT, conflict response, and payload bounds.

### Web

- Picker tests for provider default, live models, descriptions, model-compatible efforts, reset announcements, unknown advertised effort tokens, metadata-unavailable fallback, and Advanced custom model.
- Explanation tests for every sandbox, approval, Claude permission, and effort value.
- Defaults synchronization tests for server-wins, first-device migration, migration race, offline fallback, successful save, save failure, and conflict adoption.
- Wizard tests proving provider is still unselected on every open and drafts come from app-owned defaults.
- Mobile modal tests proving the scroll container remains the wizard body with Advanced expanded.

### Final verification

Run focused tests during every red/green cycle, then:

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Perform a browser smoke test at mobile and desktop widths for both providers, including an expanded Advanced section and a metadata-unavailable response.

## Rollout and compatibility

All database changes are additive. Existing local defaults migrate on first authenticated load. Existing sessions and tmux processes are untouched. Older cached clients can continue to call the existing provider model routes and ignore additive response properties. If either metadata protocol drifts after a CLI upgrade, the provider-default launch path and all existing terminal sessions remain functional.
