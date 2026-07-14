import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LoginScreen } from "./auth/LoginScreen";
import { loadToken, saveToken, clearToken, consumeTokenFromUrl } from "./auth/token-store";
import { createApiClient, ApiError } from "./api/client";
import { API_BASE_URL } from "./config";
import { useStore } from "./store/store";
import { useShallow } from "zustand/react/shallow";
import { AppLayout } from "./AppLayout";
import { SessionList, awaitingCount } from "./session/SessionList";
import { sortSessions } from "./session/order";
import { loadSessionOrder, saveSessionOrder, type SessionOrder } from "./session/order-preference";
import { sessionIdFromLocation } from "./session/deep-link";
import { NewSessionWizard } from "./session/NewSessionWizard";
import { loadRecentDirs } from "./picker/recents";
import { TerminalView } from "./chat/TerminalView";
import { HelpSheet } from "./chat/HelpSheet";
import { SettingsPanel } from "./settings/SettingsPanel";
import type { DefaultsSaveState } from "./settings/SettingsPanel";
import { ClaudeAuthDialog } from "./settings/ClaudeAuthDialog";
import { loadDefaults, saveDefaults } from "./settings/defaults";
import type { SessionDefaults } from "./settings/defaults";
import { hydrateSessionDefaults, persistSessionDefaults } from "./settings/defaults-sync";
import type { DefaultsSyncState } from "./settings/defaults-sync";
import { enablePush, disablePush, currentPushState } from "./pwa/push";
import { applyAppBadge, badgeCount } from "./pwa/badge";
import { playNeedsYouChime, needsYouHaptic, unlockAudio } from "./pwa/alert-sound";
import { isIosWebKit } from "./pwa/platform";
import { healPaintBurst } from "./pwa/viewport";
import { InstallPrompt } from "./pwa/InstallPrompt";
import { ConnectionBanner } from "./pwa/ConnectionBanner";
import { UpdateBanner } from "./pwa/UpdateBanner";
import { UpdatePanel } from "./update/UpdatePanel";
import { UpdateProgressBanner } from "./update/UpdateProgressBanner";
import { ErrorBoundary } from "./ErrorBoundary";
import { BUILD_VERSION } from "./build-info";
import { claimAutoRefresh, hardRefresh, isClientStale, prepareForAppReopen } from "./update/stale-client";
import {
  UPDATE_SLOW_MS,
  bareVersion,
  loadUpdateOperation,
  operationReachedTarget,
  saveUpdateOperation,
  statusBelongsToOperation,
  type UpdateConnectionState,
  type UpdateOperation,
} from "./update/lifecycle";
import { useOnline } from "./pwa/online-status";
import { Icon } from "./ui/Icon";
import { MobileMenuButton } from "./ui/MobileMenuButton";
import { SplitWorkspace } from "./split/SplitWorkspace";
import { useSplitCapable } from "./split/capable";
import {
  findLeaf,
  findLeafBySession,
  leaves,
  loadLayout,
  makeLeaf,
  moveLeaf,
  normalize,
  removeLeaf,
  saveLayout,
  setLeafSession,
  splitLeaf,
  swapLeafSessions,
  type DropEdge,
  type StoredLayout,
} from "./split/layout";
import { isWorkspaceDrag, SESSION_MIME, type DropZone } from "./split/dnd";
import type { ClaudeAuthStatus, ModelInfo, SessionMeta, UpdateStatus } from "./types/server";
import type { CodexAuthStatus, CodexModel, CodexUsage, ProviderSummaries } from "./providers/types";
import type { ProviderAuthState, ProviderAuthStates } from "./providers/ProviderPicker";

type Phase = "login" | "validating" | "ready";

function checkingProviderAuth(): ProviderAuthStates {
  return { claude: "checking", codex: "checking" };
}

function claudeAuthState(status: ClaudeAuthStatus): ProviderAuthState {
  if (!status.available) return "unavailable";
  return status.loggedIn === true ? "signed-in" : "signed-out";
}

function codexAuthState(status: CodexAuthStatus): ProviderAuthState {
  if (!status.available) return "unavailable";
  return status.authenticated === true ? "signed-in" : "signed-out";
}

/** The last path segment of a cwd — the human-readable session label used in toasts. */
function basename(p: string): string {
  const parts = p.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || p;
}

/** Display name for a session in the "needs you" alert: the SERVER name first (the cross-device truth),
 *  then the local label (localStorage, shared with the rail), else the cwd basename. Best-effort — a
 *  storage read failure just falls back down the chain. */
function sessionLabel(s: { id: string; cwd: string; name?: string }): string {
  const server = s.name?.trim();
  if (server) return server;
  try {
    const names = JSON.parse(localStorage.getItem("rc-session-names") || "{}") as Record<string, string>;
    const custom = names[s.id]?.trim();
    if (custom) return custom;
  } catch {
    /* ignore malformed / blocked storage */
  }
  return basename(s.cwd);
}

/**
 * After an OTA update the SERVER is on the new build, but THIS open page is still running the old
 * precached bundle: vite-plugin-pwa's autoUpdate service worker only re-checks for a new SW on a
 * navigation, never while the PWA stays open — so the update appeared to "not apply" until the user
 * fully closed and reopened. Force a check NOW: the new SW installs and (autoUpdate) takes control, and
 * main.tsx reloads the page on `controllerchange`. A delayed reload is a safety net if that never fires.
 * Gated on `navigator.serviceWorker` (absent in jsdom/dev), so it's inert in tests.
 */
let reloadScheduled = false;
function requestReloadForNewVersion(): void {
  if (typeof navigator === "undefined" || !navigator.serviceWorker) return;
  // Guard: both the version poll AND the update-status poll can detect the new version, and each could
  // fire this — schedule the (uncancellable) fallback reload only ONCE.
  if (reloadScheduled) return;
  reloadScheduled = true;
  void navigator.serviceWorker.getRegistration().then((reg) => reg?.update());
  setTimeout(() => {
    // Only hard-reload if we're STILL on the old bundle. If the SW already swapped us onto the new one
    // (the controllerchange path in main.tsx), reloading again would needlessly yank the page out from
    // under the user — losing unsent composer text / an in-flight answer — for no gain. Re-arm if skipped
    // so a later genuine version bump can still schedule one.
    const serverLabel = useStore.getState().updateInfo?.current;
    // replace(href), not reload(): see main.tsx. On iOS BOTH freeze the standalone compositor post-OTA, so we
    // never auto-reload there — the "close & reopen to update" banner covers it. Elsewhere, swap to the new bundle.
    if (!IOS_WEBKIT && isClientStale(BUILD_VERSION, serverLabel)) window.location.replace(window.location.href);
    else reloadScheduled = false;
  }, 10_000);
}

// iOS/WebKit: every automatic in-page reload freezes the standalone compositor (see ./pwa/platform). Computed
// once; gates the stale-bundle self-heal + the post-update reload so neither ever auto-reloads on iOS.
const IOS_WEBKIT = isIosWebKit();

