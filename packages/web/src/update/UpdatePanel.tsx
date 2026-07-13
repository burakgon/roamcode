import { useRef, useState } from "react";
import type { CSSProperties } from "react";
import { Icon } from "../ui/Icon";
import { useFocusTrap } from "../ui/useFocusTrap";
import type { ChangelogEntry, UpdateStatus, VersionInfo } from "../types/server";
import type { UpdateUxState } from "../store/store";
import {
  UPDATE_STEPS,
  updateProgressDetail,
  updateProgressLabel,
  updateStepIndex,
  type UpdateConnectionState,
} from "./lifecycle";

export interface UpdatePanelProps {
  info: VersionInfo;
  /** idle = show the changelog + "Update now"; updating = show the live progress overlay; failed =
   * show the error + Retry. */
  state: UpdateUxState;
  /** The server-reported updater status (for the updating overlay's phase + a failure message). */
  status?: UpdateStatus;
  /** Whether status polling is healthy, crossing a planned restart, or taking unusually long. */
  connection?: UpdateConnectionState;
  /** Confirm + apply the update (POST /update). */
  onUpdate: () => void;
  /** Roll back to the previous verified version (POST /update/rollback — App wires api.rollbackUpdate into
   * the same updating/status lifecycle). Rendered as a quiet affordance ONLY while idle; guarded by an
   * inline two-step confirm. Absent → the affordance is hidden. */
  onRollback?: () => void;
  /** Dismiss the panel (Later / Escape / backdrop). */
  onClose: () => void;
  /**
   * OTA DRAIN WARNING (durability): true when ANY session has a turn in flight. The update restarts the
   * server and interrupts that turn, so "Update now" first shows an "A turn is in progress — update
   * anyway?" confirm instead of applying immediately. Absent/false → apply straight away (current flow).
   */
  turnInProgress?: boolean;
}

const GROUP_LABELS: Record<ChangelogEntry["group"], string> = {
  new: "New",
  fixes: "Fixes",
  improvements: "Improvements",
  other: "Other",
};
const GROUP_ORDER: ChangelogEntry["group"][] = ["new", "fixes", "improvements", "other"];

/**
 * The "What's new" / update sheet — a floating-glass bottom sheet (the `.rc-glass--float` material,
 * mirroring RewindSheet) showing the current→new version, the grouped changelog (New / Fixes /
 * Improvements) with relative dates, and the primary "Update now" action with a plain-language confirm
 * blurb. While updating it swaps to a live progress overlay; on failure it shows the error + Retry.
 *
 * Tokens only, no emoji (icons via <Icon>), focus-trapped + Escape-to-close, reduced-motion safe (the
 * entrance rise references a global keyframe neutralized under prefers-reduced-motion).
 */
