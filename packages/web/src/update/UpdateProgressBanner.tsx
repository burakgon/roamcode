import { Icon } from "../ui/Icon";
import type { UpdateStatus } from "../types/server";
import { updateProgressLabel, type UpdateConnectionState } from "./lifecycle";

export interface UpdateProgressBannerProps {
  status?: UpdateStatus;
  target?: string;
  connection: UpdateConnectionState;
  onOpen: () => void;
}

/** Persistent, compact progress outside the sheet. Hiding the sheet never makes a background update
 * invisible, and a service restart is described as reconnecting instead of a frozen “Starting…”. */
export function UpdateProgressBanner({ status, target, connection, onOpen }: UpdateProgressBannerProps) {
  const label = updateProgressLabel(status, connection, target);
  return (
    <div role="status" aria-live="polite" className="rc-update-progress-banner">
      <span aria-hidden className="rc-update-progress-banner__spinner" />
      <span className="rc-update-progress-banner__message">
        <strong>{target ? `Updating to v${target.replace(/^v/, "")}` : "Updating RoamCode"}</strong>
        <span aria-hidden> · </span>
        <span>{label}</span>
      </span>
      <button type="button" onClick={onOpen} className="rc-update-progress-banner__button">
        View progress
        <Icon name="chevron-right" size={13} />
      </button>
      <style>{`
        .rc-update-progress-banner {
          display: flex; align-items: center; justify-content: center; flex-wrap: wrap;
          gap: var(--sp-2) var(--sp-3);
          padding: calc(var(--sp-2) + env(safe-area-inset-top, 0px)) var(--sp-4) var(--sp-2);
          color: var(--text); background: var(--surface-2); border-bottom: 1px solid var(--accent-line);
          font-size: var(--fs-sm); text-align: center;
        }
        .rc-update-progress-banner__spinner {
          width: 14px; height: 14px; flex: none; border-radius: 50%;
          border: 2px solid var(--border-strong); border-top-color: var(--coral);
          animation: rc-update-banner-spin .8s linear infinite;
        }
        .rc-update-progress-banner__message { min-width: 0; }
        .rc-update-progress-banner__button {
          display: inline-flex; align-items: center; gap: var(--sp-1); min-height: 32px;
          padding: var(--sp-1) var(--sp-3); border: 1px solid var(--border-strong);
          border-radius: var(--radius-pill); background: transparent; color: var(--text);
          font: inherit; font-weight: 600; cursor: pointer;
        }
        @keyframes rc-update-banner-spin { to { transform: rotate(360deg); } }
        @media (prefers-reduced-motion: reduce) {
          .rc-update-progress-banner__spinner { animation: none; }
        }
      `}</style>
    </div>
  );
}
