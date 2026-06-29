// Client-side mirror of the Plan 3 server contract (packages/server/src/replay-buffer.ts,
// session-hub.ts, fs-service.ts, claude-process.ts and @remote-coder/protocol). Kept as a
// standalone type module so the browser bundle never imports the Node server package.

export type ServerFrameKind =
  | "event"
  | "permission"
  | "question"
  | "result"
  | "diagnostic"
  | "exit"
  | "attachment"
  | "rewound"
  // A pending prompt (question/permission) was answered/cancelled server-side — clear it now (so an
  // already-answered question doesn't linger or re-appear after a reconnect/OTA reload).
  | "resolve"
  // Control signal (never folded into the view): the reconnect replay buffer rotated PAST the client's
  // `?since=` position, so a delta replay would silently miss evicted frames — the client must refetch
  // the full REST history to become whole again. Consumed by the socket layer, not the reducer.
  | "resync";

export interface ServerFrame {
  seq: number;
  kind: ServerFrameKind;
  payload: unknown;
}

/**
 * Client-side mirror of the protocol's subagent lifecycle fields (packages/protocol/src/types.ts
 * `SystemTaskInfo`), surfaced by parseLine on a `system` event whose `subtype` starts with `task_`.
 * The frame-reducer reads these typed (it never digs in `raw`).
 *
 * Keying: `toolUseId` == the Agent tool_use id == children's `parentToolUseId` == the subagent thread
 * key. `taskId` == the resume `agentId`. Only `task_started` carries BOTH `taskId` and `toolUseId`;
 * `task_updated` carries ONLY `taskId` (apply its patch via a `taskId → toolUseId` map).
 */
export interface SystemTaskInfo {
  taskId?: string;
  toolUseId?: string;
  subagentType?: string;
  description?: string;
  prompt?: string;
  status?: string;
  summary?: string;
  patch?: { status?: string; endTime?: number };
  usage?: { totalTokens?: number; toolUses?: number; durationMs?: number };
  lastToolName?: string;
}

/**
 * Client-side mirror of an InboundEvent payload (the parsed `frame.payload` for `kind:"event"`). The
 * subagent feature reads `parentToolUseId` (the Agent tool_use id for a subagent's own inline message)
 * and, on a `system` task_* event, the typed `task` lifecycle.
 */
export interface EventPayload {
  type?: string;
  message?: unknown;
  event?: unknown;
  sessionId?: string;
  subtype?: string;
  /** `null`/absent for the main agent; the Agent tool_use id for a subagent's own inline message. */
  parentToolUseId?: string;
  uuid?: string;
  agents?: string[];
  /** The session's available slash commands (system/init `slash_commands`) — drives the composer menu. */
  slashCommands?: string[];
  /** The session's available tool names (system/init `tools`) — built-ins + `mcp__<server>__<tool>`;
   *  drives the MCP visibility panel (the `/mcp` equivalent). */
  tools?: string[];
  task?: SystemTaskInfo;
}

/**
 * Server-derived live tail for a session (mirror of session-hub `LiveState`), returned by GET
 * /sessions/:id. `turnActive` says a turn is mid-flight (so a switched-to chat shows "working" instead
 * of a wrong "idle"); `usage` is the last result's token usage (so the context meter shows immediately on
 * switch). Neither survives in the transcript or a `?since=` WS resume, hence the explicit seed.
 */
export interface LiveState {
  turnActive: boolean;
  usage?: { contextTokens?: number; outputTokens?: number; contextWindow?: number };
  /** The in-flight turn's output tokens so far (the live "Thinking… · N tok" counter) — so a chat
   *  reopened mid-turn shows the right count instead of zero; live deltas refine it after. */
  liveTokens?: number;
  /** A permission/question prompt still PENDING when the session was (re)opened. The transcript carries
   *  no prompt frames and the `?since=` resume skips the retained one, so without this a chat reopened
   *  mid-prompt showed "working" with no card to answer → stuck. Seeded into the view on loadHistory. */
  pendingPermission?: PermissionPayload;
  pendingQuestion?: QuestionPayload;
  /** The HONEST in-flight phase for a chat reopened mid-turn (only while `turnActive`): "running-tool" when
   *  a tool_use is genuinely unmatched (executing), else "thinking" (the model is generating). Used to seed
   *  the wire so reopen never fabricates a "Running tool" during thinking/streaming. Live frames refine it. */
  liveWire?: "running-tool" | "thinking";
}

