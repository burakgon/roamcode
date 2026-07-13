import { Icon } from "../ui/Icon";
import type { VersionInfo } from "../types/server";

export interface UpdateBannerProps {
  info: VersionInfo;
  /** Open the "What's new" / update panel. */
  onWhatsNew: () => void;
  /** Confirm + apply the update directly (opens the panel's confirm flow via the parent). */
  onUpdate: () => void;
  /** Dismiss the banner for this session. */
  onDismiss: () => void;
}

/**
 * The OTA "update available" banner — the ONE place (besides the primary "Update now" button) the coral
 * accent leads in the shell. A restrained coral top edge (mirroring ConnectionBanner's amber edge), an
 * icon paired with TEXT (color is never the sole signal, a11y), the version + change count, a "What's
 * new" link that opens the changelog panel, a primary "Update now", and a per-session dismiss. Renders
 * nothing unless an update is actually available.
 *
 * Tokens only, no emoji (icons via <Icon>); the row is a `role="status"` region so a screen reader
 * announces the available update.
 */
export function UpdateBanner({ info, onWhatsNew, onUpdate, onDismiss }: UpdateBannerProps) {
  if (!info.updatable || !info.updateAvailable) return null;
  const count = info.releaseCount;
  const actionLabel =
    info.updateAction === "migrate"
      ? "Version-based updates ready"
      : info.updateAction === "restart"
        ? "Restart required"
        : "Update available";
  return (
    <div role="status" className="rc-update-banner">
      <div className="rc-update-banner__msg">
        <Icon name="download" size={15} style={{ color: "var(--coral)", flex: "none" }} />
        <span>
          {actionLabel} — <span style={{ fontFamily: "var(--font-mono)", color: "var(--text)" }}>{info.latest}</span>
          {count > 0 && (
            <span style={{ color: "var(--text-muted)" }}>
              {" · "}
              {count} {count === 1 ? "release" : "releases"}
            </span>
          )}
        </span>
      </div>
      <div className="rc-update-banner__actions">
        <button type="button" className="rc-update-banner__link" onClick={onWhatsNew}>
          What&apos;s new
        </button>
        <button type="button" className="rc-update-banner__cta" onClick={onUpdate}>
          {info.updateAction === "migrate"
            ? "Migrate now"
            : info.updateAction === "restart"
              ? "Restart now"
              : "Update now"}
        </button>
        <button type="button" className="rc-update-banner__dismiss" onClick={onDismiss} aria-label="Dismiss">
          <Icon name="x" size={14} />
        </button>
      </div>
      <style>{`
        .rc-update-banner {
          display: flex; align-items: center; justify-content: center; flex-wrap: wrap;
          gap: var(--sp-2) var(--sp-4);
          background: var(--surface-2);
          border-bottom: 1px solid var(--accent-line);
          color: var(--text);
          /* The banner is the topmost element, above the inset-padded header — so it must clear the
             device status bar / notch itself, or its content renders UNDER the status bar. The fill
             still extends edge-to-edge behind the status bar; only the content drops below it. */
          padding: calc(var(--sp-2) + env(safe-area-inset-top, 0px)) var(--sp-4) var(--sp-2);
          font-size: var(--fs-sm);
          text-align: center;
        }
        .rc-update-banner__msg { display: inline-flex; align-items: center; gap: var(--sp-2); }
        .rc-update-banner__actions { display: inline-flex; align-items: center; gap: var(--sp-2); }
        .rc-update-banner__link {
          background: transparent; border: none; cursor: pointer;
          color: var(--text-muted); font: inherit;
          text-decoration: underline; text-underline-offset: 2px;
          padding: var(--sp-1) var(--sp-2); border-radius: var(--radius-sm);
        }
        .rc-update-banner__link:hover { color: var(--text); }
        .rc-update-banner__cta {
          /* The single coral primary — a FLAT coral fill, dark ink label. */
          background: var(--accent-grad); color: var(--on-accent);
          border: 1px solid transparent; border-radius: var(--radius-pill);
          font: inherit; font-weight: 600; cursor: pointer;
          padding: var(--sp-1) var(--sp-4); min-height: 32px;
        }
        .rc-update-banner__dismiss {
          display: grid; place-items: center; width: 28px; height: 28px;
          background: transparent; border: none; color: var(--text-muted); cursor: pointer;
          border-radius: var(--radius-sm);
        }
        .rc-update-banner__dismiss:hover { color: var(--text); background: var(--surface); }
      `}</style>
    </div>
  );
}
