# Claude Code stream-json + control protocol — observed schema

Captured by driving the **real** `claude` binary (v2.1.186, subscription auth,
`ANTHROPIC_API_KEY` unset) via `scripts/spike/drive.mjs`. Every shape below has a
real, captured example line, sanitized only in free-text fields (home path →
`/Users/user`, email → `user@example.com`, org → `Example Org`). Structural keys
are untouched. Source fixtures: `packages/protocol/fixtures/{permission-turn,simple-turn}.jsonl`.

> This is the canonical reference for Tasks 3–5 (parser, serializers, mock
> `claude`). When a shape here disagrees with a guess elsewhere, **this wins** —
> it is what the binary actually emitted/accepted.

## How `claude` is invoked

```
claude \
  --input-format  stream-json \
  --output-format stream-json \
  --verbose \
  --include-partial-messages \
  --include-hook-events \
  --permission-mode default
```

- **No `-p`/`--print`.** Bidirectional stream-json (stdin+stdout both
  `stream-json`) keeps the session interactive enough to round-trip
  `control_request`s; the process still exits after the `result` once we close
  stdin.
- **`--verbose`** is required for `stream-json` output.
- **`--include-partial-messages`** turns on the `stream_event` (SSE-style)
  delta lines.
- **`--include-hook-events`** surfaces `hook_started` / `hook_response` system
  lines (and is what makes the PreToolUse hook callback fire as a
  `control_request` — see "Permissions" below).
- Subscription auth: the spike deletes any inherited `ANTHROPIC_API_KEY` before
  spawning. `system/init` confirms with `"apiKeySource":"none"`.

Every line on stdout is one JSON object (newline-delimited). The CLI never emits
multi-line JSON.

---

## Message taxonomy

Top-level discriminator is `type`. Observed values on stdout:

| `type`             | Direction | Meaning |
|--------------------|-----------|---------|
| `system`           | CLI→client | Lifecycle/metadata. Discriminated further by `subtype`. |
| `stream_event`     | CLI→client | SSE-style incremental deltas; the real event is nested under `event`. |
| `assistant`        | CLI→client | A complete assistant message (one content block per line). |
| `user`             | CLI→client | A complete user message — here, the synthetic `tool_result` after a tool runs. |
| `result`           | CLI→client | Terminal line for the turn: cost, usage, final text, denials. |
| `control_request`  | **both** | Out-of-band request needing a `control_response`. See "Control protocol". |
| `control_response` | **both** | Reply to a `control_request`. |
| `rate_limit_event` | CLI→client | Rate-limit status snapshot (`rate_limit_info`). |

Sent by the client (us) on stdin: `control_request` (the `initialize`
handshake), `control_response` (answers), and `user` (the prompt). In the
committed fixtures, lines **we sent** are tagged `"_dir":"out"` (a fixture-only
annotation; the real wire bytes do not contain `_dir`). Untagged lines are
verbatim CLI output.

---

## 1. `system` / `init`

First line of every session. Carries session identity and capabilities.

```json
{"type":"system","subtype":"init","cwd":"/private/tmp/rc-spike","session_id":"0ea4a7b2-9680-4b86-91a6-a1cca086895c","tools":["Task","AskUserQuestion","Bash", …],"mcp_servers":[{"name":"context7","status":"pending"}, …],"model":"claude-opus-4-8[1m]","permissionMode":"default","slash_commands":[ … ],"apiKeySource":"none","claude_code_version":"2.1.186","output_style":"default","agents":[ … ],"skills":[ … ],"plugins":[ … ],"uuid":"9b392d07-78c0-43d6-a4ed-3ce224c1ef97","memory_paths":{"auto":"/Users/user/.claude/projects/-private-tmp-rc-spike/memory/"}, …}
```

Field map (the ones Tasks 3–5 care about):
- **`session_id`** — UUID string. The same value reappears on every subsequent
  line as a top-level `session_id`.
- **`model`** — e.g. `"claude-opus-4-8[1m]"` (note the `[1m]` context-window
  suffix; the `assistant` message blocks report the bare `"claude-opus-4-8"`).
- **`tools`** — array of tool-name strings (31 in this capture).
- **`cwd`** — absolute working directory.
- Also present: `permissionMode`, `apiKeySource` (`"none"` under subscription),
  `claude_code_version`, `mcp_servers` (`{name,status}`), `slash_commands`,
  `agents`, `skills`, `plugins`, `output_style`, `uuid`, `memory_paths`.

Other `system` subtypes observed (only with `--include-hook-events` /
`--verbose`):

```json
{"type":"system","subtype":"status","status":"requesting","session_id":"…"}
{"type":"system","subtype":"thinking_tokens","estimated_tokens":50,"estimated_tokens_delta":50,"session_id":"…"}
{"type":"system","subtype":"hook_started","hook_id":"…","hook_name":"SessionStart:startup","hook_event":"SessionStart","session_id":"…"}
{"type":"system","subtype":"hook_response","hook_id":"…","hook_name":"SessionStart:startup","hook_event":"SessionStart","output":"Session status updated.\n","stdout":"…","stderr":"","exit_code":0, …}
```

A parser should treat `system` as open-ended: switch on `subtype`, tolerate
unknown subtypes.

---

## 2. `stream_event` (partial messages)

