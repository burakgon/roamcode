# Terminal Sessions

Manual Sessions are shell-first. RoamCode opens a persistent login shell in the selected directory and gives the
user the same terminal surface on desktop and mobile. It does not choose a provider, add agent arguments, run a
sign-in flow, or modify shell configuration.

## Start and stop

From the PWA, choose **New terminal**, select a directory, and choose **Open terminal**.

The equivalent local API command is:

```sh
roamcode api start --cwd /path/to/project
```

The creation contract contains only the terminal location:

```json
{
  "cwd": "/path/to/project",
  "mode": "terminal"
}
```

Provider and option fields are rejected. At the prompt, run `claude`, `codex`, or any other command normally.
Exiting that command returns to the shell. Exiting the owning shell ends the Session. Reconnecting a browser attaches
to the existing tmux terminal instead of starting another shell.

## Agent observation

RoamCode identifies a supported coding agent only when a registered executable is in the terminal's foreground
process group. It reads one bounded process snapshot for all panes and accepts exact executable aliases plus a small
set of conservative, non-evaluating wrapper forms such as ordinary package runners. Shell expressions are never
evaluated.

The observation changes Session metadata only:

- starting a recognized agent adds its provider identity;
- activity can become `working`, `blocked`, or `idle`;
- leaving the agent clears that identity after consecutive definitive misses;
- a failed process snapshot preserves the previous state instead of guessing;
- the shell and tmux process remain the lifecycle authority.

RoamCode does not inject a launcher, alias, `PATH` shim, hook, command-line flag, or terminal input to improve
detection. Terminal bytes alone are not used as agent identity evidence.

## Optional explicit integration

An existing tool such as cmux or a provider-native integration may already know exact agent lifecycle and activity. It can
report that state through:

```text
POST /api/v1/sessions/{id}/agent-state
```

Active report:

```json
{
  "active": true,
  "provider": "codex",
  "activity": "working",
  "model": "gpt-5",
  "effort": "high",
  "providerSessionId": "provider-owned-id"
}
```

Clear report:

```json
{
  "active": false
}
```

`model`, `effort`, and `providerSessionId` are optional bounded metadata. The provider must be registered on the Node,
the target must be a user-controlled shell Session, and the caller must be authorized to operate it. The endpoint
only updates observed metadata: it cannot launch a process, write terminal input, alter argv, edit configuration, or
change the shell lifecycle.

Use this seam only when the external tool already has authoritative events. Do not wrap the user's command or install
shell mutations merely to call it. The exact request and response schemas are published by the Node at
`GET /api/v1/openapi.json`.

## Automations

Automations deliberately retain managed provider launches. An Automation definition owns an exact runtime, working
directory, and provider-native options so scheduled and webhook Runs are deterministic. Each Run still becomes an
inspectable terminal Session, but its launch metadata records `managed` ownership instead of pretending it was a
manual shell.
