import { Fragment, useEffect, useRef, useState } from "react";
import { Icon } from "../ui/Icon";
import { SESSION_MIME } from "../split/dnd";
import { basename, displaySessionName, saveSessionName, useSessionNames } from "./names";
import type { SessionMeta, UsageInfo, WorkspaceRecord } from "../types/server";
import { sortSessions } from "./order";
import type { SessionOrder } from "./order-preference";
import { relativeTime } from "./relative-time";
import { formatEpochReset, normalizeProviderUsage, shortenReset, type NormalizedUsageBar } from "./UsageBars";
import { providerDisplayName, providerSessionDisplay } from "./provider-display";
import type { CodexUsage, ProviderId } from "../providers/types";
import { ProviderIcon } from "../providers/ProviderIcon";

export interface SessionListProps {
  sessions: SessionMeta[];
  /** Server-authoritative command-center hierarchy. Absent on older hosts, where the list stays flat. */
  hostLabel?: string;
  workspaces?: WorkspaceRecord[];
  /** Legacy/internal hierarchy compatibility. Product Sessions stays flat unless explicitly enabled. */
  groupByWorkspace?: boolean;
  activeId?: string;
  /** Selected rail ordering policy. Awaiting sessions stay pinned first in either mode. */
  order: SessionOrder;
  /** Per-session activity stamps (ms) from the store — drives activity order + the per-row relative
   * time. A missing id falls back to that session's createdAt. */
  lastActiveAt: Record<string, number>;
  /** "Wall clock" for the relative-time labels, passed in so the component itself stays free of
   * Date.now() (the parent owns the clock + can re-tick to keep labels fresh). */
  now: number;
  onSelect: (id: string) => void;
  onNew: () => void;
  /** Start a NEW session in the SAME folder as an existing row (the per-row "＋ here"), skipping the
   * directory picker. When omitted, the per-row affordance is hidden. Passes the row's cwd. */
  onNewHere?: (cwd: string) => void;
  /** Close (stop + remove) a session in one tap — the row's ✕ button. The optional second id is the
   * first other row currently shown, so filtered rail closes can keep selection visible. */
  onClose: (id: string, visibleReplacementId?: string) => void;
  /** Persist a committed rename SERVER-side (PATCH /sessions/:id). The list ALSO writes the local map
   * (instant UI via its change event) — this is the fire-and-forget server half, so the name follows the
   * session across devices. An empty string clears the server name. When omitted, renames stay local. */
  onRename?: (id: string, name: string) => void;
  /** Open the SESSION-SCOPED settings for a row (the ⋯ menu's "Settings" item) — the panel lost its chat
   * header entry point when the gear moved to the rail, so the row menu is its home now. */
  onSessionSettings?: (id: string) => void;
  /** Claude usage limits. Provider snapshots share one quiet rail summary and expand into separate groups. */
  usage?: UsageInfo | null;
  /** Codex usage limits from GET /providers/codex/usage. */
  codexUsage?: CodexUsage | null;
  /** Current running version label (from GET /version, e.g. "v2026.06.26 · ebe4bd3"), shown as a quiet
   * footer at the bottom of the rail so you always know what's deployed. */
  version?: string;
  /** True when a newer version is available — the footer surfaces a tappable "Update available". */
  updateAvailable?: boolean;
  /** Open the update panel (from the footer's "Update available" affordance). */
  onShowUpdate?: () => void;
  /** Force a fresh update check (the footer's "Check for updates"). Resolves true if an update is now
   * available. When provided + no update is pending, the footer shows the check button. */
  onCheckUpdate?: () => Promise<boolean>;
  /** Open the GLOBAL settings (defaults + notifications) — reachable from the rail without a chat. */
  onOpenSettings?: () => void;
  /** Open the Help sheet (gesture + key legend). Lives in the rail (left of the gear) — the chat header
   *  stays minimal (user request: the "?" had no business in the chat). */
  onOpenHelp?: () => void;
  /** Durable command-center inbox. Unlike the live needs-you badge this also contains finished work,
   *  files, and errors that happened while the user was away. */
  attentionCount?: number;
  onOpenAttention?: () => void;
  /** Manage the current host's durable workspace hierarchy. */
  onOpenWorkspaces?: () => void;
  /** Tap handler for the header's "N need you" badge (CONTRACT C1 — App jumps to the first awaiting
   *  session). When provided, the badge renders as a BUTTON; omitted, it stays a non-interactive span. */
  onNeedsYouTap?: () => void;
  /** Desktop split-screen: make each row DRAGGABLE (HTML5 DnD, SESSION_MIME payload) so a session can be
   *  dropped onto a workspace pane's edge (split there) or center (show there). App passes splitCapable. */
  draggableRows?: boolean;
  /** Desktop split-screen: EVERY session currently visible in a pane. Those rows read as "on screen"
   *  (a quiet lift + neutral left rail); the FOCUSED one (`activeId`) keeps the strong active treatment —
   *  previously only the focused session was marked, which read as "only one is open". */
  visibleIds?: readonly string[];
}

function absoluteTime(ms: number): string {
  return new Date(ms).toLocaleString();
}

/** A clear, human label for each terminal-session `status`, so the rail distinguishes a live PTY from an
 * exited one — every status carries a distinct word (never a blank glyph). `ended` is the real dead-session
 * state the server emits when a terminal exits/crashes; dormant/errored/stopped are legacy/back-compat. */
const STATUS_LABEL: Record<SessionMeta["status"], string> = {
  // `running` is resolved by rowStatus (it splits into "working"/"idle" by live activity), so this entry is a
  // type-required fallback only; the map's real job is the non-running (dead/legacy) words below.
  running: "working",
  ended: "ended",
  dormant: "dormant",
  errored: "errored",
  stopped: "stopped",
};

/** The footer's "Check for updates" — forces a fresh server-side check so you never wait on the poll.
 * Shows "Checking…" in flight; if an update turns up the parent swaps this for the coral "Update
 * available" pill, otherwise it briefly confirms "Up to date". */
function CheckUpdateButton({ onCheck }: { onCheck: () => Promise<boolean> }) {
  const [state, setState] = useState<"idle" | "checking" | "uptodate">("idle");
  // Guard against setState after unmount: the footer can swap to the "Update available" pill (or drop
  // when version goes falsy) while the check is in flight or the "Up to date" timer is pending.
  const mounted = useRef(true);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(
    () => () => {
      mounted.current = false;
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  return (
    <button
      type="button"
      className="rc-sl__check"
      disabled={state === "checking"}
      aria-label="Check for updates"
      onClick={async () => {
        setState("checking");
        try {
          const found = await onCheck();
          if (!mounted.current) return;
          if (found) {
            setState("idle"); // parent re-renders into the "Update available" pill
          } else {
            setState("uptodate");
            timer.current = setTimeout(() => {
              if (mounted.current) setState("idle");
            }, 2500);
          }
        } catch {
          if (mounted.current) setState("idle");
        }
      }}
    >
      {state === "checking" ? "Checking…" : state === "uptodate" ? "Up to date ✓" : "Check for updates"}
    </button>
  );
}

/**
 * The per-row STATUS: a state `tone` (which colours the dot AND the word) and its label. A RUNNING session
 * reads "working" (busy — its main loop OR background agents) or "idle" (a finished turn at rest); an awaiting
 * session is the loud "needs you"; a dead/legacy status reads its own faint word. The caller always pairs the
 * tone (color) with the text, so state is never conveyed by color alone.
 */
type RowTone = "work" | "idle" | "need" | "dead";
function rowStatus(s: SessionMeta): { tone: RowTone; word: string } {
  if (s.awaiting) return { tone: "need", word: "needs you" };
  if (s.status === "running") {
    return s.activity === "working" ? { tone: "work", word: "working" } : { tone: "idle", word: "idle" };
  }
  return { tone: "dead", word: STATUS_LABEL[s.status] };
}

/** A small pencil (edit) glyph — the Icon set has no "edit" entry and Icon.tsx is out of scope here, so
 * this matches the same 24×24 / currentColor / ~1.75px-stroke conventions locally. Decorative. */
function PencilGlyph() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </svg>
  );
}

/**
 * Count of sessions with a pending permission/question (`meta.awaiting`). Drives the "needs you" badges.
 * `excludeId` drops one session from the count — pass the session you're actively viewing so its own header
 * badge counts only the OTHER conversations waiting on you (you don't need to be nagged about the one on screen).
 */