The Anthropic Messages SSE stream, wrapped. The real event is under
`event`; the wrapper adds `session_id`, `parent_tool_use_id`, `uuid`.

```json
{"type":"stream_event","event":{"type":"message_start","message":{"model":"claude-opus-4-8","id":"msg_01LfQM2qKfEhuQAXvv4CcU9A","type":"message","role":"assistant","content":[],"stop_reason":null, …}},"session_id":"…","parent_tool_use_id":null,"uuid":"…"}
{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"2"}},"session_id":"…","parent_tool_use_id":null,"uuid":"…"}
```

Observed nested `event.type` values, and for `content_block_delta` the
`delta.type` values:

| `event.type`          | `delta.type` (when applicable) |
|-----------------------|--------------------------------|
| `message_start`       | — (carries the seed `message` envelope) |
| `content_block_start` | — (carries the new `content_block`) |
| `content_block_delta` | `text_delta` (`delta.text`) |
| `content_block_delta` | `input_json_delta` (`delta.partial_json` — streamed tool input) |
| `content_block_delta` | `thinking_delta` (`delta.thinking`) |
| `content_block_delta` | `signature_delta` (`delta.signature` — thinking-block signature) |
| `content_block_stop`  | — |
| `message_delta`       | — (`event.delta` carries `stop_reason`; `event.usage`) |
| `message_stop`        | — |

These are exactly the standard Messages streaming events; a parser can reuse
Anthropic SSE types for `event` and just unwrap the `stream_event` envelope.

---

## 3. `assistant` / `user` (complete messages)

`assistant` lines carry a full `message` (Anthropic shape). Each line has a
single content block. Example with a `tool_use` block:

```json
{"type":"assistant","message":{"id":"msg_01GmeWu9Qj6q7TYFgfM5Rygx","role":"assistant","model":"claude-opus-4-8","stop_reason":null,"content":[{"type":"tool_use","id":"toolu_01DC8WPnnR3GjMKYZBhcruUq","name":"Write","input":{"file_path":"/private/tmp/rc-spike/spike.txt","content":"hello\n"}}], …},"session_id":"…","parent_tool_use_id":null, …}
```

(`assistant` also appears with `content:[{"type":"thinking", …}]` and
`content:[{"type":"text", …}]`.)

`user` lines from the CLI carry the synthetic tool result after a tool runs:

```json
{"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_01DC8WPnnR3GjMKYZBhcruUq","type":"tool_result","content":"File created successfully at: /private/tmp/rc-spike/spike.txt …"}]},"parent_tool_use_id":null,"session_id":"…", …}
```

The `tool_result`'s `tool_use_id` matches the `tool_use.id` from the assistant
message. `parent_tool_use_id` is `null` for top-level turns (non-null inside
sub-agent/Task tool runs).

---

## 4. `result`

Terminal line of a turn.

```json
{"type":"result","subtype":"success","is_error":false,"num_turns":2,"session_id":"7bd0a4b6-0924-46fc-b9d3-d8f33105e37b","result":"Created `spike.txt` with the text `hello`.","stop_reason":"end_turn","total_cost_usd":0.165912,"usage":{"input_tokens":9264,"cache_creation_input_tokens":…,"cache_read_input_tokens":…,"output_tokens":244,"server_tool_use":{…},"service_tier":"standard","cache_creation":{…},"inference_geo":"not_available","iterations":[…],"speed":"standard"},"permission_denials":[],"terminal_reason":"completed","uuid":"…"}
```

Field map:
- **`subtype`** — `"success"` (also `"error_*"` variants exist; not captured).
- **`is_error`** — boolean.
- **`result`** — the final assistant text (string).
- **`session_id`**, **`stop_reason`** (`"end_turn"`), **`num_turns`**.
- **`total_cost_usd`**, **`usage`** (`input_tokens`,
  `cache_creation_input_tokens`, `cache_read_input_tokens`, `output_tokens`,
  `server_tool_use`, `service_tier`, `cache_creation`, `inference_geo`,
  `iterations`, `speed`), **`modelUsage`** (per-model breakdown).
- **`permission_denials`** — array of
  `{tool_name, tool_use_id, tool_input}` for tools that were denied. **`[]`
  when the tool was allowed** (the success/allow case in our permission turn).
- **`terminal_reason`** — `"completed"`.

---

## Control protocol (the under-documented part)

### Envelope

A control message is `{"type":"control_request", "request_id", "request":{…}}`
or `{"type":"control_response", "response":{…}}`. **`request_id` lives at the
top level of a `control_request`** and is echoed back **inside `response`** of
the `control_response`. The discriminator inside `request`/`response` is
`subtype`.

Confirmed shapes (parser-side) from the binary's own handler:
`processControlRequest(e)` dispatches on `e.request.subtype` ∈
`{ can_use_tool, hook_callback, mcp_message, elicitation, request_user_dialog,
oauth_token_refresh, host_auth_token_refresh }`, and `request(e)` builds
`{request_id, type:"control_request", request:e}`. Client→CLI control subtypes
the binary accepts include `initialize`, `interrupt`, `set_permission_mode`,
`set_model`, `set_max_thinking_tokens`, `get_settings`, etc.

### 5a. `initialize` handshake (client → CLI), and the CLI's response