export function App() {
  // Prefer a `?token=` in the connect URL (the link the server prints): persist it + strip it from
  // the address bar, so opening the printed link authenticates directly instead of prompting. Falls
  // back to a previously stored token.
  const [token, setTokenState] = useState<string | undefined>(() => consumeTokenFromUrl() ?? loadToken());
  const [sessionOrder, setSessionOrderState] = useState<SessionOrder>(() => loadSessionOrder());
  const changeSessionOrder = (order: SessionOrder) => {
    setSessionOrderState(order);
    saveSessionOrder(order);
  };
  const [phase, setPhase] = useState<Phase>(token === undefined ? "login" : "validating");
  const [loginError, setLoginError] = useState<string | undefined>();
  // SCOPED selector (useShallow) over only the fields the shell needs. Actions are stable; state fields
  // are shallow-compared, so the shell re-renders only when one it actually uses changes.
  const {
    sessions,
    setSessions,
    mergeSessionMeta,
    addSession,
    setToken,
    activeSessionId,
    setActive,
    removeSession,
    lastActiveAt,
    updateInfo,
    setUpdateInfo,
    updateState,
    setUpdateState,
    usage,
    setUsage,
  } = useStore(
    useShallow((s) => ({
      sessions: s.sessions,
      setSessions: s.setSessions,
      mergeSessionMeta: s.mergeSessionMeta,
      addSession: s.addSession,
      setToken: s.setToken,
      activeSessionId: s.activeSessionId,
      setActive: s.setActive,
      removeSession: s.removeSession,
      lastActiveAt: s.lastActiveAt,
      updateInfo: s.updateInfo,
      setUpdateInfo: s.setUpdateInfo,
      updateState: s.updateState,
      setUpdateState: s.setUpdateState,
      usage: s.usage,
      setUsage: s.setUsage,
    })),
  );
  const [wizardOpen, setWizardOpen] = useState(false);
  // Claude's legacy snapshot remains in the shared store; Codex usage is rail-local shell state. Both are
  // last-good snapshots, so a transient provider metadata failure never makes limits disappear.
  const [codexUsage, setCodexUsage] = useState<CodexUsage | null>();
  // When the wizard is opened via "＋ here" (a per-row / same-folder shortcut), this prefills the folder so
  // the wizard skips the directory picker. Undefined → the normal pick-a-directory flow.
  const [wizardCwd, setWizardCwd] = useState<string | undefined>(undefined);
  // A small, dismissible error surfaced when a close actually FAILS (so we don't silently pretend a
  // session is gone). Cleared on the next close attempt or when the user dismisses it.
  const [closeError, setCloseError] = useState<string | undefined>();
  // UNDO a close: after the optimistic removal we hold the closed session briefly so an "Undo" toast can
  // re-add + re-select it (a fat-finger safety net for the one-tap destructive ✕). Auto-expires.
  const [pendingUndo, setPendingUndo] = useState<{ session: SessionMeta; wasActive: boolean } | undefined>(undefined);
  const undoTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // Claude sign-in awareness: the server-side Claude login can expire (every turn then 401s inside the
  // TUI with no app signal). We poll GET /auth/status; when the feature is available but NOT signed in we
  // surface a dismissible banner whose CTA opens the in-app re-auth dialog (no SSH needed).
  const [authStatus, setAuthStatus] = useState<ClaudeAuthStatus | undefined>(undefined);
  const claudeAuthRequestGeneration = useRef(0);
  const [claudeAuthOpen, setClaudeAuthOpen] = useState(false);
  const [claudeAuthBannerDismissed, setClaudeAuthBannerDismissed] = useState(false);
  // Surfaced when the INITIAL session load fails for a non-auth reason (server down / wrong host /
  // network): without this the app silently dropped you into an empty list. Cleared on any successful
  // (re)load — the background poll keeps retrying.
  const [loadError, setLoadError] = useState<string | undefined>();
  // Consecutive background-poll failures — surfaces loadError only after the server is genuinely
  // unreachable (not a single blip), reset on the next success.
  const pollFailures = useRef(0);
  // GLOBAL settings (defaults for new sessions + notifications), reachable WITHOUT opening a chat — from
  // the rail header and the landing top bar. Rendered with no `session`, so it shows only the global
  // sections. Push state is read once (the opt-in itself is a deliberate tap).
  const [globalSettingsOpen, setGlobalSettingsOpen] = useState(false);
  // SESSION-SCOPED settings — the same SettingsPanel, but seeded with the ACTIVE session so it shows the
  // "This session" block. Opened from the chat header's gear (ChatHeader → TerminalView `onOpenSettings`).
  const [sessionSettingsOpen, setSessionSettingsOpen] = useState(false);
  const [defaultsSync, setDefaultsSync] = useState<DefaultsSyncState>(() => ({
    status: "loading",
    defaults: loadDefaults(),
    revision: 0,
  }));
  const defaultsGeneration = useRef(0);
  const [defaultsSaveState, setDefaultsSaveState] = useState<DefaultsSaveState>("idle");
  const [defaultsSaveError, setDefaultsSaveError] = useState<string | undefined>();
  // iOS-Safari compositor fix: gate the (heavy) terminal mount so that, when SWITCHING sessions, xterm is
  // built a couple frames AFTER the session-select layout swap has painted — not synchronously in the same
  // commit that closes the sessions sheet. Mounting xterm mid-transition blocks the main thread and freezes
  // iOS's compositor on the stale frame (worst on the cold first select — "ekran siyah / liste takılı").
  // Starts true so initial load / a restored session / tests mount immediately (no sheet transition there);
  // onSelect drops it to false for the switch, then a double-rAF flips it back once the swap has painted.
  const [terminalMountReady, setTerminalMountReady] = useState(true);

  // ---- Desktop split-screen workspace (iTerm2-style panes; split/layout.ts owns the model) ----
  // The tree + focused pane live here and persist per browser. MOBILE IS UNTOUCHED: splitCapable is false on
  // any coarse-pointer/narrow window (and in jsdom), so the battle-hardened single-view path renders there.
  const splitCapable = useSplitCapable();
  const [layout, setLayout] = useState<StoredLayout>(() => {
    const stored = loadLayout();
    if (stored) return stored;
    const solo = makeLeaf();
    return { tree: solo, focusedLeafId: solo.id };
  });
  useEffect(() => saveLayout(layout), [layout]);
  // The LANDING (no active session) is a drop target too: dragging a session from the rail onto it opens
  // that session — logically "drop anywhere = open" when there are no panes to aim at (user report: a drop
  // on the empty screen silently did nothing). Highlight while a workspace drag hovers it.
  const [landingDragOver, setLandingDragOver] = useState(false);
  // The Help sheet (gesture + key legend) — owned here now that its "?" lives in the RAIL, not the chat
  // header (user request), so it opens over whatever is on screen (landing included).
  const [helpOpen, setHelpOpen] = useState(false);
  // The sessions currently VISIBLE in panes — the needs-you chime/banner must not nag about any of them
  // (you're looking at all of them). A ref so the poll effect reads it without re-subscribing.
  const visiblePaneIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    visiblePaneIdsRef.current = splitCapable
      ? new Set(leaves(layout.tree).flatMap((l) => (l.sessionId ? [l.sessionId] : [])))
      : new Set();
  }, [layout, splitCapable]);
  // Keep the tree honest against the LIVE session list (a closed session's pane collapses; duplicates
  // clear). Gated on ready so the initial empty list can't wipe a restored layout before /sessions lands.
  useEffect(() => {
    if (phase !== "ready") return;
    setLayout((prev) => {
      const tree = normalize(prev.tree, new Set(sessions.map((s) => s.id)));
      const focusedLeafId = findLeaf(tree, prev.focusedLeafId)?.id ?? leaves(tree)[0]?.id;
      if (tree === prev.tree && focusedLeafId === prev.focusedLeafId) return prev;
      const solo = focusedLeafId === undefined ? makeLeaf() : undefined;
      return solo ? { tree: solo, focusedLeafId: solo.id } : { tree, focusedLeafId: focusedLeafId! };
    });
  }, [phase, sessions]);
  // EVERY path that activates a session (rail select, needs-you jump, wizard-created, deep link) funnels
  // through activeSessionId — mirror it into the workspace: focus the pane already showing it, else load it
  // into the focused pane. Deliberately NOT keyed on `layout` (focusing an empty pane must not re-trigger).
  useEffect(() => {
    if (!splitCapable || !activeSessionId) return;
    setLayout((prev) => {
      const existing = findLeafBySession(prev.tree, activeSessionId);
      if (existing) return existing.id === prev.focusedLeafId ? prev : { ...prev, focusedLeafId: existing.id };
      return {
        tree: setLeafSession(prev.tree, prev.focusedLeafId, activeSessionId),
        focusedLeafId: prev.focusedLeafId,
      };
    });
  }, [activeSessionId, splitCapable]);

  // "A session needs you" foreground alert: the OTHER session(s) that flipped to awaiting while you weren't
  // looking. Drives a prominent tappable banner + a chime/haptic (see the poll effect below). `id`/`label`
  // point at the FIRST fresh one (for a one-tap open); `count` is how many chats are currently waiting on
  // you (minus the one on screen) so the banner can read "N chats need you" when more than one is.
  const [needsYouAlert, setNeedsYouAlert] = useState<
    { id: string; label: string; provider: "Claude" | "Codex"; count: number } | undefined
  >(undefined);
  // Awaiting ids from the PREVIOUS poll, to detect false→true transitions. undefined until the first poll
  // seeds it, so already-waiting sessions on load never fire a burst of chimes.
  const prevAwaitingRef = useRef<Set<string> | undefined>(undefined);
  // Shown when the one-shot restored-session validation clears an active session that no longer exists (its
  // tmux died across an OTA, say) — so landing on the empty picker has an explanation instead of a silent,
  // unexplained empty screen. A brief, dismissible toast.
  const [endedNotice, setEndedNotice] = useState(false);
  // First-run onboarding card on the landing (the core model in a few calm lines). Dismissed FOREVER via
  // localStorage `rc-onboarded`; read once on mount. A storage failure just shows the card (harmless).
  const [onboarded, setOnboarded] = useState<boolean>(() => {
    try {
      return localStorage.getItem("rc-onboarded") === "1";
    } catch {
      return false;
    }
  });
  const dismissOnboarding = () => {
    try {
      localStorage.setItem("rc-onboarded", "1");
    } catch {
      /* storage blocked (private mode) — it just won't persist */
    }
    setOnboarded(true);
  };
  const [pushState, setPushState] = useState<"subscribed" | "unsubscribed" | "unsupported" | "denied">("unsubscribed");
  // Read the live push subscription state only when the global settings actually open (not on every app
  // mount): it's the only place that needs it, and deferring avoids an on-load async state update.
  useEffect(() => {
    if (!globalSettingsOpen) return;
    let mounted = true;
    currentPushState()
      .then((s) => mounted && setPushState(s))
      .catch(() => mounted && setPushState("unsupported"));
    return () => {
      mounted = false;
    };
  }, [globalSettingsOpen]);
  const [sessionsOpen, setSessionsOpen] = useState(false);
  // OTA self-update UI state. The banner is dismissible PER SESSION (a page reload re-shows it if the
  // update is still pending). The panel is the "What's new" / confirm sheet. `updateStatus` is the
  // server-reported updater progress polled while updating. `updatedTo` drives the "Updated to …"
  // toast after a successful reconnect onto the new version.
  const [updateBannerDismissed, setUpdateBannerDismissed] = useState(false);
  const [updatePanelOpen, setUpdatePanelOpen] = useState(false);
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | undefined>();
  const [updateOperation, setUpdateOperation] = useState<UpdateOperation | undefined>(() => loadUpdateOperation());
  const updateOperationRef = useRef(updateOperation);
  const [updateConnection, setUpdateConnection] = useState<UpdateConnectionState>(() =>
    updateOperation ? "checking" : "connected",
  );
  const [updatedTo, setUpdatedTo] = useState<string | undefined>();
  // TRUE when THIS bundle (BUILD_SHA) is older than the server is serving — a stale precached PWA. The
  // server-driven update banner can't catch this (it describes server releases, not the loaded bundle), so this
  // is the only thing that surfaces a phone stuck on old JS. Set in the version poll; cleared by a refresh.
  const [clientStale, setClientStale] = useState(false);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [providerSummaries, setProviderSummaries] = useState<ProviderSummaries>({});
  const [codexModels, setCodexModels] = useState<CodexModel[]>([]);
  const [codexProfiles, setCodexProfiles] = useState<string[]>([]);
  const [providerAvailabilityState, setProviderAvailabilityState] = useState<"loading" | "ready" | "error">("loading");
  const [claudeMetadataState, setClaudeMetadataState] = useState<"loading" | "ready" | "unavailable">("loading");
  const [codexMetadataState, setCodexMetadataState] = useState<"loading" | "ready" | "unavailable">("loading");
  const [providerAuthStates, setProviderAuthStates] = useState<ProviderAuthStates>(checkingProviderAuth);
  const [providerReload, setProviderReload] = useState(0);

  // Open the new-session wizard (directory picker → settings). Terminal is the only session mode. An
  // optional `cwd` prefills the folder (the "＋ here" / same-folder shortcut) so the picker step is skipped.
  const openWizard = (cwd?: string) => {
    setProviderSummaries({});
    setProviderAvailabilityState("loading");
    setClaudeMetadataState("loading");
    setCodexMetadataState("loading");
    setProviderAuthStates(checkingProviderAuth());
    setWizardCwd(cwd);
    setWizardOpen(true);
  };
  const online = useOnline();

  // The rail's relative-time labels ("2m", "1h") need a clock. The component stays pure (no
  // Date.now() inside it); the app owns the tick and re-renders the labels every 30s so "now"
  // creeps to "1m" without a reload. Cheap: one timer, one state value.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  const api = useMemo(
    () => createApiClient({ baseUrl: API_BASE_URL, getToken: () => (token === "" ? undefined : token) }),
    [token],
  );

  const rememberUpdateOperation = useCallback((operation: UpdateOperation | undefined) => {
    updateOperationRef.current = operation;
    setUpdateOperation(operation);
    saveUpdateOperation(operation);
  }, []);

  const completeUpdate = useCallback(
    (target?: string) => {
      const normalized = bareVersion(target);
      if (!IOS_WEBKIT && normalized) setUpdatedTo(`v${normalized}`);
      rememberUpdateOperation(undefined);
      setUpdateStatus(normalized ? { state: "done", phase: "done", target: normalized } : { state: "done" });
      setUpdateConnection("connected");
      setUpdatePanelOpen(false);
      setUpdateBannerDismissed(false);
      setUpdateState("idle");
      requestReloadForNewVersion();
    },
    [rememberUpdateOperation, setUpdateState],
  );

  const failUpdate = useCallback(
    (status: UpdateStatus) => {
      rememberUpdateOperation(undefined);
      setUpdateConnection("connected");
      setUpdateStatus(status);
      setUpdateState("failed");
    },
    [rememberUpdateOperation, setUpdateState],
  );

  const resetDefaultsSync = useCallback(() => {
    defaultsGeneration.current += 1;
    setDefaultsSync({ status: "loading", defaults: loadDefaults(), revision: 0 });
    setDefaultsSaveState("idle");
    setDefaultsSaveError(undefined);
  }, []);

  useEffect(() => {
    if (phase !== "ready" || token === undefined) {
      resetDefaultsSync();
      return;
    }
    let cancelled = false;
    const generation = ++defaultsGeneration.current;
    const local = loadDefaults();
    setDefaultsSync({ status: "loading", defaults: local, revision: 0 });
    setDefaultsSaveState("idle");
    setDefaultsSaveError(undefined);
    void hydrateSessionDefaults({ api, local }).then((next) => {
      if (cancelled || generation !== defaultsGeneration.current) return;
      if (next.status === "synced") saveDefaults(next.defaults);
      setDefaultsSync(next);
    });
    return () => {
      cancelled = true;
      if (generation === defaultsGeneration.current) defaultsGeneration.current += 1;
    };
  }, [api, phase, resetDefaultsSync, token]);

  const saveSessionDefaults = useCallback(
    async (defaults: SessionDefaults): Promise<void> => {
      const previous = defaultsSync;
      const generation = defaultsGeneration.current;
      setDefaultsSaveState("saving");
      setDefaultsSaveError(undefined);
      const next = await persistSessionDefaults({ api, defaults, revision: previous.revision });
      if (generation !== defaultsGeneration.current) return;
      if (next.status === "loading") throw new Error("Defaults save returned an incomplete synchronization state");
      if (next.status === "synced") {
        saveDefaults(next.defaults);
        setDefaultsSync(next);
        setDefaultsSaveState("saved");
        return;
      }
      if (next.revision !== previous.revision) {
        saveDefaults(next.defaults);
        setDefaultsSync(next);
        setDefaultsSaveState("conflict");
      } else {
        setDefaultsSync({
          status: "unsynced",
          defaults: previous.defaults,
          revision: previous.revision,
          error: next.error,
        });
        setDefaultsSaveState("error");
      }
      setDefaultsSaveError(next.error);
      throw new Error(next.error);
    },
    [api, defaultsSync],
  );

  // Any authenticated request that returns 401 AFTER load means the token was revoked/expired (rotated on the
  // server, or the rotation grace window elapsed). Clear it and return to the login screen instead of
  // retrying forever behind a stale "couldn't reach the server" toast or an endless terminal "Reconnecting…".
  // Returns true when it handled an auth failure so the caller can stop. Stable (useState setters + a module
  // import), so it's safe to list in effect deps.
  const handleAuthExpiry = useCallback(
    (err: unknown): boolean => {
      if (err instanceof ApiError && err.status === 401) {
        clearToken();
        setTokenState(undefined);
        resetDefaultsSync();
        setLoginError("Session expired — please sign in again.");
        setPhase("login");
        return true;
      }
      return false;
    },
    [resetDefaultsSync],
  );

  const requestClaudeAuthStatus = useCallback(async (): Promise<void> => {
    const generation = ++claudeAuthRequestGeneration.current;
    setAuthStatus(undefined);
    setProviderAuthStates((current) => ({ ...current, claude: "checking" }));
    try {
      const status = await api.getProviderAuthStatus("claude");
      if (generation !== claudeAuthRequestGeneration.current) return;
      setAuthStatus(status);
      setProviderAuthStates((current) => ({ ...current, claude: claudeAuthState(status) }));
    } catch (error: unknown) {
      if (generation !== claudeAuthRequestGeneration.current) return;
      if (handleAuthExpiry(error)) return;
      setAuthStatus(undefined);
      setProviderAuthStates((current) => ({ ...current, claude: "unavailable" }));
    }
  }, [api, handleAuthExpiry]);

  useEffect(() => {
    return () => {
      claudeAuthRequestGeneration.current += 1;
    };
  }, [api, phase]);

  // Provider capabilities and metadata feed both the new-session wizard and provider-specific defaults.
  // Fetch lazily when either surface opens, then keep the App-owned catalogs shared between them.
  useEffect(() => {
    if ((!wizardOpen && !globalSettingsOpen && !sessionSettingsOpen) || phase !== "ready") return;
    let alive = true;
    setProviderSummaries({});
    setProviderAvailabilityState("loading");
    setClaudeMetadataState("loading");
    setCodexMetadataState("loading");
    setProviderAuthStates(checkingProviderAuth());

    const loadCodexAuth = async () => {
      try {
        const status = await api.getProviderAuthStatus("codex");
        if (!alive) return;
        setProviderAuthStates((current) => ({ ...current, codex: codexAuthState(status) }));
      } catch (error: unknown) {
        if (!alive || handleAuthExpiry(error)) return;
        setProviderAuthStates((current) => ({ ...current, codex: "unavailable" }));
      }
    };
    void Promise.allSettled([requestClaudeAuthStatus(), loadCodexAuth()]);

    void (async () => {
      try {
        const summaries = await api.getProviders();
        if (!alive) return;
        if (!summaries.claude || !summaries.codex) throw new Error("Incomplete provider availability response");
        setProviderSummaries(summaries);
        setProviderAvailabilityState("ready");
        const loadClaudeModels = async () => {
          if (summaries.claude?.metadataAvailable !== true) {
            setClaudeMetadataState("unavailable");
            return;
          }
          try {
            const nextModels = await api.getProviderModels("claude");
            if (!alive) return;
            setModels(nextModels);
            setClaudeMetadataState(nextModels.length > 0 ? "ready" : "unavailable");
          } catch (error: unknown) {
            if (!alive || handleAuthExpiry(error)) return;
            setClaudeMetadataState("unavailable");
          }
        };
        const loadCodexMetadata = async () => {
          if (summaries.codex?.metadataAvailable !== true) {
            setCodexMetadataState("unavailable");
            return;
          }
          try {
            const [nextModels, nextProfiles] = await Promise.all([
              api.getProviderModels("codex"),
              api.getProviderProfiles("codex"),
            ]);
            if (!alive) return;
            setCodexModels(nextModels);
            setCodexProfiles(nextProfiles);
            setCodexMetadataState(nextModels.length > 0 ? "ready" : "unavailable");
          } catch (error: unknown) {
            if (!alive || handleAuthExpiry(error)) return;
            setCodexMetadataState("unavailable");
            setProviderSummaries((current) => ({
              ...current,
              codex: current.codex
                ? {
                    ...current.codex,
                    metadataAvailable: false,
                    detail: "Codex metadata unavailable; defaults and bounded custom values remain usable.",
                  }
                : undefined,
            }));
          }
        };
        await Promise.all([loadClaudeModels(), loadCodexMetadata()]);
      } catch (error: unknown) {
        if (!alive || handleAuthExpiry(error)) return;
        setProviderAvailabilityState("error");
        setClaudeMetadataState("unavailable");
        setCodexMetadataState("unavailable");
      }
    })();
    return () => {
      alive = false;
    };
  }, [
    wizardOpen,
    globalSettingsOpen,
    sessionSettingsOpen,
    phase,
    api,
    handleAuthExpiry,
    providerReload,
    requestClaudeAuthStatus,
  ]);

  // Sign out / switch token — the USER-initiated version of the 401 path above: clear the stored token and
  // drop back to the login screen. Every poll effect is gated on `phase === "ready"`, so flipping to "login"
  // tears them all down. Close any open settings surface so it doesn't reopen on the next sign-in, and leave
  // `loginError` blank (this is deliberate, not an "expired" failure).
  const signOut = () => {
    setGlobalSettingsOpen(false);
    setSessionSettingsOpen(false);
    clearToken();
    setTokenState(undefined);
    resetDefaultsSync();
    setLoginError(undefined);
    setPhase("login");
  };

  useEffect(() => {
    if (token === undefined) return;
    setToken(token);
    let cancelled = false;
    setPhase("validating");
    api
      .listSessions()
      .then((s) => {
        if (cancelled) return;
        setSessions(s);
        setLoadError(undefined);
        setPhase("ready");
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 401) {
          clearToken();
          setTokenState(undefined);
          resetDefaultsSync();
          setLoginError("Invalid token (401). Check the access token and try again.");
          setPhase("login");
        } else {
          // network/other error: still enter the app (the list is empty), but SURFACE it so the user
          // knows it's a connection problem, not just "no sessions". The poll keeps retrying + clears it.
          setLoadError("Couldn't reach the server. Retrying…");
          setPhase("ready");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [token, api, resetDefaultsSync, setSessions, setToken]);

  // Notification deep-link: a tapped push opens `/?session=<id>` (the SW's notificationclick). Once
  // the app is ready (session list loaded + authenticated), select that session so the tap lands on
  // it. An unknown/garbage id falls through to the normal "Session not found" fallback (no crash).
  // Clear the query param afterward so a refresh doesn't re-trigger the deep link.
  useEffect(() => {
    if (phase !== "ready") return;
    const id = sessionIdFromLocation(window.location.search);
    if (id) {
      setActive(id);
      window.history.replaceState({}, "", window.location.pathname);
    }
  }, [phase, setActive]);

  // Validate a RESTORED active session (persisted across reload/relaunch — see store) once the list has
  // loaded: if it no longer exists (closed while away), clear it so we land on the picker instead of a
  // dead "Session not found" screen. One-shot (ref) so it never fights a fresh selection or a deep link.
  // When we DO clear a restored id that's gone, surface a brief notice so the empty landing has a reason
  // (its tmux likely died across an OTA) rather than being silently, confusingly blank.
  const activeValidatedRef = useRef(false);
  useEffect(() => {
    if (phase !== "ready" || activeValidatedRef.current) return;
    activeValidatedRef.current = true;
    const deepLink = sessionIdFromLocation(window.location.search);
    if (activeSessionId && !deepLink && !sessions.some((s) => s.id === activeSessionId)) {
      setActive(undefined);
      setEndedNotice(true);
    }
  }, [phase, sessions, activeSessionId, setActive]);

  // Prime the AudioContext on the first user gesture so a later "needs you" chime (fired from a background
  // poll, not a gesture) is allowed to sound on iOS/Safari (autoplay policy). One-shot; self-removes.
  useEffect(() => {
    const unlock = () => {
      unlockAudio();
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
    };
    window.addEventListener("pointerdown", unlock);
    window.addEventListener("keydown", unlock);
    return () => {
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
    };
  }, []);

  // Keep the rail honest across ALL sessions — not just the one we're connected to. A lightweight poll
  // of GET /sessions every ~15s (and on window focus + when the connection comes back online, e.g. a WS
  // reconnect after sleep) refreshes status, `awaiting` and `lastActivityAt` for every session, and
  // drops any that no longer exist. A poll that errors is ignored (transient) so a blip doesn't wipe
  // the list.
  useEffect(() => {
    if (phase !== "ready") return;
    let cancelled = false;
    const refresh = () => {
      api
        .listSessions()
        .then((s) => {
          if (cancelled) return;
          pollFailures.current = 0;
          mergeSessionMeta(s);
          setLoadError(undefined); // a successful poll clears any earlier "couldn't reach the server"
          // "Needs you" foreground nudge: sessions that FLIPPED to awaiting since the last poll get a chime +
          // haptic + a tappable banner — but NEVER the one you're actively viewing (active + app visible), and
          // the first poll only seeds the baseline (no chime storm on load).
          const nextAwaiting = new Set(s.filter((x) => x.awaiting).map((x) => x.id));
          const prev = prevAwaitingRef.current;
          if (prev) {
            const activeId = useStore.getState().activeSessionId;
            const viewing = typeof document !== "undefined" && document.visibilityState === "visible";
            // "On screen" = the active session OR any session visible in a split pane (desktop workspace).
            const offScreen = (x: SessionMeta) =>
              !((x.id === activeId || visiblePaneIdsRef.current.has(x.id)) && viewing);
            // ALL sessions that flipped to awaiting THIS poll (not just the first) — so several going awaiting
            // at once chime ONCE but the banner can carry the true count.
            const fresh = s.filter((x) => x.awaiting && !prev.has(x.id) && offScreen(x));
            const first = fresh[0];
            if (first) {
              playNeedsYouChime(); // one chime regardless of how many flipped together
              needsYouHaptic();
              // Point the banner at the first fresh one (a one-tap open), but COUNT every chat currently
              // waiting on you (minus the one on screen) so it reads "N chats need you" when more than one is.
              const waiting = s.filter((x) => x.awaiting && offScreen(x));
              setNeedsYouAlert({
                id: first.id,
                label: sessionLabel(first),
                provider: first.provider === "codex" ? "Codex" : "Claude",
                count: waiting.length,
              });
            }
          }
          // Drop a standing alert once its session is no longer waiting (you answered it, or it ended).
          setNeedsYouAlert((cur) => (cur && !nextAwaiting.has(cur.id) ? undefined : cur));
          prevAwaitingRef.current = nextAwaiting;
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          if (handleAuthExpiry(err)) return; // token revoked/expired after load → back to login, stop polling
          // Keep the current list (a single blip is transient), but after a couple of CONSECUTIVE poll
          // failures the server is genuinely unreachable — surface it so the user knows the list is stale
          // (the cold-start banner only covered the first load). Cleared on the next success.
          if (++pollFailures.current >= 2) setLoadError("Couldn't reach the server — the list may be stale.");
        });
    };
    // Poll a bit faster than before so a "needs you" is timely (the old 15s made it feel laggy). Cheap JSON.
    const interval = setInterval(refresh, 6_000);
    const onFocusOrOnline = () => refresh();
    window.addEventListener("focus", onFocusOrOnline);
    window.addEventListener("online", onFocusOrOnline);
    return () => {
      cancelled = true;
      clearInterval(interval);
      window.removeEventListener("focus", onFocusOrOnline);
      window.removeEventListener("online", onFocusOrOnline);
    };
  }, [phase, api, mergeSessionMeta, handleAuthExpiry]);

  // A background update survives navigation, app suspension and a full PWA relaunch. Restore its
  // durable client context and immediately resume status/version reconciliation once authenticated.
  useEffect(() => {
    if (phase !== "ready" || !updateOperation || updateState === "updating") return;
    setUpdateState("updating");
    setUpdateConnection("checking");
    setUpdateStatus(
      (current) =>
        current ?? {
          ...(updateOperation.operationId ? { operationId: updateOperation.operationId } : {}),
          state: "starting",
          phase: "resuming background update",
          ...(updateOperation.target !== "previous" ? { target: updateOperation.target } : {}),
        },
    );
  }, [phase, updateOperation, updateState, setUpdateState]);

  // Updates are server-wide: if another signed-in device/user starts one, discover its durable status
  // and show the same persistent progress banner here. This also recovers an operation when browser
  // storage was cleared while the detached installer kept running.
  useEffect(() => {
    if (phase !== "ready" || updateState !== "idle" || updateOperation) return;
    let cancelled = false;
    const discover = () => {
      void api
        .getUpdateStatus()
        .then((status) => {
          if (
            cancelled ||
            updateOperationRef.current ||
            status.state === "idle" ||
            status.state === "done" ||
            status.state === "failed" ||
            !status.operationId ||
            !status.target
          )
            return;
          const target = bareVersion(status.target) ?? status.target;
          const fromVersion = bareVersion(status.fromVersion ?? useStore.getState().updateInfo?.current) ?? target;
          const phaseLabel = status.phase?.toLowerCase() ?? "";
          const action = phaseLabel.includes("rollback")
            ? "rollback"
            : phaseLabel.includes("migration")
              ? "migrate"
              : target === fromVersion
                ? "restart"
                : "update";
          rememberUpdateOperation({
            operationId: status.operationId,
            target,
            fromVersion,
            action,
            startedAt: status.updatedAt ?? Date.now(),
          });
          setUpdateStatus(status);
          setUpdateConnection("connected");
          setUpdateState("updating");
        })
        .catch(() => {
          // Normal app connectivity surfaces elsewhere; discovery is best-effort until the next tick.
        });
    };
    discover();
    const interval = setInterval(discover, 15_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [phase, updateState, updateOperation, api, rememberUpdateOperation, setUpdateState]);

  // OTA self-update: poll GET /version on open. The server caches the GitHub Releases feed
  // check (≤10min), so this is cheap. A failed poll is ignored (transient / offline / non-updatable);
  // the store keeps the last known info. When a poll comes back with a NEW current version while we
  // were updating, that means the server restarted onto the new build — finish the update UX.
  useEffect(() => {
    if (phase !== "ready") return;
    let cancelled = false;
    const poll = () => {
      api
        .getVersion()
        .then((info) => {
          if (cancelled) return;
          // Detect "the server is now on a new version" while/after an update: the polled `current`
          // differs from the version we were updating FROM (read straight from the store so this is
          // current even though the effect isn't re-run on every state change). Clear the updating UX
          // + show the "Updated to …" toast.
          const { updateState: phaseNow } = useStore.getState();
          if (phaseNow === "updating" && updateOperation && operationReachedTarget(info, updateOperation))
            completeUpdate(info.current);
          setUpdateInfo(info);
          // Stale-bundle self-heal: if THIS running bundle is older than what the server now serves (the
          // OTA built+restarted but the phone's precached PWA never swapped), drop the SW/caches and reload
          // onto the new bundle — ONCE per server version (claimAutoRefresh guards against a reload loop).
          // If we already tried for this version and it's STILL stale, surface a manual "Refresh" banner.
          if (isClientStale(BUILD_VERSION, info.current)) {
            // iOS/WebKit: hardRefresh's cache-drop + location.replace neither reliably swaps the precached
            // bundle NOR reloads cleanly — it FREEZES the compositor (the app "locks" on the old-version
            // banner). So never auto-reload there; just flag stale and let the banner tell the user to fully
            // close & reopen (the only reliable iOS PWA update). Elsewhere, self-heal once per server version.
            if (IOS_WEBKIT) {
              setClientStale(true);
              // Do NOT navigate this live page: that freezes iOS standalone rendering. Removing the worker +
              // precache in the background makes the user's next real close/reopen an unconditional network
              // load, instead of letting an old v1 shell win repeatedly.
              void prepareForAppReopen();
            } else {
              const auto = typeof sessionStorage !== "undefined" && claimAutoRefresh(info.current, sessionStorage);
              if (auto) void hardRefresh();
              else setClientStale(true);
            }
          } else {
            setClientStale(false);
          }
        })
        .catch((err: unknown) => {
          if (!cancelled) handleAuthExpiry(err); // token expired → login; otherwise transient, keep last info
        });
    };
    poll();
    // ~3 min (plus an on-focus re-check) so a freshly pushed update surfaces promptly. The server
    // caches the underlying release request, so this stays cheap.
    const interval = setInterval(poll, 3 * 60 * 1000);
    const onFocus = () => poll();
    window.addEventListener("focus", onFocus);
    return () => {
      cancelled = true;
      clearInterval(interval);
      window.removeEventListener("focus", onFocus);
    };
  }, [phase, api, updateOperation, completeUpdate, setUpdateInfo, setClientStale, handleAuthExpiry]);

  // Provider usage limits: poll Claude + Codex on open and every ~60s (plus on window focus). Each provider
  // keeps its last good snapshot independently, so one unavailable metadata source never hides the other.
  useEffect(() => {
    if (phase !== "ready") return;
    let cancelled = false;
    const poll = () => {
      api
        .getProviderUsage("claude")
        .then((u) => {
          // Only update on a REAL snapshot. The server returns `usage:null` when its `claude /usage`
          // spawn fails — which happens on a transiently loaded host — and clobbering the last-known
          // value with null made the session/weekly bars VANISH on a single slow poll. Keep the last
          // good value instead; a later good poll refreshes it (and they refresh every ~60s anyway).
          if (!cancelled && u) setUsage(u);
        })
        .catch((err: unknown) => {
          if (!cancelled) handleAuthExpiry(err); // token expired → login; otherwise transient, keep last value
        });
      api
        .getProviderUsage("codex")
        .then((u) => {
          if (!cancelled && u) setCodexUsage(u);
        })
        .catch((err: unknown) => {
          if (!cancelled) handleAuthExpiry(err);
        });
    };
    poll();
    const interval = setInterval(poll, 60_000);
    const onFocus = () => poll();
    window.addEventListener("focus", onFocus);
    return () => {
      cancelled = true;
      clearInterval(interval);
      window.removeEventListener("focus", onFocus);
    };
  }, [phase, api, setUsage]);

  // CLAUDE SIGN-IN: poll GET /auth/status on open, on focus, and every ~5min so the app can warn when the
  // server's Claude login isn't usable. NOTE: `loggedIn` reflects that creds EXIST, not that they still
  // work (expired creds report loggedIn:true yet 401 on use — that case can only be fixed reactively via
  // the re-auth dialog). The banner below covers the reliably-detectable "not signed in at all" case; a
  // failed poll / unavailable feature is ignored (the banner just won't show).
  useEffect(() => {
    if (phase !== "ready") return;
    const poll = () => {
      void requestClaudeAuthStatus();
    };
    poll();
    const interval = setInterval(poll, 5 * 60 * 1000);
    const onFocus = () => poll();
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(interval);
      window.removeEventListener("focus", onFocus);
    };
  }, [phase, requestClaudeAuthStatus]);

  // APP BADGE: reflect the "needs you" count (sessions awaiting a permission/question) onto the home-screen
  // app badge so a backgrounded session that needs an answer is glanceable without opening the app. Driven
  // by `sessions` (refreshed by the meta poll), so the badge tracks the count as it changes; it CLEARS
  // at 0. Also refresh on visibilitychange→visible: opening the
  // app re-asserts the truth (and supersedes any stale count the SW set from a push while we were closed).
  // Feature-detected inside applyAppBadge — a silent no-op where the App Badging API is unsupported (iOS).
  const needsYou = badgeCount(sessions);
  useEffect(() => {
    if (phase !== "ready") return;
    applyAppBadge(needsYou);
    if (typeof document === "undefined") return;
    const onVisible = () => {
      if (document.visibilityState === "visible") applyAppBadge(needsYou);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [phase, needsYou]);

  // Fetch the account's available models once the app is authenticated. Used by ModelSelect in the
  // wizard, global settings panel, and in-chat session settings to populate a dropdown instead of a
  // free-text field. On any error, leave `models` as [] so all components fall back to free-text.
  useEffect(() => {
    if (phase !== "ready") return;
    let alive = true;
    api
      .getModels()
      .then((m) => {
        if (alive) setModels(m);
      })
      .catch((err: unknown) => {
        if (alive) handleAuthExpiry(err); // token expired → login; otherwise leave models [] → free-text
      });
    return () => {
      alive = false;
    };
  }, [phase, api, handleAuthExpiry]);

  // Reconcile BOTH durable operation status and runtime version. Status provides detailed progress;
  // runtime version independently proves success if the final status write raced the service restart.
  useEffect(() => {
    if (phase !== "ready" || updateState !== "updating" || !updateOperation) return;
    let cancelled = false;
    let polling = false;
    const poll = async () => {
      if (polling) return;
      polling = true;
      try {
        const [statusResult, versionResult] = await Promise.allSettled([api.getUpdateStatus(), api.getVersion()]);
        if (cancelled) return;
        let serverReached = false;
        let effectiveOperation = updateOperation;

        if (statusResult.status === "fulfilled") {
          serverReached = true;
          const status = statusResult.value;
          if (statusBelongsToOperation(status, updateOperation)) {
            if (updateOperation.action === "rollback" && updateOperation.target === "previous" && status.target) {
              effectiveOperation = { ...updateOperation, target: bareVersion(status.target) ?? status.target };
              rememberUpdateOperation(effectiveOperation);
            }
            setUpdateStatus(status);
            if (status.state === "failed") {
              failUpdate(status);
              return;
            }
            if (status.state === "done") {
              completeUpdate(status.target ?? effectiveOperation.target);
              return;
            }
            if (status.state === "idle" && Date.now() - updateOperation.startedAt >= 20_000) {
              failUpdate({
                state: "failed",
                target: effectiveOperation.target,
                error: "The server did not start this update. Your current version is still running; try again.",
              });
              return;
            }
            const lastProgressAt = status.updatedAt ?? updateOperation.startedAt;
            setUpdateConnection(Date.now() - lastProgressAt >= UPDATE_SLOW_MS ? "slow" : "connected");
          }
        }

        if (versionResult.status === "fulfilled") {
          serverReached = true;
          const info = versionResult.value;
          setUpdateInfo(info);
          if (operationReachedTarget(info, effectiveOperation)) {
            completeUpdate(info.current);
            return;
          }
        }

        if (!serverReached) setUpdateConnection("reconnecting");
      } finally {
        polling = false;
      }
    };
    void poll();
    const interval = setInterval(() => void poll(), 1500);
    const onFocusOrOnline = () => void poll();
    window.addEventListener("focus", onFocusOrOnline);
    window.addEventListener("online", onFocusOrOnline);
    return () => {
      cancelled = true;
      clearInterval(interval);
      window.removeEventListener("focus", onFocusOrOnline);
      window.removeEventListener("online", onFocusOrOnline);
    };
  }, [phase, updateState, updateOperation, api, rememberUpdateOperation, completeUpdate, failUpdate, setUpdateInfo]);

  // Apply the update: POST /update, flip to the updating UX, and open the panel so the progress overlay
  // is visible. A rejected manifest/unmanaged install flips to the failed UX.
  const applyUpdate = () => {
    const info = useStore.getState().updateInfo;
    if (!info) return;
    const target = bareVersion(info.latest) ?? info.latest;
    const fromVersion = bareVersion(info.current) ?? info.current;
    const action =
      info.updateAction === "migrate" || info.updateAction === "restart" ? info.updateAction : ("update" as const);
    const pending: UpdateOperation = { target, fromVersion, action, startedAt: Date.now() };
    rememberUpdateOperation(pending);
    setUpdateState("updating");
    setUpdateConnection("connected");
    setUpdatePanelOpen(true);
    setUpdateStatus({ state: "starting", phase: "requesting update", target });
    void api
      .applyUpdate(info.latest)
      .then((started) => {
        if (updateOperationRef.current?.startedAt !== pending.startedAt) return;
        const accepted: UpdateOperation = {
          ...pending,
          operationId: started.operationId,
          target: bareVersion(started.target) ?? started.target,
        };
        rememberUpdateOperation(accepted);
        setUpdateStatus({
          operationId: started.operationId,
          state: "starting",
          phase: "starting",
          target: accepted.target,
          fromVersion,
          updatedAt: Date.now(),
        });
      })
      .catch((err: unknown) => {
        if (updateOperationRef.current?.startedAt !== pending.startedAt) return;
        if (err instanceof ApiError) {
          failUpdate({ state: "failed", target, error: err.message });
          return;
        }
        // The POST may have reached the server before the connection dropped. Keep reconciling the
        // durable status instead of falsely declaring failure or freezing on the synthetic start phase.
        setUpdateConnection("reconnecting");
      });
  };

  // Roll back to the PREVIOUS running build (POST /update/rollback {confirm:true}). Reuses the whole
  // update lifecycle: flipping to "updating" starts the same /update/status polling, and the version poll
  // ends the flow when the server restarts onto the (older) build. A 409/400 = the server has no previous
  // build recorded — mapped to a human message on the panel's existing failed surface.
  const rollbackUpdate = () => {
    const info = useStore.getState().updateInfo;
    if (!info) return;
    const pending: UpdateOperation = {
      target: "previous",
      fromVersion: bareVersion(info.current) ?? info.current,
      action: "rollback",
      startedAt: Date.now(),
    };
    rememberUpdateOperation(pending);
    setUpdateState("updating");
    setUpdateConnection("connected");
    setUpdatePanelOpen(true);
    setUpdateStatus({ state: "starting", phase: "requesting rollback" });
    void api
      .rollbackUpdate()
      .then((started) => {
        if (updateOperationRef.current?.startedAt !== pending.startedAt) return;
        const accepted: UpdateOperation = {
          ...pending,
          operationId: started.operationId,
          target: bareVersion(started.target) ?? started.target,
        };
        rememberUpdateOperation(accepted);
        setUpdateStatus({
          operationId: started.operationId,
          state: "starting",
          phase: "starting",
          target: accepted.target,
          fromVersion: pending.fromVersion,
          updatedAt: Date.now(),
        });
      })
      .catch((err: unknown) => {
        if (updateOperationRef.current?.startedAt !== pending.startedAt) return;
        if (err instanceof ApiError) {
          failUpdate({
            state: "failed",
            error: err.status === 409 || err.status === 400 ? "No previous version recorded yet." : err.message,
          });
          return;
        }
        setUpdateConnection("reconnecting");
      });
  };

  if (phase === "login" || token === undefined) {
    return (
      <LoginScreen
        initialError={loginError}
        onAuthenticated={(t) => {
          saveToken(t);
          setLoginError(undefined);
          setTokenState(t);
        }}
      />
    );
  }

  if (phase === "validating") {
    return (
      <div
        style={{
          display: "grid",
          placeItems: "center",
          gap: "var(--sp-3)",
          height: "100%",
          color: "var(--text-muted)",
        }}
      >
        <span aria-hidden="true" className="display" style={{ fontSize: "var(--fs-2xl)", color: "var(--text-faint)" }}>
          rc
        </span>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: "var(--fs-sm)" }}>Connecting…</span>
      </div>
    );
  }

  // Clear the pending-undo toast (+ its expiry timer).
  const dismissUndo = () => {
    if (undoTimer.current) clearTimeout(undoTimer.current);
    undoTimer.current = undefined;
    setPendingUndo(undefined);
  };

  // Undo a just-closed session: re-add the row (idempotent) and, if it was the active one, re-select it.
  // The DELETE already fired (the server keeps the transcript resumable), so the terminal reconnects /
  // offers Restart — this brings the row back rather than pretending it was never touched.
  const undoClose = () => {
    const p = pendingUndo;
    if (!p) return;
    dismissUndo();
    addSession(p.session);
    if (p.wasActive) {
      setActive(p.session.id);
      healPaintBurst();
    }
  };

  // Close a session in one tap: DELETE /sessions/:id → 204 (no body). The server removes it from the
  // list + store while KEEPING the transcript (still resumable via /resume), so a closed session does
  // NOT reappear after refresh. We optimistically remove it client-side for a snappy rail; if the active
  // one is closed we select a valid visible rail replacement when supplied, otherwise the new top row
  // under the current ordering policy (or the empty/landing state). Because this is a one-tap DESTRUCTIVE
  // action at the thumb edge, we then float an "Undo" toast
  // (auto-expiring) so a mis-tap is recoverable. On a REAL failure (5xx/network — not an already-gone
  // 204, which resolves) we re-add the row and surface a small error rather than silently dropping it.
  const closeSession = (id: string, visibleReplacementId?: string) => {
    const closing = sessions.find((s) => s.id === id);
    const wasActive = id === activeSessionId;
    // Optimistic removal + reselection.
    let autoSelected: string | undefined;
    if (wasActive) {
      const remaining = sortSessions(
        sessions.filter((s) => s.id !== id),
        lastActiveAt,
        sessionOrder,
      );
      autoSelected = remaining.some((session) => session.id === visibleReplacementId)
        ? visibleReplacementId
        : remaining[0]?.id;
      setActive(autoSelected);
    }
    removeSession(id);
    setCloseError(undefined);
    // Offer an Undo for a few seconds (a fresh close supersedes any earlier pending one).
    if (closing) {
      if (undoTimer.current) clearTimeout(undoTimer.current);
      setPendingUndo({ session: closing, wasActive });
      undoTimer.current = setTimeout(() => setPendingUndo(undefined), 6000);
    }
    void api.deleteSession(id).catch((err: unknown) => {
      // The delete genuinely failed — drop the Undo toast (nothing was destroyed), undo the optimistic
      // removal so the row reappears, and tell the user. (An already-gone session is a 204 server-side,
      // so it never lands here.)
      dismissUndo();
      if (closing) {
        addSession(closing);
        // Restore selection to the closed row ONLY if the user hasn't navigated since (the active is
        // still the one we auto-selected) — don't yank them back from a row they deliberately opened.
        if (wasActive && useStore.getState().activeSessionId === autoSelected) setActive(id);
      }
      const message = err instanceof ApiError ? err.message : "Couldn't close the session.";
      setCloseError(message);
    });
  };

  // Jump to a session that needs you (wired to the rail's "N need you" badge via onNeedsYouTap): select the
  // first awaiting session so one tap lands you on a waiting chat. A SINGLE waiting chat goes straight to it
  // (close the sheet); with SEVERAL waiting we keep the sheet OPEN, focused on the awaiting ones, so you can
  // pick which to answer first. Recomputes awaiting from the live list at tap time (never a stale snapshot).
  const jumpToAwaiting = () => {
    const waiting = sessions.filter((s) => s.awaiting);
    const first = waiting[0];
    if (!first) return;
    setNeedsYouAlert(undefined);
    unlockAudio();
    setActive(first.id);
    setSessionsOpen(waiting.length > 1);
    healPaintBurst();
  };

  // ---- Split-workspace handlers. NOTE: the reconcile EFFECTS live in the top hook block next to the
  // layout state — hooks must never sit here, below the login/validating early-returns, or their call
  // order changes across phases (the Rules-of-Hooks violation CI caught). Plain handlers are fine. ----

  /** Focus a pane (click anywhere in it) — the active session follows the pane when it has one. */
  const onFocusPane = (leafId: string) => {
    setLayout((prev) => (prev.focusedLeafId === leafId ? prev : { ...prev, focusedLeafId: leafId }));
    const sid = findLeaf(layout.tree, leafId)?.sessionId;
    if (sid && sid !== activeSessionId) setActive(sid);
  };
  /** Header split buttons: open an EMPTY pane on that edge (its picker chooses the session) + focus it. */
  const onSplitPane = (leafId: string, edge: DropEdge) => {
    const fresh = makeLeaf();
    setLayout((prev) => ({ tree: splitLeaf(prev.tree, leafId, edge, fresh), focusedLeafId: fresh.id }));
  };
  /** Close a PANE (the session keeps running in tmux — it's still in the rail). Collapses the split; the
   *  active session follows wherever focus lands. Last pane standing degrades to a fresh empty pane. */
  const onClosePane = (leafId: string) => {
    const collapsed = removeLeaf(layout.tree, leafId);
    if (collapsed === undefined) {
      const solo = makeLeaf();
      setLayout({ tree: solo, focusedLeafId: solo.id });
      setActive(undefined);
      return;
    }
    const focusedLeafId = findLeaf(collapsed, layout.focusedLeafId)?.id ?? leaves(collapsed)[0]!.id;
    setLayout({ tree: collapsed, focusedLeafId });
    const sid = findLeaf(collapsed, focusedLeafId)?.sessionId;
    if (sid !== activeSessionId) setActive(sid);
  };
  /** The empty pane's picker chose a session. */
  const onPickSession = (leafId: string, sessionId: string) => {
    setLayout((prev) => ({ tree: setLeafSession(prev.tree, leafId, sessionId), focusedLeafId: leafId }));
    if (sessionId !== activeSessionId) setActive(sessionId);
  };
  /** The empty pane's "+ New session": focus the pane so the wizard-created session lands in it (via the
   *  activeSessionId mirror above), then open the wizard. */
  const onNewSessionInPane = (leafId: string) => {
    setLayout((prev) => ({ ...prev, focusedLeafId: leafId }));
    openWizard();
  };
  /** A RAIL session dropped on a pane. Edge → open it split off that side; center → show it here. A session
   *  already visible in another pane MOVES (iTerm2 semantics — never a duplicate: two attachments would
   *  fight over the pty size): its old pane collapses on an edge drop, or the two panes swap on center. */
  const onDropSession = (leafId: string, zone: DropZone, sessionId: string) => {
    setLayout((prev) => {
      const existing = findLeafBySession(prev.tree, sessionId);
      if (zone === "center") {
        if (existing) {
          if (existing.id === leafId) return prev; // dropped where it already lives
          return { tree: swapLeafSessions(prev.tree, existing.id, leafId), focusedLeafId: leafId };
        }
        return { tree: setLeafSession(prev.tree, leafId, sessionId), focusedLeafId: leafId };
      }
      if (existing) {
        const tree = moveLeaf(prev.tree, existing.id, leafId, zone);
        const landed = findLeafBySession(tree, sessionId);
        return { tree, focusedLeafId: landed?.id ?? prev.focusedLeafId };
      }
      const fresh = makeLeaf(sessionId);
      return { tree: splitLeaf(prev.tree, leafId, zone, fresh), focusedLeafId: fresh.id };
    });
    if (sessionId !== activeSessionId) setActive(sessionId);
  };
  /** A PANE dropped on another pane (dragged by its header): edge → move it there (this is also how the
   *  split DIRECTION changes); center → the two panes swap contents. */
  const onDropPane = (leafId: string, zone: DropZone, srcLeafId: string) => {
    if (srcLeafId === leafId) return;
    setLayout((prev) => {
      if (!findLeaf(prev.tree, srcLeafId) || !findLeaf(prev.tree, leafId)) return prev;
      if (zone === "center") return { ...prev, tree: swapLeafSessions(prev.tree, srcLeafId, leafId) };
      const tree = moveLeaf(prev.tree, srcLeafId, leafId, zone);
      return { tree, focusedLeafId: findLeaf(tree, srcLeafId)?.id ?? prev.focusedLeafId };
    });
  };

  // The active session object (if the active id still resolves) — shared by the chat pane + the
  // session-scoped settings panel.
  const activeSession = sessions.find((s) => s.id === activeSessionId);
  // Every session visible in a split pane — the rail marks them "on screen" (the focused one stays the
  // strong active), and the per-pane needs-you counts exclude all of them.
  const visiblePaneSessions = splitCapable
    ? leaves(layout.tree).flatMap((l) => (l.sessionId ? [l.sessionId] : []))
    : [];

  const list = (
    <SessionList
      sessions={sessions}
      activeId={activeSessionId}
      visibleIds={visiblePaneSessions}
      order={sessionOrder}
      lastActiveAt={lastActiveAt}
      now={now}
      usage={usage}
      codexUsage={codexUsage}
      version={updateInfo?.current}
      updateAvailable={updateInfo?.updateAvailable}
      onShowUpdate={() => setUpdatePanelOpen(true)}
      onCheckUpdate={async () => {
        // Force a fresh server-side stable-release check so the user never waits on the cache.
        const info = await api.getVersion(true);
        setUpdateInfo(info);
        return Boolean(info.updateAvailable);
      }}
      onOpenSettings={() => {
        setGlobalSettingsOpen(true);
        setSessionsOpen(false);
      }}
      onOpenHelp={() => {
        setHelpOpen(true);
        setSessionsOpen(false);
      }}
      // CONTRACT C1: SessionList turns its "N need you" badge into a button that calls this — one tap jumps
      // to a waiting chat (the first awaiting session; the sheet stays open when several are waiting).
      onNeedsYouTap={jumpToAwaiting}
      onSelect={(id) => {
        // Defer the heavy xterm remount ONLY on touch (where the freeze lives) and ONLY when actually
        // switching sessions. On desktop / jsdom (fine pointer) mount immediately — no transition freeze
        // there, and it keeps the shell tests synchronous.
        const coarse = typeof window !== "undefined" && !!window.matchMedia?.("(pointer: coarse)")?.matches;
        const deferMount = coarse && id !== activeSessionId;
        // iOS: drop the terminal to a black placeholder for ~2 frames so the sheet-close + layout swap paints
        // on a LIGHT frame; the heavy xterm remount then happens on a stable, already-painted layout instead
        // of blocking the main thread mid-transition (the compositor freeze — "ekran siyah / liste takılı").
        if (deferMount) setTerminalMountReady(false);
        setActive(id);
        setSessionsOpen(false);
        // Safety-net repaint kick across the transition (covers same-session re-select where nothing remounts).
        healPaintBurst();
        if (deferMount) {
          requestAnimationFrame(() => requestAnimationFrame(() => setTerminalMountReady(true)));
        }
      }}
      onNew={() => openWizard()}
      onNewHere={(cwd) => {
        // Start another session in the SAME folder as this row — prefill the wizard's cwd (skips the
        // picker) and close the mobile sheet so the wizard is unobstructed.
        openWizard(cwd);
        setSessionsOpen(false);
      }}
      onClose={closeSession}
      // Server-side rename (the list already wrote the local optimistic label): fire-and-forget — the next
      // /sessions poll carries the server name. A failure only costs cross-device sync (the local label
      // still shows here), so a console.warn is enough; no toast.
      onRename={(id, name) => {
        void api.renameSession(id, name).catch((err: unknown) => {
          console.warn("session rename didn't reach the server (kept locally)", err);
        });
      }}
      // The rail row's ⋯ → Settings: open the SESSION-SCOPED panel for that row. Activate the row first —
      // the panel renders off activeSession — and drop the mobile sheet so the panel is unobstructed.
      onSessionSettings={(id) => {
        setActive(id);
        setSessionSettingsOpen(true);
        setSessionsOpen(false);
      }}
      // Desktop split-screen: rows drag onto workspace panes (edge = split there, center = show there).
      draggableRows={splitCapable}
    />
  );

  return (
    <>
      <ConnectionBanner online={online} />
      {/* Couldn't reach the server (a non-auth failure) while online — the offline banner covers the
          offline case. Auto-clears on the next successful poll; tappable to dismiss meanwhile. */}
      {loadError && online && (
        <div
          role="status"
          style={{
            display: "flex",
            alignItems: "center",
            gap: "var(--sp-2)",
            // Topmost element → clear the status bar / notch itself (the fill still extends behind it).
            padding: "calc(var(--sp-2) + env(safe-area-inset-top, 0px)) var(--sp-3) var(--sp-2)",
            background: "var(--surface-2)",
            color: "var(--warn)",
            borderBottom: "1px solid var(--border)",
            fontSize: "var(--fs-sm)",
          }}
        >
          <Icon name="alert" size={15} />
          <span style={{ flex: 1, minWidth: 0 }}>{loadError}</span>
          <button
            type="button"
            onClick={() => setLoadError(undefined)}
            aria-label="Dismiss"
            style={{
              flex: "none",
              display: "grid",
              placeItems: "center",
              width: "var(--tap-min)",
              height: "var(--tap-min)",
              background: "transparent",
              border: "none",
              color: "var(--text-muted)",
              cursor: "pointer",
            }}
          >
            <Icon name="x" size={16} />
          </button>
        </div>
      )}
      {/* This running bundle is OLDER than the deployed server (a stale precached PWA the auto-refresh
          couldn't swap). Not dismissible — tapping Refresh hard-resets (drops SW + caches) so the phone
          finally loads the current code. Takes precedence over the server-driven "update available" banner. */}
      {clientStale ? (
        <div role="status" className="rc-stale-banner">
          <Icon name="alert" size={15} />
          <span style={{ flex: 1, minWidth: 0 }}>
            {IOS_WEBKIT
              ? "Update ready — fully close the app (swipe it away in the app switcher) and reopen to finish."
              : "This app is running an old version."}
          </span>
          {/* iOS gets NO Refresh button: its hardRefresh (location.replace) freezes the compositor — the very
              bug this fixes. Closing + reopening the app is the only reliable iOS PWA update, per the text. */}
          {IOS_WEBKIT ? null : (
            <button type="button" onClick={() => void hardRefresh()} className="rc-stale-refresh">
              Refresh
            </button>
          )}
          <style>{`
            .rc-stale-banner {
              display: flex; align-items: center; gap: var(--sp-2);
              padding: calc(var(--sp-2) + env(safe-area-inset-top, 0px)) var(--sp-3) var(--sp-2);
              background: var(--surface-2); color: var(--warn);
              border-bottom: 1px solid var(--border); font-size: var(--fs-sm);
            }
            .rc-stale-refresh {
              flex: none; padding: var(--sp-1) var(--sp-3);
              background: var(--coral); color: #fff; border: none;
              border-radius: var(--radius-sm); font-weight: 600; cursor: pointer;
              min-height: var(--tap-min);
            }
          `}</style>
        </div>
      ) : updateState === "updating" ? (
        <UpdateProgressBanner
          status={updateStatus}
          target={
            updateOperation?.target && updateOperation.target !== "previous"
              ? updateOperation.target
              : updateStatus?.target
          }
          connection={updateConnection}
          onOpen={() => setUpdatePanelOpen(true)}
        />
      ) : (
        updateInfo &&
        !updateBannerDismissed && (
          <UpdateBanner
            info={updateInfo}
            onWhatsNew={() => setUpdatePanelOpen(true)}
            onUpdate={() => setUpdatePanelOpen(true)}
            onDismiss={() => setUpdateBannerDismissed(true)}
          />
        )
      )}
      {/* CLAUDE SIGN-IN banner: the server's Claude login is available but NOT signed in, so every turn
          will 401. Surface a CTA that opens the in-app re-auth dialog. Dismissible; auto-clears the moment
          a poll reports signed-in again. (Expired-but-present creds can't be detected from /auth/status —
          those are handled reactively in Settings → Claude sign-in.) */}
      {authStatus?.available && authStatus.loggedIn === false && !claudeAuthBannerDismissed && (
        <div role="status" className="rc-auth-banner">
          <Icon name="alert" size={15} />
          <span style={{ flex: 1, minWidth: 0 }}>Claude isn’t signed in — turns will fail until you sign in.</span>
          <button type="button" className="rc-auth-banner__cta" onClick={() => setClaudeAuthOpen(true)}>
            Sign in
          </button>
          <button
            type="button"
            className="rc-auth-banner__x"
            onClick={() => setClaudeAuthBannerDismissed(true)}
            aria-label="Dismiss"
          >
            <Icon name="x" size={14} />
          </button>
          <style>{`
            .rc-auth-banner {
              display: flex; align-items: center; gap: var(--sp-2);
              padding: calc(var(--sp-2) + env(safe-area-inset-top, 0px)) var(--sp-3) var(--sp-2);
              background: var(--surface-2); color: var(--warn);
              border-bottom: 1px solid var(--border); font-size: var(--fs-sm);
            }
            .rc-auth-banner__cta {
              flex: none; min-height: 32px; padding: 0 var(--sp-3);
              background: var(--coral); color: var(--on-accent); border: 1px solid transparent;
              border-radius: var(--radius-pill); font: inherit; font-weight: 600; cursor: pointer;
            }
            .rc-auth-banner__cta:hover { filter: brightness(1.08); }
            .rc-auth-banner__x {
              flex: none; display: grid; place-items: center;
              width: var(--tap-min); height: var(--tap-min); border-radius: var(--radius-sm);
              background: transparent; border: none; color: var(--text-muted); cursor: pointer;
            }
            .rc-auth-banner__x:hover { color: var(--text); }
          `}</style>
        </div>
      )}
      {updatedTo && (
        <div role="status" className="rc-updated-toast">
          <Icon name="check" size={15} style={{ color: "var(--coral)" }} />
          <span>
            Updated to <span style={{ fontFamily: "var(--font-mono)" }}>{updatedTo}</span>
          </span>
          <button type="button" onClick={() => setUpdatedTo(undefined)} aria-label="Dismiss">
            <Icon name="x" size={14} />
          </button>
          <style>{`
            .rc-updated-toast {
              position: fixed; left: 50%; transform: translateX(-50%);
              top: calc(env(safe-area-inset-top, 0px) + var(--sp-4));
              z-index: 60; max-width: min(92vw, 420px);
              display: inline-flex; align-items: center; gap: var(--sp-3);
              padding: var(--sp-2) var(--sp-3);
              background: var(--surface-2); color: var(--text);
              border: 1px solid var(--accent-line); border-radius: var(--radius);
              box-shadow: var(--shadow); font-size: var(--fs-sm);
            }
            .rc-updated-toast button {
              flex: none; display: grid; place-items: center;
              width: var(--tap-min); height: var(--tap-min); border-radius: var(--radius-sm);
              background: transparent; border: none; color: var(--text-muted); cursor: pointer;
            }
            .rc-updated-toast button:hover { color: var(--text); background: var(--surface); }
          `}</style>
        </div>
      )}
      {closeError && (
        <div role="alert" className="rc-close-err">
          <span>{closeError}</span>
          <button type="button" onClick={() => setCloseError(undefined)} aria-label="Dismiss">
            <Icon name="x" size={14} />
          </button>
          <style>{`
            .rc-close-err {
              position: fixed; left: 50%; transform: translateX(-50%);
              bottom: calc(env(safe-area-inset-bottom, 0px) + var(--sp-4));
              z-index: 60; max-width: min(92vw, 420px);
              display: inline-flex; align-items: center; gap: var(--sp-3);
              padding: var(--sp-2) var(--sp-3);
              background: var(--surface-2); color: var(--text);
              border: 1px solid var(--err-border); border-radius: var(--radius);
              box-shadow: var(--shadow); font-size: var(--fs-sm);
            }
            .rc-close-err button {
              flex: none; display: grid; place-items: center;
              width: var(--tap-min); height: var(--tap-min); border-radius: var(--radius-sm);
              background: transparent; border: none; color: var(--text-muted); cursor: pointer;
            }
            .rc-close-err button:hover { color: var(--text); background: var(--surface); }
          `}</style>
        </div>
      )}
      {/* UNDO the just-closed session — a brief, non-blocking toast (a mis-tap safety net for the one-tap
          destructive ✕). Tapping Undo re-adds + re-selects the row; it auto-expires otherwise. */}
      {pendingUndo && (
        <div role="status" className="rc-undo">
          <span>
            Closed <strong style={{ fontWeight: 600 }}>{basename(pendingUndo.session.cwd)}</strong>
          </span>
          <button type="button" className="rc-undo__action" onClick={undoClose}>
            Undo
          </button>
          <button type="button" className="rc-undo__x" onClick={dismissUndo} aria-label="Dismiss">
            <Icon name="x" size={14} />
          </button>
          <style>{`
            .rc-undo {
              position: fixed; left: 50%; transform: translateX(-50%);
              bottom: calc(env(safe-area-inset-bottom, 0px) + var(--sp-4));
              z-index: 61; max-width: min(92vw, 420px);
              display: inline-flex; align-items: center; gap: var(--sp-2);
              padding: var(--sp-2) var(--sp-2) var(--sp-2) var(--sp-3);
              background: var(--surface-2); color: var(--text);
              border: 1px solid var(--border-strong); border-radius: var(--radius);
              box-shadow: var(--shadow); font-size: var(--fs-sm);
            }
            .rc-undo__action {
              flex: none; min-height: 32px; padding: 0 var(--sp-3);
              background: transparent; color: var(--coral); border: 1px solid var(--accent-line);
              border-radius: var(--radius-pill); font: inherit; font-weight: 600; cursor: pointer;
            }
            .rc-undo__action:hover { background: var(--surface); }
            .rc-undo__x {
              flex: none; display: grid; place-items: center;
              width: var(--tap-min); height: var(--tap-min); border-radius: var(--radius-sm);
              background: transparent; border: none; color: var(--text-muted); cursor: pointer;
            }
            .rc-undo__x:hover { color: var(--text); background: var(--surface); }
          `}</style>
        </div>
      )}
      {/* The restored-session validation cleared an active session that no longer exists (e.g. its tmux died
          across an OTA). Explain the empty landing instead of dropping the user onto it silently. Dismissible;
          a fresh selection / new session makes it irrelevant. */}
      {endedNotice && (
        <div role="status" className="rc-ended-toast">
          <Icon name="history" size={15} />
          <span>Your last session ended — start a new one.</span>
          <button type="button" onClick={() => setEndedNotice(false)} aria-label="Dismiss">
            <Icon name="x" size={14} />
          </button>
          <style>{`
            .rc-ended-toast {
              position: fixed; left: 50%; transform: translateX(-50%);
              top: calc(env(safe-area-inset-top, 0px) + var(--sp-4));
              z-index: 60; max-width: min(92vw, 420px);
              display: inline-flex; align-items: center; gap: var(--sp-3);
              padding: var(--sp-2) var(--sp-3);
              background: var(--surface-2); color: var(--text);
              border: 1px solid var(--border-strong); border-radius: var(--radius);
              box-shadow: var(--shadow); font-size: var(--fs-sm);
            }
            .rc-ended-toast button {
              flex: none; display: grid; place-items: center;
              width: var(--tap-min); height: var(--tap-min); border-radius: var(--radius-sm);
              background: transparent; border: none; color: var(--text-muted); cursor: pointer;
            }
            .rc-ended-toast button:hover { color: var(--text); background: var(--surface); }
          `}</style>
        </div>
      )}
      <AppLayout
        sessionList={list}
        sessionsOpen={sessionsOpen}
        conversationActive={activeSessionId !== undefined}
        onHideSessions={() => setSessionsOpen(false)}
      >
        {activeSessionId ? (
          (() => {
            const active = sessions.find((s) => s.id === activeSessionId);
            return active ? (
              splitCapable ? (
                // DESKTOP: the split workspace. A single-leaf tree renders exactly one TerminalView (visually
                // identical to the classic view); splits add panes. Each pane gets its OWN error boundary
                // (one crashing conversation must not take down its neighbours) keyed by leaf+session so
                // moving a session between panes remounts with fresh per-instance state.
                <SplitWorkspace
                  tree={layout.tree}
                  focusedLeafId={layout.focusedLeafId}
                  sessions={sessions}
                  onFocusPane={onFocusPane}
                  onTreeChange={(tree) => setLayout((p) => ({ ...p, tree }))}
                  onPickSession={onPickSession}
                  onNewSessionInPane={onNewSessionInPane}
                  onClosePane={onClosePane}
                  onDropSession={onDropSession}
                  onDropPane={onDropPane}
                  renderTerminal={(session, pane) => (
                    <ErrorBoundary key={`${pane.leafId}:${session.id}`} variant="compact" label="this pane">
                      <TerminalView
                        session={session}
                        // Exclude EVERY visible pane from the needs-you count — you're watching all of them.
                        needsYou={awaitingCount(sessions, visiblePaneSessions)}
                        // Window-manager semantics (user request): on desktop the header ✕ ALWAYS closes
                        // the PANE — even the last one (→ back to the landing). The session keeps running
                        // in tmux and stays in the rail; actually STOPPING it lives in the rail's ⋯ → ✕
                        // and Settings → Close session. Mobile keeps its classic close-the-session ✕.
                        onClose={() => onClosePane(pane.leafId)}
                        closeIsPane
                        // No gear in the chat header (user request) — settings live in the RAIL's gear only.
                        onSplitRight={() => onSplitPane(pane.leafId, "right")}
                        onSplitDown={() => onSplitPane(pane.leafId, "bottom")}
                        // Rearrange: the header doubles as this pane's drag handle (multi-pane only —
                        // there's nowhere to move a solo pane).
                        dragPaneId={pane.multi ? pane.leafId : undefined}
                      />
                    </ErrorBoundary>
                  )}
                />
              ) : (
                // Key by the active session id so switching sessions remounts ChatView with fresh
                // per-instance state. Critically, the client-side auto-allow rules and the answered
                // set live in ChatView's component state; a stable element position would reuse the
                // same instance across sessions and leak an "Always allow <tool>" rule from one
                // session into another — a cross-session bypass of the permission gate.
                // A chat-level boundary (keyed by session) so a render crash in ONE conversation shows a
                // recoverable error in the chat pane instead of taking the whole app down to a gray screen —
                // the rail stays usable, and switching sessions resets it.
                <ErrorBoundary key={active.id} variant="compact" label="this conversation">
                  {/* Terminal is the only session mode. TerminalView owns its full chrome: the top-bar
                      (mobile menu → sessions sheet, session name, close, Files panel) + terminal + key bar.
                      Gated by terminalMountReady so a session SWITCH defers the heavy xterm mount past the
                      select transition's paint (iOS compositor freeze fix) — a black placeholder holds the
                      box for ~2 frames so the layout is stable when the terminal actually mounts. */}
                  {terminalMountReady ? (
                    <TerminalView
                      session={active}
                      onShowSessions={() => setSessionsOpen(true)}
                      needsYou={awaitingCount(sessions, activeSessionId)}
                      onClose={() => closeSession(active.id)}
                      // No gear in the chat header (user request) — settings live in the RAIL's gear only.
                    />
                  ) : (
                    <div aria-hidden style={{ flex: "1 1 auto", minHeight: 0, background: "#0a0a0b" }} />
                  )}
                </ErrorBoundary>
              )
            ) : (
              // No matching session (e.g. a stale deep-link id). There's no ChatHeader here, so keep
              // the sessions sheet reachable on mobile via the same top-left, in-flow menu button.
              <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
                <div
                  style={{
                    display: "flex",
                    padding: "calc(var(--sp-3) + env(safe-area-inset-top, 0px)) var(--sp-4) var(--sp-3)",
                    flex: "none",
                  }}
                >
                  <MobileMenuButton
                    onShowSessions={() => setSessionsOpen(true)}
                    needsYou={awaitingCount(sessions, activeSessionId)}
                  />
                </div>
                <div
                  style={{
                    display: "grid",
                    placeItems: "center",
                    gap: "var(--sp-4)",
                    flex: 1,
                    minHeight: 0,
                    color: "var(--text-muted)",
                    padding: "var(--sp-5)",
                    textAlign: "center",
                  }}
                >
                  <div style={{ display: "grid", gap: "var(--sp-2)" }}>
                    <span className="display" style={{ fontSize: "var(--fs-lg)", color: "var(--text)" }}>
                      Session not found.
                    </span>
                    <span style={{ fontSize: "var(--fs-sm)", maxWidth: "30ch", lineHeight: 1.5 }}>
                      It may have been closed or ended. Open another session or start a new one.
                    </span>
                  </div>
                  {/* Recovery actions so the stale deep-link isn't a dead end. */}
                  <div style={{ display: "flex", gap: "var(--sp-3)", flexWrap: "wrap", justifyContent: "center" }}>
                    <button
                      type="button"
                      className="rc-recover rc-recover--ghost"
                      onClick={() => setSessionsOpen(true)}
                    >
                      <Icon name="menu" size={16} />
                      Open a session
                    </button>
                    <button type="button" className="rc-recover rc-recover--primary" onClick={() => openWizard()}>
                      <Icon name="plus" size={16} />
                      Start new
                    </button>
                  </div>
                  <style>{`
                    .rc-recover {
                      display: inline-flex; align-items: center; gap: var(--sp-2);
                      min-height: var(--tap-min); padding: 0 var(--sp-4);
                      border-radius: 999px; cursor: pointer;
                      font-family: var(--font-display); font-weight: 600;
                    }
                    .rc-recover--ghost { background: var(--surface-2); color: var(--text); border: 1px solid var(--border-strong); }
                    .rc-recover--ghost:hover { border-color: var(--text-faint); }
                    .rc-recover--primary { background: var(--accent-grad); color: var(--on-accent); border: none; }
                    .rc-recover--primary:hover { filter: brightness(1.08); }
                  `}</style>
                </div>
              </div>
            );
          })()
        ) : (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              height: "100%",
              // A workspace drag hovering the landing: show it's a live drop target (drop = open the session).
              boxShadow: landingDragOver ? "inset 0 0 0 2px var(--accent-line)" : undefined,
              background: landingDragOver ? "var(--accent-soft)" : undefined,
              transition: "background 120ms ease",
            }}
            onDragOver={(e) => {
              if (!isWorkspaceDrag(e.dataTransfer.types)) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
              setLandingDragOver(true);
            }}
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setLandingDragOver(false);
            }}
            onDrop={(e) => {
              if (!isWorkspaceDrag(e.dataTransfer.types)) return;
              e.preventDefault();
              setLandingDragOver(false);
              const sessionId = e.dataTransfer.getData(SESSION_MIME);
              // Opening = exactly what selecting from the rail does; the workspace mirror effect then
              // loads it into the (persisted) focused pane.
              if (sessionId) setActive(sessionId);
            }}
          >
            {/* On the landing/empty state there's no ChatHeader, so the sessions sheet still needs a
                trigger on mobile. A slim, in-flow top-left affordance carries the SAME menu button
                (with the needs-you pip) so sessions are always reachable. Desktop: the button hides
                itself (rail always visible), leaving just the empty bar. */}
            <div
              style={{
                display: "flex",
                padding: "calc(var(--sp-3) + env(safe-area-inset-top, 0px)) var(--sp-4) var(--sp-3)",
                flex: "none",
              }}
            >
              <MobileMenuButton
                onShowSessions={() => setSessionsOpen(true)}
                needsYou={awaitingCount(sessions, activeSessionId)}
              />
            </div>
            <div
              style={{
                display: "grid",
                placeItems: "center",
                gap: "var(--sp-4)",
                flex: 1,
                minHeight: 0,
                color: "var(--text-muted)",
                padding: "var(--sp-5)",
                textAlign: "center",
              }}
            >
              {/* The landing mark — a flat elevated tile + a --line-2 edge; the ONE coral here is the
                  GLYPH (spec .mark), NOT a coral fill. No glow. */}
              <span
                aria-hidden="true"
                style={{
                  width: 56,
                  height: 56,
                  display: "grid",
                  placeItems: "center",
                  borderRadius: "var(--radius)",
                  background: "var(--tile-bg)",
                  border: "1px solid var(--tile-edge)",
                  color: "var(--coral)",
                }}
              >
                <Icon name="terminal" size={26} />
              </span>
              <span className="display" style={{ fontSize: "var(--fs-lg)", color: "var(--text)" }}>
                Select or start a session
              </span>
              <span style={{ fontSize: "var(--fs-sm)", color: "var(--text-muted)", maxWidth: "26ch", lineHeight: 1.5 }}>
                No active session. Start one and drive Claude Code or Codex from your phone.
              </span>
              {/* A landing-state CTA so a new session is reachable without first opening the mobile
                sessions sheet (the rail's "New session" is hidden until the sheet is open on mobile).
                The single coral primary — a FLAT coral fill, dark ink label. No glow. */}
              <button
                type="button"
                onClick={() => openWizard()}
                aria-label="New session"
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "var(--sp-2)",
                  minHeight: "var(--tap-min)",
                  padding: "0 var(--sp-5)",
                  background: "var(--accent-grad)",
                  color: "var(--on-accent)",
                  border: "none",
                  borderRadius: "999px",
                  cursor: "pointer",
                  fontFamily: "var(--font-display)",
                  fontWeight: 600,
                }}
              >
                <Icon name="plus" size={16} />
                New session
              </button>
              {/* First-run onboarding — the core model in a few calm lines. Dismissed forever via localStorage
                  (`rc-onboarded`). Lives ONLY on the landing, so it never covers a live chat. */}
              {!onboarded && (
                <div className="rc-onboard">
                  <div className="rc-onboard__head">
                    <span className="rc-onboard__title">How this works</span>
                    <button type="button" className="rc-onboard__x" onClick={dismissOnboarding} aria-label="Dismiss">
                      <Icon name="x" size={14} />
                    </button>
                  </div>
                  <ul className="rc-onboard__list">
                    <li>
                      Sessions run the selected agent CLI in a folder on your Mac — they keep running even if you
                      disconnect.
                    </li>
                    <li>
                      Choose Claude Code or Codex for each new session; the terminal works like it does on your Mac.
                    </li>
                    <li>
                      On iOS: Add to Home Screen and enable notifications to get pinged when Claude Code or Codex needs
                      you.
                    </li>
                    <li>Open a session and tap “?” for gesture &amp; copy help.</li>
                  </ul>
                  <style>{`
                    .rc-onboard {
                      width: min(92vw, 420px); text-align: left;
                      background: var(--surface-2); border: 1px solid var(--border);
                      border-radius: var(--radius); box-shadow: var(--shadow);
                      padding: var(--sp-3) var(--sp-4) var(--sp-4);
                    }
                    .rc-onboard__head {
                      display: flex; align-items: center; justify-content: space-between; gap: var(--sp-2);
                      margin-bottom: var(--sp-2);
                    }
                    .rc-onboard__title {
                      font-family: var(--font-display); font-weight: 600; color: var(--text); font-size: var(--fs-sm);
                    }
                    .rc-onboard__x {
                      flex: none; display: grid; place-items: center;
                      width: 32px; height: 32px; margin: -6px -8px -6px 0; border-radius: var(--radius-sm);
                      background: transparent; border: none; color: var(--text-faint); cursor: pointer;
                    }
                    .rc-onboard__x:hover { color: var(--text); }
                    .rc-onboard__list {
                      margin: 0; padding-left: 1.1em;
                      display: grid; gap: 6px;
                      font-size: var(--fs-sm); line-height: 1.5; color: var(--text-muted);
                    }
                    .rc-onboard__list code {
                      font-family: var(--font-mono); font-size: 0.92em; color: var(--text);
                    }
                  `}</style>
                </div>
              )}
            </div>
          </div>
        )}
      </AppLayout>
      {wizardOpen && (
        <NewSessionWizard
          api={api}
          defaults={defaultsSync.defaults}
          recents={loadRecentDirs()}
          now={now}
          models={models}
          providerSummaries={providerSummaries}
          codexModels={codexModels}
          codexProfiles={codexProfiles}
          providerAvailabilityState={providerAvailabilityState}
          claudeMetadataState={claudeMetadataState}
          codexMetadataState={codexMetadataState}
          providerAuthStates={providerAuthStates}
          onRetryProviderAvailability={() => setProviderReload((attempt) => attempt + 1)}
          // Prefill the folder when opened via "＋ here" (skips the picker); undefined → normal picker flow.
          initialCwd={wizardCwd}
          onClose={() => {
            setWizardOpen(false);
            setWizardCwd(undefined);
          }}
          onCreated={(session) => {
            // addSession is idempotent (no-op if the id already exists) and an immutable store update, so
            // it can't clobber a concurrent mergeSessionMeta poll the way a render-closure setSessions could.
            addSession(session);
            setActive(session.id);
            setWizardOpen(false);
            setWizardCwd(undefined);
            setSessionsOpen(false);
          }}
        />
      )}
      {globalSettingsOpen && (
        <SettingsPanel
          defaults={defaultsSync.defaults}
          defaultsSyncState={defaultsSync.status}
          defaultsSaveState={defaultsSaveState}
          defaultsSaveError={defaultsSaveError}
          sessionOrder={sessionOrder}
          onSessionOrderChange={changeSessionOrder}
          onSaveDefaults={saveSessionDefaults}
          api={api}
          models={models}
          codexModels={codexModels}
          codexProfiles={codexProfiles}
          claudeMetadataState={claudeMetadataState}
          codexMetadataState={codexMetadataState}
          onRetryProviderMetadata={() => setProviderReload((attempt) => attempt + 1)}
          pushState={pushState}
          onEnablePush={async () => {
            try {
              const result = await enablePush(api);
              // enablePush returns subscribed | denied | unsupported — surface "denied" so the panel can
              // explain it (re-tapping Enable silently no-ops once the browser has denied permission).
              setPushState(result);
            } catch {
              setPushState("unsubscribed");
            }
          }}
          onDisablePush={async () => {
            try {
              await disablePush(api);
            } finally {
              setPushState("unsubscribed");
            }
          }}
          // CONTRACT C2: SettingsPanel renders a "Sign out" button that calls this — clears the token +
          // returns to the login screen (switch token / sign out of this device).
          onSignOut={signOut}
          onClose={() => setGlobalSettingsOpen(false)}
        />
      )}
      {/* SESSION-SCOPED settings — the same panel seeded with the active session (opened from the chat
          header gear). Shows the "This session" block + the shared defaults/notifications sections. The
          per-session "Close session" routes through the shared closeSession (with its Undo affordance). */}
      {/* Help sheet — opened from the RAIL's "?" (left of the gear); renders over anything, landing included. */}
      <HelpSheet open={helpOpen} onClose={() => setHelpOpen(false)} />
      {sessionSettingsOpen && activeSession && (
        <SettingsPanel
          session={activeSession}
          defaults={defaultsSync.defaults}
          defaultsSyncState={defaultsSync.status}
          defaultsSaveState={defaultsSaveState}
          defaultsSaveError={defaultsSaveError}
          sessionOrder={sessionOrder}
          onSessionOrderChange={changeSessionOrder}
          onSaveDefaults={saveSessionDefaults}
          api={api}
          models={models}
          codexModels={codexModels}
          codexProfiles={codexProfiles}
          claudeMetadataState={claudeMetadataState}
          codexMetadataState={codexMetadataState}
          onRetryProviderMetadata={() => setProviderReload((attempt) => attempt + 1)}
          onNewSessionHere={(o) => {
            setSessionSettingsOpen(false);
            // cwd only — the wizard seeds everything else from the SAVED defaults (passing the old session's
            // opts here silently overrode them, which read as "my settings aren't remembered").
            openWizard(o.cwd);
          }}
          onStopSession={(id) => {
            setSessionSettingsOpen(false);
            closeSession(id);
          }}
          // CONTRACT C2: same "Sign out" button here as in the global panel (settings is settings).
          onSignOut={signOut}
          onClose={() => setSessionSettingsOpen(false)}
        />
      )}
      {/* In-app Claude re-authentication (opened from the sign-in banner's CTA). Re-poll status on close
          so a successful sign-in immediately clears the banner. */}
      {claudeAuthOpen && (
        <ClaudeAuthDialog
          api={api}
          onClose={() => {
            setClaudeAuthOpen(false);
            void requestClaudeAuthStatus();
          }}
        />
      )}
      {updatePanelOpen && updateInfo && (
        <UpdatePanel
          info={updateInfo}
          state={updateState}
          status={updateStatus}
          connection={updateConnection}
          onUpdate={applyUpdate}
          onRollback={updateInfo.rollbackAvailable ? rollbackUpdate : undefined}
          onClose={() => setUpdatePanelOpen(false)}
        />
      )}
      {/* PWA install nudge — captured beforeinstallprompt (Android) or an iOS Add-to-Home-Screen tip.
          Gated to AFTER the first session so it never lands on the cold login/landing screen; dismissible
          once (localStorage). Installing is what unlocks Web Push + the home-screen badge on iOS. */}
      {/* Prominent "a session needs you" alert (fires with a chime + haptic from the poll). Tappable → opens
          that session; dismissible; auto-clears once the session is no longer waiting. */}
      {needsYouAlert && (
        <div role="alert" className="rc-needsyou">
          <button
            type="button"
            className="rc-needsyou__open"
            onClick={() => {
              const { id, count } = needsYouAlert;
              setNeedsYouAlert(undefined);
              unlockAudio();
              if (count > 1) {
                // Several are waiting — open the sheet focused on the awaiting ones so you can choose which
                // to answer first (mirrors the rail badge's jump-to).
                const first = sessions.find((s) => s.awaiting);
                if (first) setActive(first.id);
                setSessionsOpen(true);
              } else {
                // A single ping — straight to that chat.
                setActive(id);
                setSessionsOpen(false);
              }
              healPaintBurst();
            }}
          >
            <Icon name="bell" size={16} />
            <span className="rc-needsyou__txt">
              {needsYouAlert.count > 1 ? (
                <>
                  <strong>{needsYouAlert.count} chats</strong> need you — tap to open
                </>
              ) : (
                <>
                  <strong>
                    {needsYouAlert.provider} · {needsYouAlert.label}
                  </strong>{" "}
                  needs you — tap to open
                </>
              )}
            </span>
          </button>
          <button
            type="button"
            className="rc-needsyou__x"
            aria-label="Dismiss"
            onClick={() => setNeedsYouAlert(undefined)}
          >
            <Icon name="x" size={16} />
          </button>
          <style>{`
            .rc-needsyou {
              position: fixed; left: 0; right: 0; top: env(safe-area-inset-top, 0px); z-index: 58;
              display: flex; align-items: stretch;
              margin: var(--sp-2) var(--sp-3); border-radius: var(--radius);
              background: var(--accent-grad, var(--coral)); color: var(--on-accent, #fff);
              box-shadow: var(--shadow); overflow: hidden;
              animation: rc-needsyou-in 200ms ease;
            }
            @keyframes rc-needsyou-in { from { opacity: 0; transform: translateY(-8px); } to { opacity: 1; transform: none; } }
            .rc-needsyou__open {
              flex: 1; min-width: 0; display: flex; align-items: center; gap: var(--sp-2);
              padding: var(--sp-3); background: transparent; border: none; cursor: pointer;
              color: inherit; font: inherit; font-weight: 600; text-align: left;
            }
            .rc-needsyou__txt { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
            .rc-needsyou__x {
              flex: none; display: grid; place-items: center; width: 44px;
              background: rgba(0, 0, 0, 0.14); border: none; color: inherit; cursor: pointer;
            }
          `}</style>
        </div>
      )}
      <InstallPrompt show={sessions.length > 0} />
    </>
  );
}