/** One selectable model the account offers (mirror of the server's ModelOption, from the init handshake). */
export interface ModelOption {
  value: string;
  displayName: string;
  description?: string;
  supportedEffortLevels?: string[];
}

export interface SessionMeta {
  id: string;
  cwd: string;
  model?: string;
  /** The account's available models (from the live session's init handshake) — drives a real model picker
   *  instead of free-text. Absent on cold/old sessions; the client falls back to a curated static list. */
  availableModels?: ModelOption[];
  effort?: string;
  dangerouslySkip: boolean;
  status: "running" | "dormant" | "errored" | "stopped";
  createdAt: number;
  /** The `claude` CLI version this chat is running on (e.g. "2.1.187"), captured at spawn. Absent on
   *  dormant/old sessions. Shown compactly in Settings; compared to /claude/version's `latest` for the
   *  subtle "update available" hint. */
  claudeVersion?: string;
  permissionMode?: string;
  /**
   * Server truth: a permission OR question is pending for this session — TRUE even for sessions the
   * client is NOT actively connected to (the meta carries it). Drives the rail's "needs you" row
   * indicator + the global badge, so attention is visible from any chat. Optional so older payloads
   * (and test fixtures) default to "not awaiting".
   */
  awaiting?: boolean;
  /**
   * Server truth (ms): bumped on user-send AND on assistant/result, monotonic. The rail orders by
   * this (most-recent-first); a missing value falls back to `createdAt`. Optional so older payloads /
   * fixtures degrade gracefully.
   */
  lastActivityAt?: number;
}

/**
 * A past Claude conversation that can be resumed (server-side mirror: packages/server/src/transcript.ts,
 * GET /resumable). One row per on-disk transcript, recent-first. `summary` is the first user message
 * (the eye-level line); `lastActivity` is the transcript file mtime (ms).
 */
export interface ResumableSession {
  sessionId: string;
  cwd?: string;
  gitBranch?: string;
  summary: string;
  lastActivity: number;
  messageCount: number;
}

export interface DirEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  isGitRepo: boolean;
  gitBranch?: string;
}

export interface DirListing {
  path: string;
  parent?: string;
  entries: DirEntry[];
}

/**
 * An image block's source. `base64` is the inline form (a freshly-sent image, or a transcript image the
 * store couldn't back). `url` is the file-backed form used everywhere we control: the bytes live in the
 * content-addressed image store at the relative `url` (GET /images/<ref>) — the composer's optimistic
 * bubble and a reopen both ship this, fetched on demand so no base64 travels on our wire. `media_type`
 * is carried for the url form too (hint only). See content-images.ts.
 */
export type ImageSource =
  | { type: "base64"; media_type: string; data: string }
  | { type: "url"; media_type?: string; url: string };

export type ContentBlock = { type: "text"; text: string } | { type: "image"; source: ImageSource };

export interface PermissionPayload {
  requestId: string;
  kind: "hook_callback" | "can_use_tool";
  toolName?: string;
  toolInput?: unknown;
  toolUseId?: string;
}

export interface QuestionOption {
  label: string;
  description?: string;
  /** A concrete artifact to compare (ASCII mockup / code / config), rendered in a monospace box. */
  preview?: string;
}

export interface QuestionSpec {
  question: string;
  header?: string;
  multiSelect: boolean;
  options: QuestionOption[];
}

