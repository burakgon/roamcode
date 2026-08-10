# Product model

RoamCode is a personal, standalone control center for real coding-agent terminals. It does not replace Claude Code or
Codex with a chat abstraction, and it does not require a hosted account or external control plane.

## Canonical hierarchy

```text
Personal RoamCode Node
├── Agent runtimes
│   ├── Claude Code
│   └── Codex
├── Workspaces
│   └── project checkout + optional Git worktrees
├── Sessions
│   └── one persistent shell + working directory + optional observed agent
├── Automations
│   └── exact managed runtime + provider options → one inspectable Session per Run
└── Local access
    ├── paired devices
    ├── short-lived presence
    └── one writable input lease per Session
```

### Node

A Node is one RoamCode installation and the machine where execution occurs. It owns provider logins, working
directories, Sessions, Automation definitions and history, device credentials, notification state, and update state.
The current Node is implicit throughout the product; daily navigation never asks the user to select a computer.

### Agent runtime

An Agent is one of the built-in Claude Code or Codex runtimes on the Node. Its identity includes provider, executable
or profile, version, authentication state, availability, and supported options. A friendly name or saved option preset
never replaces the runtime's exact identity.

**Agents** is a runtime catalog, not a list of people, abstract AI personalities, or computers. Historical Sessions
that name another runtime remain readable, but that runtime cannot start a new managed Run.

### Workspace and worktree

A Workspace is a durable project checkout used to group Sessions and Automation targets. Explicit Git worktrees are
nested under their project. Changing directory inside a terminal does not move the Session between groups, and
RoamCode never imports or removes worktrees without an explicit user action.

### Session

A manual Session is one ordinary login shell running in a persistent terminal. It is pinned to its initial working
directory but not to a provider. The user starts and stops coding agents with their native commands. Terminal output,
observed agent state, files, input ownership, and lifecycle all belong to that Session.

RoamCode observes the foreground process group to recognize Claude Code and Codex. Detection adds identity and
activity metadata; it never launches, wraps, aliases, resumes, configures, or writes input to the process. Exiting an
agent returns the Session to its neutral shell state. Exiting the owning shell ends the Session.

Internal needs-input and completion signals power rail badges, workspace counts, and notifications. Selecting the
Session resolves the relevant completion signal; there is no separate inbox to triage.

Automation Runs are the explicit managed-launch exception. An Automation owns a built-in runtime and its
provider-native options, so the Node can launch it deterministically and record its origin.

### Automation and Run

An Automation stores a repeatable instruction plus an exact runtime, working directory, and provider options. A Run
is immutable history and always creates a new inspectable Session. Manual, schedule, and webhook triggers are handled
by the local Node. Deleting an Automation never deletes its completed Runs or Sessions.

## Navigation

Primary navigation contains exactly:

1. **Sessions** — live terminal workbench and durable Session history.
2. **Automations** — definitions, triggers, Runs, and links to their real Sessions.
3. **Agents** — Claude Code and Codex health, authentication, version, and usage.

Session preferences, appearance, provider accounts, paired devices, notifications, diagnostics, and updates live in
focused supporting surfaces instead of becoming additional product areas.

## Access model

The host recovery credential is break-glass access. Every paired browser receives its own revocable device credential
through a five-minute, one-use pairing flow. A valid credential acts with the personal Node owner's authority.

Many authenticated clients may observe a Session, but exactly one client owns its writable input lease at a time.
Taking over or revoking that lease requires explicit confirmation. Presence is short-lived coordination metadata and
never includes prompts, terminal output, credentials, IP addresses, or private paths.

## Compatibility boundary

The stable v1 API owns terminal Sessions, workspaces, devices, presence, adapters, events, and input leases. The native
v2 API owns product context, runtimes, Sessions, and Automations. Existing live tmux processes and current Session data
are adopted in place; migration must never recreate or terminate them merely to fit a new label.

Removed collaboration, federation, extension, legacy Automation, and inbox records may remain in an older data
directory, but RoamCode no longer opens them as active product state. Browser migration may recover a legacy device
credential only when its saved origin exactly matches the current origin; it never reconnects to another saved host.

## Product invariants

- A manual Session starts one user-controlled login shell and never chooses or launches a provider.
- The terminal preserves the real shell and provider TUI behavior on desktop and mobile.
- Agent detection is observational; a detection failure never becomes evidence that the shell ended.
- Provider credentials, source code, task instructions, and terminal output remain on the personal Node.
- Every Automation Run has exactly one new, inspectable Session.
- Primary navigation contains exactly Sessions, Automations, and Agents.
- Claude Code and Codex are the only managed runtimes.
- Every paired device is independently revocable, while valid devices share the owner's product authority.
- Unsupported historical runtimes and removed product records stay inert rather than silently activating.