The client opens the session by sending an `initialize` `control_request`. The
CLI replies with a `control_response` carrying the full session capability
manifest. **This is also how the client registers hooks** (see permissions).

What we send:

```json
{"type":"control_request","request_id":"init-4bbaea34-…","request":{"subtype":"initialize","hooks":{"PreToolUse":[{"matcher":"","hookCallbackIds":["hook_0"]}]}}}
```

What the CLI sends back (truncated — the `response` is large):

```json
{"type":"control_response","response":{"subtype":"success","request_id":"init-4bbaea34-…","response":{"commands":[…65 entries…],"agents":[…9…],"output_style":"default","available_output_styles":["default","Proactive","Explanatory","Learning"],"models":[…4…],"account":{"email":"user@example.com","organization":"Example Org","subscriptionType":"Claude Max","apiProvider":"firstParty"},"pid":33739,"feedback_survey_config":{…}}}}
```

So the `control_response` envelope is **`{type:"control_response", response:{
subtype:"success", request_id, response:<payload> }}`** — `request_id` and
`subtype` are siblings *inside* `response`, and the actual payload is nested one
level deeper as `response.response`. (An error reply is
`response:{subtype:"error", request_id, error:"…"}`.)

The SDK init request may also include `sdkMcpServers`, `jsonSchema`,
`systemPrompt`, `appendSystemPrompt`, `agents`, `skills`, etc.; only `subtype`
and `hooks` are required for our purposes.

### 5b. The permission request — `hook_callback` (CLI → client)

**KEY FINDING.** In headless stream-json mode, an un-gated tool in
`--permission-mode default` is **auto-denied** — the CLI does **not** emit a
`can_use_tool` `control_request` to stdout. (The binary literally logs *"entered
'requires\_action' (likely a permission prompt) with no client to answer it"* and
short-circuits to deny.) The direct `can_use_tool` control_request path is
reserved for the CLI's interactive **bridge/Remote-Control** session, not
headless stdio.

The mechanism that **does** surface an answerable permission request over
headless stdio is a **PreToolUse hook** registered in the `initialize`
handshake. When the model calls a tool, the CLI sends a `hook_callback`
`control_request`; the client answers with a `control_response` whose payload
carries a `PreToolUse` permission decision, and the tool then executes (or is
blocked) accordingly.

The `hook_callback` `control_request` the CLI sent us (verbatim, sanitized):

```json
{"type":"control_request","request_id":"fc9a4b4b-b542-452e-9d1a-54710ae0c3de","request":{"subtype":"hook_callback","callback_id":"hook_0","input":{"session_id":"7bd0a4b6-…","transcript_path":"/Users/user/.claude/projects/-private-tmp-rc-spike/7bd0a4b6-….jsonl","cwd":"/private/tmp/rc-spike","permission_mode":"default","effort":{"level":"xhigh"},"hook_event_name":"PreToolUse","tool_name":"Write","tool_input":{"file_path":"/private/tmp/rc-spike/spike.txt","content":"hello\n"},"tool_use_id":"toolu_01DC8WPnnR3GjMKYZBhcruUq"}}}
```

- **`request_id`** — top-level; echo it back in the response.
- **`request.subtype`** — `"hook_callback"`.
- **`request.callback_id`** — `"hook_0"` (matches the id we registered in
  `initialize.hooks.PreToolUse[].hookCallbackIds`).
- **`request.tool_use_id`** — also mirrored at `request.input.tool_use_id`.
- **`request.input`** — the PreToolUse hook payload: `session_id`,
  `transcript_path`, `cwd`, `permission_mode`, `effort`, `hook_event_name`
  (`"PreToolUse"`), **`tool_name`** (`"Write"`), **`tool_input`** (the proposed
  tool call), `tool_use_id`.

### 5c. The `control_response` that the binary ACCEPTED (allow)

What we sent to allow the Write — and the file was then created
(`result.permission_denials == []`):

```json
{"type":"control_response","response":{"subtype":"success","request_id":"fc9a4b4b-b542-452e-9d1a-54710ae0c3de","response":{"async":false,"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","permissionDecisionReason":"spike auto-allow"}}}}
```

- Envelope: `{type:"control_response", response:{subtype:"success",
  request_id, response:<payload>}}` (same shape as the init reply).
- Payload (`response.response`):
  - **`async`** — `false`.
  - **`hookSpecificOutput`** — `{hookEventName:"PreToolUse",
    permissionDecision:"allow"|"deny", permissionDecisionReason:<string>}`.
- **Deny** is the same shape with `permissionDecision:"deny"`; the tool is then
  blocked and shows up in `result.permission_denials`. A plain
  `response:{async:false}` (no `hookSpecificOutput`) does **not** grant
  permission → falls through to the default auto-deny.

### 5d. `can_use_tool` (direct permission path — for reference)

Not emitted over headless stdio in this version, but the binary builds it as
(extracted from the binary, verbatim):

```js
{subtype:"can_use_tool", tool_name, display_name, input, tool_use_id, description, ...(permission_suggestions && {permission_suggestions})}
```

