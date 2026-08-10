---
name: roamcode-command-center
description: Read and operate an authenticated personal RoamCode Node through its stable API.
---

# RoamCode command center

Use the installed `roamcode api` wrapper. Set `ROAMCODE_API_URL` to the Node origin and provide a revocable device or
host credential in `ROAMCODE_API_TOKEN`. Never put a credential in a URL, command argument, log, or response.

Start by running `roamcode api capabilities`. The supported read actions are `sessions`, `agents`, `workspaces`,
`devices`, `presence`, `adapters`, `events`, and `openapi`.

`presence` contains only short-lived viewing metadata and never terminal content, prompts, credentials, IP addresses,
or private filesystem paths. Manual starts open a neutral shell and never choose a provider. Start Claude Code, Codex,
or another terminal command explicitly after the Session exists.

Mutations:

- `roamcode api start --cwd /absolute/project` opens a neutral persistent shell.
- `roamcode api send --session SESSION_ID --data 'text'` writes to that terminal.
- `roamcode api wait --agent AGENT_ID --after UPDATED_AT --timeout-ms 30000`
- `roamcode api focus --agent AGENT_ID` emits a non-stealing request. Add `--activate` only when the user explicitly
  asked to switch their visible context.

Pass `--idempotency-key` when retrying a mutation across processes. A key is actor-scoped for 24 hours; reusing it
with another request returns `IDEMPOTENCY_CONFLICT`. `send` writes only to the Session's native terminal and returns
`focused:false`. Use `wait` or the resumable event stream instead of tight polling.

Treat `blocked` as requiring a decision, `working` as in progress, `done` as completed but unseen, and `ended` as no
longer running. Do not infer success from a transport timeout: read the resource again using the same idempotency key.
