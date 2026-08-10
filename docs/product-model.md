# Product model

RoamCode is a personal, standalone control center for real coding-agent terminals. It does not replace Claude Code or
Codex with a chat abstraction, and it does not require a hosted account or external control plane.

## Canonical hierarchy

```text
Personal RoamCode Node
├── Workspaces
│   └── project checkout + optional Git worktrees
├── Sessions
│   └── one persistent shell + working directory + optional observed agent
└── Local access
    ├── paired devices
    └── short-lived presence
```

### Node

A Node is one RoamCode installation and the machine where execution occurs. It owns working directories, Sessions,
device credentials, notification state, and update state. The current Node is implicit throughout the product; daily
use never asks the user to select a computer.

### Workspace and worktree

A Workspace is a durable project checkout used to group Sessions. Explicit Git worktrees are nested under their
project. Changing directory inside a terminal does not move the Session between groups, and RoamCode never imports or
removes worktrees without an explicit user action.

### Session

A Session is one ordinary login shell running in a persistent terminal. It is pinned to its initial working directory
but not to a provider. The user starts and stops coding agents with their native commands. Terminal output, observed
agent state, files, and lifecycle all belong to that Session.

RoamCode observes the foreground process group to recognize Claude Code and Codex. Detection adds identity and
activity metadata; it never launches, wraps, aliases, resumes, configures, or writes input to the process. Exiting an
agent returns the Session to its neutral shell state. Exiting the shell ends the Session.

Internal needs-input and completion signals power rail badges, workspace counts, and notifications. Selecting the
Session resolves the relevant completion signal; there is no separate inbox to triage.

## Navigation

Sessions are the product workspace. The Session rail, terminal panes, and focused supporting surfaces replace a
separate primary or bottom navigation bar. Session preferences, appearance, provider accounts, paired devices,
notifications, diagnostics, and updates live in Settings.

## Access model

The host recovery credential is break-glass access. Every paired browser receives its own revocable device credential
through a five-minute, one-use pairing flow. A valid credential acts with the personal Node owner's authority. Every
authenticated client attached to a Session can send terminal input directly. Presence is short-lived coordination
metadata and never includes prompts, terminal output, credentials, IP addresses, or private paths.

## Compatibility boundary

The stable v1 API owns terminal Sessions, workspaces, devices, presence, adapters, and events. The v2 API exposes the
personal context, Node, runtime metadata, and Sessions. Existing live tmux processes and current Session data are
adopted in place; migration must never recreate or terminate them merely to fit a new label.

Removed product records from older releases may remain in an older data directory, but RoamCode no longer opens them
as active state. Browser migration may recover a legacy device credential only when its saved origin exactly matches
the current origin; it never reconnects to another saved host.

## Product invariants

- A new Session starts one ordinary login shell and never chooses or launches a provider.
- The terminal preserves the real shell and provider TUI behavior on desktop and mobile.
- Agent detection is observational; a detection failure never becomes evidence that the shell ended.
- Every authenticated Session connection can send input without an ownership or takeover protocol.
- Provider credentials, source code, task instructions, and terminal output remain on the personal Node.
- Every paired device is independently revocable, while valid devices share the owner's product authority.
- Unsupported historical runtimes and removed product records stay inert rather than silently activating.