export interface QuestionPayload {
  requestId: string;
  /**
   * Routing key for the `ask_user` MCP tool (server-side mirror: session-hub.askUser). When present the
   * WS `answer` MUST carry it so the server resolves the matching held POST /ask long-poll (answerAsk).
   * Absent for the legacy built-in AskUserQuestion path, which routes by `requestId` back into the CLI.
   */
  askId?: string;
  toolUseId?: string;
  toolInput: unknown;
  questions: QuestionSpec[];
}

export interface ResultPayload {
  type: "result";
  subtype?: string;
  isError?: boolean;
  result?: string;
  sessionId?: string;
  totalCostUsd?: number;
  /** Wall-clock duration of the turn in ms (the CLI's `duration_ms`) — shown on the turn-end marker. */
  durationMs?: number;
  /**
   * Token usage for the turn. `contextTokens` = how full the model's context window now is (the whole
   * prompt sent + this turn's output), which drives the chat's context meter / "time to /compact" hint.
   * `outputTokens` = just this turn's generated tokens. `contextWindow` = the authoritative window size
   * the CLI reports for the model (e.g. 1_000_000 for a 1M variant) — the meter's denominator. Omitted
   * when the CLI doesn't report usage.
   */
  usage?: { contextTokens?: number; outputTokens?: number; contextWindow?: number };
  permissionDenials?: unknown[];
  /**
   * How the turn ended, when the CLI reports it. A user-initiated STOP (interrupt) ends the turn with
   * `terminal_reason:"aborted_streaming"` (and `subtype:"error_during_execution"`); the reducer reads
   * this to render the turn as a calm "Stopped" marker rather than a red error.
   */
  terminalReason?: string;
  raw: unknown;
}

export interface DiagnosticPayload {
  source: "stderr" | "parser";
  message: string;
}

/**
 * Claude sent a file/image to the chat (server-side mirror: packages/server/src/fs-service.ts).
 * Carries only the PATH — the web fetches the bytes via /fs/download (the `downloadUrl` builder) so a
 * large file never bloats the WS frame. `isImage` decides inline-image vs download-chip rendering.
 */
export interface AttachmentPayload {
  id: string;
  path: string;
  name: string;
  caption?: string;
  isImage: boolean;
}

/**
 * REWIND / CHECKPOINT outcome (server-side mirror: packages/server/src/session-hub.ts `rewound`). Emitted
 * after a `{type:"rewind"}` is processed. `mode` is which kind of rewind ran; `checkpointId` is the turn's
 * user-message uuid the session was taken back to. `ok:false` carries an `error` (e.g. checkpointing
 * disabled). For `conversation`/`both` the UI also truncates the displayed thread to that checkpoint.
 */
export interface RewoundPayload {
  checkpointId: string;
  mode: "code" | "conversation" | "both";
  ok: boolean;
  error?: string;
  canRewind?: boolean;
  filesChanged?: string[];
  insertions?: number;
  deletions?: number;
}

/**
 * OTA self-update (server-side mirror: packages/server/src/updater.ts). GET /version reports whether a
 * newer version is on origin/main and a grouped changelog of the behind commits; POST /update spawns
 * the detached pull+build+restart; GET /update/status reports the updater's progress.
 */
export interface ChangelogEntry {
  sha: string;
  subject: string;
  group: "new" | "fixes" | "improvements" | "other";
  when: string;
  date: string;
}

export interface VersionInfo {
  current: string;
  latest: string;
  behind: number;
  /** False when the server isn't a git checkout / has the wrong remote — hides the whole feature. */
  updatable: boolean;
  updateAvailable: boolean;
  changelog: ChangelogEntry[];
}

export type UpdateState =
  | "idle"
  | "starting"
  | "pulling"
  | "installing"
  | "building"
  | "restarting"
  | "done"
  | "failed";

export interface UpdateStatus {
  state: UpdateState;
  phase?: string;
  error?: string;
  target?: string;
  log?: string;
  updatedAt?: number;
}

