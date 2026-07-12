# tmux update-environment Compatibility Design

## Problem

RoamCode adds `RC_BASE_URL`, `RC_SESSION_ID`, `RC_TOKEN`, and `RC_TOKEN_FILE` to tmux's global
`update-environment` array so a newly attached client refreshes the variables used by the active session.
The current implementation rebuilds the array inside a tmux format expression using
`#{update-environment}`.

That works with the developer machine's tmux 3.6b, but GitHub Actions uses tmux 3.4. On tmux 3.4 the
array option does not expand through that format as expected, so the reconstructed value contains only
the appended RoamCode names. Existing entries such as `DISPLAY`, `SSH_AUTH_SOCK`, and custom names are
dropped. The real-tmux integration test correctly exposes this as a functional compatibility defect.

## Requirements

- Support the tmux 3.4 behavior exercised by GitHub Actions.
- Preserve every unrelated `update-environment` name and its order.
- Remove every existing exact occurrence of the four RoamCode names, then append each required name once.
- Preserve lookalikes such as `OTHER_RC_TOKEN_X`.
- Keep secret values out of tmux argv; only environment variable names may be read or written.
- Keep the normalized `set-option` in the same command chain before `new-session` or `attach-session`.
- If the dedicated tmux server does not exist yet or the read fails, start from tmux's documented/default
  update list rather than from an empty list.

## Considered Approaches

### Upgrade CI tmux

Installing tmux 3.6 in CI would make the existing expression pass, but would hide a production defect on
hosts that still run tmux 3.4. Rejected.

### Store required names at reserved array indexes

Fixed high indexes avoid format expansion and repeated growth, but can collide with a customized array and
cannot remove duplicates left by older versions. Rejected.

### Read, normalize, then write the name list

Read the global array with `tmux show-options -gv update-environment`, normalize it in Node, and pass the
resulting names to the existing tmux command chain without `-F`. This uses a command that already works in
the tmux 3.4 integration test, preserves custom entries, removes exact duplicates, and never handles secret
values. Chosen.

## Design

`TerminalProcess` receives an optional production dependency that reads the current tmux update-environment
names. The default reader calls tmux synchronously with an argument array and returns trimmed non-empty
stdout lines. Dependency injection lets the unit test model tmux 3.4 deterministically without mocking
tmux internals or adding test-only class methods.

A pure normalization helper filters the four exact RoamCode names from the current list, preserves all
other entries in order, and appends the required bundle once. `tmuxConfigChain` takes the normalized list
and emits:

```text
set-option -g update-environment "<names only>" ;
```

It deliberately does not use `-F`, so tmux never needs to expand an array option through its format engine.
The existing PTY environment remains unchanged: it still carries the current session's values to the tmux
client, while argv contains names only.

If reading fails because the tmux server has not started yet or tmux is unavailable, the normalizer uses
tmux's default update-environment name list. The subsequent PTY spawn remains the authority for reporting
a missing tmux executable.

## Testing

- Unit regression: inject the same mixed list used by the real-tmux test and assert that the spawn chain
  preserves unrelated names, removes duplicates, appends all four required names once, omits `-F`, and
  contains no secret values.
- Fallback unit test: make the reader unavailable and assert that tmux defaults plus the required bundle are
  emitted.
- Real-tmux integration: retain the existing test so supported local/CI tmux versions validate the actual
  command chain.
- Release verification: focused terminal tests, full test suite, typecheck, lint, format check, build, and
  the GitHub Actions CI run on `main`.

## Scope

No provider selection, session resume, authentication, modal scrolling, or deployment behavior changes.
