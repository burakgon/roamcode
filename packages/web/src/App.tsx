import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LoginScreen } from "./auth/LoginScreen";
import { loadToken, saveToken, clearToken, consumeTokenFromUrl, consumePairingFromUrl } from "./auth/token-store";
import { defaultDeviceName } from "./auth/device-name";
import { createApiClient, ApiError, claimPairing, type ApiClientOptions } from "./api/client";
import { API_BASE_URL } from "./config";
import { useStore } from "./store/store";
import { useShallow } from "zustand/react/shallow";
import { AppLayout } from "./AppLayout";
import { SessionList, awaitingCount } from "./session/SessionList";
import { sortSessions } from "./session/order";
import { loadSessionOrder, saveSessionOrder, type SessionOrder } from "./session/order-preference";
import { sessionIdFromLocation } from "./session/deep-link";
import { loadRecentDirs } from "./picker/recents";
import { enablePush, disablePush, currentPushState, syncExistingPushOwner } from "./pwa/push";
import { applyAppBadge, badgeCount } from "./pwa/badge";
import { playFinishedChime, playNeedsYouChime, needsYouHaptic, unlockAudio } from "./pwa/alert-sound";
import { isIosWebKit } from "./pwa/platform";
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
  parseStoredLayout,
  removeLeaf,
  saveLayout,
  setLeafSession,
  splitLeaf,
  swapLeafSessions,
  type DropEdge,
  type StoredLayout,
} from "./split/layout";
import { isWorkspaceDrag, SESSION_MIME, type DropZone } from "./split/dnd";
import type { CommandLayoutEnvelope, HostRecord, SessionMeta, UpdateStatus } from "./types/server";
import type { CodexUsage } from "./providers/types";
import { currentOriginScopeId, loadLegacyCurrentOriginToken } from "./hosts/current-origin";
import {
  loadHostActiveSession,
  loadHostRailMode,
  saveHostActiveSession,
  saveHostRailMode,
  type RailMode,
} from "./hosts/host-ui-state";
import { providerDisplayName } from "./session/provider-display";
import { sessionAttentionSection } from "./session/attention-groups";

type Phase = "login" | "pairing" | "validating" | "ready";

const TerminalView = lazy(async () => ({ default: (await import("./chat/TerminalView")).TerminalView }));
const NewSessionWizard = lazy(async () => ({
  default: (await import("./session/NewSessionWizard")).NewSessionWizard,
}));
const SettingsPanel = lazy(async () => ({ default: (await import("./settings/SettingsPanel")).SettingsPanel }));
const HelpSheet = lazy(async () => ({ default: (await import("./chat/HelpSheet")).HelpSheet }));

function DeferredTerminal() {
  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        flex: "1 1 auto",
        minHeight: 0,
        display: "grid",
        placeItems: "center",
        background: "var(--terminal-bg, var(--bg))",
        color: "var(--text-faint)",
        fontSize: "var(--fs-xs)",
      }}
    >
      Loading terminal…
    </div>
  );
}

function DeferredPanel({ label }: { label: string }) {
  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 80,
        display: "grid",
        placeItems: "center",
        padding: "var(--sp-5)",
        background: "color-mix(in srgb, var(--bg) 92%, transparent)",
        color: "var(--text-muted)",
        fontSize: "var(--fs-sm)",
      }}
    >
      Loading {label}…
    </div>
  );
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

function responsiveRailDefault(): RailMode {
  return typeof window !== "undefined" && window.matchMedia?.("(min-width: 1024px)").matches ? "expanded" : "compact";
}

function effectiveActivity(session: SessionMeta): SessionMeta["activity"] {
  return session.agent?.activity ?? session.activity;
}