i.e. `{"type":"control_request","request_id":…,"request":{"subtype":"can_use_tool",
"tool_name","display_name","input","tool_use_id","description","permission_suggestions"?}}`.
The matching answer (from the binary's parser + the SDK's `PermissionResult`
type) is a `control_response` whose `response.response` is the permission
result: **allow** = `{behavior:"allow", updatedInput:<input>, userModified?:bool,
contentBlocks?:[…]}`, **deny/ask** = `{behavior:"deny"|"ask", message:<string>,
contentBlocks?:[…]}`. The driver answers this shape too, defensively, in case a
future/interactive transport uses it. Tasks 3–5 should support **both** the
`hook_callback` and `can_use_tool` permission shapes.

### 6. The outbound user-message envelope that the binary ACCEPTED

```json
{"type":"user","message":{"role":"user","content":[{"type":"text","text":"Use the Write tool to create a file named spike.txt with the text hello"}]}}
```

- The minimal accepted shape is **`{type:"user", message:{role:"user",
  content:[…]}}`**. `content` may be a string or a content-block array; the
  block array (`[{type:"text",text:…}]`) is what we used and it worked.
- Optional fields the CLI also accepts / echoes: `parent_tool_use_id`,
  `session_id` (omit to start a new session). The first-guess SDK envelope was
  correct as-is — no alternate was needed.
- To send a **tool result** back as a user turn, the same envelope with a
  `tool_result` content block applies (see §3).

---

## Summary for Tasks 3–5

- **Parsing inbound stdout**: discriminate on `type`; for `system` switch on
  `subtype` (open set); for `stream_event` unwrap `event` and reuse Anthropic
  SSE types; `assistant`/`user` carry standard Messages `message` objects.
- **`control_request` / `control_response` envelopes**: `request_id` is
  top-level on requests, nested under `response` on responses; payloads are at
  `request.<fields>` / `response.response`.
- **Permissions**: the practical, headless mechanism is **PreToolUse hook →
  `hook_callback` control_request → `control_response` with
  `hookSpecificOutput.permissionDecision`**. Also model the `can_use_tool`
  shape for the interactive transport.
- **Serializing outbound**: `initialize` handshake first (register hooks),
  then `{type:"user", message:{role,content}}`, then `control_response`s to
  answer `hook_callback`/`can_use_tool`.
- **Lifecycle**: send `initialize` → on its `control_response`, send the user
  message → answer any `hook_callback` → on `result`, close stdin → child
  exits. **But closing stdin is optional** — keeping it open lets the same
  process serve another turn; see "Multi-turn" below.

---

## Multi-turn (one process, multiple turns)

**Question:** does the real `claude` CLI, in bidirectional stream-json mode,
process a SECOND user message in the SAME process if we KEEP stdin open after
the first `result` — or does each process only handle one turn?

**Verdict: keep-alive is VIABLE — YES.** A single `claude` process handles
multiple turns over one long-lived stdin/stdout pair. After the first `result`
you do **not** close stdin; you just write the next `{type:"user", …}` line and
a second turn runs to completion on the same process, same session, with no
intervening control message required.

Captured by `scripts/spike/multiturn.mjs` (same invocation/flags as `drive.mjs`,
plus an explicit `--session-id`; subscription auth, `ANTHROPIC_API_KEY` unset;
run from `/private/tmp/rc-multiturn`). Turn 1 asked `2+2`, turn 2 asked `3+3`.
Sanitized excerpt — note the **same `session_id` on both turns** and that the
second answer is `"6"` (it reflects the second question, i.e. real conversational
continuity, not a replay):

```jsonc
// turn 1 — we send user msg 1, get a result on the SAME process
{"type":"system","subtype":"init","session_id":"21d99cac-…","model":"claude-opus-4-8[1m]","permissionMode":"default","apiKeySource":"none","uuid":"01dc03f8-…"}
{"type":"assistant","message":{"content":[{"type":"text","text":"4"}], …}, …}
{"type":"result","subtype":"success","is_error":false,"num_turns":1,"session_id":"21d99cac-…","result":"4","stop_reason":"end_turn","terminal_reason":"completed", …}

// turn 2 — stdin STAYS OPEN; we just write the next user line:
{"type":"user","message":{"role":"user","content":[{"type":"text","text":"Now what is 3+3? Just the number."}]}}   // ← sent by us, no control msg in between

// the SAME process emits a fresh init + a second result:
{"type":"system","subtype":"init","session_id":"21d99cac-…","model":"claude-opus-4-8[1m]","permissionMode":"default","apiKeySource":"none","uuid":"89b28fec-…"}
{"type":"assistant","message":{"content":[{"type":"text","text":"6"}], …}, …}
{"type":"result","subtype":"success","is_error":false,"num_turns":1,"session_id":"21d99cac-…","result":"6","stop_reason":"end_turn","terminal_reason":"completed", …}
```

Observations that matter for Plan 3:

- **Same process, same session.** Both turns share one `session_id`
  (`21d99cac-…` above). The child only exits once we close stdin after the last
  turn (`exit code=0`, `resultCount=2`). It does **not** exit after turn 1.
- **Nothing is required between turns** beyond the next `{type:"user", …}` line
  — no `interrupt`, no re-`initialize`, no new control message. The
  `initialize` handshake (and its registered hooks) is sent **once** and stays
  in effect for every subsequent turn.
