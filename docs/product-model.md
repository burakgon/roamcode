# Product model

RoamCode is a control plane for real coding-agent terminals. It does not replace Claude Code or Codex with a chat
facsimile: every interactive or automated job is a durable terminal session running on a machine that owns the code,
the CLI installation, and the provider login.

## Canonical hierarchy

```text
Personal or Organization
├── Sessions
├── Automations
├── Agents
│   └── Node
│       ├── Claude Code runtime
│       └── Codex runtime
└── People & Access (organization administrators only)
```

The three primary product destinations are **Sessions**, **Automations**, and **Agents**. Organization membership and
access are administrative concerns, not a fourth daily-work destination.

### Personal or Organization

The selected context owns Nodes, Sessions, Automations, and access policy. A Node has exactly one owner at a time.
Moving a Node between Personal and Organization contexts is an explicit ownership transfer; showing the same Node as
independently owned in two contexts would make access and audit decisions ambiguous.

### Node

A Node is a machine on which RoamCode can start a real coding-agent process. Its stable identity is independent of how
a client reaches it. Direct addresses, relay routes, peer-host records, and managed-cloud host identifiers are aliases
for connectivity; they are not additional machine objects.

The Agents screen is Node-first because availability and authentication are machine facts. It answers three questions
without sending the user into Settings: which machine will run the work, which coding-agent runtimes are usable there,
and how many live Sessions each runtime owns.

### Agent runtime

An Agent runtime is a concrete Claude Code, Codex, or installed adapter runtime on one Node. It is not a persona,
prompt profile, teammate, or reusable configuration preset. Runtime authentication stays on the Node and uses the
provider CLI's own account mechanism.

One runtime can own many concurrent Sessions. A runtime identifier is stable only for the `(Node, provider)` pair, so
a Codex installation on one machine cannot be confused with Codex on another.

### Session

A Session is one durable, real provider TUI. It has one Node and one Agent runtime for its lifetime. Its working
directory, repository, branch, worktree, model, safety controls, and display name are Session context rather than
top-level product objects.

Changing machines is a handoff that creates a new Session; silently moving a live TUI would break process, filesystem,
and audit continuity. Several people may observe a Session, while the input lease ensures that only one actor types at
a time. The lease controls concurrency, not authorization.

`working`, `needs input`, `ready`, `ended`, and connection recovery are Session states. There is no separate Attention
inbox that asks users to manage a second copy of terminal work. Selecting a status returns directly to the owning
Session and its real provider prompt.

### Automation and run

An Automation is a repeatable instruction pinned to one exact Node, Agent runtime, working directory, and set of
provider options. A Run is one immutable invocation of an Automation. Every Run creates a new real Session and stores
that Session identifier, so a user can inspect or continue the exact provider TUI instead of reading a synthetic job
log.

The first supported trigger is manual. Scheduled and event triggers must remain capability-gated until their durable
scheduler or event source exists; the UI must never pretend that an unsupported trigger is active.

## Access model

Node grants have three permission values:

| Permission | Current managed-browser capability |
| --- | --- |
| `view` | Reserved for future read-only experiences. It does not enroll or open the managed terminal today. |
| `use` | Enroll a browser, open Sessions, start work, and acquire an input lease. |
| `manage` | `use` capabilities plus Node access and machine-level administration. |

The hosted grant editor therefore creates only `use` and `manage` grants. Existing `view` grants remain visible and
revocable, but the UI must not imply that they can open a terminal. A directory or legacy workspace grant must not
silently elevate into Node access. Organization policy can further restrict provider, model, safety, transfer, relay,
extension, and update actions.

### Hosted browser enrollment

The managed product uses one canonical web origin. `https://roamcode.ai/` is the public entry,
`https://roamcode.ai/app` owns account sign-in, Personal/Organization context, fleet, and access administration, and
`https://roamcode.ai/terminal/{sessions,automations,agents}` is the installed working surface. The account surface
chooses an exact online Node before handing the browser to the matching terminal destination. A legacy
`app.roamcode.ai` hostname is only a redirect to `/app`; it is not a second account or product instance.

The hosted account surface is a fleet and access control plane, not a terminal proxy. After a signed-in person chooses
an online Node, the browser creates its own non-exportable P-256 identity, local device credential, and temporary and
durable relay credentials. The account service receives only public identity material and the hash of the temporary
relay credential, using the relay protocol's domain-separated digest. It never receives the local device credential,
durable relay credential, provider login, working directory, prompt, source code, or terminal stream.

The selected Node verifies the one-use account challenge inside the pinned end-to-end relay channel, binds the
browser's signed identity to its canonical local device actor, and promotes the relay credential only after local
enrollment is durable. Activation also requires a fresh signed authorization snapshot that still grants that device
Session operation access to the selected Node. Repeating the same attempt after a dropped response must resume the
same state transition; different identity, actor, challenge, or credential material must fail closed. Pending recovery
is bounded and fair so one damaged enrollment cannot starve newer browsers. Once enrolled, the existing Sessions,
Automations, Agents, and real terminal client operate directly over that encrypted Node channel. Signing out of the
account does not silently delete a Node credential; forgetting or revoking that browser is an explicit action.

The account UI offers **Open** only when the Node is online, its heartbeat is ready, and it advertises
`terminal.v1`, `relay.v1`, and `managed-device-enrollment.v1`. Organization users must also have a current `use` or
`manage` grant. Missing grants become an explicit request flow; pending, denied, expired, unknown, and unsupported
states remain distinct and never optimistically enroll a browser.

Hosted launch is independently fail-closed through the public, no-session, no-store
`GET /api/v1/meta/product-capabilities` v1 contract. Account creation and product bootstrap require both the explicit
account launch flag and `account.v1`. Managed terminal enrollment additionally requires its explicit launch flag,
`managed-device-enrollment.v1`, and the exact three Node capabilities above. Missing endpoints on an older control
plane, false flags, malformed or future contracts, and incomplete capability sets never inherit optimistic behavior.
Existing sign-in, sign-out, and account-recovery routes remain usable while the hosted product gate is closed.

## Compatibility boundary

The v2 product API is additive. Existing v1 workspace, attention, command-center, peer, and terminal contracts remain
available for older clients and integrations. Internally, legacy workspace records may continue to help validate or
index working directories, but they are not shown as a required product hierarchy. Existing stored Sessions and live
tmux processes are adopted in place; migration must never recreate or terminate them merely to fit the new labels.

## Product invariants

- The terminal is the provider's real TUI and keeps all current desktop and mobile interaction behavior.
- Provider credentials, source code, task instructions, and terminal output do not enter relay metadata or public
  runtime inventory.
- A Node identity does not change when its connection method changes.
- A Session never changes Node or runtime in place.
- Every Automation Run has exactly one new, inspectable Session.
- Primary navigation contains exactly Sessions, Automations, and Agents.
- Unsupported cloud, scheduling, or provider capabilities are reported honestly and fail closed.