/**
 * Claude usage limits (server-side mirror: packages/server/src/usage-service.ts). GET /usage reports the
 * 5-hour SESSION limit + the WEEKLY limit (all models) + an optional Sonnet-only weekly limit, each a
 * percent-used and a human reset string. `usage` is null when the feature is unavailable (claude not
 * logged in / not installed / parse failed) — the UI then hides the bars.
 */
export interface UsageBar {
  /** Percent of the limit used (0–100). */
  percent: number;
  /** Human reset string, e.g. "Jun 25 at 11:30pm (Europe/Istanbul)". The UI may shorten it. */
  resets: string;
}

export interface UsageInfo {
  /** The rolling 5-hour session limit. */
  session?: UsageBar;
  /** The weekly limit across all models. */
  week?: UsageBar;
  /** The Sonnet-only weekly limit (optional; not always present). */
  weekSonnet?: UsageBar;
  /** Server clock (ms) when the snapshot was parsed. */
  fetchedAt: number;
}

/** One selectable model from GET /models (server-normalized from the CLI init response). */
export interface ModelInfo {
  value: string;
  displayName: string;
  description?: string;
}

/** GET /auth/status — the server-side Claude sign-in state. `available:false` means the feature is off
 *  (no claude bin / a test server). `loggedIn` reflects stored creds existing (NOT that they still work —
 *  expired creds report loggedIn:true yet 401 on use, so the UI always offers re-authentication). */
export interface ClaudeAuthStatus {
  available: boolean;
  loggedIn?: boolean;
  email?: string;
  subscriptionType?: string;
  authMethod?: string;
  orgName?: string;
}

export type OutboundFrame =
  | {
      type: "user";
      content?: string;
      blocks?: ContentBlock[];
      text?: string;
      /** Refs of images uploaded to the content-addressed store (POST /images). The server reads the
       *  bytes and builds the base64 image block for Claude — no base64 travels on the WS. */
      imageRefs?: string[];
      /** Legacy inline base64 images (kept for back-compat; the composer now sends `imageRefs`). */
      images?: { mediaType: string; dataBase64: string }[];
      /**
       * SEND IDEMPOTENCY (#9): a uuid the composer mints ONCE per distinct user submission. It rides the
       * frame through the reconnect queue UNCHANGED, so a frame buffered during a blip and re-sent on the
       * next open carries the SAME id — the server then delivers it to Claude at most once (a duplicate
       * "force push"/"delete" prompt running twice is dangerous). Older clients omit it (server falls back
       * to no-dedup).
       */
      msgId?: string;
    }
  | { type: "permission"; requestId: string; decision: "allow" | "deny"; reason?: string }
  // ask_user path: { askId, answers } resolves the held POST /ask (the server routes by askId). Legacy
  // built-in path: { requestId, toolInput, answers } routes back into the CLI. Both fields optional so
  // either shape is valid; the web sends askId when the pending question carries one, else requestId.
  | {
      type: "answer";
      askId?: string;
      requestId?: string;
      toolInput?: unknown;
      answers: Record<string, string | string[]>;
    }
  | {
      type: "settings";
      model?: string;
      maxThinkingTokens?: number;
      effort?: string;
      permissionMode?: string;
      // A changed value RESPAWNS the session server-side (the permission boundary is fixed at spawn).
      dangerouslySkip?: boolean;
    }
  // STOP the running turn (interrupt). No payload — the server interrupts the session the WS is for.
  | { type: "interrupt" }
  // REWIND / CHECKPOINT: go back to a turn's checkpoint (its user-message uuid), optionally reverting
  // code and/or the conversation. `code` = live file rewind; `conversation`/`both` = resume truncated at
  // the checkpoint (and, for `both`, also rewind files on resume).
  | { type: "rewind"; checkpointId: string; mode: "code" | "conversation" | "both" }
  // FOREGROUND-GATING: report whether THIS connection's PWA tab is visible. The server suppresses a push
  // for a session while a foreground subscriber exists, so the user never gets a notification for the
  // chat they're actively looking at. Sent on document.visibilitychange and right after (re)connect.
  | { type: "visibility"; state: "foreground" | "background" };