export function awaitingCount(sessions: SessionMeta[], exclude?: string | readonly string[]): number {
  // One id in the classic single view, or EVERY visible pane's session in the desktop split workspace —
  // no nagging about chats already on screen.
  const excluded = new Set(exclude === undefined ? [] : typeof exclude === "string" ? [exclude] : exclude);
  return sessions.reduce((n, s) => (s.awaiting && !excluded.has(s.id) ? n + 1 : n), 0);
}

/**
 * The global "N need you" badge — a loud iris pill shown in the rail header and on the mobile sessions
 * toggle so a pending permission/question is visible from ANY chat. Renders nothing at zero. The count
 * is paired with text ("need you") so the signal is never color-only (a11y).
 *
 * When `onTap` is supplied the badge becomes a BUTTON (App wires it to jump to the first awaiting
 * session — CONTRACT C1); with no handler it stays a non-interactive `role="status"` span (a11y-safe,
 * so a screen reader announces the count without a phantom control).
 */
export function NeedsYouBadge({ count, className, onTap }: { count: number; className?: string; onTap?: () => void }) {
  if (count <= 0) return null;
  const inner = (
    <>
      <span className="rc-needs__n">{count}</span>
      <span className="rc-needs__label">need you</span>
    </>
  );
  if (onTap) {
    return (
      <button
        type="button"
        className={`rc-needs rc-needs--tap${className ? ` ${className}` : ""}`}
        onClick={onTap}
        aria-label={`${count} ${count === 1 ? "session needs" : "sessions need"} you — go to the first`}
      >
        {inner}
      </button>
    );
  }
  return (
    <span className={`rc-needs${className ? ` ${className}` : ""}`} role="status">
      {inner}
    </span>
  );
}

const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export interface RailLimitSlot {
  id: "five-hour" | "weekly";
  label: "5h" | "Week";
  bar?: NormalizedUsageBar;
}

function durationMatches(value: number | undefined, target: number): boolean {
  if (value === undefined) return false;
  return Math.abs(value - target) <= 30 * 60 * 1000;
}

/**
 * The rail has two stable, comparable slots per provider. Claude has explicit session/week ids; Codex
 * describes windows dynamically, so duration metadata is authoritative and provider labels are the
 * backwards-compatible fallback. Missing windows stay empty instead of borrowing an unrelated model bucket.
 */
export function railLimitSlots(provider: ProviderId, bars: NormalizedUsageBar[]): [RailLimitSlot, RailLimitSlot] {
  const fiveHour =
    provider === "claude"
      ? bars.find((bar) => bar.id === "session")
      : bars.find(
          (bar) =>
            durationMatches(bar.windowDurationMs, FIVE_HOURS_MS) ||
            /(?:^|\b)(?:5\s*(?:h|hours?)|session)\b/i.test(bar.label),
        );
  const weekly =
    provider === "claude"
      ? bars.find((bar) => bar.id === "week")
      : bars.find(
          (bar) =>
            bar !== fiveHour &&
            (durationMatches(bar.windowDurationMs, ONE_WEEK_MS) || /\bweek(?:ly)?\b/i.test(bar.label)),
        );
  return [
    { id: "five-hour", label: "5h", ...(fiveHour ? { bar: fiveHour } : {}) },
    { id: "weekly", label: "Week", ...(weekly ? { bar: weekly } : {}) },
  ];
}

function railReset(bar: NormalizedUsageBar | undefined, now: number): string {
  if (bar?.resets) return compactRailReset(shortenReset(bar.resets, now));
  if (bar?.resetsAt !== undefined) return compactRailReset(formatEpochReset(bar.resetsAt));
  return "—";
}

/** Preserve date + time in a form that fits the 300px rail: "September 18 at 11:30pm" →
 *  "Sep 18 · 11:30pm". Relative provider values such as "in 2h 41m" pass through unchanged. */
function compactRailReset(reset: string): string {
  const dated = /^([A-Za-z]{3})[A-Za-z]*\s+(\d{1,2})\s+at\s+(.+)$/i.exec(reset.trim());
  if (!dated) return reset.trim();
  const month = `${dated[1]![0]!.toUpperCase()}${dated[1]!.slice(1).toLowerCase()}`;
  const time = dated[3]!
    .replace(/:00(?=\s*[ap]m\b)/i, "")
    .replace(/\s+([ap]m)$/i, "$1")
    .toLowerCase();
  return `${month} ${dated[2]} · ${time}`;
}

function railResetDetail(bar: NormalizedUsageBar | undefined): string {
  if (bar?.resets) return `Resets ${bar.resets}`;
  if (bar?.resetsAt !== undefined) return `Resets ${formatEpochReset(bar.resetsAt)}`;
  return "Reset time not reported";
}

function RailProviderLimits({
  provider,
  bars,
  now,
}: {
  provider: ProviderId;
  bars: NormalizedUsageBar[];
  now: number;
}) {
  const providerName = providerDisplayName(provider);
  const slots = railLimitSlots(provider, bars);
  const [openLimitId, setOpenLimitId] = useState<string>();
  const openSlot = slots.find(({ id }) => id === openLimitId);
  const detailId = `rc-sl-${provider}-limit-detail`;
  return (
    <section
      className={`rc-sl__usage-provider rc-sl__usage-provider--${provider}`}
      aria-label={`${providerName} limits`}
    >
      <span className="rc-sl__usage-provider-name">
        <ProviderIcon provider={provider} label={`${providerName} provider`} />
      </span>
      <div className="rc-sl__usage-metrics">
        {slots.map(({ id, label, bar }) => {
          const used = bar ? Math.max(0, Math.min(100, Math.round(bar.percent))) : undefined;
          const remaining = used === undefined ? undefined : 100 - used;
          const reset = railReset(bar, now);
          const resetDetail = railResetDetail(bar);
          const resetParts = reset.split(" · ");
          const hasDatedReset = resetParts.length === 2;
          const urgency =
            used !== undefined && used > 90 ? "critical" : used !== undefined && used > 70 ? "low" : undefined;
          const expanded = bar !== undefined && openLimitId === id;
          return (
            <button
              type="button"
              className={`rc-sl__usage-metric${remaining === undefined ? " rc-sl__usage-metric--missing" : ""}${urgency ? ` rc-sl__usage-metric--${urgency}` : ""}`}
              key={id}
              data-limit-id={bar?.id ?? id}
              disabled={!bar}
              aria-expanded={bar ? expanded : undefined}
              aria-controls={bar ? detailId : undefined}
              aria-label={`${providerName} ${label} limit, ${remaining === undefined ? "not reported" : `${remaining}% remaining`}, ${resetDetail}`}
              title={resetDetail}
              onClick={() => {
                if (bar) setOpenLimitId(expanded ? undefined : id);
              }}
            >
              <span className="rc-sl__usage-metric-label">{label}</span>
              <span
                className={`rc-sl__usage-metric-value${remaining === undefined ? " rc-sl__usage-metric-value--missing" : ""}`}
              >
                {remaining === undefined ? "—" : `${remaining}%`}
              </span>
              {remaining === undefined ? (
                <span className="rc-sl__usage-track rc-sl__usage-track--missing" aria-hidden="true" />
              ) : (
                <span
                  className="rc-sl__usage-track"
                  role="progressbar"
                  aria-valuenow={remaining}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-label={`${providerName} ${label} limit ${remaining}% left`}
                >
                  <span className="rc-sl__usage-fill" style={{ width: `${remaining}%` }} />
                </span>
              )}
              <span
                className={`rc-sl__usage-reset${hasDatedReset ? " rc-sl__usage-reset--dated" : ""}`}
                title={resetDetail}
              >
                {hasDatedReset ? (
                  <>
                    <span className="rc-sl__usage-reset-date">{resetParts[0]}</span>
                    <span className="rc-sl__usage-reset-time">{resetParts[1]}</span>
                  </>
                ) : (
                  <span className="rc-sl__usage-reset-single">{reset}</span>
                )}
              </span>
            </button>
          );
        })}
      </div>
      {openSlot?.bar && (
        <div
          id={detailId}
          className="rc-sl__usage-detail"
          role="group"
          aria-label={`${providerName} ${openSlot.label} reset details`}
        >
          <span className="rc-sl__usage-detail-copy">
            <strong>
              {providerName} · {openSlot.label}
            </strong>
            <span>{railResetDetail(openSlot.bar)}</span>
          </span>
          <button
            type="button"
            className="rc-sl__usage-detail-close"
            aria-label={`Close ${providerName} ${openSlot.label} reset details`}
            onClick={() => setOpenLimitId(undefined)}
          >
            <Icon name="x" size={13} />
          </button>
        </div>
      )}
    </section>
  );
}