- **Each turn re-emits its own lifecycle.** A new `system/init` line is emitted
  at the **start of every turn** (turn 2 has a fresh per-line `uuid` but the
  **same `session_id`**), followed by the usual `status` → `stream_event`s →
  `assistant` → `result`. So a parser must treat `system/init` as "turn start,"
  not "session start" — it can recur. Each `result` reports `num_turns:1` (it is
  per-turn, not cumulative). The user's `Stop`/`UserPromptSubmit` hooks (from
  their installed plugins) also fire per turn, marking clean turn boundaries.
- **Permissions still work on later turns.** A second confirmation run
  (turn 1 = math, turn 2 = a `Write`) showed the PreToolUse `hook_callback`
  `control_request` **fires on turn 2** exactly as on turn 1; answering it with
  `hookSpecificOutput.permissionDecision:"allow"` let the `Write` actually
  execute (`result.permission_denials == []`, file created) — all on the same
  keep-alive process/session. The hook registered in the one-time `initialize`
  remains armed across turns.

### Recommended Plan-3 model: **(A) keep the process alive**

Spawn `claude` once per session, send `initialize` once, then drive N turns by
writing successive `user` lines and reading until each turn's `result`. Close
stdin only when tearing the session down. This avoids the per-turn cost of
`claude --resume <id>` respawns (process startup, MCP server reconnects, full
context re-hydration from the transcript) and preserves in-process conversation
state. Model **(B) respawn with `--resume`** is the fallback **only** for crash
recovery / reattaching to a session whose process has died — not the steady-state
path.

Practical notes for the driver: drop the "close stdin on `result`" step and
instead gate it on session teardown; track `result` count (or `result.uuid`) to
delimit turns since `system/init` now recurs per turn; keep one safety/idle
watchdog rather than a per-turn kill timer.

---

## Plan-5 spikes: AskUserQuestion answering + resume/history

Captured by driving the **real** `claude` (v2.1.186, subscription auth,
`ANTHROPIC_API_KEY` unset) from a throwaway cwd (`/private/tmp/rc-spike5`) via
`scripts/spike/askq.mjs`, `scripts/spike/askq2.mjs`, `scripts/spike/resume.mjs`.
Cross-checked against the binary's own strings. Host paths/PII sanitized in
free-text only; structural keys verbatim.

### A. AskUserQuestion — surfacing + answering (SOLVED)

**Question:** how does the model asking the USER to pick among options surface
over headless stream-json, and how do we deliver the chosen option so the model
proceeds and reflects the choice?

**How AskUserQuestion is gated (from the binary).** The tool's own
`checkPermissions` returns a permission **ask**:

```js
// AskUserQuestion.checkPermissions:
{ behavior: "ask", message: "Answer questions?", updatedInput: { questions, ...metadata } }
```

In headless `default` mode an `"ask"` is **auto-denied** (same root cause as
ordinary permissions — "no client to answer it"). The interactive UI answers it
via a dialog whose answer-builder (binary fn `$9m`) produces a permission
**allow** whose `updatedInput` carries the chosen labels:

```js
// interactive answer → permission allow with the answers merged into the input:
{ behavior:"allow", updatedInput:{ ...input, answers:{ "<question text>":"<chosen label>" }, annotations:{…} } }
```

i.e. **the answer to AskUserQuestion is an `answers` map (question → chosen
option label) merged into the tool input.**

**What did NOT work (attempt 1 — `askq.mjs`).** Declaring the dialog kind in
the `initialize` handshake
(`supportedDialogKinds:["permission_ask_user_question"]`) and merely **allowing**
the PreToolUse `hook_callback` does **not** route a dialog to us. No
`request_user_dialog` control_request is emitted over headless stdio; the tool's
internal `"ask"` still parks and auto-cancels:

```jsonc
// CLI → us: the un-answerable dialog collapses into an is_error tool_result
{"type":"user","message":{"role":"user","content":[{"type":"tool_result","content":"Answer questions?","is_error":true,"tool_use_id":"toolu_…"}]}}
// result: model says it was "dismissed without a selection"; AskUserQuestion lands in permission_denials
```

(The `request_user_dialog` / `can_use_tool` direct paths are reserved for the
interactive bridge/Remote-Control transport — never emitted over headless
stdio, exactly like `can_use_tool` for ordinary permissions in §5b.)

**WORKING answer shape (attempt 2 — `askq2.mjs`).** Answer at the **PreToolUse
hook**: when the `hook_callback` fires for `tool_name === "AskUserQuestion"`,
reply `permissionDecision:"allow"` **and inject the answers into
`hookSpecificOutput.updatedInput`** (mirroring `$9m`). The CLI runs the tool
with the pre-filled `answers`, the tool emits a non-error `tool_result` stating
the selection, and the model reflects the choice.

The `hook_callback` request the CLI sends for AskUserQuestion (verbatim, the
`tool_input` is the full questions payload):

```json
{"type":"control_request","request_id":"…","request":{"subtype":"hook_callback","callback_id":"hook_0","input":{"hook_event_name":"PreToolUse","tool_name":"AskUserQuestion","tool_input":{"questions":[{"question":"Which language do you prefer?","header":"Language","multiSelect":false,"options":[{"label":"TypeScript","description":"…"},{"label":"Python","description":"…"}]}]},"tool_use_id":"toolu_…","session_id":"…","cwd":"/private/tmp/rc-spike5","permission_mode":"default", …}}}
```

