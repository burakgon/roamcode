export const SERVER_PACKAGE = "@remote-coder/server";
export type { QuestionSpec, QuestionOption } from "@remote-coder/protocol";
export {
  loadConfig,
  buildClaudeArgs,
  buildMcpConfigDocument,
  mcpConfigPathFor,
  PERMISSION_MODES,
  LIVE_PERMISSION_MODES,
  isLivePermissionMode,
} from "./config.js";
export type { ServerConfig, BuildClaudeArgsOptions, AttachSpawnOptions, McpConfigDocument } from "./config.js";
export { ClaudeProcess, ClaudeStartError, looksLikeAuthError } from "./claude-process.js";
export type {
  ClaudeProcessOptions,
  PermissionEvent,
  QuestionEvent,
  DiagnosticEvent,
  ClaudeStartErrorCode,
} from "./claude-process.js";
export { SessionManager } from "./session-manager.js";
export type { CreateSessionOptions, Session, SessionManagerDeps } from "./session-manager.js";
export { loadServerConfig, isLoopbackAddress, assertConfigAllowsStart } from "./server-config.js";
export type { ServerRuntimeConfig } from "./server-config.js";
export { AuthGate, extractBearerToken } from "./auth.js";
export type { AuthGateOptions, AuthCheckResult } from "./auth.js";
export { FsService, FsError } from "./fs-service.js";
export type { DirEntry, DirListing, FsServiceOptions, FsErrorCode, AttachmentPayload } from "./fs-service.js";
export { ReplayBuffer, isCriticalKind } from "./replay-buffer.js";
export type { ServerFrame, ServerFrameKind } from "./replay-buffer.js";
export {
  SessionHub,
  ASK_TIMEOUT_MS,
  SPOOL_RECOVERY_TTL_MS,
  liveStateFromBuffer,
  accumulateLiveTokens,
} from "./session-hub.js";
export type {
  SessionHubOptions,
  SessionMeta,
  SessionStatus,
  LiveState,
  FrameListener,
  Subscription,
  LiveSettings,
  AskAnswers,
  AskResult,
} from "./session-hub.js";
export { openSessionStore } from "./session-store.js";
export type { SessionStore, StoredSession, StoredStatus, OpenSessionStoreOptions, StoreMode } from "./session-store.js";
export {
  resolveDataDir,
  ensureDataDir,
  resolveAccessToken,
  generateAccessToken,
  persistAccessToken,
} from "./data-dir.js";
export type { ResolveAccessTokenOptions } from "./data-dir.js";
export { isOriginAllowed, normalizeOrigin, parseAllowedOrigins } from "./origin-check.js";
export type { OriginCheckOptions } from "./origin-check.js";
export { RateLimiter } from "./rate-limit.js";
export type { RateLimiterOptions, RateLimitDecision } from "./rate-limit.js";
export { resolveVapidKeys } from "./vapid.js";
export type { VapidKeys, ResolveVapidKeysOptions } from "./vapid.js";
export { createServer, mapSpawnError } from "./transport.js";
export type { CreateServerResult, CreateServerDeps } from "./transport.js";
export {
  registerStatic,
  isPublicPath,
  isPublicForRequest,
  pathForGate,
  hasEncodedSep,
  looksLikeAssetRequest,
  API_PATH_DENYLIST,
} from "./static-routes.js";
export type { RegisterStaticOptions } from "./static-routes.js";
export { startServer, claudePreflightWarning, runClaudePreflight } from "./start.js";
export { HistoryService } from "./history-service.js";
export type { HistoryServiceOptions } from "./history-service.js";
export { ImageStore } from "./image-store.js";
export type { ImageStoreOptions } from "./image-store.js";
export {
  parseTranscript,
  transcriptToFrames,
  listResumable,
  findTranscriptFile,
  defaultProjectsDir,
} from "./transcript.js";
export type { TranscriptMessage, ParsedTranscript, ResumableSession, ListResumableOptions } from "./transcript.js";
export { openIdempotencyStore } from "./idempotency.js";
export type { IdempotencyStore, OpenIdempotencyStoreOptions } from "./idempotency.js";
export { openFrameSpool, inMemoryFrameSpool, isSpoolable, spoolFrameIdentity, SPOOL_CAP } from "./frame-spool.js";
export type { FrameSpool, OpenFrameSpoolOptions } from "./frame-spool.js";
export { createSendDedup } from "./send-dedup.js";
export type { SendDedup, CreateSendDedupOptions } from "./send-dedup.js";
export { openPushStore } from "./push-store.js";
export type { PushStore, PushSubscriptionRecord, OpenPushStoreOptions } from "./push-store.js";
export { PushDispatcher } from "./push-dispatcher.js";
export type { PushMessage, PushSendFn, PushDispatcherOptions } from "./push-dispatcher.js";
export { createWebPushSend } from "./web-push-send.js";
export type { CreateWebPushSendOptions } from "./web-push-send.js";
export {
  Updater,
  createUpdater,
  defaultRunGit,
  defaultUpdaterFs,
  parseChangelog,
  parseConventionalSubject,
  groupForPrefix,
  relativeWhen,
  versionLabel,
  renderRestartCommand,
  renderUpdaterScript,
  EXPECTED_REMOTE_SUBSTRING,
  CHECK_CACHE_MS,
  FETCH_TIMEOUT_MS,
} from "./updater.js";
export type {
  UpdaterDeps,
  UpdaterFs,
  RunGit,
  RunGitResult,
  ChangelogEntry,
  VersionInfo,
  UpdateState,
  UpdateStatus,
  RenderUpdaterScriptOptions,
} from "./updater.js";
export { RUNNING_BUILD, computeBuildDrift } from "./updater.js";
export {
  createClaudeVersionProbe,
  defaultRunClaudeVersion,
  parseClaudeVersion,
  CLAUDE_VERSION_CACHE_MS,
  CLAUDE_VERSION_TIMEOUT_MS,
} from "./diag.js";
export type { ClaudeAvailability, ClaudeVersionProbe, RunClaudeVersion } from "./diag.js";
export {
  UsageService,
  createUsageService,
  createUsageRunner,
  parseUsage,
  USAGE_CACHE_MS,
  USAGE_TIMEOUT_MS,
} from "./usage-service.js";
export type { UsageInfo, Bar, RunUsage, UsageServiceDeps } from "./usage-service.js";
export { ClaudeAuthService, createClaudeAuthService, parseAuthStatus, extractLoginUrl } from "./claude-auth-service.js";
export type { ClaudeAuthStatus, ClaudeAuthDeps } from "./claude-auth-service.js";
export {
  ClaudeLatestService,
  createClaudeLatestService,
  parseNpmLatest,
  CLAUDE_LATEST_CACHE_MS,
} from "./claude-latest-service.js";
export type { ClaudeLatestDeps, FetchLatest } from "./claude-latest-service.js";
