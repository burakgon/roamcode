# Stable Session Rail Ordering Design

## Problem and verified root cause

The session rail currently has one ordering policy: awaiting sessions first, then descending `lastActiveAt`. The original per-frame and per-selection client bumps have already been removed, but `lastActiveAt` is still reconciled from the server and advances when the user writes to a session. Polling that updated metadata can therefore move rows. There is no user preference that guarantees a stable non-activity order.

This causes lost spatial memory and creates moving tap targets, especially in the mobile session sheet.

## Chosen behavior

- Add two rail-order modes:
  - `created`: labelled **Stable (created)** and used by default.
  - `activity`: labelled **Recent activity** and preserving the current behavior.
- In both modes, sessions with `awaiting: true` remain in a top group.
- In `created` mode, each group is ordered by `createdAt` descending, then by session id for a deterministic tie-break. Existing rows do not move when activity timestamps change. Rows can still move when they enter or leave the explicit “needs you” group, and creating or removing a session can change the list.
- In `activity` mode, each group is ordered by `lastActiveAt` descending, with `createdAt` and session id as deterministic tie-breaks.
- Relative-time labels continue to show last activity time in both modes; changing the sorting policy does not remove useful activity information.

## Preference and migration

The preference is browser-local because it is display behavior, matching the existing theme and other client-only preferences. A focused module in `packages/web/src/session/order-preference.ts` owns:

- the `SessionOrder` union type (`"created" | "activity"`),
- the localStorage key,
- strict loading/validation with `created` as the fallback,
- best-effort saving that does not throw when storage is blocked.

Missing, malformed, or unknown stored values normalize to `created`. Selecting a mode updates the current UI immediately even if persistence fails.

## Component and data flow

`App` owns the live preference state, initialized once through `loadSessionOrder()`. It passes the mode to both `SessionList` and `SettingsPanel`.

`SessionList` calls a pure generalized sorter with `sessions`, `lastActiveAt`, and the chosen mode. `App` uses that same sorter and mode when closing the active session so the automatically selected replacement is exactly the first row the user can see.

The global Settings panel adds a labelled **Session order** select in Appearance, beside the existing OLED preference. It applies immediately and includes short copy explaining that “needs you” sessions always stay on top. The control is not tied to the “Save defaults” button because it is an appearance preference, not a new-session default.

No server endpoint, database column, session metadata, or cross-device synchronization is added.

## Error handling and accessibility

- localStorage read, parse, and write failures are non-fatal.
- Unknown values never enter component state.
- The select has an explicit accessible label and native keyboard/touch behavior.
- The “needs you” exception is described in visible helper text so stable ordering is not misleading.

## Test strategy

Test-driven implementation will cover:

1. Preference loading defaults to `created`, accepts valid values, rejects invalid values, and survives blocked storage.
2. The pure sorter keeps activity changes from moving rows in `created` mode, preserves the current ordering in `activity` mode, pins awaiting sessions in both modes, handles deterministic ties, and never mutates input.
3. `SessionList` renders the requested ordering mode.
4. `SettingsPanel` exposes the labelled control and emits immediate changes.
5. `App` initializes, persists, and threads the preference consistently, including active-session close fallback selection.
6. The complete repository build, unit suite, typecheck, lint, format check, and production dependency audit remain green.

## Out of scope

- Manual drag ordering.
- Pinning individual sessions.
- Syncing the preference between browsers/devices.
- Changing how server activity timestamps are generated.
