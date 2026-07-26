# Product model

RoamCode is a standalone control center for real coding-agent terminals. It does not replace Claude Code or Codex
with a chat abstraction, and it does not require a hosted account or external control plane.

## Canonical hierarchy

```text
Standalone RoamCode Node
├── Agent runtimes
│   ├── Claude Code
│   ├── Codex
│   └── installed adapters
├── Sessions
│   └── one persistent shell + working directory + optional observed agent
├── Automations
│   └── exact managed runtime + provider options → one inspectable Session per Run
└── Local access
    ├── paired devices
    ├── optional team members and roles
    ├── resource grants and policy
    └── explicitly paired peer Nodes
```

### Node

A Node is one standalone RoamCode installation and the machine where execution occurs. It owns provider logins,
working directories, Sessions, Automation definitions and history, device credentials, policy, and audit data.

For normal standalone use the current Node is the product boundary, not a fleet item that users must repeatedly
select. Primary navigation does not show an active-computers catalog. Cross-instance operation is an explicit peer
federation capability configured under access settings.

### Agent runtime

An Agent is a concrete installed runtime on the Node: Claude Code, Codex, or a verified adapter. Its identity includes
provider, executable/profile, version, authentication state, availability, and supported options. A friendly name or
saved option preset never replaces the runtime's exact identity.

**Agents** is a runtime catalog, not a list of people, abstract AI personalities, or computers.

### Session

A manual Session is one ordinary login shell running in a persistent terminal. It is pinned to one Node and initial
working directory, but not to a provider. The user starts and stops coding agents with their native commands. Its
output, observed agent state, attention state, files, input lease, and terminal lifecycle belong to that Session.

RoamCode observes the foreground process group to recognize registered agent executables. Detection adds identity to
the Session; it never launches, wraps, aliases, resumes, configures, or writes input to the process. Exiting an agent
returns the Session to its neutral shell state. Exiting the owning shell ends the Session.

Automation Runs are the explicit exception: an Automation owns a provider and its provider-native options, so the
Node launches that managed runtime deterministically and records the managed launch owner.

Changing panes or reconnecting never moves or recreates the Session. A `needs input` state links directly to the live
terminal instead of creating a separate inbox.

The Sessions rail groups launch directories under durable projects. When a project has explicit Git worktrees, its
base checkout and worktree checkouts become a second level; otherwise Sessions remain directly under the project.
Changing directory inside a terminal does not move the Session between groups.

### Automation and run

An Automation stores a repeatable instruction plus an exact runtime, working directory, and provider options. A Run
is immutable history and always creates a new inspectable Session. Manual, schedule, and webhook triggers are handled
by the local Node; unsupported trigger capabilities are shown as unavailable rather than simulated.

Deleting an Automation never deletes its completed Runs or Sessions.

## Navigation

Primary navigation contains exactly:

1. **Sessions** — live terminal workbench and durable Session history.
2. **Automations** — definitions, triggers, Runs, and links to their real Sessions.
3. **Agents** — installed runtime health, authentication, version, and usage.

Devices, local team access, organization policy, peer federation, provider setup, diagnostics, and updates are
secondary configuration surfaces. They should not compete with the three daily workflows.

## Access model

The host recovery credential is break-glass administration. Every paired browser receives its own revocable device
credential through a five-minute one-use pairing flow. A standalone operator may optionally enable local role
enforcement, bind devices to members, grant resource scopes, and apply organization policy. These records live on the
Node and do not depend on an external identity service.

Peer federation is direct delegation between two standalone Nodes. The coordinating Node stores one independently
revocable remote device credential, pins remote Node identity, and receives only configured action/workspace scopes.
Both Nodes authorize every forwarded operation, and the remote Node remains authoritative for execution and data.

## Compatibility boundary

The product API is additive to the stable v1 terminal and integration surface. Existing Session records and live tmux
processes are adopted in place; a migration must never recreate or terminate them merely to fit new labels. Legacy
workspace records become self-rooted projects in place. RoamCode creates or imports worktree relationships only from
an explicit user action; it does not scan external Git worktrees into the rail automatically.

Old local data created by removed connection modes is ignored or safely migrated; it must never reactivate an
external connection path.

## Product invariants

- A manual Session starts one user-controlled login shell and never chooses or launches a provider.
- The terminal preserves the real shell and provider TUI behavior on desktop and mobile.
- Agent detection is observational; a detection failure never becomes evidence that the shell ended.
- Provider credentials, source code, task instructions, and terminal output remain on the standalone Node.
- A Session never changes Node in place; observed foreground agent identity may appear or clear as commands run.
- Every Automation Run has exactly one new, inspectable Session.
- Primary navigation contains exactly Sessions, Automations, and Agents.
- The current standalone Node is implicit in daily navigation.
- Direct devices and peer Nodes are independently paired and revocable.
- Unsupported scheduler, provider, or peer capabilities are reported honestly and fail closed.