- **Question/options shape**: `tool_input.questions[]` =
  `{question:<string>, header:<short label>, multiSelect:<bool>, options:[{label, description}]}`.
  AskUserQuestion always implicitly adds a Skip button + a free-text box, so the
  model is told not to include `None`/`Other` options.

The `control_response` the binary ACCEPTED (made the tool succeed):

```json
{"type":"control_response","response":{"subtype":"success","request_id":"…","response":{"async":false,"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","permissionDecisionReason":"spike auto-allow","updatedInput":{"questions":[…echoed…],"answers":{"Which language do you prefer?":"TypeScript"},"annotations":{"Which language do you prefer?":{"preview":"<option description>"}}}}}}}
```

- Same envelope as the §5c permission allow, with **two additions inside
  `hookSpecificOutput`**:
  - **`updatedInput`** — the original `tool_input` **plus** `answers` and
    (optional) `annotations`.
  - **`answers`** — `{ "<question text>": "<chosen option label>" }`. The key is
    the exact `question` string; the value is the exact option `label`.
    Multi-select / free-text would extend this (free text uses a `notes` field
    in `annotations`, per `$9m`); single-choice is just the label.
  - **`annotations`** (optional) — `{ "<question text>": {preview:"…", notes?:"…"} }`.
    Omitting it still works; it only enriches the tool_result preview.

What the CLI then emitted (the tool succeeded, **`permission_denials: []`**):

```jsonc
{"type":"user","message":{"role":"user","content":[{"type":"tool_result","content":"Your questions have been answered: \"Which language do you prefer?\"=\"TypeScript\" selected preview:\n…. You can now continue with these answers in mind.","tool_use_id":"toolu_…"}]}}
{"type":"assistant","message":{"content":[{"type":"text","text":"You picked TypeScript."}], …}}
{"type":"result","subtype":"success","result":"You picked TypeScript.","permission_denials":[]}
```

**Did the model reflect the choice? YES** — final text `"You picked
TypeScript."`. Re-running with choice `"Python"` selects the other label the
same way (pick `options.find(o => o.label === choice)`).

Binary cross-check (`strings`): `permission_ask_user_question` is a real dialog
kind (`{kind, payload:{requestId,toolName,permissionResult,questions},
result:{behavior}}`); the answer builder `$9m` returns
`{behavior:"allow", updatedInput:{...input, answers, annotations}}`;
`supportedDialogKinds` is an init field (`A.array(A.string()).optional()`,
"CLAUDE treats ABSENCE as 'cannot render'"). But the **dialog path never fires
over headless stdio** — the **PreToolUse-hook `updatedInput.answers`** injection
is the channel that works.

### B. Resume across process death + transcript location (SOLVED)

**Resume continues context? YES.**

1. Process 1: `claude … --session-id <UUID>` (stream-json, cwd
   `/private/tmp/rc-spike5`). Sent "Remember this codeword: BANANA42…" →
   `result:"OK"`; closed stdin → process **exited** (code 0).
2. Process 2 (fresh): **`claude … --resume <same UUID>`** (stream-json, **same
   cwd**). Asked "What was the codeword…" → `result:"BANANA42"`. Context
   survived process death.

**Exact resume invocation:** `--resume <session-id>` (NOT `--session-id` again —
that errors on an existing id; NOT `--continue`, which picks the most-recent
session implicitly). Same flags as steady-state
(`--input-format/--output-format stream-json --verbose
--include-partial-messages --permission-mode default`), **same cwd**, and the
same `initialize` handshake. The resumed turn keeps the **same `session_id`**
on every line (`f2b3cf5d-…`).

Caveat: `--resume` injects a synthetic warm-up turn (`user:"Continue from where
you left off."` → `assistant:"No response requested."`) before our first real
message. Harmless, but it appears in the transcript; the daemon should expect /
ignore it when rendering history.

**Transcript path + encoding.** History lives in ONE file per session:

```
~/.claude/projects/<ENCODED_CWD>/<session-id>.jsonl
```

- **`<ENCODED_CWD>` encoding** (binary fn `OS`):
  `cwd.replace(/[^a-zA-Z0-9]/g, "-")` — **every** non-alphanumeric char (`/`,
  `.`, `_`, space, …) becomes `-`; the leading `/` becomes a leading `-`. If the
  result exceeds a max length, it is truncated and a base36 hash of the full cwd
  is appended (`<truncated>-<hash>`). Examples observed:
  `/private/tmp/rc-spike5` → `-private-tmp-rc-spike5`;
  `/Users/<user>/Developer/remote-coder` → `-Users-<user>-Developer-remote-coder`;
  `…/magicplay.io` → `…-magicplay-io` (the `.` collapses to `-`). **Note:**
  because `.`/`_`/`/` all map to `-`, the encoding is lossy/ambiguous — the
  daemon should track the real cwd alongside the session, not reverse-derive it.
  (`/tmp` resolves through the `/private/tmp` symlink, so the macOS encoding uses
  `-private-tmp-…`.)
- **Resume reuses the same `<session-id>.jsonl`** — process 2 **appended** to
  the file process 1 wrote (it grew across the restart), so the whole
  conversation (both processes) is in one file.

