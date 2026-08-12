import { Fragment, useEffect, useRef, useState } from "react";
import { Icon } from "../ui/Icon";
import { SESSION_MIME } from "../split/dnd";
import { basename, displaySessionName, saveSessionName, useSessionNames } from "./names";
import type { SessionMeta, UsageInfo } from "../types/server";
import type { SessionOrder } from "./order-preference";
import { relativeTime } from "./relative-time";
import { formatEpochReset, normalizeProviderUsage, shortenReset, type NormalizedUsageBar } from "./UsageBars";
import { providerDisplayName, providerSessionDisplay } from "./provider-display";
import type { CodexUsage, ProviderId } from "../providers/types";
import { ProviderIcon } from "../providers/ProviderIcon";
import { groupSessionsByAttention, sessionAttentionSection } from "./attention-groups";
import type { RailMode } from "../hosts/host-ui-state";

export interface SessionListProps {
  sessions: SessionMeta[];
  hostLabel?: string;
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
  /** Desktop presentation; mobile always renders the expanded full-width switcher. */
  railMode?: RailMode;
  /** Collapse or expand the permanent desktop rail. */
  onToggleRail?: () => void;
}

function absoluteTime(ms: number): string {
  return new Date(ms).toLocaleString();
}

function useDesktopRail(): boolean {
  const [desktop, setDesktop] = useState(
    () =>
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(min-width: 768px)").matches,
  );
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const query = window.matchMedia("(min-width: 768px)");
    const update = () => setDesktop(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return desktop;
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
  const activity = s.agent?.activity ?? s.activity;
  if (sessionAttentionSection(s) === "need-you") return { tone: "need", word: "needs you" };
  if (s.status === "running") {
    return activity === "working" ? { tone: "work", word: "working" } : { tone: "idle", word: "idle" };
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
  return sessions.reduce((n, s) => (sessionAttentionSection(s) === "need-you" && !excluded.has(s.id) ? n + 1 : n), 0);
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

function primaryRemaining(provider: ProviderId, bars: NormalizedUsageBar[]): number | undefined {
  const preferred = railLimitSlots(provider, bars)[0].bar ?? bars[0];
  if (!preferred) return undefined;
  return 100 - Math.max(0, Math.min(100, Math.round(preferred.percent)));
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
 * header carries a "New terminal" `+` icon button and a live session count. Works as the desktop rail
 * (var(--rail-w)) and as the mobile sheet.
 */
/** Show search only once scanning is genuinely slower than filtering. Three or four quiet rows fit cleanly
 * on a phone; at five, similarly named sibling folders benefit from a dedicated query field. */
const SEARCH_MIN = 9;

export function SessionList({
  sessions,
  hostLabel,
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
  onNeedsYouTap,
  onOpenHelp,
  draggableRows = false,
  visibleIds,
  railMode = "expanded",
  onToggleRail,
}: SessionListProps) {
  const grouped = groupSessionsByAttention(sessions, lastActiveAt, order);
  const compact = useDesktopRail() && railMode === "compact";

  // Search/filter (by name or cwd) — surfaced only for longer lists.
  const [query, setQuery] = useState("");
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
  // Runtime metadata is intentionally progressive: the default row shows provider + status; model, effort,
  // and safety details stay behind one disclosure so the rail remains scannable on desktop and phone.
  const [detailsOpenId, setDetailsOpenId] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (!menuOpenId) return undefined;
    const close = () => setMenuOpenId(undefined);
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [menuOpenId]);

  // Split-screen drag DISCOVERABILITY (desktop only, via draggableRows): dragging a session onto the
  // terminal is invisible until you know it exists, so a one-time coach hint teaches it — same pattern as
  // the terminal's one-finger-scroll hint (show briefly, cap the shows, learn forever on first REAL drag).
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
  const filteredNeedYou = grouped.needYou.filter(matchesSession);
  const filteredWorking = grouped.working.filter(matchesSession);
  const filteredOther = grouped.other.filter(matchesSession);
  const railEntries: Array<
    | { type: "section"; key: string; label: string; count: number; tone: "need" | "work" | "other" }
    | { type: "session"; key: string; session: SessionMeta }
  > = [];
  const pushSection = (key: string, label: string, tone: "need" | "work" | "other", sectionSessions: SessionMeta[]) => {
    if (sectionSessions.length === 0) return;
    railEntries.push({ type: "section", key: `section:${key}`, label, count: sectionSessions.length, tone });
    railEntries.push(
      ...sectionSessions.map((session) => ({ type: "session" as const, key: `${key}:${session.id}`, session })),
    );
  };

  // Attention is global: prompts needing the user and actively working agents stay above the remaining shells.
  pushSection("need-you", "Need You", "need", filteredNeedYou);
  pushSection("working", "Working", "work", filteredWorking);

  if (compact) {
    pushSection("other", "Other", "other", filteredOther);
  } else if (filteredOther.length > 0) {
    railEntries.push({
      type: "section",
      key: "section:other",
      label: "Other",
      count: filteredOther.length,
      tone: "other",
    });
  }

  if (!compact && filteredOther.length > 0) {
    railEntries.push(
      ...filteredOther.map((session) => ({ type: "session" as const, key: `other:${session.id}`, session })),
    );
  }
  const shown = railEntries.flatMap((entry) => (entry.type === "session" ? [entry.session] : []));
  const claudeUsageBars = usage ? normalizeProviderUsage("claude", usage).bars : [];
  const codexUsageBars = codexUsage ? normalizeProviderUsage("codex", codexUsage).bars : [];
  const hasUsageLimits = claudeUsageBars.length > 0 || codexUsageBars.length > 0;
  const [limitsOpen, setLimitsOpen] = useState(false);
  const claudeRemaining = primaryRemaining("claude", claudeUsageBars);
  const codexRemaining = primaryRemaining("codex", codexUsageBars);

  return (
    <div className={`rc-sl rc-sl--${compact ? "compact" : "expanded"}`}>
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
        {onToggleRail && (
          <button
            type="button"
            className="rc-sl__rail-toggle"
            onClick={onToggleRail}
            aria-label={compact ? "Expand sessions rail" : "Collapse sessions rail"}
            title={compact ? "Expand sessions" : "Collapse sessions"}
          >
            <Icon name="chevron-right" size={16} />
          </button>
        )}
        {compact && (
          <button type="button" className="rc-sl__new" onClick={onNew} aria-label="New terminal">
            <Icon name="plus" size={16} />
          </button>
        )}
      </div>
      {!compact && (
        <button type="button" className="rc-sl__new-row" onClick={onNew} aria-label="New terminal">
          <Icon name="plus" size={15} />
          <span>new session</span>
        </button>
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
          if (entry.type === "section") {
            const content = (
              <>
                <span>{entry.label}</span>
                <span aria-hidden="true">·</span>
                <span>{entry.count}</span>
              </>
            );
            return (
              <li key={entry.key} className={`rc-sl__section rc-sl__section--${entry.tone}`}>
                {entry.tone === "need" && onNeedsYouTap ? (
                  <button
                    type="button"
                    className="rc-sl__section-action"
                    onClick={onNeedsYouTap}
                    aria-label={`${entry.count} ${entry.count === 1 ? "session needs" : "sessions need"} you`}
                  >
                    {content}
                  </button>
                ) : (
                  <div className="rc-sl__section-label">{content}</div>
                )}
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
          const provider = s.agent?.provider ?? s.provider ?? "terminal";
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
                      <span className="rc-sl__compact-provider" aria-hidden="true">
                        <ProviderIcon provider={provider} label=" " />
                        <span className={`rc-sl__compact-status rc-sl__compact-status--${tone}`} />
                      </span>
                      {/* A single state dot carries the status at a glance; the text on line two keeps it
                        accessible without spending a third row on runtime metadata. */}
                      <span className={`rc-sl__dot rc-sl__dot--${tone}`} aria-hidden="true" />
                      <span className="rc-sl__main">
                        <strong className="display rc-sl__name">{name}</strong>
                        <span className="rc-sl__provider-meta">
                          <ProviderIcon provider={provider} />
                          <span className="rc-sl__provider-name">{providerMeta.provider}</span>
                          <span className="rc-sl__sub-sep" aria-hidden="true">
                            ·
                          </span>
                          {awaiting ? (
                            <span className="rc-sl__sub-need" role="status" aria-label={`${name} needs you`}>
                              {word}
                            </span>
                          ) : (
                            <span className={`rc-sl__sub-word rc-sl__sub-word--${tone}`}>{word}</span>
                          )}
                        </span>
                      </span>
                      <time
                        className="rc-sl__time"
                        dateTime={new Date(activeAt).toISOString()}
                        title={absoluteTime(activeAt)}
                      >
                        {relativeTime(activeAt, now)}
                      </time>
                    </button>
                    {/* Row actions behind a single "⋯" so the default rail stays quiet — it opens an inline
                      cluster (new-here · rename · close). Each button stopPropagation so it never selects the
                      row; an outside click closes the cluster (see the menuOpenId effect). */}
                    <span className="rc-sl__actions">
                      {menuOpen ? (
                        <>
                          <button
                            type="button"
                            className={`rc-sl__act${detailsOpen ? " rc-sl__act--open" : ""}`}
                            onClick={(e) => {
                              e.stopPropagation();
                              setDetailsOpenId(detailsOpen ? undefined : s.id);
                              setMenuOpenId(undefined);
                            }}
                            aria-label={`${detailsOpen ? "Hide" : "Show"} details for ${name}`}
                            aria-expanded={detailsOpen}
                            title="Runtime details"
                          >
                            <Icon name="chevron-down" size={15} />
                          </button>
                          {onNewHere && (
                            <button
                              type="button"
                              className="rc-sl__act"
                              onClick={(e) => {
                                e.stopPropagation();
                                setMenuOpenId(undefined);
                                onNewHere(s.cwd);
                              }}
                              aria-label={`New terminal in ${name}`}
                              title="New terminal in this folder"
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
            to start one.
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

      {hasUsageLimits && !compact && limitsOpen && (
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
      {hasUsageLimits && !compact && (
        <button
          type="button"
          className="rc-sl__usage-summary"
          onClick={() => setLimitsOpen((open) => !open)}
          aria-expanded={limitsOpen}
          aria-label={`Usage limits${claudeRemaining === undefined ? "" : `, Claude ${claudeRemaining}% remaining`}${codexRemaining === undefined ? "" : `, Codex ${codexRemaining}% remaining`}`}
        >
          {claudeRemaining !== undefined && <span>Claude {claudeRemaining}%</span>}
          {claudeRemaining !== undefined && codexRemaining !== undefined && <span aria-hidden="true">·</span>}
          {codexRemaining !== undefined && <span>Codex {codexRemaining}%</span>}
          <Icon name="chevron-down" size={13} />
        </button>
      )}

      {/* The quiet footer: Help + Settings bottom-left (moved out of the cramped header — classic sidebar
          placement), then the running version + the update affordance on the right. */}
      {compact && onOpenSettings ? (
        <div className="rc-sl__footer rc-sl__footer--compact">
          <button type="button" className="rc-sl__foot-btn" onClick={onOpenSettings} aria-label="Settings">
            <Icon name="settings" size={16} />
          </button>
        </div>
      ) : version || onOpenHelp || onOpenSettings ? (
        <div className="rc-sl__footer">
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
      ) : null}

      <style>{sessionListCss}</style>
    </div>
  );
}

const sessionListCss = `
.rc-sl { display: flex; flex-direction: column; height: 100%; }
/* Version footer — pinned at the bottom of the rail; quiet mono label + a coral "Update available". */
.rc-sl__footer {
  flex: none;
  min-height: var(--control-h); display: flex; align-items: center; gap: 4px;
  padding: 0 6px;
  border-top: 1px solid var(--border);
}
/* Help + Settings as quiet footer tiles (bottom-left, out of the header) — smaller than the header CTAs. */
.rc-sl__foot-btn {
  width: 28px; height: 28px; flex: none;
  display: grid; place-items: center;
  border-radius: var(--radius-sm);
  background: transparent; border: 1px solid transparent;
  color: var(--text-muted); cursor: pointer;
  transition: color 120ms ease, border-color 120ms ease;
}
.rc-sl__foot-btn:hover, .rc-sl__foot-btn:focus-visible { color: var(--text); border-color: var(--border-strong); }
/* The version takes the slack and right-aligns (ellipsising first) so the update affordance stays pinned. */
.rc-sl__version {
  flex: 1 1 auto; min-width: 0; text-align: right;
  font-family: var(--font-mono); font-size: var(--fs-xs); color: var(--text-faint);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.rc-sl__update {
  flex: none; font: inherit; font-size: var(--fs-xs); font-weight: 600; cursor: pointer;
  color: var(--on-accent); background: var(--coral); border: 1px solid transparent;
  border-radius: var(--radius-sm); padding: 3px 6px;
}
.rc-sl__update:hover { filter: brightness(1.08); }
/* Secondary, quiet "Check for updates" — a hairline pill, never coral (that's reserved for an actual
   available update). */
.rc-sl__check {
  flex: none; font: inherit; font-size: var(--fs-xs); cursor: pointer;
  color: var(--text-muted); background: transparent; border: 1px solid var(--border);
  border-radius: var(--radius-sm); padding: 3px 6px; white-space: nowrap;
}
.rc-sl__check:hover:not(:disabled) { color: var(--text); border-color: var(--border-strong); }
.rc-sl__check:disabled { opacity: 0.6; cursor: default; }
.rc-sl__usage-summary {
  flex: none; width: 100%; min-height: var(--control-h); padding: 0 8px;
  display: flex; align-items: center; gap: 7px;
  border: 0; border-top: 1px solid var(--border); background: transparent;
  color: var(--text-muted); cursor: pointer; text-align: left;
  font: 500 var(--fs-xs)/1 var(--font-mono); font-variant-numeric: tabular-nums;
}
.rc-sl__usage-summary:hover, .rc-sl__usage-summary:focus-visible { color: var(--text); background: var(--surface); }
.rc-sl__usage-summary svg { margin-left: auto; transition: transform 120ms ease; }
.rc-sl__usage-summary[aria-expanded="true"] svg { transform: rotate(180deg); }
/* The rail header — a flat surface bar with a hairline below (no glass blur). */
.rc-sl__head {
  flex: none;
  display: flex; align-items: center; gap: 6px;
  min-height: calc(var(--tap-min) + env(safe-area-inset-top, 0px));
  padding: env(safe-area-inset-top, 0px) 92px 0 10px;
  border-bottom: 1px solid var(--border);
  background: var(--bar-glass);
  position: sticky; top: 0; z-index: 1;
}
.rc-sl__limits {
  flex: none; max-height: min(42vh, 300px); overflow-y: auto; padding: 0;
  border-top: 1px solid var(--border); background: var(--bar-glass);
}
.rc-sl__limits-card {
  min-width: 0; overflow: hidden;
  border: 0; border-radius: 0; background: var(--surface);
  box-shadow: none;
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
  display: inline-flex; align-items: baseline; gap: 6px;
  font-size: var(--fs-sm); letter-spacing: 0; color: var(--text-muted); text-transform: lowercase;
}
.rc-sl__heading { margin-right: auto; min-width: 0; display: grid; gap: 2px; }
.rc-sl__heading--host .rc-sl__title { margin-right: 0; font-size: var(--fs-xs); color: var(--text-muted); }
.rc-sl__host { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text); font-size: var(--fs-base); }
.rc-sl__count { color: var(--text-faint); }
.rc-sl__count-n { color: var(--text-muted); font-variant-numeric: tabular-nums; }
.rc-sl__rail-toggle {
  width: var(--control-h); height: var(--control-h); flex: none; display: none; place-items: center;
  padding: 0; border: 1px solid transparent; border-radius: var(--radius-sm);
  background: transparent; color: var(--text-faint); cursor: pointer;
}
.rc-sl__rail-toggle:hover, .rc-sl__rail-toggle:focus-visible {
  color: var(--text); background: var(--surface-2); border-color: var(--border);
}
.rc-sl--expanded .rc-sl__rail-toggle svg { transform: rotate(180deg); }
/* The "+" new-session button — the coral PRIMARY (spec): a compact 34px FLAT coral tile with a dark
   ink glyph. The one coral CTA in the rail. */
.rc-sl__new {
  width: var(--control-h); height: var(--control-h); flex: none;
  display: grid; place-items: center;
  border-radius: var(--radius-sm);
  background: transparent; border: 1px solid transparent;
  color: var(--coral); cursor: pointer;
  transition: filter 120ms ease;
}
.rc-sl__new:hover, .rc-sl__new:focus-visible { background: var(--accent-soft); }
.rc-sl__new-row {
  flex: none; width: 100%; min-height: var(--control-h); padding: 0 10px;
  display: flex; align-items: center; gap: 7px;
  border: 0; border-bottom: 1px solid var(--border); border-radius: 0;
  background: transparent; color: var(--coral); cursor: pointer;
  font: 600 var(--fs-sm)/1 var(--font-mono); text-align: left;
}
.rc-sl__new-row:hover, .rc-sl__new-row:focus-visible { background: var(--accent-soft); }
.rc-sl__list {
  list-style: none; margin: 0; padding: 0; overflow-y: auto; flex: 1;
  overscroll-behavior: contain; touch-action: pan-y; -webkit-overflow-scrolling: touch;
}
.rc-sl__section {
  min-width: 0; list-style: none; border-bottom: 1px solid var(--border); background: var(--bg);
}
.rc-sl__section-label, .rc-sl__section-action {
  width: 100%; min-height: var(--section-h); padding: 0 10px;
  display: flex; align-items: center; gap: 7px;
  border: 0; background: transparent; color: var(--text-faint); text-align: left;
  font: 600 10px/1 var(--font-mono); letter-spacing: .02em; text-transform: lowercase;
}
.rc-sl__section-action { cursor: pointer; }
.rc-sl__section-action:hover, .rc-sl__section-action:focus-visible { background: var(--surface); color: var(--text); }
.rc-sl__section--need .rc-sl__section-label, .rc-sl__section--need .rc-sl__section-action { color: var(--awaiting); }
.rc-sl__section--work .rc-sl__section-label { color: var(--text-muted); }
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
  min-height: 42px;
  display: flex; align-items: center; gap: 7px;
  background: transparent; border: none;
  color: var(--text); cursor: pointer;
  padding: 4px 2px 4px 10px;
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
   Working stays neutral; idle is a quiet hollow ring; needs-you alone gets coral plus a radiating halo and
   bold status copy; ended/dead is a dim faint dot. */
.rc-sl__dot { flex: none; width: 6px; height: 6px; border-radius: 50%; }
.rc-sl__dot--work {
  background: var(--text-muted);
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
  display: flex; flex-direction: column; gap: 1px;
}
.rc-sl__name {
  font-size: var(--fs-sm); font-weight: 600; letter-spacing: -0.1px;
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
.rc-sl__time {
  flex: none; color: var(--text-faint); font: var(--fs-xs)/1 var(--font-mono);
  font-variant-numeric: tabular-nums;
}
.rc-sl__provider-meta {
  display: flex; gap: var(--sp-1); align-items: center; min-width: 0;
  overflow: hidden; white-space: nowrap; text-overflow: ellipsis;
  font: var(--fs-xs)/1.3 var(--font-mono); color: var(--text-faint);
}
.rc-sl__provider-name { overflow: hidden; text-overflow: ellipsis; }
.rc-sl__compact-provider { display: none; }
/* Row actions live on the right of each item — collapsed behind a single "⋯" (rc-sl__more) by default, so
   the rail stays quiet; tapping it swaps in the inline cluster (＋ here, rename, ✕) for that one row. */
.rc-sl__actions {
  flex: none; align-self: center;
  display: flex; align-items: center; gap: 2px;
  padding-right: 1px;
}
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
  width: var(--control-h); height: var(--control-h);
  display: grid; place-items: center;
  background: transparent; border: 1px solid transparent; border-radius: var(--radius-sm);
  color: var(--text-faint); font-size: 19px; line-height: 1; cursor: pointer;
  transition: color 120ms ease, background 120ms ease, border-color 120ms ease;
}
.rc-sl__more:hover, .rc-sl__more:focus-visible {
  color: var(--text); background: var(--surface); border-color: var(--border);
}
/* The neutral per-row action buttons (＋ here / rename) — quiet by default, brightening on hover. */
.rc-sl__act {
  flex: none;
  width: var(--control-h); height: var(--control-h);
  display: grid; place-items: center;
  background: transparent; border: 1px solid transparent; border-radius: var(--radius-sm);
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
  width: var(--control-h); height: var(--control-h);
  display: grid; place-items: center;
  background: transparent; border: 1px solid transparent; border-radius: var(--radius-sm);
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
@media (max-width: 767px) {
  .rc-sl__host { display: none; }
  .rc-sl__heading--host .rc-sl__title { font-size: var(--fs-sm); color: var(--text-muted); }
  .rc-sl__footer { padding-bottom: 4px; }
  .rc-shell[data-conversation-active="false"] .rc-sl__footer {
    padding-bottom: calc(4px + env(safe-area-inset-bottom, 0px));
  }
}
@media (min-width: 768px) {
  .rc-sl__head { min-height: var(--control-h); padding: 0 4px 0 8px; }
  .rc-sl__rail-toggle { display: grid; }
  .rc-sl--compact .rc-sl__head {
    min-height: auto; padding: 4px; flex-direction: column; gap: 2px; border-bottom-color: var(--border);
  }
  .rc-sl--compact .rc-sl__heading { display: none; }
  .rc-sl--compact .rc-sl__rail-toggle, .rc-sl--compact .rc-sl__new { width: 36px; height: 36px; }
  .rc-sl--compact .rc-sl__new { order: 1; }
  .rc-sl--compact .rc-sl__rail-toggle { order: 2; }
  .rc-sl--compact .rc-sl__section { height: 10px; min-height: 10px; border-bottom: 1px solid var(--border); }
  .rc-sl--compact .rc-sl__section-label, .rc-sl--compact .rc-sl__section-action {
    min-height: 9px; height: 9px; padding: 0; overflow: hidden; pointer-events: none;
  }
  .rc-sl--compact .rc-sl__section-label > *, .rc-sl--compact .rc-sl__section-action > * { display: none; }
  .rc-sl--compact .rc-sl__section--need { border-bottom-color: var(--awaiting-line); }
  .rc-sl--compact .rc-sl__item { min-height: 42px; }
  .rc-sl--compact .rc-sl__row {
    width: 43px; min-width: 43px; min-height: 42px; padding: 0; flex: 0 0 43px; justify-content: center;
  }
  .rc-sl--compact .rc-sl__main,
  .rc-sl--compact .rc-sl__dot,
  .rc-sl--compact .rc-sl__time,
  .rc-sl--compact .rc-sl__actions,
  .rc-sl--compact .rc-sl__runtime-details,
  .rc-sl--compact .rc-sl__search,
  .rc-sl--compact .rc-sl__draghint { display: none; }
  .rc-sl--compact .rc-sl__compact-provider {
    position: relative; width: 28px; height: 28px; display: grid; place-items: center;
    border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface);
  }
  .rc-sl--compact .rc-sl__compact-provider .rc-provider-icon { width: 20px; height: 20px; border-radius: 2px; }
  .rc-sl--compact .rc-sl__compact-provider .rc-provider-icon img { width: 13px; height: 13px; }
  .rc-sl__compact-status {
    position: absolute; right: -3px; bottom: -3px; width: 9px; height: 9px;
    border: 2px solid var(--bg); border-radius: 999px; background: var(--text-faint);
  }
  .rc-sl__compact-status--need { background: var(--awaiting); }
  .rc-sl__compact-status--work { background: var(--text-muted); }
  .rc-sl__compact-status--idle { background: var(--bg); box-shadow: inset 0 0 0 1px var(--text-faint); }
  .rc-sl__compact-status--dead { opacity: .6; }
  .rc-sl--compact .rc-sl__row--active .rc-sl__compact-provider { border-color: var(--text-muted); background: var(--surface-2); }
  .rc-sl--compact .rc-sl__footer--compact { justify-content: center; padding: 5px; }
  .rc-sl--compact .rc-sl__footer--compact .rc-sl__foot-btn { width: 34px; height: 34px; }
}
/* Fine pointers keep the rail compact. On touch hardware every actionable surface owns a real 44px box;
   this is layout, not an overlapping pseudo-target, so adjacent actions cannot steal one another's taps. */
@media (pointer: coarse) {
  .rc-sl__new-row,
  .rc-sl__usage-summary,
  .rc-sl__section-action,
  .rc-sl__row {
    min-height: var(--tap-min);
  }
  .rc-sl__foot-btn,
  .rc-sl__usage-detail-close,
  .rc-sl__more,
  .rc-sl__act,
  .rc-sl__close,
  .rc-sl__draghint-x,
  .rc-sl__search-clear,
  .rc-sl__edit-btn {
    width: var(--tap-min); height: var(--tap-min);
  }
  .rc-sl__usage-provider {
    grid-template-rows: repeat(2, minmax(var(--tap-min), auto));
  }
  .rc-sl__usage-metric,
  .rc-sl__search-input,
  .rc-sl__edit-input,
  .rc-sl__update,
  .rc-sl__check {
    min-height: var(--tap-min);
  }
  .rc-sl__update,
  .rc-sl__check {
    display: inline-flex; align-items: center; justify-content: center;
  }
}
@media (max-width: 767px) and (pointer: coarse) {
  .rc-sl__runtime-details {
    flex-basis: calc(100% - 32px);
    margin: 0 16px 10px;
  }
}
`;