export function UpdatePanel({
  info,
  state,
  status,
  connection = "connected",
  onUpdate,
  onRollback,
  onClose,
  turnInProgress,
}: UpdatePanelProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(dialogRef as React.RefObject<HTMLElement>, true);
  // ROLLBACK two-step: the quiet "Roll back to previous version" first ARMS an inline confirm (NO
  // window.confirm — iOS standalone PWAs can silently suppress it; same pattern as SettingsPanel's
  // danger toggle), and only the explicit "Yes, roll back" fires onRollback.
  const [confirmingRollback, setConfirmingRollback] = useState(false);
  // OTA DRAIN WARNING: when a turn is in flight, the first "Update now" tap arms a confirm ("update
  // anyway?") instead of applying — so a live turn isn't silently interrupted by the restart. A second
  // tap (now labelled "Update anyway") applies. With no turn in flight this stays false and "Update now"
  // applies immediately (the unchanged flow).
  const [confirmingDrain, setConfirmingDrain] = useState(false);
  const handleUpdate = () => {
    if (turnInProgress && !confirmingDrain) {
      setConfirmingDrain(true);
      return;
    }
    onUpdate();
  };

  const grouped = GROUP_ORDER.map((g) => ({
    group: g,
    label: GROUP_LABELS[g],
    items: info.changelog.filter((c) => c.group === g),
  })).filter((s) => s.items.length > 0);

  const updating = state === "updating";
  const failed = state === "failed";

  // The changelog stays visible in EVERY state — pressing Update no longer hides it; you keep seeing what
  // is being installed while it downloads/verifies/restarts (and what you were updating to if it fails). When a
  // progress/error body is above it, cap it shorter so that body stays in view.
  const changelog =
    grouped.length > 0 ? (
      <div
        style={{
          display: "grid",
          gap: "var(--sp-4)",
          maxHeight: updating || failed ? "32vh" : "46vh",
          overflowY: "auto",
        }}
      >
        {grouped.map((section) => (
          <div key={section.group} style={{ display: "grid", gap: "var(--sp-2)" }}>
            <div style={SECTION_LABEL}>{section.label}</div>
            <ul style={LIST}>
              {section.items.map((c) => (
                <li key={c.id} style={LIST_ITEM}>
                  <span style={{ color: "var(--text)", lineHeight: 1.45 }}>{c.subject}</span>
                  {c.when && (
                    <span
                      style={{
                        flex: "none",
                        fontFamily: "var(--font-mono)",
                        fontSize: "var(--fs-xs)",
                        color: "var(--text-faint)",
                      }}
                    >
                      {c.when}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    ) : (
      <p style={{ margin: 0, color: "var(--text-muted)", fontSize: "var(--fs-sm)" }}>
        {info.updateAction === "migrate"
          ? "Move this service to verified, version-based updates."
          : info.updateAction === "restart"
            ? "The verified version is installed and ready to restart."
            : `${info.releaseCount} ${info.releaseCount === 1 ? "release" : "releases"} available.`}
      </p>
    );

  return (
    <div
      role="presentation"
      onClick={(e) => {
        // Don't let a backdrop tap dismiss mid-update (the work continues server-side regardless, but
        // closing would lose the progress view). Only the idle/failed states are dismissible by backdrop.
        if (e.target === e.currentTarget && !updating) onClose();
      }}
      style={BACKDROP}
    >
      <div
        ref={dialogRef}
        className="rc-glass--float"
        role="dialog"
        aria-modal="true"
        aria-labelledby="update-title"
        onKeyDown={(e) => {
          // Escape always closes — even while updating: the server work continues, the modal just hides
          // (so a hung/never-restarting update can't trap the user). App keeps polling + ends the flow.
          if (e.key === "Escape") {
            e.stopPropagation();
            onClose();
          }
        }}
        style={SHEET}
      >
        <div style={HEADER}>
          <span aria-hidden style={{ display: "inline-flex", color: "var(--coral)" }}>
            <Icon name="download" size={18} />
          </span>
          <span id="update-title" style={TITLE}>
            {failed
              ? "Update failed"
              : updating
                ? "Updating…"
                : info.updateAction === "migrate"
                  ? "Finish update setup"
                  : info.updateAction === "restart"
                    ? "Restart required"
                    : "Update available"}
          </span>
        </div>

        {/* current → new version (mono labels). */}
        <div style={VERSION_ROW}>
          <span style={{ fontFamily: "var(--font-mono)", color: "var(--text-muted)", fontSize: "var(--fs-sm)" }}>
            {info.current}
          </span>
          <span aria-hidden style={{ color: "var(--text-faint)" }}>
            <Icon name="chevron-right" size={14} />
          </span>
          <span style={{ fontFamily: "var(--font-mono)", color: "var(--text)", fontSize: "var(--fs-sm)" }}>
            {info.latest}
          </span>
        </div>

        {/* Progress (updating) or error (failed) sits ABOVE the changelog, which always stays visible. */}
        {updating && <UpdatingBody status={status} connection={connection} target={info.latest} />}
        {failed && <FailedBody status={status} />}

        {(updating || failed) && <div style={SECTION_LABEL}>What&apos;s new in {info.latest}</div>}
        {changelog}

        {/* The confirm blurb is only relevant before you act (idle). */}
        {!updating && !failed && (
          <p style={CONFIRM_BLURB}>
            This verifies and activates the published {info.latest} package, then restarts the server. Running turns are
            interrupted and resume after the restart.
          </p>
        )}

        {/* OTA DRAIN WARNING: a turn is in flight and the user armed the confirm — surface the explicit
            "updating will interrupt it" warning before the second (applying) tap. */}
        {!updating && !failed && turnInProgress && confirmingDrain && (
          <div role="alert" style={DRAIN_WARNING}>
            <span aria-hidden style={{ display: "inline-flex", color: "var(--coral)", flex: "none", marginTop: 2 }}>
              <Icon name="alert" size={16} />
            </span>
            <span style={{ color: "var(--text)", lineHeight: 1.45 }}>
              A turn is in progress — updating will restart the server and interrupt it. Update anyway?
            </span>
          </div>
        )}

        <div style={{ display: "flex", gap: "var(--sp-2)", justifyContent: "flex-end" }}>
          {updating ? (
            // Updating keeps running server-side; "Hide" just dismisses the overlay so a hung update can't
            // trap the user with no closable control. App's status poll finishes the flow + shows the toast.
            <button type="button" onClick={onClose} style={LATER_BTN}>
              Hide
            </button>
          ) : (
            <>
              <button type="button" onClick={onClose} style={LATER_BTN}>
                Later
              </button>
              <button type="button" onClick={handleUpdate} style={UPDATE_BTN}>
                {failed
                  ? "Retry"
                  : confirmingDrain
                    ? "Update anyway"
                    : info.updateAction === "migrate"
                      ? "Migrate now"
                      : info.updateAction === "restart"
                        ? "Restart now"
                        : "Update now"}
              </button>
            </>
          )}
        </div>

        {/* ROLLBACK — a QUIET escape hatch to the previous verified version (for "the update I just took is
            broken"). Idle only: mid-update there's nothing settled to roll back to, and the failed state
            already means the previous version kept running. Two-step inline confirm (no window.confirm —
            iOS standalone suppresses it); the actual failure/progress rides the panel's normal lifecycle. */}
        {!updating && !failed && onRollback && (
          <div style={{ display: "grid", gap: "var(--sp-2)", justifyItems: "start" }}>
            {confirmingRollback ? (
              <>
                <div role="alert" style={DRAIN_WARNING}>
                  <span
                    aria-hidden
                    style={{ display: "inline-flex", color: "var(--coral)", flex: "none", marginTop: 2 }}
                  >
                    <Icon name="alert" size={16} />
                  </span>
                  <span style={{ color: "var(--text)", lineHeight: 1.45 }}>
                    This restarts the server on the previous verified version. Roll back?
                  </span>
                </div>
                <div style={{ display: "flex", gap: "var(--sp-2)" }}>
                  <button type="button" onClick={onRollback} style={LATER_BTN} aria-label="Yes, roll back">
                    Yes, roll back
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmingRollback(false)}
                    style={ROLLBACK_LINK}
                    aria-label="Cancel rollback"
                  >
                    Cancel
                  </button>
                </div>
              </>
            ) : (
              <button type="button" onClick={() => setConfirmingRollback(true)} style={ROLLBACK_LINK}>
                Roll back to previous version
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** The live progress overlay shown while updating. */
function UpdatingBody({
  status,
  connection,
  target,
}: {
  status?: UpdateStatus;
  connection: UpdateConnectionState;
  target: string;
}) {
  const label = updateProgressLabel(status, connection, target);
  const currentStep = connection === "reconnecting" ? UPDATE_STEPS.length - 1 : updateStepIndex(status?.state);
  return (
    <div role="status" aria-live="polite" style={{ display: "grid", gap: "var(--sp-3)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "var(--sp-3)" }}>
        <span aria-hidden className="rc-update-spin" style={SPINNER} />
        <strong style={{ color: "var(--text)", fontWeight: 600 }}>{label}</strong>
      </div>
      <ol aria-label="Update progress" style={PROGRESS_STEPS}>
        {UPDATE_STEPS.map((step, index) => {
          const complete = index < currentStep || status?.state === "done";
          const active = index === currentStep && status?.state !== "done";
          return (
            <li key={step} aria-current={active ? "step" : undefined} style={PROGRESS_STEP}>
              <span
                aria-hidden
                style={{
                  ...PROGRESS_DOT,
                  color: complete ? "var(--on-accent)" : active ? "var(--coral)" : "var(--text-faint)",
                  background: complete ? "var(--coral)" : "transparent",
                  borderColor: complete || active ? "var(--coral)" : "var(--border-strong)",
                }}
              >
                {complete ? <Icon name="check" size={11} /> : index + 1}
              </span>
              <span style={{ color: active || complete ? "var(--text)" : "var(--text-faint)" }}>{step}</span>
            </li>
          );
        })}
      </ol>
      <p style={{ margin: 0, color: "var(--text-muted)", fontSize: "var(--fs-sm)", lineHeight: 1.45 }}>
        {updateProgressDetail(connection)}
      </p>
      {/* The spinner uses a global-ish keyframe defined inline; neutralized under reduced-motion. */}
      <style>{`
        @keyframes rc-update-spin { to { transform: rotate(360deg); } }
        @media (prefers-reduced-motion: reduce) { .rc-update-spin { animation: none !important; } }
      `}</style>
    </div>
  );
}

/** The failure body — the updater's error + last log lines. */
function FailedBody({ status }: { status?: UpdateStatus }) {
  return (
    <div style={{ display: "grid", gap: "var(--sp-3)" }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: "var(--sp-2)" }}>
        <span aria-hidden style={{ display: "inline-flex", color: "var(--err)", flex: "none", marginTop: 2 }}>
          <Icon name="alert" size={16} />
        </span>
        <span style={{ color: "var(--text)", lineHeight: 1.45 }}>
          {status?.error ?? "The update didn't complete. The previous version is still running."}
        </span>
      </div>
      {status?.log && (
        <pre style={LOG_BOX}>
          <code>{status.log}</code>
        </pre>
      )}
    </div>
  );
}

const BACKDROP: CSSProperties = {
  position: "fixed",
  inset: 0,
  zIndex: 55,
  display: "grid",
  placeItems: "end center",
  padding: "var(--sp-4)",
  paddingBottom: "max(var(--sp-4), env(safe-area-inset-bottom))",
  background: "var(--scrim, rgba(0,0,0,0.45))",
};

const SHEET: CSSProperties = {
  width: "min(480px, 100%)",
  // Cap to the viewport (minus the backdrop padding) and scroll, so on a short phone a long changelog
  // doesn't push the header/title above the top of the screen (the sheet is bottom-aligned).
  maxHeight: "calc(100dvh - 2 * var(--sp-4))",
  overflowY: "auto",
  borderRadius: "var(--radius)",
  padding: "var(--sp-4)",
  display: "grid",
  gap: "var(--sp-4)",
  animation: "rc-rise 0.28s ease-out",
};

const HEADER: CSSProperties = { display: "flex", alignItems: "center", gap: "var(--sp-2)" };

const TITLE: CSSProperties = {
  fontFamily: "var(--font-display)",
  fontWeight: 600,
  fontSize: "var(--fs-lg, var(--fs-base))",
  color: "var(--text)",
  letterSpacing: "0.01em",
};

const VERSION_ROW: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--sp-2)",
  flexWrap: "wrap",
};

const SECTION_LABEL: CSSProperties = {
  fontSize: "var(--fs-xs)",
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  color: "var(--text-muted)",
  fontWeight: 600,
};

const LIST: CSSProperties = { listStyle: "none", margin: 0, padding: 0, display: "grid", gap: "var(--sp-2)" };

const LIST_ITEM: CSSProperties = {
  display: "flex",
  gap: "var(--sp-3)",
  alignItems: "baseline",
  justifyContent: "space-between",
  fontSize: "var(--fs-sm)",
};

const CONFIRM_BLURB: CSSProperties = {
  margin: 0,
  color: "var(--text-muted)",
  fontSize: "var(--fs-sm)",
  lineHeight: 1.45,
};

const DRAIN_WARNING: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: "var(--sp-2)",
  padding: "var(--sp-3)",
  borderRadius: "var(--radius-sm)",
  border: "1px solid var(--border-strong)",
  background: "var(--surface-2, transparent)",
  fontSize: "var(--fs-sm)",
};

const LATER_BTN: CSSProperties = {
  minHeight: "var(--tap-min)",
  padding: "0 var(--sp-4)",
  borderRadius: "var(--radius-sm)",
  border: "1px solid var(--border-strong)",
  background: "transparent",
  color: "var(--text)",
  fontWeight: 500,
  cursor: "pointer",
};

const UPDATE_BTN: CSSProperties = {
  // The single coral primary — a FLAT coral fill, dark ink label. No glow.
  minHeight: "var(--tap-min)",
  padding: "0 var(--sp-4)",
  borderRadius: "var(--radius-sm)",
  border: "1px solid transparent",
  background: "var(--accent-grad)",
  color: "var(--on-accent)",
  fontWeight: 600,
  cursor: "pointer",
};

/** The quiet rollback affordance/cancel — a small hairline pill (never coral: that's the update CTA). */
const ROLLBACK_LINK: CSSProperties = {
  minHeight: 32,
  padding: "0 var(--sp-3)",
  borderRadius: "var(--radius-pill, 999px)",
  border: "1px solid var(--border)",
  background: "transparent",
  color: "var(--text-muted)",
  fontSize: "var(--fs-xs)",
  cursor: "pointer",
};

const SPINNER: CSSProperties = {
  width: 18,
  height: 18,
  flex: "none",
  borderRadius: "50%",
  border: "2px solid var(--border-strong)",
  borderTopColor: "var(--coral)",
  animation: "rc-update-spin 0.8s linear infinite",
};

const PROGRESS_STEPS: CSSProperties = {
  listStyle: "none",
  margin: 0,
  padding: 0,
  display: "grid",
  gridTemplateColumns: "repeat(5, minmax(0, 1fr))",
  gap: "var(--sp-1)",
};

const PROGRESS_STEP: CSSProperties = {
  display: "grid",
  justifyItems: "center",
  alignContent: "start",
  gap: "var(--sp-1)",
  minWidth: 0,
  textAlign: "center",
  fontSize: "var(--fs-xs)",
};

const PROGRESS_DOT: CSSProperties = {
  width: 24,
  height: 24,
  display: "grid",
  placeItems: "center",
  borderRadius: "50%",
  border: "1px solid var(--border-strong)",
  fontFamily: "var(--font-mono)",
  fontSize: "10px",
  fontWeight: 600,
};

const LOG_BOX: CSSProperties = {
  margin: 0,
  padding: "var(--sp-3)",
  background: "var(--code-bg)",
  border: "1px solid var(--code-border)",
  borderRadius: "var(--radius-sm)",
  color: "var(--code-text)",
  fontFamily: "var(--font-mono)",
  fontSize: "var(--fs-xs)",
  lineHeight: 1.5,
  maxHeight: "30vh",
  overflow: "auto",
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
};