**History is parseable. YES.** Newline-delimited JSON; one record per line.
Top-level `type` values seen: `user`, `assistant` (the renderable turns), plus
bookkeeping lines to skip (`queue-operation`, `attachment`, `last-prompt`,
`mode`). Renderable line shapes:

```jsonc
// user turn
{"type":"user","message":{"role":"user","content":[{"type":"text","text":"Remember this codeword: BANANA42…"}]},"uuid":"…","parentUuid":"…","timestamp":"2026-…Z","sessionId":"f2b3cf5d-…","cwd":"/private/tmp/rc-spike5","gitBranch":"…","version":"2.1.186"}
// assistant turn (content blocks: thinking | text | tool_use)
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"OK"}]},"requestId":"…","uuid":"…","parentUuid":"…","timestamp":"…","sessionId":"f2b3cf5d-…",…}
```

- **Each line carries `uuid` + `parentUuid`** → the turns form a linked tree
  (follow `parentUuid` for the active thread; sidechains/sub-agents branch off).
  Also present per line: `sessionId`, `cwd`, `timestamp`, `gitBranch`,
  `version`, `userType`, `entrypoint`.
- `message.content` is the standard Anthropic blocks array (text / thinking /
  tool_use / tool_result) — the **same** `message` shape as the live
  `assistant`/`user` stdout lines (§3), so one parser serves both. `tool_result`
  blocks live in `user` lines; `tool_use` in `assistant` lines.
- Rendering history = read the `.jsonl`, keep `type∈{user,assistant}`, walk the
  `parentUuid` chain, project each `message.content` to text/tool blocks.

### `encodeProjectDir` limitation (Plan 6 note)

`encodeProjectDir(cwd)` mirrors Claude's simple `[^a-zA-Z0-9] → '-'` substitution but does NOT implement
Claude's truncation + base36-hash branch for very long paths. For typical cwds this matches exactly. For an
unusually long cwd, the computed `~/.claude/projects/<dir>` name may diverge from Claude's actual directory,
so on-disk transcript history can read empty (the server falls back to the in-memory replay buffer for the
current session). This is a known, bounded limitation; porting the full truncation+hash branch is future work.
If history reads empty for a session in a deeply nested directory, this is the cause.

### Recommended Plan-5 approach

