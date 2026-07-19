export const SERVER_PACKAGE = "@roamcode.ai/server";
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
export type {
  SessionStore,
  StoredSession,
  StoredExternalSession,
  StoredStatus,
  StoredSessionFile,
  SessionFileDirection,
  SessionFileStorage,
  SessionFileKind,
  OpenSessionStoreOptions,
  StoreMode,
} from "./session-store.js";
export { normalizeSessionDefaults, SessionDefaultsConflictError } from "./session-defaults.js";
export type { SessionDefaults, StoredSessionDefaults } from "./session-defaults.js";
export {
  resolveDataDir,
  ensureDataDir,
  resolveAccessToken,
  generateAccessToken,
  persistAccessToken,
} from "./data-dir.js";
export type { ResolveAccessTokenOptions } from "./data-dir.js";
export { openDeviceStore, normalizeDeviceName, normalizeDeviceScopes, PAIRING_TTL_MS } from "./device-store.js";
export type {
  DeviceStore,
  DeviceInfo,
  DeviceEnrollment,
  PairingTicket,
  OpenDeviceStoreOptions,
  DeviceScope,
} from "./device-store.js";
export { InputLeaseCoordinator, INPUT_LEASE_TTL_MS } from "./input-lease.js";
export type {
  InputLease,
  InputLeasePrincipal,
  InputLeaseActorType,
  InputLeaseEvent,
  InputLeaseAcquireResult,
  InputLeaseCoordinatorOptions,
} from "./input-lease.js";
export {
  openTeamStore,
  teamRolePermissions,
  isTeamRole,
  isTeamScopeType,
  TeamRevisionConflictError,
} from "./team-store.js";
export { PresenceCoordinator, PRESENCE_TTL_MS, PRESENCE_HEARTBEAT_MS } from "./presence.js";
export type {
  PresenceRecord,
  PresenceTarget,
  PresenceMode,
  PresenceEvent,
  PresenceHeartbeatInput,
  PresenceCoordinatorOptions,
} from "./presence.js";
export { createTeamAuthorizer } from "./authorization.js";
export type { AuthorizationDecision, Authorizer } from "./authorization.js";
export type {
  TeamStore,
  TeamStoreMode,
  TeamRecord,
  TeamMember,
  TeamMemberKind,
  TeamMemberStatus,
  TeamRole,
  TeamScopeType,
  TeamPrincipalType,
  TeamPermission,
  TeamRoleBinding,
  TeamPrincipalBinding,
  TeamAuthorizationResource,
  TeamAuthorizationDecision,
  OpenTeamStoreOptions,
} from "./team-store.js";
export { openPolicyStore, evaluateEnterprisePolicy, EnterprisePolicyRevisionConflictError } from "./policy-store.js";
export type {
  PolicyStore,
  PolicyStoreMode,
  EnterprisePolicy,
  EnterprisePolicyUpdate,
  EnterprisePolicyAction,
  EnterprisePolicyContext,
  EnterprisePolicyDecision,
  ExtensionPolicyMode,
  UpdatePolicyMode,
  OpenPolicyStoreOptions,
} from "./policy-store.js";
export { openPeerStore, normalizePeerBaseUrl, PeerRevisionConflictError } from "./peer-store.js";
export type {
  PeerStore,
  PeerStoreMode,
  PeerRecord,
  PeerConnection,
  PeerAction,
  PeerStatus,
  CreatePeerInput,
  UpdatePeerInput,
  OpenPeerStoreOptions,
} from "./peer-store.js";
export { requestPeerJson, verifyPeerConnection, PeerRequestError } from "./peer-client.js";
export type { PeerJsonResponse, VerifiedPeerIdentity } from "./peer-client.js";
export {
  openCommandCenterStore,
  currentAgentIdForSession,
  normalizeCommandCenterLabel,
  CommandCenterRevisionConflictError,
} from "./command-center-store.js";
export { createWorktreeService, WorktreeError } from "./worktree-service.js";
export type {
  WorktreeService,
  WorktreeRecord,
  CreateWorktreeInput,
  CreateWorktreeResult,
  CreateWorktreeServiceOptions,
  WorktreeErrorCode,
} from "./worktree-service.js";
export {
  openExtensionManager,
  inspectExtensionPackage,
  parseMarketplaceIndex,
  searchMarketplace,
  ExtensionError,
} from "./extension-manager.js";
export type {
  ExtensionManager,
  ExtensionKind,
  ExtensionTrust,
  ExtensionManifestV1,
  ExtensionVersionRecord,
  InstalledExtension,
  InstallExtensionInput,
  OpenExtensionManagerOptions,
  PluginManifestV1,
  PluginPermission,
  AdapterPackageManifestV1,
  AdapterRuntimeV1,
  MarketplaceEntry,
} from "./extension-manager.js";
export { createPluginRuntime, PluginRuntimeError } from "./plugin-runtime.js";
export type {
  PluginRuntime,
  PluginRunInput,
  PluginRunResult,
  PluginAuditEvent,
  CreatePluginRuntimeOptions,
} from "./plugin-runtime.js";
export {
  openControlStore,
  normalizeAutomationInput,
  normalizeAutomationTrigger,
  normalizeAutomationAction,
  privacySafeAuditMetadata,
  CONTROL_IDEMPOTENCY_TTL_MS,
} from "./control-store.js";
export type {
  ControlStore,
  ControlStoreMode,
  IdempotencyRecord,
  AuditRecord,
  AuditActorType,
  AuditResult,
  AutomationDefinition,
  AutomationTrigger,
  AutomationAction,
  AutomationRun,
  CreateAutomationInput,
  UpdateAutomationInput,
  OpenControlStoreOptions,
} from "./control-store.js";
export { openSessionAutomationStore, SessionAutomationRevisionConflictError } from "./session-automation-store.js";
export type {
  SessionAutomationStore,
  SessionAutomationStoreMode,
  SessionAutomationDefinition,
  SessionAutomationRun,
  SessionAutomationRunStatus,
  SessionAutomationTrigger,
  CreateSessionAutomationInput,
  CreateSessionAutomationRunInput,
  UpdateSessionAutomationInput,
  OpenSessionAutomationStoreOptions,
} from "./session-automation-store.js";
export {
  agentRuntimeId,
  productContextFromOwner,
  ownerFromProductContext,
  projectNodeRecord,
  projectAgentRuntimeRecords,
} from "./node-domain.js";
export type {
  OwnerRef,
  ProductContext,
  NodeAlias,
  NodeRecord,
  AgentRuntimeAuthState,
  AgentRuntimeRecord,
} from "./node-domain.js";
export type {
  CommandCenterStore,
  CommandCenterStoreMode,
  HostRecord,
  WorkspaceRecord,
  WorkspaceKind,
  SessionPlacement,
  AgentRecord,
  AgentActivity,
  AttentionItem,
  AttentionKind,
  AttentionState,
  CommandEvent,
  CommandLayoutEnvelope,
  OpenCommandCenterStoreOptions,
} from "./command-center-store.js";
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
  PWA_BOOT_WATCHDOG_SHA256,
  PWA_CONTENT_SECURITY_POLICY,
} from "./static-routes.js";
export type { RegisterStaticOptions } from "./static-routes.js";
export {
  startServer,
  claudePreflightWarning,
  runClaudePreflight,
  providerPreflightWarning,
  runProviderPreflight,
} from "./start.js";
export { installProcessLifecycle, safeProcessErrorSummary } from "./process-lifecycle.js";
export type { ProcessLifecycleOptions, ProcessLifecycleTarget, ProcessLifecycleHandle } from "./process-lifecycle.js";
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
export type { WsTicketStoreOptions, WsTicketContext } from "./ws-ticket.js";
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
  defaultUpdaterFs,
  defaultFetchReleases,
  defaultFetchManifest,
  stableReleases,
  normalizeRelease,
  parseReleaseNotes,
  relativeWhen,
  computeInstallDrift,
  RUNNING_VERSION,
  CHECK_CACHE_MS,
  FETCH_TIMEOUT_MS,
} from "./updater.js";
export type {
  UpdaterDeps,
  UpdaterFs,
  FetchReleases,
  FetchManifest,
  GitHubRelease,
  ReleaseRecord,
  ChangelogEntry,
  VersionInfo,
  UpdateState,
  UpdateStatus,
  UpdateAction,
  InstallationKind,
} from "./updater.js";
export { RUNNING_BUILD, computeBuildDrift } from "./updater.js";
export {
  resolveInstallRoot,
  managedPaths,
  readActiveVersion,
  readPreviousVersion,
  writeManagedLauncher,
  renderManagedLauncher,
  installManagedRelease,
  isStableVersion,
  compareVersions,
} from "./managed-runtime.js";
export type {
  ManagedPaths,
  ManagedInstallOptions,
  ManagedInstallResult,
  ManagedInstallStatus,
} from "./managed-runtime.js";
export {
  installService,
  readServiceRecord,
  migrateServiceToLauncher,
  restartService,
  enableService,
  renderLaunchdPlist,
  renderSystemdUnit,
  buildServicePath,
} from "./service-install.js";
export type {
  InstallServiceContext,
  InstallServiceResult,
  ServiceRecord,
  RenderLaunchdOptions,
  RenderSystemdOptions,
} from "./service-install.js";
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
export type { UsageInfo, Bar, ModelWeekBar, RunUsage, UsageServiceDeps } from "./usage-service.js";
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
  ProviderAdapterV1,
} from "./providers/types.js";
export {
  ADAPTER_CONTRACT_VERSION,
  adapterCapabilityNames,
  validateAdapterOptionSchema,
  validateAdapterManifest,
  defineAdapterManifest,
  publicAdapterDescriptor,
  AdapterManifestError,
} from "./providers/adapter-contract.js";
export type { AdapterManifestV1, AdapterCapabilityName, AdapterStateAuthority } from "./providers/adapter-contract.js";
export { ProviderOptionsError, parseProviderOptions, parseLegacyClaudeArgs } from "./providers/options.js";
export { ProviderRegistry } from "./providers/registry.js";
export { createInstalledAdapterProvider } from "./providers/installed-adapter-provider.js";
export type { CreateInstalledAdapterProviderOptions } from "./providers/installed-adapter-provider.js";
export type { ReturnTypeOfDescriptors } from "./providers/registry.js";
export { buildOpenApiDocument } from "./openapi.js";
export type { OpenApiBuildOptions } from "./openapi.js";
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
export {
  resolveCodexExecutable,
  defaultProbeCodexExecutable,
  CODEX_EXECUTABLE_PROBE_TIMEOUT_MS,
  OPENAI_CODE_SIGNING_TEAM_ID,
} from "./providers/codex-executable.js";
export type {
  CodexExecutableProbe,
  CodexExecutableResolution,
  CodexExecutableDeps,
  ResolveCodexExecutableOptions,
} from "./providers/codex-executable.js";
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