export function App() {
  // Pairing capabilities are consumed and removed from the address bar immediately; they are never
  // written to durable browser storage.
  const [pairingSecret] = useState<string | undefined>(() => consumePairingFromUrl());
  const [urlToken] = useState<string | undefined>(() => consumeTokenFromUrl());
  const [initialCredential] = useState<string | undefined>(() => urlToken ?? loadToken());
  const [legacyCurrentOriginCredential] = useState<string | undefined>(() =>
    loadLegacyCurrentOriginToken(API_BASE_URL),
  );
  const legacyCredentialRecoveryTried = useRef(
    initialCredential === undefined && legacyCurrentOriginCredential !== undefined,
  );
  const [connectionScopeId] = useState(() => currentOriginScopeId(API_BASE_URL));
  // Prefer a `?token=` in the connect URL (the link the server prints): persist it + strip it from
  // the address bar, so opening the printed link authenticates directly instead of prompting. Falls
  // back to a previously stored token.
  const [token, setTokenState] = useState<string | undefined>(() => initialCredential ?? legacyCurrentOriginCredential);

  const [sessionOrder, setSessionOrderState] = useState<SessionOrder>(() => loadSessionOrder());
  const changeSessionOrder = (order: SessionOrder) => {
    setSessionOrderState(order);
    saveSessionOrder(order);
  };
  const [phase, setPhase] = useState<Phase>(pairingSecret ? "pairing" : token === undefined ? "login" : "validating");
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
  // A small, dismissible error for a session mutation that actually FAILED — a close (so we don't silently
  // pretend a session is gone) or a rename that never reached the server. Cleared on the next attempt or when
  // the user dismisses it.
  const [closeError, setCloseError] = useState<string | undefined>();
  // UNDO a close: after the optimistic removal we hold the closed session briefly so an "Undo" toast can
  // re-add + re-select it (a fat-finger safety net for the one-tap destructive ✕). Auto-expires.
  const [pendingUndo, setPendingUndo] = useState<{ session: SessionMeta; wasActive: boolean } | undefined>(undefined);
  const undoTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // Surfaced when the INITIAL session load fails for a non-auth reason (server down / wrong host /
  // network): without this the app silently dropped you into an empty list. Cleared on any successful
  // (re)load — the background poll keeps retrying.
  const [loadError, setLoadError] = useState<string | undefined>();
  // Consecutive background-poll failures — surfaces loadError only after the server is genuinely
  // unreachable (not a single blip), reset on the next success.
  const pollFailures = useRef(0);
  // The session poll's refresh, published so the rail's "Retry" can run it now instead of leaving the user to
  // wait out the 6s interval with nothing to press.
  const refreshSessionsRef = useRef<() => void>(() => {});
  // GLOBAL settings (appearance, accounts, device, notifications), reachable WITHOUT opening a session.
  const [globalSettingsOpen, setGlobalSettingsOpen] = useState(false);
  // SESSION-SCOPED settings — the same SettingsPanel, but seeded with the ACTIVE session so it shows the
  // "This session" block. Opened from the chat header's gear (ChatHeader → TerminalView `onOpenSettings`).
  const [sessionSettingsOpen, setSessionSettingsOpen] = useState(false);
  // iOS-Safari compositor fix: gate the terminal mount so that, when SWITCHING sessions, xterm is
  // built a couple frames AFTER the session-select layout swap has painted — not synchronously in the same
  // commit that closes the sessions sheet. Mounting the terminal mid-transition can block the main thread and freeze
  // iOS's compositor on the stale frame (worst on the cold first select — "ekran siyah / liste takılı").
  // Starts true so initial load / a restored session / tests mount immediately (no sheet transition there);
  // onSelect drops it to false for the switch, then a double-rAF flips it back once the swap has painted.
  const [terminalMountReady, setTerminalMountReady] = useState(true);

  // ---- Desktop split-screen workspace (iTerm2-style panes; split/layout.ts owns the model) ----
  // The tree + focused pane live here and persist per browser. MOBILE IS UNTOUCHED: splitCapable is false on
  // any coarse-pointer/narrow window (and in jsdom), so the battle-hardened single-view path renders there.
  const splitCapable = useSplitCapable();
  const [layout, setLayout] = useState<StoredLayout>(() => {
    const stored = loadLayout(connectionScopeId, true);
    if (stored) return stored;
    const solo = makeLeaf();
    return { tree: solo, focusedLeafId: solo.id };
  });
  const layoutRevisionRef = useRef(0);
  const layoutHydratedRef = useRef(false);
  const applyingRemoteLayoutRef = useRef(false);
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  useEffect(() => saveLayout(layout, connectionScopeId), [connectionScopeId, layout]);
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
    { id: string; label: string; provider: string; count: number } | undefined
  >(undefined);
  const [focusRequest, setFocusRequest] = useState<{ agentId: string; sessionId: string } | undefined>();
  // Awaiting ids from the PREVIOUS poll, to detect false→true transitions. undefined until the first poll
  // seeds it, so already-waiting sessions on load never fire a burst of chimes.
  const prevAwaitingRef = useRef<Set<string> | undefined>(undefined);
  // Previous activity by session, used to play the distinct "done" sound only for a real working/blocked →
  // idle transition. undefined until seeded so a reload never announces every already-idle session.
  const prevActivityRef = useRef<Map<string, SessionMeta["activity"]> | undefined>(undefined);
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
  const [commandCenterAvailable, setCommandCenterAvailable] = useState<boolean | undefined>();
  const [commandHost, setCommandHost] = useState<HostRecord>();
  const [railMode, setRailMode] = useState<RailMode>(responsiveRailDefault);
  const railModeHostRef = useRef<string | undefined>(undefined);
  const railModeHostId = commandHost?.id ?? connectionScopeId;
  useEffect(() => {
    if (railModeHostRef.current === railModeHostId) return;
    railModeHostRef.current = railModeHostId;
    setRailMode(loadHostRailMode(railModeHostId) ?? responsiveRailDefault());
  }, [railModeHostId]);
  const toggleRailMode = () => {
    setRailMode((current) => {
      const next = current === "expanded" ? "compact" : "expanded";
      saveHostRailMode(railModeHostId, next);
      return next;
    });
  };
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
  // Open the terminal wizard. A cwd skips the directory picker.
  const openWizard = (cwd?: string) => {
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

  const persistActiveCredential = useCallback((next: string) => saveToken(next), []);

  const clearActiveCredential = useCallback(() => {
    clearToken();
  }, []);

  const activeConnection = useMemo<ApiClientOptions & { hostId: string }>(
    () => ({
      hostId: connectionScopeId,
      baseUrl: API_BASE_URL,
      getToken: () => (token !== "" ? token : undefined),
    }),
    [connectionScopeId, token],
  );
  const api = useMemo(() => createApiClient(activeConnection), [activeConnection]);

  // A browser may already own a PushSubscription when it upgrades from the legacy host key to a device
  // key. Re-upsert that EXISTING endpoint under the current credential (no permission prompt, no new
  // subscription) so later device revocation also removes its out-of-band notification channel.
  useEffect(() => {
    if (phase !== "ready" || token === undefined) return;
    void syncExistingPushOwner(api).catch(() => {
      /* best-effort: push ownership must never block terminal access */
    });
  }, [api, phase, token]);

  useEffect(() => {
    if (!pairingSecret) return;
    let cancelled = false;
    void claimPairing(pairingSecret, defaultDeviceName(), API_BASE_URL)
      .then((enrollment) => {
        if (cancelled) return;
        persistActiveCredential(enrollment.token);
        setTokenState(enrollment.token);
        setLoginError(undefined);
        setPhase("validating");
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        // If an already-connected browser opened an expired link, keep its existing credential. A brand
        // new browser falls back to the manual host-token escape hatch with an actionable explanation.
        const fallback = loadToken() ?? loadLegacyCurrentOriginToken(API_BASE_URL);
        if (fallback !== undefined) {
          setTokenState(fallback);
          setLoginError(undefined);
          setPhase("validating");
          return;
        }
        setLoginError(
          error instanceof ApiError
            ? "This pairing link expired or was already used. Create a new one with `roamcode pair`."
            : "Couldn't reach the host to pair this device. Check the connection and try a fresh link.",
        );
        setPhase("login");
      });
    return () => {
      cancelled = true;
    };
  }, [pairingSecret, persistActiveCredential]);

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

  // Any authenticated request that returns 401 AFTER load means the token was revoked/expired (rotated on the
  // server, or the rotation grace window elapsed). Clear it and return to the login screen instead of
  // retrying forever behind a stale "couldn't reach the server" toast or an endless terminal "Reconnecting…".
  // Returns true when it handled an auth failure so the caller can stop. Stable (useState setters + a module
  // import), so it's safe to list in effect deps.
  const handleAuthExpiry = useCallback(
    (err: unknown): boolean => {
      if (err instanceof ApiError && err.status === 401) {
        clearActiveCredential();
        setTokenState(undefined);
        setLoginError("Session expired — please sign in again.");
        setPhase("login");
        return true;
      }
      return false;
    },
    [clearActiveCredential],
  );

  const refreshCommandCenter = useCallback(async (): Promise<void> => {
    try {
      const capabilities = await api.getCommandCenterCapabilities();
      setCommandHost(capabilities.host);
      setCommandCenterAvailable(true);
    } catch (error: unknown) {
      if (handleAuthExpiry(error)) return;
      if (error instanceof ApiError && error.status === 404) {
        // One-release progressive enhancement: an older host keeps its battle-tested session rail.
        setCommandCenterAvailable(false);
        setCommandHost(undefined);
        return;
      }
    }
  }, [api, handleAuthExpiry]);

  useEffect(() => {
    if (phase !== "ready") {
      setCommandHost(undefined);
      setCommandCenterAvailable(undefined);
      return;
    }
    if (commandCenterAvailable === false) return;
    let cancelled = false;
    const refresh = async () => {
      if (!cancelled) await refreshCommandCenter();
    };
    void refresh();
    const interval = window.setInterval(() => void refresh(), 6_000);
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      window.removeEventListener("focus", onFocus);
    };
  }, [commandCenterAvailable, phase, refreshCommandCenter]);

  const acceptSharedLayout = useCallback((envelope: CommandLayoutEnvelope<StoredLayout>) => {
    layoutRevisionRef.current = envelope.revision;
    const parsed = parseStoredLayout(envelope.document);
    if (!parsed) return false;
    applyingRemoteLayoutRef.current = true;
    setLayout(parsed);
    return true;
  }, []);

  const pullSharedLayout = useCallback(async (): Promise<void> => {
    try {
      const envelope = await api.getCommandLayout<StoredLayout>();
      if (envelope.revision > layoutRevisionRef.current) acceptSharedLayout(envelope);
    } catch (error: unknown) {
      handleAuthExpiry(error);
    }
  }, [acceptSharedLayout, api, handleAuthExpiry]);

  useEffect(() => {
    if (phase !== "ready" || commandCenterAvailable !== true) {
      layoutHydratedRef.current = false;
      layoutRevisionRef.current = 0;
      return;
    }
    if (layoutHydratedRef.current) return;
    let cancelled = false;
    void api
      .getCommandLayout<StoredLayout>()
      .then(async (envelope) => {
        if (cancelled) return;
        layoutRevisionRef.current = envelope.revision;
        const parsed = parseStoredLayout(envelope.document);
        if (parsed) {
          layoutHydratedRef.current = true;
          applyingRemoteLayoutRef.current = true;
          setLayout(parsed);
          return;
        }
        const seeded = await api.putCommandLayout(layout, envelope.revision);
        if (cancelled) return;
        layoutRevisionRef.current = seeded.revision;
        layoutHydratedRef.current = true;
      })
      .catch((error: unknown) => {
        if (!cancelled) handleAuthExpiry(error);
      });
    return () => {
      cancelled = true;
    };
  }, [api, commandCenterAvailable, handleAuthExpiry, layout, phase]);

  useEffect(() => {
    if (phase !== "ready" || commandCenterAvailable !== true || !layoutHydratedRef.current) return;
    if (applyingRemoteLayoutRef.current) {
      applyingRemoteLayoutRef.current = false;
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      const expectedRevision = layoutRevisionRef.current;
      void api
        .putCommandLayout(layout, expectedRevision)
        .then((saved) => {
          if (!cancelled) layoutRevisionRef.current = saved.revision;
        })
        .catch((error: unknown) => {
          if (cancelled || handleAuthExpiry(error)) return;
          if (error instanceof ApiError && error.status === 409) {
            const current = (error.body as { current?: CommandLayoutEnvelope<StoredLayout> } | undefined)?.current;
            if (current) acceptSharedLayout(current);
          }
        });
    }, 350);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [acceptSharedLayout, api, commandCenterAvailable, handleAuthExpiry, layout, phase]);

  useEffect(() => {
    if (phase !== "ready" || commandCenterAvailable !== true) return;
    let reconcileTimer: ReturnType<typeof setTimeout> | undefined;
    const reconcile = () => {
      if (reconcileTimer) return;
      reconcileTimer = setTimeout(() => {
        reconcileTimer = undefined;
        void refreshCommandCenter();
        void api
          .listSessions()
          .then(mergeSessionMeta)
          .catch((error: unknown) => {
            handleAuthExpiry(error);
          });
      }, 75);
    };
    const unsubscribe = api.subscribeCommandEvents({
      onEvent: (message) => {
        const command = message.data as {
          type?: unknown;
          resourceId?: unknown;
          payload?: { sessionId?: unknown; stealFocus?: unknown };
        };
        if (message.event === "command" && command.type === "layout.updated") {
          void pullSharedLayout();
          return;
        }
        if (
          message.event === "command" &&
          (command.type === "focus.requested" || command.type === "focus.activation_requested") &&
          typeof command.resourceId === "string" &&
          typeof command.payload?.sessionId === "string"
        ) {
          if (command.type === "focus.activation_requested" && command.payload.stealFocus === true) {
            setActive(command.payload.sessionId);
            setSessionsOpen(false);
          } else {
            setFocusRequest({ agentId: command.resourceId, sessionId: command.payload.sessionId });
          }
          return;
        }
        if (message.event === "snapshot" || message.event === "reset" || message.event === "command") reconcile();
      },
      onError: (error) => {
        if (handleAuthExpiry(error)) return;
        if (error instanceof ApiError && error.status === 404) setCommandCenterAvailable(false);
      },
    });
    return () => {
      unsubscribe();
      if (reconcileTimer) clearTimeout(reconcileTimer);
    };
  }, [api, commandCenterAvailable, handleAuthExpiry, mergeSessionMeta, phase, pullSharedLayout, refreshCommandCenter]);

  // Sign out / switch token — the USER-initiated version of the 401 path above: clear the stored token and
  // drop back to the login screen. Every poll effect is gated on `phase === "ready"`, so flipping to "login"
  // tears them all down. Close any open settings surface so it doesn't reopen on the next sign-in, and leave
  // `loginError` blank (this is deliberate, not an "expired" failure).
  const signOut = () => {
    setGlobalSettingsOpen(false);
    setSessionSettingsOpen(false);
    setWizardOpen(false);
    setWizardCwd(undefined);
    clearActiveCredential();
    setTokenState(undefined);
    setLoginError(undefined);
    setPhase("login");
  };

  useEffect(() => {
    if (token === undefined || phase !== "validating") return;
    setToken(token);
    let cancelled = false;
    setPhase("validating");
    api
      .listSessions()
      .then((s) => {
        if (cancelled) return;
        setSessions(s);
        const target = loadHostActiveSession(connectionScopeId);
        setActive(target && s.some((session) => session.id === target) ? target : undefined);
        if (token === legacyCurrentOriginCredential) persistActiveCredential(token);
        setLoadError(undefined);
        setPhase("ready");
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 401) {
          if (
            !legacyCredentialRecoveryTried.current &&
            legacyCurrentOriginCredential !== undefined &&
            legacyCurrentOriginCredential !== token
          ) {
            legacyCredentialRecoveryTried.current = true;
            clearActiveCredential();
            setTokenState(legacyCurrentOriginCredential);
            setLoginError(undefined);
            return;
          }
          clearActiveCredential();
          setTokenState(undefined);
          setLoginError("That access token wasn't accepted. Paste a fresh one, or run `roamcode pair` again.");
          setPhase("login");
        } else {
          // network/other error: still enter the app (the list is empty), but SURFACE it so the user
          // knows it's a connection problem, not just "no sessions". The poll keeps retrying + clears it.
          setLoadError("Reconnecting to RoamCode…");
          setPhase("ready");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [
    api,
    clearActiveCredential,
    connectionScopeId,
    legacyCurrentOriginCredential,
    persistActiveCredential,
    phase,
    setSessions,
    setToken,
    token,
  ]);

  useEffect(() => {
    if (phase !== "ready") return;
    saveHostActiveSession(connectionScopeId, activeSessionId);
  }, [activeSessionId, connectionScopeId, phase]);

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
          // "Needs you" foreground nudge: every genuine not-waiting → waiting transition gets the request
          // sound, including the visible terminal (matching Herdr's state/sound contract). The tappable banner
          // remains reserved for an off-screen session, where it provides useful navigation.
          const nextAwaiting = new Set(s.filter((x) => sessionAttentionSection(x) === "need-you").map((x) => x.id));
          const prev = prevAwaitingRef.current;
          if (prev) {
            const activeId = useStore.getState().activeSessionId;
            const viewing = typeof document !== "undefined" && document.visibilityState === "visible";
            // "On screen" = the active session OR any session visible in a split pane (desktop workspace).
            const offScreen = (x: SessionMeta) =>
              !((x.id === activeId || visiblePaneIdsRef.current.has(x.id)) && viewing);
            const freshAll = s.filter((x) => sessionAttentionSection(x) === "need-you" && !prev.has(x.id));
            if (freshAll.length > 0) {
              playNeedsYouChime(); // one request sound regardless of how many changed together
              needsYouHaptic();
            }
            // ALL off-screen sessions that flipped this poll. The banner points at the first while its count
            // includes every off-screen session currently waiting.
            const fresh = freshAll.filter(offScreen);
            const first = fresh[0];
            if (first) {
              // Point the banner at the first fresh one (a one-tap open), but COUNT every chat currently
              // waiting on you (minus the one on screen) so it reads "N chats need you" when more than one is.
              const waiting = s.filter((x) => sessionAttentionSection(x) === "need-you" && offScreen(x));
              setNeedsYouAlert({
                id: first.id,
                label: sessionLabel(first),
                provider: providerDisplayName(first.agent?.provider ?? first.provider ?? "terminal"),
                count: waiting.length,
              });
            }
          }
          // Drop a standing alert once its session is no longer waiting (you answered it, or it ended).
          setNeedsYouAlert((cur) => (cur && !nextAwaiting.has(cur.id) ? undefined : cur));
          prevAwaitingRef.current = nextAwaiting;

          // Completion sound: only a real work/wait → idle transition, and only when that terminal is not the
          // visible one. This mirrors Herdr's "request always, done in the background" behavior and prevents
          // idle snapshots, reconnects, or ended sessions from producing a false completion sound.
          const previousActivity = prevActivityRef.current;
          if (previousActivity) {
            const activeId = useStore.getState().activeSessionId;
            const viewing = typeof document !== "undefined" && document.visibilityState === "visible";
            const completedOffScreen = s.some((x) => {
              const prior = previousActivity.get(x.id);
              const onScreen = (x.id === activeId || visiblePaneIdsRef.current.has(x.id)) && viewing;
              return (
                x.status === "running" &&
                effectiveActivity(x) === "idle" &&
                (prior === "working" || prior === "blocked") &&
                !onScreen
              );
            });
            if (completedOffScreen) playFinishedChime();
          }
          prevActivityRef.current = new Map(s.map((x) => [x.id, effectiveActivity(x)]));
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          if (handleAuthExpiry(err)) return; // token revoked/expired after load → back to login, stop polling
          // A 429 means the Node is up and answering — it is throttling US. Calling that "Reconnecting" was
          // simply untrue and hid the one thing the user can act on (raise the limit, or slow down).
          if (err instanceof ApiError && err.status === 429) {
            pollFailures.current = 0;
            setLoadError("Rate limited by your Node — the session list may be a moment behind.");
            return;
          }
          // Keep the current list (a single blip is transient), but after a couple of CONSECUTIVE poll
          // failures the server is genuinely unreachable — surface it so the user knows the list is stale
          // (the cold-start banner only covered the first load). Cleared on the next success.
          if (++pollFailures.current >= 2) setLoadError("Reconnecting to RoamCode…");
        });
    };
    refreshSessionsRef.current = refresh;
    // Poll a bit faster than before so a "needs you" is timely (the old 15s made it feel laggy). Cheap JSON.
    const interval = setInterval(refresh, 6_000);
    const onFocusOrOnline = () => refresh();
    window.addEventListener("focus", onFocusOrOnline);
    window.addEventListener("online", onFocusOrOnline);
    return () => {
      cancelled = true;
      refreshSessionsRef.current = () => {};
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

  // Session navigation hooks must live above every phase-specific early return. Login → ready changes are
  // ordinary rerenders of this component, so placing them beside ready-only handlers would violate hook order.
  const activateSession = useCallback(
    (id: string) => {
      const coarse = typeof window !== "undefined" && !!window.matchMedia?.("(pointer: coarse)")?.matches;
      const deferMount = coarse && id !== activeSessionId;
      if (deferMount) setTerminalMountReady(false);
      setActive(id);
      setSessionsOpen(false);
      if (deferMount) requestAnimationFrame(() => requestAnimationFrame(() => setTerminalMountReady(true)));
    },
    [activeSessionId, setActive],
  );
  const orderedSessions = useMemo(
    () => sortSessions(sessions, lastActiveAt, sessionOrder),
    [lastActiveAt, sessionOrder, sessions],
  );
  // The single sentence the live region above announces. Ordered by urgency: a failure first, then the
  // things a user is most likely to want confirmation of.
  const liveAnnouncement =
    closeError ??
    (loadError ? loadError : undefined) ??
    (pendingUndo ? `Closed ${basename(pendingUndo.session.cwd)}. Undo is available.` : undefined) ??
    (updatedTo ? `Updated to ${updatedTo}` : undefined) ??
    (endedNotice ? "Your last session ended — start a new one." : undefined) ??
    "";

  // OTA DRAIN GUARD: an update restarts the server and interrupts whatever an agent is doing. `UpdatePanel`
  // has always carried the "a turn is in progress — update anyway?" confirm, but nothing ever told it a turn
  // was running, so the warning could not fire. A live session whose observed activity is "working" is
  // exactly that signal.
  const turnInProgress = useMemo(
    () => sessions.some((s) => s.status === "running" && effectiveActivity(s) === "working"),
    [sessions],
  );
  const moveSession = useCallback(
    (direction: -1 | 1) => {
      if (orderedSessions.length < 2) return;
      const current = orderedSessions.findIndex((candidate) => candidate.id === activeSessionId);
      if (current < 0) return;
      const next = (current + direction + orderedSessions.length) % orderedSessions.length;
      const target = orderedSessions[next];
      if (target) activateSession(target.id);
    },
    [activateSession, activeSessionId, orderedSessions],
  );

  if (phase === "pairing") {
    return (
      <div
        role="status"
        aria-live="polite"
        style={{ minHeight: "100%", display: "grid", placeItems: "center", padding: "var(--sp-5)" }}
      >
        <section
          className="rc-glass--float"
          style={{
            width: "min(92vw, 400px)",
            display: "grid",
            gap: "var(--sp-4)",
            padding: "var(--sp-6)",
            textAlign: "center",
            borderRadius: "var(--radius-lg)",
          }}
        >
          <span aria-hidden="true" className="display" style={{ fontSize: "var(--fs-2xl)", color: "var(--coral)" }}>
            rc
          </span>
          <strong className="display" style={{ color: "var(--text)" }}>
            Pairing this device…
          </strong>
          <span style={{ color: "var(--text-muted)", fontSize: "var(--fs-sm)" }}>
            Creating its own revocable access key. The host key never enters this browser.
          </span>
        </section>
      </div>
    );
  }

  if (phase === "login" || token === undefined) {
    return (
      <div style={{ minHeight: "100%", display: "flex", flexDirection: "column" }}>
        <div style={{ flex: 1, minHeight: 0 }}>
          <LoginScreen
            initialError={loginError}
            onAuthenticated={(t) => {
              persistActiveCredential(t);
              setLoginError(undefined);
              setTokenState(t);
              setPhase("validating");
            }}
          />
        </div>
      </div>
    );
  }

  if (phase === "validating") {
    return (
      <div style={{ minHeight: "100%", display: "flex", flexDirection: "column" }}>
        <div
          style={{
            display: "grid",
            placeItems: "center",
            alignContent: "center",
            gap: "var(--sp-3)",
            flex: 1,
            color: "var(--text-muted)",
            padding: "var(--sp-5)",
            textAlign: "center",
          }}
        >
          <span
            aria-hidden="true"
            className="display"
            style={{ fontSize: "var(--fs-2xl)", color: "var(--text-faint)" }}
          >
            rc
          </span>
          <span style={{ fontFamily: "var(--font-mono)", fontSize: "var(--fs-sm)" }}>Connecting…</span>
        </div>
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
    const waiting = sessions.filter((s) => sessionAttentionSection(s) === "need-you");
    const first = waiting[0];
    if (!first) return;
    setNeedsYouAlert(undefined);
    unlockAudio();
    setActive(first.id);
    setSessionsOpen(waiting.length > 1);
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
  /** The empty pane's "+ New terminal": focus the pane so the wizard-created session lands in it (via the
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
  const activeSessionIndex = orderedSessions.findIndex((candidate) => candidate.id === activeSessionId);
  const sessionPosition =
    activeSessionIndex >= 0 ? { current: activeSessionIndex + 1, total: orderedSessions.length } : undefined;
  // Every session visible in a split pane — the rail marks them "on screen" (the focused one stays the
  // strong active), and the per-pane needs-you counts exclude all of them.
  const visiblePaneSessions = splitCapable
    ? leaves(layout.tree).flatMap((l) => (l.sessionId ? [l.sessionId] : []))
    : [];

  const list = (
    <SessionList
      sessions={sessions}
      hostLabel={commandHost?.label}
      activeId={activeSessionId}
      visibleIds={visiblePaneSessions}
      order={sessionOrder}
      lastActiveAt={lastActiveAt}
      now={now}
      usage={usage}
      codexUsage={codexUsage}
      version={updateInfo?.current}
      updateAvailable={updateInfo?.updateAvailable}
      // With the Node unreachable the list is empty because nothing could be FETCHED, not because there is
      // nothing to show. Tell the rail so it stops claiming "No sessions yet".
      loadState={loadError ? "error" : "ready"}
      onRetryLoad={() => refreshSessionsRef.current()}
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
        activateSession(id);
      }}
      onNew={() => openWizard()}
      onNewHere={(cwd) => {
        // Start another session in the SAME folder as this row — prefill the wizard's cwd (skips the
        // picker) and close the mobile sheet so the wizard is unobstructed.
        openWizard(cwd);
        setSessionsOpen(false);
      }}
      onClose={closeSession}
      // Server-side rename (the list already wrote the local optimistic label): the next /sessions poll
      // carries the server name. A failure costs cross-device sync — this rail keeps showing the new name
      // while every other device keeps the old one — so it is told, not just logged to a console nobody has
      // open on a phone.
      onRename={(id, name) => {
        void api.renameSession(id, name).catch((err: unknown) => {
          console.warn("session rename didn't reach the server (kept locally)", err);
          setCloseError("Renamed on this device only — the Node didn't accept it.");
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
      railMode={railMode}
      onToggleRail={toggleRailMode}
    />
  );

  return (
    <>
      <ConnectionBanner online={online} />
      {/* A reachable network with an unavailable RoamCode service is normally a short startup/restart race.
          Keep the status truthful but compact; the next successful poll removes it automatically. */}
      {loadError && online && (
        <div role="status" aria-live="polite" className="rc-reconnecting">
          <span className="rc-reconnecting__dot" aria-hidden="true" />
          <span>{loadError}</span>
          <style>{`
            .rc-reconnecting {
              flex: none; min-height: 28px;
              display: flex; align-items: center; justify-content: center; gap: var(--sp-2);
              padding: calc(var(--sp-1) + env(safe-area-inset-top, 0px)) var(--sp-3) var(--sp-1);
              background: var(--surface); color: var(--text-muted);
              border-bottom: 1px solid var(--border); font-size: var(--fs-xs);
            }
            .rc-reconnecting__dot {
              width: 6px; height: 6px; flex: none; border-radius: 999px; background: var(--warn);
              animation: rc-reconnecting-pulse 1.2s ease-in-out infinite;
            }
            @keyframes rc-reconnecting-pulse { 0%, 100% { opacity: .4; } 50% { opacity: 1; } }
            @media (prefers-reduced-motion: reduce) { .rc-reconnecting__dot { animation: none; } }
          `}</style>
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
              background: var(--coral); color: var(--on-accent); border: none;
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
      {/* SCREEN READERS: every toast below is created at the same moment its message appears, and a live
          region that is INSERTED with its content is frequently not announced at all. This region is always
          in the DOM and only its text changes, which is what actually gets read out. The visual toasts stay
          exactly as they are; they simply no longer pretend to be the announcement. */}
      <div
        aria-live="polite"
        aria-atomic="true"
        style={{
          position: "absolute",
          width: 1,
          height: 1,
          margin: -1,
          padding: 0,
          overflow: "hidden",
          clip: "rect(0 0 0 0)",
          whiteSpace: "nowrap",
          border: 0,
        }}
      >
        {liveAnnouncement}
      </div>
      {updatedTo && (
        <div className="rc-updated-toast">
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
        <div className="rc-undo">
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
          a fresh selection / new terminal makes it irrelevant. */}
      {endedNotice && (
        <div className="rc-ended-toast">
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
        railMode={railMode}
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
                      <Suspense fallback={<DeferredTerminal />}>
                        <TerminalView
                          session={session}
                          connection={activeConnection}
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
                          // Help is reachable from inside a session, not only from the rail (which a desktop
                          // user can collapse and a mobile user navigates away from).
                          onOpenHelp={() => setHelpOpen(true)}
                          // Rearrange: the header doubles as this pane's drag handle (multi-pane only —
                          // there's nowhere to move a solo pane).
                          dragPaneId={pane.multi ? pane.leafId : undefined}
                        />
                      </Suspense>
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
                      Gated by terminalMountReady so a session SWITCH defers the xterm mount past the
                      select transition's paint (iOS compositor freeze fix) — a black placeholder holds the
                      box for ~2 frames so the layout is stable when the terminal actually mounts. */}
                  {terminalMountReady ? (
                    <Suspense fallback={<DeferredTerminal />}>
                      <TerminalView
                        session={active}
                        connection={activeConnection}
                        onShowSessions={() => setSessionsOpen(true)}
                        sessionSwitcherOpen={sessionsOpen}
                        onHideSessions={() => setSessionsOpen(false)}
                        needsYou={awaitingCount(sessions, activeSessionId)}
                        sessionPosition={sessionPosition}
                        onPreviousSession={orderedSessions.length > 1 ? () => moveSession(-1) : undefined}
                        onNextSession={orderedSessions.length > 1 ? () => moveSession(1) : undefined}
                        onClose={() => closeSession(active.id)}
                        // Help is reachable from inside a session: the rail's "?" is off-screen on mobile the
                        // moment a session is open, which is exactly when the gesture guide is needed.
                        onOpenHelp={() => setHelpOpen(true)}
                        // No gear in the chat header (user request) — settings live in the RAIL's gear only.
                      />
                    </Suspense>
                  ) : (
                    <div
                      aria-hidden
                      style={{ flex: "1 1 auto", minHeight: 0, background: "var(--terminal-bg, var(--bg))" }}
                    />
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
                Select a session or open a terminal
              </span>
              <span style={{ fontSize: "var(--fs-sm)", color: "var(--text-muted)", maxWidth: "26ch", lineHeight: 1.5 }}>
                No active session. Open a persistent shell, then run the tools you want.
              </span>
              {/* A landing-state CTA so a new terminal is reachable without first opening the mobile
                sessions sheet (the rail's action is hidden until the sheet is open on mobile).
                The single coral primary — a FLAT coral fill, dark ink label. No glow. */}
              <button
                type="button"
                onClick={() => openWizard()}
                aria-label="New terminal"
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
                New terminal
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
                      Sessions open an ordinary shell in a directory on the Node and keep running if you disconnect.
                    </li>
                    <li>
                      Start Claude Code, Codex, or any other command yourself; RoamCode observes supported foreground
                      agents without changing them.
                    </li>
                    <li>
                      On iOS: Add to Home Screen and enable notifications to get pinged when an observed agent needs
                      you.
                    </li>
                    <li>
                      Inside a session, tap its title and choose “Help and gestures” for the gesture &amp; copy guide.
                      It is also the “?” at the bottom of this sessions list.
                    </li>
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
        <Suspense fallback={<DeferredPanel label="new terminal" />}>
          <NewSessionWizard
            api={api}
            recents={loadRecentDirs()}
            // The Node already reports whether it can spawn terminals at all; nothing consumed it, so a Node
            // without tmux let the user browse for a directory and only then failed.
            terminalAvailable={updateInfo?.terminalAvailable}
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
        </Suspense>
      )}
      {globalSettingsOpen && (
        <Suspense fallback={<DeferredPanel label="settings" />}>
          <SettingsPanel
            sessionOrder={sessionOrder}
            onSessionOrderChange={changeSessionOrder}
            api={api}
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
            onDeviceTokenChanged={(next) => {
              persistActiveCredential(next);
              setTokenState(next);
              setToken(next);
            }}
            // CONTRACT C2: SettingsPanel renders a "Sign out" button that calls this — clears the token +
            // returns to the login screen (switch token / sign out of this device).
            onSignOut={signOut}
            onClose={() => setGlobalSettingsOpen(false)}
          />
        </Suspense>
      )}
      {/* SESSION-SCOPED settings — the same panel seeded with the active session (opened from the chat
          header gear). Shows the "This session" block + the shared appearance/account/device sections. The
          per-session "Close session" routes through the shared closeSession (with its Undo affordance). */}
      {/* Help sheet — opened from the RAIL's "?" (left of the gear); renders over anything, landing included. */}
      {helpOpen && (
        <Suspense fallback={<DeferredPanel label="help" />}>
          <HelpSheet open onClose={() => setHelpOpen(false)} />
        </Suspense>
      )}
      {sessionSettingsOpen && activeSession && (
        <Suspense fallback={<DeferredPanel label="session settings" />}>
          <SettingsPanel
            session={activeSession}
            sessionOrder={sessionOrder}
            onSessionOrderChange={changeSessionOrder}
            api={api}
            onNewSessionHere={(o) => {
              setSessionSettingsOpen(false);
              // cwd only — the wizard seeds everything else from the server's last successful launch.
              openWizard(o.cwd);
            }}
            onStopSession={(id) => {
              setSessionSettingsOpen(false);
              closeSession(id);
            }}
            // CONTRACT C2: same "Sign out" button here as in the global panel (settings is settings).
            onDeviceTokenChanged={(next) => {
              persistActiveCredential(next);
              setTokenState(next);
              setToken(next);
            }}
            onSignOut={signOut}
            onClose={() => setSessionSettingsOpen(false)}
          />
        </Suspense>
      )}
      {updatePanelOpen && updateInfo && (
        <UpdatePanel
          info={updateInfo}
          state={updateState}
          status={updateStatus}
          connection={updateConnection}
          onUpdate={applyUpdate}
          onRollback={updateInfo.rollbackAvailable ? rollbackUpdate : undefined}
          turnInProgress={turnInProgress}
          onClose={() => setUpdatePanelOpen(false)}
        />
      )}
      {/* PWA install nudge — captured beforeinstallprompt (Android) or an iOS Add-to-Home-Screen tip.
          Gated to AFTER the first session so it never lands on the cold login/landing screen; dismissible
          once (localStorage). Installing is what unlocks Web Push + the home-screen badge on iOS. */}
      {/* Prominent "a session needs you" alert (fires with a chime + haptic from the poll). Tappable → opens
          that session; dismissible; auto-clears once the session is no longer waiting. */}
      {focusRequest && !needsYouAlert && (
        <div role="status" className="rc-needsyou">
          <button
            type="button"
            className="rc-needsyou__open"
            onClick={() => {
              setActive(focusRequest.sessionId);
              setSessionsOpen(false);
              setFocusRequest(undefined);
            }}
          >
            <Icon name="agent" size={16} />
            <span className="rc-needsyou__txt">
              Another client requested this agent — <strong>open when ready</strong>
            </span>
          </button>
          <button
            type="button"
            className="rc-needsyou__x"
            onClick={() => setFocusRequest(undefined)}
            aria-label="Dismiss focus request"
          >
            <Icon name="x" size={15} />
          </button>
        </div>
      )}
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
                const first = sessions.find((s) => sessionAttentionSection(s) === "need-you");
                if (first) setActive(first.id);
                setSessionsOpen(true);
              } else {
                // A single ping — straight to that chat.
                setActive(id);
                setSessionsOpen(false);
              }
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
        </div>
      )}
      {(focusRequest || needsYouAlert) && (
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
      )}
      <InstallPrompt show={sessions.length > 0} />
    </>
  );
}