- **AskUserQuestion: BUILD the channel.** It works headlessly via the PreToolUse
  hook (which the daemon already runs for permissions — Plan 4). On a
  `hook_callback` with `tool_name === "AskUserQuestion"`: parse
  `input.tool_input.questions[]`, surface the questions/options to the remote
  user, collect their picks, then answer the **same** `hook_callback` with
  `permissionDecision:"allow"` + `hookSpecificOutput.updatedInput =
  {...tool_input, answers:{<question>:<label>}, annotations?}`. No
  `request_user_dialog`/`can_use_tool` handling needed; do **not** rely on
  `supportedDialogKinds` (it doesn't route over stdio). This reuses the existing
  permission round-trip plumbing — it's the same envelope plus an `answers`
  field. (If the remote user cancels/skips: answer `permissionDecision:"deny"`,
  which yields a normal denial the model handles.)
- **Resume: `--resume <id>` + read the `.jsonl` for history.** Steady state stays
  keep-alive (Plan 3 model A); on daemon restart, respawn with `--resume <id>`
  (same cwd) to rehydrate live context, and render past history by parsing
  `~/.claude/projects/<OS(cwd)>/<id>.jsonl` (filter to user/assistant, walk
  `parentUuid`). Store the real cwd per session (don't reverse the lossy
  encoding) and skip the synthetic "Continue from where you left off." warm-up
  turn. SQLite-only is unnecessary for history — the transcript jsonl already
  has it; SQLite remains the daemon's own session index/metadata store.

Source drivers: `scripts/spike/askq.mjs` (failed attempt — declare+allow),
`scripts/spike/askq2.mjs` (WORKING — hook `updatedInput.answers`),
`scripts/spike/resume.mjs` (resume + transcript).

### Live settings (set_model / set_max_thinking_tokens / set_permission_mode)

Captured by `scripts/spike/livesettings.mjs` against the **real** `claude`
v2.1.186 (subscription auth, `ANTHROPIC_API_KEY` unset, cwd
`/private/tmp/rc-spike-livesettings`). Flow: `initialize` handshake → turn 1
(warm-up) makes the session live → send each settings `control_request`
mid-session, then run a follow-up turn to observe the effect. Field names were
first read out of the binary's own Zod schemas + main-loop control handler, then
confirmed on the wire. **All three are ACCEPTED over headless stream-json stdin
on the first-guess shape** (the binary's main loop — not just the REPL bridge —
handles them). These are the **client → CLI** direction; `request_id` is
top-level and echoed back inside `response` (same envelope as §5).

The binary's verbatim Zod schemas (v2.1.186) — the source of truth for fields:

```js
A.object({ subtype:A.literal("set_model"), model:A.string().optional() })
A.object({ subtype:A.literal("set_max_thinking_tokens"),
           max_thinking_tokens:A.number().nullable(),
           thinking_display:A.enum(["summarized","omitted"]).nullable().optional() })
A.object({ subtype:A.literal("set_permission_mode"),
           mode:A.enum(["default","acceptEdits","bypassPermissions","plan","dontAsk","auto"]),
           ultraplan:A.boolean().optional() })
```

The full client→CLI mutating set is one Set in the binary:
`{"interrupt","set_permission_mode","set_model","set_max_thinking_tokens",
"set_color","mcp_toggle","message_rated"}` (plus `rename_session`).

#### 1. `set_model` — VERIFIED, effect OBSERVED

Working request (verbatim, we sent):

```json
{"type":"control_request","request_id":"ctl-…","request":{"subtype":"set_model","model":"claude-sonnet-4-6"}}
```

CLI reply — **ACCEPTED** (no payload):

```json
{"type":"control_response","response":{"subtype":"success","request_id":"ctl-…"}}
```

- **Exact field: `model`** (the guessed name; `modelName`/`value` not needed).
  `model` is **optional**; omitting it or sending `"default"` resets to the
  workspace default (binary: `e.request.model ?? "default"`).
- **Effect OBSERVED — yes.** After the switch, the **next turn's `system/init`
  reported `"model":"claude-sonnet-4-6"`** (was `"claude-opus-4-8[1m]"`), the
  `assistant` message block reported `"model":"claude-sonnet-4-6"`, and asking
  the model its id returned `result:"claude-sonnet-4-6"`. The switch takes effect
  on the **subsequent** turn (the in-flight turn keeps its model). The binary
  calls `notifyMetadataChanged({model})` and sets `mainLoopModelForSession`, so
  it's a session-scoped override.

#### 2. `set_max_thinking_tokens` — VERIFIED, effect uncertain (accepted)

Working request (verbatim, we sent):

```json
{"type":"control_request","request_id":"ctl-…","request":{"subtype":"set_max_thinking_tokens","max_thinking_tokens":30000}}
```

CLI reply — **ACCEPTED** (no payload):

```json
{"type":"control_response","response":{"subtype":"success","request_id":"ctl-…"}}
```

- **Exact field: `max_thinking_tokens`** (a `number`, and **nullable** — `null`
  clears it). The guessed name was right; `maxThinkingTokens`/`tokens`/`value`
  not needed.
- **Optional sibling `thinking_display`**: `"summarized"` | `"omitted"` | `null`
  (we omitted it → keeps the session-start `--thinking-display`). Sending `null`
  clears to the API default; a value replaces the session display mode.
- **Effect observed — uncertain.** The CLI accepts and updates session state
  (binary: `re = D_c(max_thinking_tokens, thinking_display)`), but there is **no
  per-turn stdout field** that echoes the budget, so the change isn't directly
  observable on the wire. Acceptance is confirmed; the numeric effect would only
  show up as more/less thinking in a thinking-heavy turn.

#### 3. `set_permission_mode` — VERIFIED, effect OBSERVED

Working request (verbatim, we sent):

```json
{"type":"control_request","request_id":"ctl-…","request":{"subtype":"set_permission_mode","mode":"acceptEdits"}}
```

CLI reply — **ACCEPTED**, and unlike the other two it **echoes a payload**:

```json
{"type":"control_response","response":{"subtype":"success","request_id":"ctl-…","response":{"mode":"acceptEdits"}}}
```

- **Exact field: `mode`** (the guessed name; `permissionMode`/`value` not needed).
  Valid values are the enum
  `["default","acceptEdits","bypassPermissions","plan","dontAsk","auto"]`.
  Optional `ultraplan:bool` exists (internal CCR marker; leave unset).
- **Effect OBSERVED — yes.** After switching to `acceptEdits`, the **next turn's
  `system/init` reported `"permissionMode":"acceptEdits"`** (was `"default"`),
  and the **`hook_callback` input for the tool carried
  `"permission_mode":"acceptEdits"`**. (A PreToolUse `hook_callback` still fires
  even in `acceptEdits` because we registered a hook in `initialize`; the hook
  is independent of mode. So the mode change is visible in `system/init` and the
  hook input, not by the hook disappearing.)

#### Effect summary

| subtype | accepted | exact field(s) | effect observed |
|---|---|---|---|
| `set_model` | yes | `model` (optional; `"default"`/omit resets) | yes — next `system/init`/`assistant`/`result` report the new model |
| `set_max_thinking_tokens` | yes | `max_thinking_tokens` (number\|null), `thinking_display?` (`"summarized"`/`"omitted"`/null) | accepted; no wire echo (uncertain) |
| `set_permission_mode` | yes | `mode` (enum above), `ultraplan?` | yes — next `system/init.permissionMode` + `hook_callback.input.permission_mode` reflect it; response echoes `{mode}` |

**Plan-5 Task 8 recommendation: implement all three now — they are verified
end-to-end.** They share the §5 control envelope (`request_id` top-level, echoed
in `response`), succeed mid-session over the existing keep-alive stdin (Plan 3
model A), and require no new transport. Apply each on its own turn boundary and
expect the change to take effect on the **next** user turn (the binary applies
`set_model` to `mainLoopModelForSession`, not the in-flight turn). For UI
confirmation: surface the new model/mode from the subsequent `system/init`
(`model`, `permissionMode`). `set_max_thinking_tokens` is safe to expose too
(accepted, session-scoped); just note its effect isn't echoed on the wire, so
the daemon should treat the `control_response` `success` as the confirmation
rather than waiting for a stdout reflection.

Source driver: `scripts/spike/livesettings.mjs`.
