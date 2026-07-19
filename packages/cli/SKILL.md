---
name: roamcode-command-center
description: Read and operate an authenticated RoamCode host through its stable v1 control plane.
---

# RoamCode command center

Use the installed `roamcode api` wrapper. Set `ROAMCODE_API_URL` to the host origin and provide a scoped
device credential in `ROAMCODE_API_TOKEN`. Never put a credential in a URL, command argument, log, or response.

Start by running `roamcode api capabilities`. The supported read actions are `attention`, `sessions`, `agents`,
`workspaces`, `devices`, `team`, `members`, `policy`, `fleet`, `presence`, `adapters`, `extensions`, `plugins`,
`peers`, `peer-workspaces`, `peer-agents`, `peer-sessions`, `automations`, `events`, `audit`, `audit-verify`,
`audit-export`, and `openapi`.

Read `team` before coordinating across devices. `members` exposes role-scoped person and service identities; `presence`
contains only short-lived viewing/operating metadata and never terminal content, prompts, credentials, IP addresses, or
private filesystem paths. A service identity still needs an assigned device principal and an `operator` role
before it can own terminal input.

Read `policy` before launching an agent that requests elevated provider modes, file transfer, or extension
changes. `fleet` is metadata-only: it exposes host health, durability, enabled adapter capabilities, and policy posture,
never source paths, prompts, terminal content, or credentials. `audit`, `audit-verify`, and `audit-export` require the
current host recovery credential. Exports are bounded NDJSON pages with an integrity manifest; use `--after` and
`--limit` to advance the cursor and do not treat an export as verified unless its manifest reports `valid:true`.

Mutations:

- `roamcode api start --cwd /absolute/project --provider claude --options-json '{}'`
- `roamcode api lease --session SESSION_ID --client AGENT_INSTANCE_ID` acquires the single writable input stream.
- `roamcode api send --session SESSION_ID --client AGENT_INSTANCE_ID --lease LEASE_ID --data 'text'`
- `roamcode api lease --session SESSION_ID --client AGENT_INSTANCE_ID --lease LEASE_ID --renew`
- `roamcode api lease --session SESSION_ID --client AGENT_INSTANCE_ID --lease LEASE_ID --release`
- `roamcode api lease --session SESSION_ID --client AGENT_INSTANCE_ID --takeover --confirm` explicitly takes control
  from another writer. Never use takeover unless the user authorized the interruption.
- `roamcode api lease --session SESSION_ID --revoke --confirm` is an administrator-only emergency release. It does
  not transfer input to the caller; a permitted operator must acquire a fresh lease afterward.
- `roamcode api wait --agent AGENT_ID --after UPDATED_AT --timeout-ms 30000`
- `roamcode api focus --agent AGENT_ID` emits a non-stealing request. Add `--activate` only when the user explicitly
  asked to switch their visible context.

Peer federation keeps every remote credential server-side and applies peer scope, local RBAC/policy, and remote
RBAC/policy in sequence. Prefer a five-minute, one-use `roamcode pair` link from the remote host. Put it in a
current-user-owned mode-0600 file; never pass the link or a durable credential as a CLI value. The coordinating server
claims and stores the resulting revocable device credential without returning it to the caller.

- `roamcode api peer-add --peer-pairing-file ./peer-link --confirm`
- A new peer starts with no workspace access. Run `roamcode api peer-discover --peer PEER_ID --expected-revision N`,
  select the returned metadata-only workspace ids, then apply them with `peer-update`. `peer-workspaces` shows only the
  scope that is now operationally visible.
- If the remote host enforces team roles, an administrator there must assign the newly paired `RoamCode peer · …`
  device to an agent/service member. Identity verification works before assignment; all operational reads and writes
  remain denied.
- `roamcode api start --peer PEER_ID --workspace WORKSPACE_ID --provider codex --options-json '{}'`
- Add `--peer PEER_ID` to `lease`, `send`, `wait`, or `focus` to operate the remote agent through the same single-writer
  contract. Keep `--client` stable; the server one-way binds it to the authenticated local actor before forwarding.
- `roamcode api peer-update --peer PEER_ID --expected-revision N --peer-status suspended` fails closed without deleting
  the stored connection. Use explicit workspace/action allowlists instead of `*` whenever possible.
- `peer-verify`, `peer-rotate`, and `peer-remove` require the current revision; access replacement/removal also require
  `--confirm`. Rotate with another private `--peer-pairing-file`; it must verify the same pinned identity and origin.
  Existing service automation may use `--peer-url` plus `--peer-credential-file`, but never store a host recovery token
  when an independently revocable service-device credential will do.

Pass `--idempotency-key` when retrying a mutation across processes. A key is actor-scoped for 24 hours; reusing it
with another request returns `IDEMPOTENCY_CONFLICT`. `send` writes only to the provider's native terminal and returns
`focused:false`. A session permits many observers but exactly one input lease. Keep `--client` stable for the lifetime
of the agent instance, renew before the 30-second expiry, and stop sending immediately on `INPUT_LEASE_REQUIRED` or
`INPUT_LEASE_MISMATCH`. Use `wait` or the resumable event stream instead of tight polling.

Treat `blocked` as requiring a decision, `working` as in progress, `done` as completed but unseen, and `ended` as no
longer running. Do not infer success from a transport timeout: read the resource again using the same idempotency key.
