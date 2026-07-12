export const SERVER_PACKAGE = "@roamcode/server";
export {
  loadConfig,
  buildMcpConfigDocument,
  mcpConfigPathFor,
  buildHooksSettingsDocument,
  hooksSettingsPathFor,
  hookAuthPathFor,
  hookAuthFileContent,
} from "./config.js";
export type { ServerConfig, AttachSpawnOptions, McpConfigDocument, HooksSettingsDocument } from "./config.js";
export { loadServerConfig, isLoopbackAddress, assertConfigAllowsStart } from "./server-config.js";
export type { ServerRuntimeConfig } from "./server-config.js";
export { AuthGate, extractBearerToken } from "./auth.js";
export type { AuthGateOptions, AuthCheckResult } from "./auth.js";
export { FsService, FsError, SEARCH_MAX_DEPTH, SEARCH_MAX_DIRS, SEARCH_MAX_RESULTS } from "./fs-service.js";
export type { DirEntry, DirListing, DirSearchResult, FsServiceOptions, FsErrorCode } from "./fs-service.js";
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
export { createServer } from "./transport.js";
export type { CreateServerResult, CreateServerDeps } from "./transport.js";
export {
  registerStatic,
  isPublicPath,
  isPublicForRequest,
  isShellPath,
  pathForGate,
  hasEncodedSep,
  looksLikeAssetRequest,
  API_PATH_DENYLIST,
  SHELL_PATH_ALLOWLIST,
} from "./static-routes.js";
export type { RegisterStaticOptions } from "./static-routes.js";
export {
  startServer,
  claudePreflightWarning,
  runClaudePreflight,
  providerPreflightWarning,
  runProviderPreflight,
} from "./start.js";
export { TerminalProcess, tmuxSessionName } from "./terminal-process.js";
export type { TerminalProcessOptions, IPty, PtySpawn } from "./terminal-process.js";
export { TerminalManager } from "./terminal-manager.js";
export type { TerminalMeta, TerminalSub, TerminalManagerDeps } from "./terminal-manager.js";
export { detectTerminalSupport } from "./terminal-capability.js";
export { listTmuxSessions } from "./tmux-list.js";
export {
  classifyPaneStatus,
  capturePane,
  CLASSIFIER_TESTED_UP_TO,
  isNewerMajorMinor,
  classifierVersionWarning,
} from "./pane-status.js";
export type { PaneStatus, CaptureOptions } from "./pane-status.js";
export { WsTicketStore, WS_TICKET_TTL_MS } from "./ws-ticket.js";
export type { WsTicketStoreOptions } from "./ws-ticket.js";
export { openPushStore } from "./push-store.js";
export type { PushStore, PushSubscriptionRecord, OpenPushStoreOptions } from "./push-store.js";
export { createWebPushSend } from "./web-push-send.js";
export type { CreateWebPushSendOptions, PushSendFn, PushRecipient } from "./web-push-send.js";
export { createPushDispatcher, buildPushPayload } from "./push-dispatch.js";
export type {
  PushDispatcher,
  PushEvent,
  PushPayload,
  PushEventKind,
  CreatePushDispatcherDeps,
} from "./push-dispatch.js";
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
  normalizeProviderAvailability,
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
export { ProviderError } from "./providers/types.js";
export type {
  ProviderId,
  ProviderAvailability,
  ClaudeSessionOptions,
  CodexSessionOptions,
  ProviderSessionOptions,
  LaunchIntent,
  ProcessSpec,
  ProviderProcessContext,
  ProviderRuntimeSignal,
  ProviderRuntimeSignalParser,
  AgentProvider,
} from "./providers/types.js";
export { ProviderOptionsError, parseProviderOptions, parseLegacyClaudeArgs } from "./providers/options.js";
export { ProviderRegistry } from "./providers/registry.js";
export { createClaudeProvider } from "./providers/claude-provider.js";
export type { CreateClaudeProviderOptions } from "./providers/claude-provider.js";
export { ClaudeMetadataService, createClaudeMetadataRunner } from "./providers/claude-metadata-service.js";
export type { ClaudeMetadataRunner, ClaudeModelCatalogItem } from "./providers/claude-metadata-service.js";
export { createCodexProvider, buildCodexArgs } from "./providers/codex-provider.js";
export type { CreateCodexProviderOptions } from "./providers/codex-provider.js";
export { CodexMetadataService } from "./providers/codex-metadata-service.js";
export type {
  CodexMetadataRpc,
  CodexMetadataServiceOptions,
  CodexAccount,
  CodexModel,
  CodexUsage,
  CodexDeviceLogin,
  CodexLoginCompletion,
  CodexLoginStatus,
} from "./providers/codex-metadata-service.js";
export { CodexAppServerClient } from "./providers/codex-app-server-client.js";
export type { CodexAppServerClientOptions, CodexMetadataDiagnostics } from "./providers/codex-app-server-client.js";
export { CodexLatestService, parseCodexVersion } from "./providers/codex-latest-service.js";
export type { CodexVersionInfo, CodexInstallProvenance } from "./providers/codex-latest-service.js";
export { createCodexProfileClientLifecycle, isCodexProfileClientLifecycle } from "./providers/codex-profile-client.js";
export type {
  CodexProfileClientLifecycle,
  CreateCodexProfileClientLifecycleOptions,
} from "./providers/codex-profile-client.js";
export { createCodexThreadPersistence } from "./providers/codex-thread-persistence.js";
export type { CodexThreadPersistence } from "./providers/codex-thread-persistence.js";
export type { CodexSpawnLease } from "./providers/codex-thread-coordinator.js";
export {
  CodexThreadResolver,
  createCodexThreadInventory,
  resetCodexThreadResolutionCoordinatorForTests,
} from "./providers/codex-thread-resolver.js";
export type {
  CodexThreadInventoryEntry,
  CodexThreadResolverOptions,
  ResolveCodexThreadOptions,
} from "./providers/codex-thread-resolver.js";
export {
  CODEX_CLASSIFIER_TESTED_UP_TO,
  CODEX_OSC_MAX_CARRY,
  classifyCodexPane,
  codexClassifierVersionWarning,
  createCodexOscParser,
  parseCodexOscNotifications,
} from "./providers/codex-activity.js";
export type { CodexOscParser } from "./providers/codex-activity.js";