/**
 * The session rail / sheet: a calm, scannable, hairline-separated list (Variant A). Sessions are
 * ordered by the selected creation/activity policy, with awaiting sessions always pinned first. Each row
 * is one clean entry —
 * the cwd basename in the display font, the terminal status, a compact relative time, and one
 * provider·effort hint. Model and safety details sit behind a per-row disclosure. A clear accent
 * left-rail marks the active row, while the remaining actions stay behind the quiet overflow button. The
 * header carries a "New session" `+` icon button and a live session count. Works as the desktop rail
 * (var(--rail-w)) and as the mobile sheet.
 */
/** Show search only once scanning is genuinely slower than filtering. Three or four quiet rows fit cleanly
 * on a phone; at five, similarly named sibling folders benefit from a dedicated query field. */
const SEARCH_MIN = 5;

export function SessionList({
  sessions,
  hostLabel,
  workspaces = [],
  groupByWorkspace = false,
  activeId,
  order,
  lastActiveAt,
  now,
  onSelect,
  onNew,
  onNewHere,
  onClose,
  onRename,
  onSessionSettings,
  usage,
  codexUsage,
  version,
  updateAvailable,
  onShowUpdate,
  onCheckUpdate,
  onOpenSettings,
  attentionCount = 0,
  onOpenAttention,
  onOpenWorkspaces,
  onNeedsYouTap,
  onOpenHelp,
  draggableRows = false,
  visibleIds,
}: SessionListProps) {
  const ordered = sortSessions(sessions, lastActiveAt, order);
  const needs = awaitingCount(sessions);

  // Search/filter (by name or cwd) — surfaced only for longer lists.
  const [query, setQuery] = useState("");
  const [collapsedWorkspaces, setCollapsedWorkspaces] = useState<Set<string>>(() => new Set());
  // Client-only session names — the SHARED live map (session/names.ts): a rename here also updates the
  // chat header (which previously kept showing the stale basename — the reported bug).
  const names = useSessionNames();
  const displayName = (s: SessionMeta): string => displaySessionName(s, names);
  // Inline rename: which row is being edited + its draft label.
  const [editingId, setEditingId] = useState<string | undefined>(undefined);
  const [editDraft, setEditDraft] = useState("");
  const startEdit = (s: SessionMeta) => {
    setEditingId(s.id);
    setEditDraft(displayName(s));
  };
  const commitEdit = () => {
    if (editingId) {
      saveSessionName(editingId, editDraft); // fires the change event → every subscriber re-reads (instant UI)
      // The server half (fire-and-forget PATCH; App owns the catch): the next /sessions poll carries the
      // server name, and every other device follows. The local write above stays the optimistic layer.
      onRename?.(editingId, editDraft);
    }
    setEditingId(undefined);
  };
  const cancelEdit = () => setEditingId(undefined);

  // Row actions (new-here / rename / close) live behind a single per-row "⋯" so the default rail stays quiet.
  // `menuOpenId` is the one row whose actions are currently revealed. A click anywhere else closes it (the
  // ⋯ + action buttons stopPropagation, so only OUTSIDE clicks reach this document listener).
  const [menuOpenId, setMenuOpenId] = useState<string | undefined>(undefined);
  // Runtime metadata is intentionally progressive: the default row shows provider + effort only; model
  // and safety details stay behind one disclosure so the rail remains scannable on both desktop and phone.
  const [detailsOpenId, setDetailsOpenId] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (!menuOpenId) return undefined;
    const close = () => setMenuOpenId(undefined);
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [menuOpenId]);

  // Split-screen drag DISCOVERABILITY (desktop only, via draggableRows): dragging a session onto the
  // terminal is invisible until you know it exists, so a one-time coach hint teaches it — same pattern as
  // the terminal's two-finger-scroll hint (show briefly, cap the shows, learn forever on first REAL drag).
  const [showDragHint, setShowDragHint] = useState(false);
  useEffect(() => {
    if (!draggableRows || sessions.length < 2) return undefined;
    let learned = false;
    let shows = 0;
    try {
      learned = window.localStorage?.getItem("rc-split-hint-learned") === "1";
      shows = Number(window.localStorage?.getItem("rc-split-hint-shows") ?? 0) || 0;
    } catch {
      /* storage blocked — show it this session only */
    }
    if (learned || shows >= 3) return undefined;
    const show = window.setTimeout(() => setShowDragHint(true), 900);
    const hide = window.setTimeout(() => setShowDragHint(false), 11_000);
    try {
      window.localStorage?.setItem("rc-split-hint-shows", String(shows + 1));
    } catch {
      /* ignore */
    }
    return () => {
      window.clearTimeout(show);
      window.clearTimeout(hide);
    };
  }, [draggableRows, sessions.length]);
  const learnSplitDrag = () => {
    setShowDragHint(false);
    try {
      window.localStorage?.setItem("rc-split-hint-learned", "1");
    } catch {
      /* ignore */
    }
  };

  const showSearch = sessions.length >= SEARCH_MIN;
  const q = query.trim().toLowerCase();
  const matchesSession = (session: SessionMeta) =>
    q.length === 0 || displayName(session).toLowerCase().includes(q) || session.cwd.toLowerCase().includes(q);
  const knownWorkspaceIds = new Set(workspaces.map((workspace) => workspace.id));
  const useWorkspaceHierarchy =
    groupByWorkspace && (workspaces.length > 0 || sessions.some((session) => session.workspaceId));
  const workspaceGroups = [...workspaces]
    .sort((a, b) => a.sortOrder - b.sortOrder || a.createdAt - b.createdAt)
    .map((workspace) => {
      const allSessions = ordered.filter((session) => session.workspaceId === workspace.id);
      const workspaceMatches = q.length > 0 && workspace.label.toLowerCase().includes(q);
      return { workspace, sessions: workspaceMatches ? allSessions : allSessions.filter(matchesSession) };
    });
  const ungrouped = ordered.filter((session) => !session.workspaceId || !knownWorkspaceIds.has(session.workspaceId));
  const filteredUngrouped = ungrouped.filter(matchesSession);
  const shown = useWorkspaceHierarchy
    ? [...workspaceGroups.flatMap((group) => group.sessions), ...filteredUngrouped]
    : ordered.filter(matchesSession);
  const railEntries: Array<
    | { type: "workspace"; key: string; workspace?: WorkspaceRecord; label: string; count: number }
    | { type: "session"; key: string; session: SessionMeta }
  > = useWorkspaceHierarchy
    ? [
        ...workspaceGroups.flatMap((group) => {
          const visible =
            q.length === 0 || group.workspace.label.toLowerCase().includes(q) || group.sessions.length > 0;
          if (!visible) return [];
          const collapsed = collapsedWorkspaces.has(group.workspace.id) && q.length === 0;
          return [
            {
              type: "workspace" as const,
              key: `workspace:${group.workspace.id}`,
              workspace: group.workspace,
              label: group.workspace.label,
              count: group.sessions.length,
            },
            ...(collapsed
              ? []
              : group.sessions.map((session) => ({ type: "session" as const, key: session.id, session }))),
          ];
        }),
        ...(filteredUngrouped.length > 0
          ? [
              {
                type: "workspace" as const,
                key: "workspace:ungrouped",
                label: "Other sessions",
                count: filteredUngrouped.length,
              },
              ...(collapsedWorkspaces.has("workspace:ungrouped") && q.length === 0
                ? []
                : filteredUngrouped.map((session) => ({ type: "session" as const, key: session.id, session }))),
            ]
          : []),
      ]
    : shown.map((session) => ({ type: "session" as const, key: session.id, session }));
  const claudeUsageBars = usage ? normalizeProviderUsage("claude", usage).bars : [];
  const codexUsageBars = codexUsage ? normalizeProviderUsage("codex", codexUsage).bars : [];
  const hasUsageLimits = claudeUsageBars.length > 0 || codexUsageBars.length > 0;

  return (
    <div className="rc-sl">
      <div className="rc-sl__head">
        <span className={`rc-sl__heading${hostLabel ? " rc-sl__heading--host" : ""}`}>
          {hostLabel && <strong className="display rc-sl__host">{hostLabel}</strong>}
          <span className="display rc-sl__title">
            Sessions
            <span className="rc-sl__count" aria-hidden="true">
              ·
            </span>
            <span className="rc-sl__count-n">{sessions.length}</span>
          </span>
        </span>
        {/* The global "needs you" badge sits in the header so it's visible whenever the rail is open.
            With onNeedsYouTap it's tappable (jumps to the first awaiting session — C1). */}
        <NeedsYouBadge count={needs} className="rc-sl__needs" onTap={onNeedsYouTap} />
        {/* The header stays SPARSE (user feedback: it got cramped): just the title, the needs-you badge and
            the one primary action. Help + Settings live in the FOOTER (classic sidebar bottom-left). */}
        <button type="button" className="rc-sl__new" onClick={onNew} aria-label="New session">
          <Icon name="plus" size={18} />
        </button>
      </div>
      {/* A single compact vertical card: provider marks form the row groups and every comparable limit gets
          its own full-width line. The list starts immediately afterward — the Sessions heading is not repeated. */}
      {hasUsageLimits && (
        <section className="rc-sl__limits" aria-label="Provider limits">
          <div className="rc-sl__limits-card">
            <div className="rc-sl__limits-head" aria-hidden="true">
              <span className="rc-sl__limits-kicker">Usage</span>
              <span className="rc-sl__limits-caption">Remaining</span>
              <span className="rc-sl__limits-reset-caption">Reset</span>
            </div>
            {claudeUsageBars.length > 0 && usage && (
              <RailProviderLimits provider="claude" bars={claudeUsageBars} now={now} />
            )}
            {codexUsageBars.length > 0 && codexUsage && (
              <RailProviderLimits provider="codex" bars={codexUsageBars} now={now} />
            )}
          </div>
        </section>
      )}
      {/* A filter box — only for longer lists (SEARCH_MIN+), where scanning by eye stops being enough.
          Matches name OR cwd, so you can find a session by either. */}
      {showSearch && (
        <div className="rc-sl__search">
          <Icon name="search" size={15} />
          <input
            type="text"
            className="rc-sl__search-input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter by name or path"
            aria-label="Filter sessions"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
          />
          {query && (
            <button
              type="button"
              className="rc-sl__search-clear"
              onClick={() => setQuery("")}
              aria-label="Clear filter"
            >
              <Icon name="x" size={14} />
            </button>
          )}
        </div>
      )}
      <ul className="rc-sl__list">
        {railEntries.map((entry) => {
          if (entry.type === "workspace") {
            const workspace = entry.workspace;
            const collapseId = workspace?.id ?? entry.key;
            const collapsed = collapsedWorkspaces.has(collapseId) && q.length === 0;
            return (
              <li key={entry.key} className="rc-sl__workspace">
                <button
                  type="button"
                  className="rc-sl__workspace-toggle"
                  aria-expanded={!collapsed}
                  onClick={() => {
                    setCollapsedWorkspaces((current) => {
                      const next = new Set(current);
                      if (next.has(collapseId)) next.delete(collapseId);
                      else next.add(collapseId);
                      return next;
                    });
                  }}
                >
                  <Icon name="chevron-down" size={13} />
                  <span>{entry.label}</span>
                  <span className="rc-sl__workspace-count">{entry.count}</span>
                  {(workspace?.attentionCount ?? 0) > 0 && (
                    <span className="rc-sl__workspace-attention" aria-label={`${workspace!.attentionCount} new`}>
                      {workspace!.attentionCount}
                    </span>
                  )}
                </button>
              </li>
            );
          }
          const s = entry.session;
          const selected = s.id === activeId;
          // Visible in a split pane but not the focused one → the quiet "on screen" treatment.
          const onScreen = !selected && (visibleIds?.includes(s.id) ?? false);
          const name = displayName(s);
          const activeAt = lastActiveAt[s.id] ?? s.createdAt;
          const { tone, word } = rowStatus(s);
          const awaiting = tone === "need";
          // A dead PTY (server "ended") reads dimmed so it's obviously not live at a glance; the awaiting/idle
          // states sit above it. "needs you" is NOT a row wash anymore — only the dot + word carry its coral,
          // so it never looks like the SELECTED row (which owns the surface lift + neutral left rail).
          const ended = s.status === "ended" && !awaiting;
          const editing = editingId === s.id;
          const menuOpen = menuOpenId === s.id;
          const detailsOpen = detailsOpenId === s.id;
          const providerMeta = providerSessionDisplay(s);
          const provider = s.provider ?? "claude";
          return (
            <Fragment key={entry.key}>
              <li className="rc-sl__item">
                {editing ? (
                  // Rename in place: the whole row becomes an edit form (no nested interactive elements).
                  // Enter/blur commits, Escape cancels. Clearing the field reverts to the cwd basename.
                  <form
                    className="rc-sl__edit"
                    onSubmit={(e) => {
                      e.preventDefault();
                      commitEdit();
                    }}
                  >
                    <input
                      className="rc-sl__edit-input"
                      value={editDraft}
                      onChange={(e) => setEditDraft(e.target.value)}
                      onBlur={commitEdit}
                      onKeyDown={(e) => {
                        if (e.key === "Escape") {
                          e.preventDefault();
                          cancelEdit();
                        }
                      }}
                      aria-label={`Rename ${basename(s.cwd)}`}
                      placeholder={basename(s.cwd)}
                      autoFocus
                      autoCapitalize="off"
                      autoCorrect="off"
                      spellCheck={false}
                    />
                    <button type="submit" className="rc-sl__edit-btn" aria-label="Save name">
                      <Icon name="check" size={16} />
                    </button>
                    <button
                      type="button"
                      className="rc-sl__edit-btn"
                      // onMouseDown (not onClick) so it fires BEFORE the input's blur-commit swallows it.
                      onMouseDown={(e) => {
                        e.preventDefault();
                        cancelEdit();
                      }}
                      aria-label="Cancel rename"
                    >
                      <Icon name="x" size={16} />
                    </button>
                  </form>
                ) : (
                  <>
                    <button
                      type="button"
                      className={`rc-sl__row${selected ? " rc-sl__row--active" : ""}${onScreen ? " rc-sl__row--open" : ""}${ended ? " rc-sl__row--ended" : ""}`}
                      onClick={() => {
                        setMenuOpenId(undefined);
                        onSelect(s.id);
                      }}
                      aria-current={selected ? "true" : undefined}
                      // Desktop split-screen: drag this session onto a pane (edge = split there, center =
                      // show there). draggable only when enabled so mobile touch scrolling is untouched.
                      draggable={draggableRows || undefined}
                      title={draggableRows ? "Drag onto the terminal to split the screen" : undefined}
                      onDragStart={
                        draggableRows
                          ? (e) => {
                              e.dataTransfer.setData(SESSION_MIME, s.id);
                              e.dataTransfer.effectAllowed = "move";
                              learnSplitDrag(); // a real drag = the gesture is learned; retire the coach hint
                            }
                          : undefined
                      }
                    >
                      <span className="rc-sl__rail" aria-hidden="true" />
                      {/* A single state dot carries the status at a glance; the word beside it (below) keeps it
                        a11y-safe (never color-only). Coral is reserved for the "needs you" state. */}
                      <span className={`rc-sl__dot rc-sl__dot--${tone}`} aria-hidden="true" />
                      <span className="rc-sl__main">
                        <strong className="display rc-sl__name">{name}</strong>
                        {/* Line 2: the status word + a compact relative time, side by side. "needs you" is the
                          one loud (coral) word; working reads muted, idle/ended read faint. */}
                        <span className="rc-sl__sub">
                          {awaiting ? (
                            <span className="rc-sl__sub-need" role="status" aria-label={`${name} needs you`}>
                              {word}
                            </span>
                          ) : (
                            <span className={`rc-sl__sub-word rc-sl__sub-word--${tone}`}>{word}</span>
                          )}
                          <span className="rc-sl__sub-sep" aria-hidden="true">
                            ·
                          </span>
                          <time
                            className="rc-sl__time"
                            dateTime={new Date(activeAt).toISOString()}
                            title={absoluteTime(activeAt)}
                          >
                            {relativeTime(activeAt, now)}
                          </time>
                        </span>
                        <span className="rc-sl__provider-meta">
                          <ProviderIcon provider={provider} />
                          {providerMeta.effort && <span>{providerMeta.effort.replace(/ reasoning$/, "")}</span>}
                        </span>
                      </span>
                    </button>
                    {/* Row actions behind a single "⋯" so the default rail stays quiet — it opens an inline
                      cluster (new-here · rename · close). Each button stopPropagation so it never selects the
                      row; an outside click closes the cluster (see the menuOpenId effect). */}
                    <span className="rc-sl__actions">
                      {!menuOpen && (
                        <button
                          type="button"
                          className={`rc-sl__details-toggle${detailsOpen ? " rc-sl__details-toggle--open" : ""}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            setDetailsOpenId(detailsOpen ? undefined : s.id);
                          }}
                          aria-label={`${detailsOpen ? "Hide" : "Show"} details for ${name}`}
                          aria-expanded={detailsOpen}
                          title="Runtime details"
                        >
                          <Icon name="chevron-down" size={15} />
                        </button>
                      )}
                      {menuOpen ? (
                        <>
                          {onNewHere && (
                            <button
                              type="button"
                              className="rc-sl__act"
                              onClick={(e) => {
                                e.stopPropagation();
                                setMenuOpenId(undefined);
                                onNewHere(s.cwd);
                              }}
                              aria-label={`Start a session in ${name}`}
                              title="New session in this folder"
                            >
                              <Icon name="plus" size={15} />
                            </button>
                          )}
                          <button
                            type="button"
                            className="rc-sl__act"
                            onClick={(e) => {
                              e.stopPropagation();
                              setMenuOpenId(undefined);
                              startEdit(s);
                            }}
                            aria-label={`Rename ${name}`}
                            title="Rename"
                          >
                            <PencilGlyph />
                          </button>
                          {/* Session-scoped settings — the panel's only entry point since the chat header
                            lost its gear. Selecting which session it opens FOR is the App's concern. */}
                          {onSessionSettings && (
                            <button
                              type="button"
                              className="rc-sl__act"
                              onClick={(e) => {
                                e.stopPropagation();
                                setMenuOpenId(undefined);
                                onSessionSettings(s.id);
                              }}
                              aria-label={`Settings for ${name}`}
                              title="Session settings"
                            >
                              <Icon name="settings" size={15} />
                            </button>
                          )}
                          <button
                            type="button"
                            className="rc-sl__close"
                            onClick={(e) => {
                              e.stopPropagation();
                              setMenuOpenId(undefined);
                              onClose(s.id, shown.find((candidate) => candidate.id !== s.id)?.id);
                            }}
                            aria-label={`Close session ${name}`}
                            title={`Stop & remove ${name}`}
                          >
                            <Icon name="x" size={16} />
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          className="rc-sl__more"
                          onClick={(e) => {
                            e.stopPropagation();
                            setMenuOpenId(s.id);
                          }}
                          aria-label={`Actions for ${name}`}
                          title="Actions"
                        >
                          ⋯
                        </button>
                      )}
                    </span>
                    {detailsOpen && (
                      <div className="rc-sl__runtime-details" role="group" aria-label={`Runtime details for ${name}`}>
                        <div className="rc-sl__runtime-line">
                          <span className="rc-sl__runtime-label">Runtime</span>
                          <span>
                            {[providerMeta.provider, providerMeta.model, providerMeta.effort]
                              .filter(Boolean)
                              .join(" · ")}
                          </span>
                        </div>
                        <div
                          className={`rc-sl__runtime-line${providerMeta.dangerous ? " rc-sl__runtime-line--danger" : ""}`}
                        >
                          <span className="rc-sl__runtime-label">
                            {providerMeta.dangerous && <Icon name="alert" size={13} />}
                            Safety
                          </span>
                          <span>{providerMeta.safety.join(" · ")}</span>
                        </div>
                      </div>
                    )}
                  </>
                )}
              </li>
            </Fragment>
          );
        })}
        {sessions.length === 0 && (
          <li className="rc-sl__empty">
            No sessions yet. Tap{" "}
            <span className="rc-sl__empty-em" aria-hidden="true">
              +
            </span>{" "}
            above to start one.
          </li>
        )}
        {sessions.length > 0 && shown.length === 0 && (
          <li className="rc-sl__empty">No sessions match “{query.trim()}”.</li>
        )}
      </ul>

      {/* The one-time split-drag coach hint (desktop, ≥2 sessions): teaches the invisible gesture. Dismiss
          ✕ or a real drag marks it learned forever; otherwise it self-hides and re-offers up to 3 times. */}
      {showDragHint && (
        <div className="rc-sl__draghint" role="status">
          <span className="rc-sl__draghint-icon" aria-hidden="true">
            ⠿
          </span>
          <span>
            <strong>Split screen:</strong> drag a session onto the terminal — drop on an edge to split, center to show
            it there.
          </span>
          <button type="button" className="rc-sl__draghint-x" onClick={learnSplitDrag} aria-label="Dismiss hint">
            <Icon name="x" size={13} />
          </button>
        </div>
      )}

      {/* The quiet footer: Help + Settings bottom-left (moved out of the cramped header — classic sidebar
          placement), then the running version + the update affordance on the right. */}
      {(version || onOpenAttention || onOpenWorkspaces || onOpenHelp || onOpenSettings) && (
        <div className="rc-sl__footer">
          {onOpenAttention && (
            <button
              type="button"
              className="rc-sl__foot-btn rc-sl__attention-btn"
              onClick={onOpenAttention}
              aria-label={attentionCount > 0 ? `Attention inbox, ${attentionCount} new` : "Attention inbox"}
            >
              <Icon name="bell" size={16} />
              {attentionCount > 0 && (
                <span className="rc-sl__attention-count" aria-hidden="true">
                  {attentionCount > 99 ? "99+" : attentionCount}
                </span>
              )}
            </button>
          )}
          {onOpenWorkspaces && (
            <button
              type="button"
              className="rc-sl__foot-btn"
              onClick={onOpenWorkspaces}
              aria-label="Host and workspaces"
            >
              <Icon name="folder" size={16} />
            </button>
          )}
          {onOpenHelp && (
            <button
              type="button"
              className="rc-sl__foot-btn"
              onClick={onOpenHelp}
              aria-label="Help — gestures and keys"
              // No "?" glyph in the icon set — a mono "?" reads unambiguously.
              style={{ fontFamily: "var(--font-mono)", fontWeight: 700, fontSize: 14 }}
            >
              ?
            </button>
          )}
          {onOpenSettings && (
            <button type="button" className="rc-sl__foot-btn" onClick={onOpenSettings} aria-label="Settings">
              <Icon name="settings" size={16} />
            </button>
          )}
          {version && (
            <span className="rc-sl__version" title={version}>
              {version}
            </span>
          )}
          {updateAvailable && onShowUpdate ? (
            <button type="button" className="rc-sl__update" onClick={onShowUpdate} aria-label="Update available">
              Update available
            </button>
          ) : (
            onCheckUpdate && <CheckUpdateButton onCheck={onCheckUpdate} />
          )}
        </div>
      )}

      <style>{sessionListCss}</style>
    </div>
  );
}

const sessionListCss = `
.rc-sl { display: flex; flex-direction: column; height: 100%; }
/* Version footer — pinned at the bottom of the rail; quiet mono label + a coral "Update available". */
.rc-sl__footer {
  flex: none;
  display: flex; align-items: center; gap: var(--sp-2);
  padding: 8px 13px calc(8px + env(safe-area-inset-bottom, 0px));
  border-top: 1px solid var(--border);
}
/* Help + Settings as quiet footer tiles (bottom-left, out of the header) — smaller than the header CTAs. */
.rc-sl__foot-btn {
  width: 30px; height: 30px; flex: none;
  display: grid; place-items: center;
  border-radius: 8px;
  background: var(--surface-2); border: 1px solid var(--border);
  color: var(--text-muted); cursor: pointer;
  transition: color 120ms ease, border-color 120ms ease;
}
.rc-sl__foot-btn:hover, .rc-sl__foot-btn:focus-visible { color: var(--text); border-color: var(--border-strong); }
.rc-sl__attention-btn { position: relative; }
.rc-sl__attention-count {
  position: absolute; top: -5px; right: -6px; min-width: 17px; height: 17px; padding: 0 4px;
  display: grid; place-items: center; border: 2px solid var(--surface); border-radius: 999px;
  background: var(--awaiting); color: var(--on-accent); font: 750 8px/1 var(--font-mono);
  font-variant-numeric: tabular-nums;
}
/* The version takes the slack and right-aligns (ellipsising first) so the update affordance stays pinned. */
.rc-sl__version {
  flex: 1 1 auto; min-width: 0; text-align: right;
  font-family: var(--font-mono); font-size: var(--fs-xs); color: var(--text-faint);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.rc-sl__update {
  flex: none; font: inherit; font-size: var(--fs-xs); font-weight: 600; cursor: pointer;
  color: var(--on-accent); background: var(--coral); border: 1px solid transparent;
  border-radius: var(--radius-pill); padding: 2px var(--sp-2);
}
.rc-sl__update:hover { filter: brightness(1.08); }
/* Secondary, quiet "Check for updates" — a hairline pill, never coral (that's reserved for an actual
   available update). */
.rc-sl__check {
  flex: none; font: inherit; font-size: var(--fs-xs); cursor: pointer;
  color: var(--text-muted); background: transparent; border: 1px solid var(--border);
  border-radius: var(--radius-pill); padding: 2px var(--sp-2); white-space: nowrap;
}
.rc-sl__check:hover:not(:disabled) { color: var(--text); border-color: var(--border-strong); }
.rc-sl__check:disabled { opacity: 0.6; cursor: default; }
/* The rail header — a flat surface bar with a hairline below (no glass blur). */
.rc-sl__head {
  flex: none;
  display: flex; align-items: center; gap: 9px;
  /* The mobile sheet's dedicated chrome row already clears the top edge. Adding the device safe-area
     inset here double-counted it and left a phone-sized void above "Sessions". */
  padding: 12px 13px;
  border-bottom: 1px solid var(--border);
  background: var(--bar-glass);
  position: sticky; top: 0; z-index: 1;
}
.rc-sl__limits {
  flex: none; padding: 8px;
  border-bottom: 1px solid var(--border); background: var(--bar-glass);
}
.rc-sl__limits-card {
  min-width: 0; overflow: hidden;
  border: 1px solid var(--border); border-radius: 11px; background: var(--surface);
  box-shadow: 0 1px 0 rgba(255,255,255,0.025) inset;
}
.rc-sl__limits-head {
  min-height: 25px; padding: 0 9px;
  display: grid; grid-template-columns: minmax(0, 1fr) auto 60px; align-items: center; gap: 5px;
  border-bottom: 1px solid var(--border); background: rgba(255,255,255,0.018);
}
.rc-sl__limits-kicker,
.rc-sl__limits-caption,
.rc-sl__limits-reset-caption {
  overflow: hidden; white-space: nowrap;
  color: var(--text-faint); font-size: 8px; font-weight: 700; letter-spacing: .07em; text-transform: uppercase;
}
.rc-sl__limits-caption { font-family: var(--font-mono); font-weight: 600; }
.rc-sl__limits-reset-caption { justify-self: end; font-family: var(--font-mono); font-weight: 600; }
.rc-sl__usage-provider {
  --rc-sl-provider-color: var(--coral);
  min-width: 0;
  display: grid; grid-template-columns: 27px minmax(0, 1fr); grid-template-rows: repeat(2, minmax(25px, auto));
  column-gap: 7px; align-items: center; padding: 3px 7px;
}
.rc-sl__usage-provider--codex { --rc-sl-provider-color: #8aa7ff; }
.rc-sl__usage-provider + .rc-sl__usage-provider { border-top: 1px solid var(--border); }
.rc-sl__usage-provider-name {
  min-width: 0; grid-row: 1 / span 2; align-self: stretch;
  display: flex; align-items: center; justify-content: center;
}
.rc-sl__usage-metrics { display: contents; }
.rc-sl__usage-metric {
  appearance: none; width: 100%; min-width: 0; min-height: 25px; grid-column: 2;
  display: grid; grid-template-columns: 31px 38px minmax(44px, 1fr) 60px; align-items: center; gap: 5px;
  padding: 2px 4px; border: 1px solid transparent; border-radius: 7px;
  background: transparent; color: inherit; cursor: pointer; text-align: left;
  transition: background 120ms ease;
}
.rc-sl__usage-metric:hover:not(:disabled) .rc-sl__usage-reset,
.rc-sl__usage-metric:hover:not(:disabled) .rc-sl__usage-metric-label {
  color: var(--text-muted);
}
.rc-sl__usage-metric:focus-visible {
  outline: 1px solid var(--border-strong); outline-offset: -1px;
  background: rgba(255,255,255,0.025);
}
.rc-sl__usage-metric[aria-expanded="true"] {
  background: rgba(255,255,255,0.035);
}
.rc-sl__usage-metric:disabled { cursor: default; }
.rc-sl__usage-metric-label {
  overflow: hidden; white-space: nowrap;
  color: var(--text-faint); font: 700 8.5px/1 var(--font-body); letter-spacing: .02em; text-transform: uppercase;
}
.rc-sl__usage-metric-value {
  color: var(--text); font: 700 12px/1 var(--font-mono); font-variant-numeric: tabular-nums; letter-spacing: -.04em;
}
.rc-sl__usage-metric-value--missing { color: var(--text-faint); }
.rc-sl__usage-metric--low .rc-sl__usage-metric-value { color: var(--warn); }
.rc-sl__usage-metric--critical .rc-sl__usage-metric-value { color: var(--err); }
.rc-sl__usage-track {
  display: block; height: 3px; overflow: hidden;
  border-radius: var(--radius-pill); background: var(--surface-3);
}
.rc-sl__usage-track--missing { opacity: 0.55; }
.rc-sl__usage-fill {
  display: block; height: 100%; border-radius: inherit; background: var(--rc-sl-provider-color); transition: width 360ms ease;
}
.rc-sl__usage-reset {
  min-width: 0; align-self: stretch;
  display: flex; align-items: center; justify-content: flex-end; text-align: right;
  color: var(--text-muted); font-family: var(--font-mono); font-variant-numeric: tabular-nums;
}
.rc-sl__usage-reset--dated { flex-direction: column; align-items: flex-end; justify-content: center; gap: 2px; }
.rc-sl__usage-reset-date {
  color: var(--text-faint); font-size: 7.5px; font-weight: 600; line-height: 1; letter-spacing: .02em;
}
.rc-sl__usage-reset-time { color: var(--text-muted); font-size: 8.5px; font-weight: 600; line-height: 1; }
.rc-sl__usage-reset-single {
  max-width: 100%; overflow: hidden; white-space: nowrap; text-overflow: ellipsis;
  font-size: 8.5px; font-weight: 600; line-height: 1; letter-spacing: -.025em;
}
.rc-sl__usage-detail {
  grid-column: 1 / -1; min-width: 0; min-height: 42px; margin: 3px -7px -3px; padding: 6px 8px 6px 34px;
  display: flex; align-items: center; gap: 8px;
  border-top: 1px solid var(--border-strong); background: var(--surface-2);
  animation: rc-usage-detail-in 140ms ease-out;
}
@keyframes rc-usage-detail-in {
  from { opacity: 0; transform: translateY(-3px); }
}
.rc-sl__usage-detail-copy {
  min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 3px;
}
.rc-sl__usage-detail-copy strong {
  overflow: hidden; white-space: nowrap; text-overflow: ellipsis;
  color: var(--text); font-size: 10px; font-weight: 650;
}
.rc-sl__usage-detail-copy > span {
  overflow: hidden; white-space: nowrap; text-overflow: ellipsis;
  color: var(--text-muted); font: 500 8.5px/1.2 var(--font-mono); font-variant-numeric: tabular-nums;
}
.rc-sl__usage-detail-close {
  flex: none; width: 26px; height: 26px; padding: 0;
  display: grid; place-items: center;
  border: 1px solid var(--border); border-radius: 7px; background: transparent;
  color: var(--text-muted); cursor: pointer;
}
.rc-sl__usage-detail-close:hover,
.rc-sl__usage-detail-close:focus-visible {
  color: var(--text); border-color: var(--border-strong);
}
@media (prefers-reduced-motion: reduce) {
  .rc-sl__usage-fill { transition: none; }
  .rc-sl__usage-detail { animation: none; }
}
.rc-sl__title {
  /* margin-right:auto pins the "+" to the right edge ALWAYS — previously only the needs-you badge
     carried it, so with zero awaiting sessions (the common case) the badge was null and "+" packed
     against the title. */
  margin-right: auto;
  display: inline-flex; align-items: baseline; gap: var(--sp-2);
  font-size: var(--fs-lg); letter-spacing: 0.01em; color: var(--text);
}
.rc-sl__heading { margin-right: auto; min-width: 0; display: grid; gap: 2px; }
.rc-sl__heading--host .rc-sl__title { margin-right: 0; font-size: var(--fs-xs); color: var(--text-muted); }
.rc-sl__host { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text); font-size: var(--fs-base); }
.rc-sl__count { color: var(--text-faint); }
.rc-sl__count-n { color: var(--text-muted); font-variant-numeric: tabular-nums; }
/* The global "N need you" badge — a FLAT awaiting pill (mockup .sl-needs): an --awaiting-soft wash
   with an --awaiting-line hairline. No halo: it pushes the New button right; the loud awaiting signal
   lives on the rail row + the iris card. */
.rc-needs {
  display: inline-flex; align-items: center; gap: var(--sp-1);
  padding: 3px 9px; border-radius: 999px;
  background: var(--awaiting-soft); border: 1px solid var(--awaiting-line);
  color: var(--awaiting); font-family: var(--font-mono); font-size: var(--fs-xs); line-height: 1.4;
  white-space: nowrap;
}
.rc-needs__n { font-weight: 700; font-variant-numeric: tabular-nums; }
.rc-needs__label { color: var(--awaiting); }
.rc-sl__needs { margin-left: var(--sp-2); }
/* When the badge carries a tap handler (C1 — jump to the first awaiting session) it renders as a
   BUTTON: reset the UA chrome down to the same pill, add a pointer + hover lift + focus ring. */
.rc-needs--tap { cursor: pointer; font: inherit; font-family: var(--font-mono); font-size: var(--fs-xs);
  transition: filter 120ms ease, border-color 120ms ease; }
.rc-needs--tap:hover { filter: brightness(1.08); border-color: var(--awaiting); }
.rc-needs--tap:focus-visible { outline: 2px solid var(--awaiting); outline-offset: 2px; }
/* The settings gear — a NEUTRAL icon button (coral is reserved for the "+" CTA), opening the global
   defaults + notifications without entering a chat. */
/* The "+" new-session button — the coral PRIMARY (spec): a compact 34px FLAT coral tile with a dark
   ink glyph. The one coral CTA in the rail. */
.rc-sl__new {
  width: var(--tap-min); height: var(--tap-min); flex: none;
  display: grid; place-items: center;
  border-radius: 9px;
  background: var(--coral); border: 1px solid transparent;
  color: var(--on-accent); cursor: pointer;
  transition: filter 120ms ease;
}
.rc-sl__new:hover, .rc-sl__new:focus-visible {
  filter: brightness(1.08);
}
.rc-sl__list { list-style: none; margin: 0; padding: 0; overflow-y: auto; flex: 1; }
.rc-sl__workspace { list-style: none; border-bottom: 1px solid var(--border); background: var(--bar-glass); }
.rc-sl__workspace-toggle {
  width: 100%; min-height: 34px; padding: 0 12px;
  display: flex; align-items: center; gap: 7px; border: 0; background: transparent;
  color: var(--text-muted); cursor: pointer; text-align: left;
  font: 650 10px/1 var(--font-mono); letter-spacing: .025em;
}
.rc-sl__workspace-toggle:hover, .rc-sl__workspace-toggle:focus-visible { color: var(--text); background: var(--surface); }
.rc-sl__workspace-toggle > svg { flex: none; transition: transform 120ms ease; }
.rc-sl__workspace-toggle[aria-expanded="false"] > svg { transform: rotate(-90deg); }
.rc-sl__workspace-toggle > span:nth-child(2) { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rc-sl__workspace-count { margin-left: auto; color: var(--text-faint); font-variant-numeric: tabular-nums; }
.rc-sl__workspace-attention { min-width: 17px; height: 17px; padding: 0 4px; display: grid; place-items: center; border-radius: 999px; background: var(--awaiting-soft); color: var(--awaiting); font-size: 8px; font-variant-numeric: tabular-nums; }
/* The row + its ✕ live side by side in the list item; a hairline divider sits on the item so it
   spans both. A subtle entrance fade (reduce-motion-neutralized globally) softens reorders. */
.rc-sl__item {
  position: relative;
  display: flex; align-items: stretch; flex-wrap: wrap;
  border-bottom: 1px solid var(--border);
  animation: rc-row-in 140ms ease both;
}
.rc-sl__row {
  position: relative;
  flex: 1; min-width: 0; text-align: left;
  min-height: var(--tap-min);
  display: flex; align-items: center; gap: var(--sp-3);
  background: transparent; border: none;
  color: var(--text); cursor: pointer;
  padding: var(--sp-3) var(--sp-2) var(--sp-3) var(--sp-3);
  transition: background 120ms ease;
}
.rc-sl__row:hover { background: var(--surface); }
/* Draggable rows (desktop split-screen) advertise it: a grab cursor, closing to grabbing mid-drag. */
.rc-sl__row[draggable="true"] { cursor: grab; }
.rc-sl__row[draggable="true"]:active { cursor: grabbing; }
/* The one-time split-drag coach hint — a quiet accent-washed pill pinned above the footer. */
.rc-sl__draghint {
  flex: none;
  display: flex; align-items: flex-start; gap: var(--sp-2);
  margin: var(--sp-2) 13px; padding: 9px 11px;
  background: var(--accent-soft); border: 1px solid var(--accent-line); border-radius: var(--radius-sm);
  color: var(--text); font-size: var(--fs-xs); line-height: 1.45;
  animation: rc-rise 220ms ease both;
}
.rc-sl__draghint-icon { flex: none; color: var(--accent-2); font-size: 14px; line-height: 1.3; }
.rc-sl__draghint strong { color: var(--accent-2); font-weight: 600; }
.rc-sl__draghint-x {
  flex: none; margin-left: auto; width: 22px; height: 22px;
  display: grid; place-items: center; border-radius: 6px; cursor: pointer;
  background: transparent; border: none; color: var(--text-muted);
}
.rc-sl__draghint-x:hover { color: var(--text); }
/* Row treatments (split-aware):
   - ACTIVE (the FOCUSED pane's session): the strong lift + an ACCENT left rail — matches the focused pane's
     accent ring, so "which window my rail-clicks replace" is one glance.
   - OPEN (visible in another pane): a quiet lift + a neutral left rail — on screen, but not the target.
   "needs you" never borrows either (its coral lives only on the dot + word). */
.rc-sl__row--active { background: var(--surface-2); }
.rc-sl__rail { position: absolute; left: 0; top: 0; bottom: 0; width: 2px; background: transparent; }
.rc-sl__row--active .rc-sl__rail { background: var(--accent-line); }
.rc-sl__row--open { background: var(--surface); }
.rc-sl__row--open .rc-sl__rail { background: var(--border-strong); }
/* The state dot — the at-a-glance status, always paired with the word (line 2) so it's never color-only.
   working = the signature CORAL pulsing dot (the app's "something's happening" blink); idle = a quiet hollow
   ring; needs-you = coral too, but a radiating HALO (more urgent than a blink) so it out-reads a working row
   even though both are coral — plus the bold "needs you" word; ended/dead = a dim faint dot. */
.rc-sl__dot { flex: none; width: 8px; height: 8px; border-radius: 50%; }
.rc-sl__dot--work {
  background: var(--accent); box-shadow: 0 0 6px rgba(247, 124, 68, 0.6);
  animation: rc-sl-pulse 1.2s ease-in-out infinite;
}
.rc-sl__dot--idle { background: transparent; border: 1.5px solid var(--text-faint); }
.rc-sl__dot--need { background: var(--awaiting); animation: rc-sl-halo 1.6s ease-out infinite; }
.rc-sl__dot--dead { background: var(--text-faint); opacity: 0.5; }
/* Own keyframe names (rc-sl-*) so these never collide with another component's keyframes. */
@keyframes rc-sl-pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.35; } }
@keyframes rc-sl-halo {
  0% { box-shadow: 0 0 0 0 rgba(255, 146, 99, 0.55); }
  70% { box-shadow: 0 0 0 6px rgba(255, 146, 99, 0); }
  100% { box-shadow: 0 0 0 0 rgba(255, 146, 99, 0); }
}
/* An ENDED (dead) session's row reads dimmed so it's obviously not live at a glance — a secondary cue
   on top of the "ended" text label (never dim-only). The right-hand actions stay full-strength (they're
   a sibling of the row button) so closing a dead session is still easy. */
.rc-sl__row--ended { opacity: 0.6; }
.rc-sl__row--ended .rc-sl__name { color: var(--text-muted); }
.rc-sl__main {
  flex: 1; min-width: 0;
  display: flex; flex-direction: column; gap: 2px;
}
.rc-sl__name {
  font-size: var(--fs-base); font-weight: 600; letter-spacing: -0.2px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0;
}
/* Line 2 — the status word + a compact relative time, side by side (mono, calm). */
.rc-sl__sub {
  display: flex; align-items: baseline; gap: var(--sp-1);
  font-family: var(--font-mono); font-size: var(--fs-xs); color: var(--text-faint);
}
.rc-sl__sub-word--work { color: var(--text-muted); }
.rc-sl__sub-word--idle { color: var(--text-faint); }
.rc-sl__sub-word--dead { color: var(--text-faint); }
/* "needs you" — the one loud word: coral, paired with the coral dot. NOT a row wash (the selected row owns that). */
.rc-sl__sub-need { color: var(--awaiting); font-weight: 600; }
.rc-sl__sub-sep { color: var(--text-faint); }
.rc-sl__time { color: var(--text-faint); font-variant-numeric: tabular-nums; }
.rc-sl__provider-meta {
  display: flex; gap: var(--sp-1); align-items: center; min-width: 0;
  overflow: hidden; white-space: nowrap; text-overflow: ellipsis;
  font: var(--fs-xs)/1.3 var(--font-mono); color: var(--text-faint);
}
/* Row actions live on the right of each item — collapsed behind a single "⋯" (rc-sl__more) by default, so
   the rail stays quiet; tapping it swaps in the inline cluster (＋ here, rename, ✕) for that one row. */
.rc-sl__actions {
  flex: none; align-self: center;
  display: flex; align-items: center; gap: 2px;
  padding-right: var(--sp-2);
}
.rc-sl__details-toggle {
  flex: none; width: 30px; height: 34px;
  display: grid; place-items: center;
  background: transparent; border: 1px solid transparent; border-radius: 8px;
  color: var(--text-faint); cursor: pointer;
  transition: color 120ms ease, background 120ms ease, border-color 120ms ease, transform 140ms ease;
}
.rc-sl__details-toggle:hover, .rc-sl__details-toggle:focus-visible {
  color: var(--text); background: var(--surface); border-color: var(--border);
}
.rc-sl__details-toggle--open { color: var(--text-muted); }
.rc-sl__details-toggle--open svg { transform: rotate(180deg); }
.rc-sl__runtime-details {
  flex: 0 0 calc(100% - 74px); width: auto; min-width: 0; box-sizing: border-box;
  margin: -3px 42px 10px 32px; padding: 8px 9px;
  display: flex; flex-direction: column; gap: 6px;
  background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-sm);
  font: var(--fs-xs)/1.4 var(--font-mono); color: var(--text-muted);
}
.rc-sl__runtime-line { display: grid; grid-template-columns: 58px minmax(0, 1fr); gap: var(--sp-2); }
.rc-sl__runtime-line > :last-child { overflow-wrap: anywhere; }
.rc-sl__runtime-label { display: inline-flex; align-items: center; gap: 5px; color: var(--text-faint); }
.rc-sl__runtime-line--danger, .rc-sl__runtime-line--danger .rc-sl__runtime-label { color: var(--warn); }
/* The "⋯" that reveals a row's actions — a quiet dotted glyph, brightening on hover/focus like the rest. */
.rc-sl__more {
  flex: none;
  width: 34px; height: 34px;
  display: grid; place-items: center;
  background: transparent; border: 1px solid transparent; border-radius: 8px;
  color: var(--text-faint); font-size: 19px; line-height: 1; cursor: pointer;
  transition: color 120ms ease, background 120ms ease, border-color 120ms ease;
}
.rc-sl__more:hover, .rc-sl__more:focus-visible {
  color: var(--text); background: var(--surface); border-color: var(--border);
}
/* The neutral per-row action buttons (＋ here / rename) — quiet by default, brightening on hover. */
.rc-sl__act {
  flex: none;
  width: 34px; height: 34px;
  display: grid; place-items: center;
  background: transparent; border: 1px solid transparent; border-radius: 8px;
  color: var(--text-faint); cursor: pointer;
  transition: color 120ms ease, background 120ms ease, border-color 120ms ease;
}
.rc-sl__act:hover, .rc-sl__act:focus-visible {
  color: var(--text); background: var(--surface); border-color: var(--border);
}
/* The ✕ close button — a clearly separated, comfortably tappable target; muted by default, warming to
   the error tint on hover/focus to read as the destructive "stop & remove" action. */
.rc-sl__close {
  flex: none;
  width: 34px; height: 34px;
  display: grid; place-items: center;
  background: transparent; border: 1px solid transparent; border-radius: 8px;
  color: var(--text-faint); cursor: pointer;
  transition: color 120ms ease, background 120ms ease, border-color 120ms ease;
}
.rc-sl__close:hover, .rc-sl__close:focus-visible {
  color: var(--err); background: var(--err-soft); border-color: var(--err-line);
}
/* The filter box — a hairline field below the header; a leading magnifier + a clear-when-typed ✕. */
.rc-sl__search {
  flex: none;
  display: flex; align-items: center; gap: var(--sp-2);
  margin: var(--sp-2) 13px;
  padding: 0 var(--sp-2);
  background: var(--surface-2); border: 1px solid var(--border);
  border-radius: var(--radius-sm); color: var(--text-muted);
  transition: border-color 120ms ease;
}
.rc-sl__search:focus-within { border-color: var(--accent-line); box-shadow: var(--focus-glow); }
.rc-sl__search-input {
  flex: 1; min-width: 0; min-height: 36px;
  background: transparent; border: none; outline: none;
  color: var(--text); font: inherit; font-size: var(--fs-sm);
}
.rc-sl__search-clear {
  flex: none; display: grid; place-items: center;
  width: 28px; height: 28px; border-radius: var(--radius-sm);
  background: transparent; border: none; color: var(--text-faint); cursor: pointer;
}
.rc-sl__search-clear:hover { color: var(--text); }
/* Inline rename form — replaces the row while editing so there are no nested interactive elements. */
.rc-sl__edit {
  flex: 1; min-width: 0;
  display: flex; align-items: center; gap: var(--sp-1);
  padding: var(--sp-2) var(--sp-2) var(--sp-2) var(--sp-4);
}
.rc-sl__edit-input {
  flex: 1; min-width: 0; min-height: 36px;
  background: var(--surface-2); border: 1px solid var(--accent-line);
  border-radius: var(--radius-sm); color: var(--text);
  padding: 0 var(--sp-2); font: inherit; font-size: var(--fs-base); font-weight: 600;
}
.rc-sl__edit-input:focus { outline: none; box-shadow: var(--focus-glow); }
.rc-sl__edit-btn {
  flex: none; width: 34px; height: 34px;
  display: grid; place-items: center;
  background: transparent; border: 1px solid transparent; border-radius: 8px;
  color: var(--text-muted); cursor: pointer;
  transition: color 120ms ease, background 120ms ease, border-color 120ms ease;
}
.rc-sl__edit-btn:hover, .rc-sl__edit-btn:focus-visible {
  color: var(--text); background: var(--surface); border-color: var(--border);
}
.rc-sl__empty { padding: var(--sp-4); color: var(--text-muted); font-size: var(--fs-sm); line-height: 1.5; }
.rc-sl__empty-em { color: var(--accent); font-family: var(--font-display); font-weight: 600; }
@keyframes rc-row-in {
  from { opacity: 0; transform: translateY(-2px); }
  to { opacity: 1; transform: none; }
}
`;
