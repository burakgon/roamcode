---
name: roamcode-command-center
description: Read and operate an authenticated personal RoamCode Node through its stable API.
---

# RoamCode command center

Use the installed `roamcode api` wrapper. Set `ROAMCODE_API_URL` to the Node origin and provide a revocable device or
host credential in `ROAMCODE_API_TOKEN`. Never put a credential in a URL, command argument, log, or response.

Start by running `roamcode api capabilities`. The supported read actions are `sessions`, `agents`, `workspaces`,
`devices`, `presence`, `adapters`, `automations`, `events`, and `openapi`. The Automations action reads the native v2
resource; the other inventory actions use the stable v1 terminal API.

`presence` contains only short-lived viewing metadata and never terminal content, prompts, credentials, IP addresses,
or private filesystem paths. Manual starts open a neutral shell and never choose a provider. Start Claude Code, Codex,
or another terminal command explicitly after the Session exists.

Mutations:

- `roamcode api start --cwd /absolute/project` opens a neutral persistent shell. Start the desired agent by sending
  its native command through an acquired input lease.
- `roamcode api lease --session SESSION_ID --client AGENT_INSTANCE_ID` acquires the single writable input stream.
- `roamcode api send --session SESSION_ID --client AGENT_INSTANCE_ID --lease LEASE_ID --data 'text'`
- `roamcode api lease --session SESSION_ID --client AGENT_INSTANCE_ID --lease LEASE_ID --renew`
- `roamcode api lease --session SESSION_ID --client AGENT_INSTANCE_ID --lease LEASE_ID --release`
- `roamcode api lease --session SESSION_ID --client AGENT_INSTANCE_ID --takeover --confirm` explicitly takes control
  from another writer. Never use takeover unless the user authorized the interruption.
- `roamcode api lease --session SESSION_ID --revoke --confirm` is an emergency release. It does not transfer input to
  the caller; acquire a fresh lease afterward.
- `roamcode api wait --agent AGENT_ID --after UPDATED_AT --timeout-ms 30000`
- `roamcode api focus --agent AGENT_ID` emits a non-stealing request. Add `--activate` only when the user explicitly
  asked to switch their visible context.

Pass `--idempotency-key` when retrying a mutation across processes. A key is actor-scoped for 24 hours; reusing it
with another request returns `IDEMPOTENCY_CONFLICT`. `send` writes only to the Session's native terminal and returns
`focused:false`. A session permits many observers but exactly one input lease. Keep `--client` stable for the lifetime
of the agent instance, renew before the 30-second expiry, and stop sending immediately on `INPUT_LEASE_REQUIRED` or
`INPUT_LEASE_MISMATCH`. Use `wait` or the resumable event stream instead of tight polling.

Treat `blocked` as requiring a decision, `working` as in progress, `done` as completed but unseen, and `ended` as no
longer running. Do not infer success from a transport timeout: read the resource again using the same idempotency key.
