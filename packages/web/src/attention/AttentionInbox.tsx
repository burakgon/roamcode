import { useEffect, useRef } from "react";
import type { AttentionItem, AttentionResponse, WorkspaceRecord } from "../types/server";
import { Icon } from "../ui/Icon";
import { useFocusTrap } from "../ui/useFocusTrap";

export type AttentionAction = "acknowledge" | "resolve" | "snooze";

export interface AttentionInboxProps {
  open: boolean;
  response: AttentionResponse;
  workspaces: WorkspaceRecord[];
  now: number;
  busyId?: string;
  error?: string;
  onClose: () => void;
  onOpenSession: (sessionId: string) => void;
  onAction: (item: AttentionItem, action: AttentionAction, until?: number) => void;
}

const KIND_LABEL: Record<AttentionItem["kind"], string> = {
  blocked: "Needs a decision",
  done: "Finished",
  error: "Error",
  file: "Shared a file",
  policy: "Policy check",
};

function relativeAge(timestamp: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1000));
  if (seconds < 45) return "now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/**
 * A durable, cross-session inbox for agent work that needs a human. It deliberately stays separate from
 * notifications: a push may disappear, while these items remain actionable until acknowledged, snoozed,
 * or resolved on the host.
 */
export function AttentionInbox({
  open,
  response,
  workspaces,
  now,
  busyId,
  error,
  onClose,
  onOpenSession,
  onAction,
}: AttentionInboxProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  useFocusTrap(panelRef, open);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  const workspaceLabels = new Map(workspaces.map((workspace) => [workspace.id, workspace.label]));

  return (
    <div className="rc-attention" role="dialog" aria-modal="true" aria-labelledby="rc-attention-title">
      <button type="button" className="rc-attention__scrim" aria-label="Close attention inbox" onClick={onClose} />
      <div className="rc-attention__panel" ref={panelRef}>
        <header className="rc-attention__head">
          <span className="rc-attention__head-mark" aria-hidden="true">
            <Icon name="bell" size={17} />
          </span>
          <span className="rc-attention__heading">
            <strong id="rc-attention-title">Attention</strong>
            <span>{response.unreadCount > 0 ? `${response.unreadCount} new` : "All caught up"}</span>
          </span>
          <button type="button" className="rc-attention__close" aria-label="Close" onClick={onClose}>
            <Icon name="x" size={18} />
          </button>
        </header>

        {error && (
          <div className="rc-attention__error" role="status">
            <Icon name="alert" size={14} />
            {error}
          </div>
        )}

        <div className="rc-attention__body">
          {response.items.length === 0 ? (
            <div className="rc-attention__empty">
              <span className="rc-attention__empty-mark" aria-hidden="true">
                <Icon name="check" size={22} />
              </span>
              <strong>Nothing needs you</strong>
              <span>Blocked agents, completed turns, files, and errors will collect here.</span>
            </div>
          ) : (
            <ol className="rc-attention__list">
              {response.items.map((item) => {
                const busy = item.id === busyId;
                const workspace = workspaceLabels.get(item.workspaceId) ?? "Workspace";
                return (
                  <li
                    key={item.id}
                    className={`rc-attention__item rc-attention__item--${item.kind}${
                      item.state === "acknowledged" ? " rc-attention__item--seen" : ""
                    }`}
                  >
                    <div className="rc-attention__item-top">
                      <span className="rc-attention__kind">
                        <span className="rc-attention__dot" aria-hidden="true" />
                        {KIND_LABEL[item.kind]}
                      </span>
                      <time
                        dateTime={new Date(item.updatedAt).toISOString()}
                        title={new Date(item.updatedAt).toLocaleString()}
                      >
                        {relativeAge(item.updatedAt, now)}
                      </time>
                    </div>
                    <strong className="rc-attention__title">{item.title}</strong>
                    {item.detail && <p className="rc-attention__detail">{item.detail}</p>}
                    <div className="rc-attention__meta">
                      <Icon name="folder" size={12} />
                      <span>{workspace}</span>
                      {item.occurrenceCount > 1 && <span>· {item.occurrenceCount} updates</span>}
                    </div>
                    <div className="rc-attention__actions">
                      <button
                        type="button"
                        className="rc-attention__open"
                        disabled={busy}
                        onClick={() => onOpenSession(item.sessionId)}
                      >
                        Open session
                        <Icon name="arrow-right" size={14} />
                      </button>
                      {item.state === "open" && (
                        <button type="button" disabled={busy} onClick={() => onAction(item, "acknowledge")}>
                          Mark seen
                        </button>
                      )}
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => onAction(item, "snooze", now + 60 * 60 * 1000)}
                      >
                        Snooze 1h
                      </button>
                      <button type="button" disabled={busy} onClick={() => onAction(item, "resolve")}>
                        Dismiss
                      </button>
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
        </div>
      </div>
      <style>{css}</style>
    </div>
  );
}

const css = `
.rc-attention { position: absolute; inset: 0; z-index: 34; }
.rc-attention__scrim { position: absolute; inset: 0; border: 0; background: rgba(0,0,0,.5); cursor: pointer; }
.rc-attention__panel {
  position: absolute; inset: auto 0 0; max-height: min(88%, 760px);
  display: flex; flex-direction: column; overflow: hidden;
  background: var(--surface); border: 1px solid var(--border-strong); border-width: 1px 0 0;
  border-radius: 15px 15px 0 0; box-shadow: 0 -16px 48px rgba(0,0,0,.48);
  animation: rc-attention-in 180ms cubic-bezier(.16,1,.3,1);
}
@keyframes rc-attention-in { from { transform: translateY(18px); opacity: 0; } }
.rc-attention__head { flex: none; display: flex; align-items: center; gap: 10px; padding: 13px 14px; border-bottom: 1px solid var(--border); }
.rc-attention__head-mark { width: 34px; height: 34px; flex: none; display: grid; place-items: center; border: 1px solid var(--awaiting-line); border-radius: 9px; color: var(--awaiting); background: var(--awaiting-soft); }
.rc-attention__heading { min-width: 0; display: grid; gap: 2px; }
.rc-attention__heading strong { color: var(--text); font: 650 15px/1.2 var(--font-display); }
.rc-attention__heading span { color: var(--text-faint); font: 500 10px/1.2 var(--font-mono); }
.rc-attention__close { margin-left: auto; width: 34px; height: 34px; display: grid; place-items: center; border: 0; border-radius: 8px; background: transparent; color: var(--text-muted); cursor: pointer; }
.rc-attention__close:hover, .rc-attention__close:focus-visible { color: var(--text); background: var(--surface-2); }
.rc-attention__error { flex: none; display: flex; align-items: center; gap: 7px; padding: 8px 14px; border-bottom: 1px solid var(--border); color: var(--warn); background: var(--surface-2); font-size: var(--fs-xs); }
.rc-attention__body { flex: 1; min-height: 0; overflow: auto; -webkit-overflow-scrolling: touch; padding: 10px 10px calc(12px + env(safe-area-inset-bottom, 0px)); }
.rc-attention__list { list-style: none; display: grid; gap: 8px; margin: 0; padding: 0; }
.rc-attention__item { position: relative; padding: 12px; border: 1px solid var(--border); border-radius: 11px; background: var(--surface-2); }
.rc-attention__item--seen { opacity: .78; }
.rc-attention__item-top { display: flex; align-items: center; gap: 8px; margin-bottom: 7px; }
.rc-attention__item-top time { margin-left: auto; color: var(--text-faint); font: 500 10px/1 var(--font-mono); }
.rc-attention__kind { display: inline-flex; align-items: center; gap: 6px; color: var(--text-muted); font: 650 10px/1 var(--font-mono); text-transform: uppercase; letter-spacing: .045em; }
.rc-attention__dot { width: 7px; height: 7px; border-radius: 50%; background: var(--text-faint); }
.rc-attention__item--blocked .rc-attention__dot, .rc-attention__item--error .rc-attention__dot { background: var(--awaiting); box-shadow: 0 0 0 4px var(--awaiting-soft); }
.rc-attention__item--done .rc-attention__dot { background: var(--accent-2); }
.rc-attention__item--file .rc-attention__dot, .rc-attention__item--policy .rc-attention__dot { background: var(--warn); }
.rc-attention__title { display: block; color: var(--text); font: 620 14px/1.35 var(--font-display); }
.rc-attention__detail { margin: 5px 0 0; color: var(--text-muted); font-size: var(--fs-xs); line-height: 1.45; }
.rc-attention__meta { display: flex; align-items: center; gap: 5px; min-width: 0; margin-top: 8px; color: var(--text-faint); font: 500 10px/1.2 var(--font-mono); }
.rc-attention__meta span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rc-attention__actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 11px; }
.rc-attention__actions button { min-height: 30px; padding: 0 9px; border: 1px solid var(--border); border-radius: 8px; background: transparent; color: var(--text-muted); font: 550 10px/1 var(--font-mono); cursor: pointer; }
.rc-attention__actions button:hover:not(:disabled), .rc-attention__actions button:focus-visible { color: var(--text); border-color: var(--border-strong); }
.rc-attention__actions button:disabled { opacity: .55; cursor: wait; }
.rc-attention__actions .rc-attention__open { display: inline-flex; align-items: center; gap: 6px; color: var(--on-accent); background: var(--coral); border-color: transparent; }
.rc-attention__empty { min-height: 260px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 7px; padding: 28px; text-align: center; }
.rc-attention__empty-mark { width: 46px; height: 46px; display: grid; place-items: center; margin-bottom: 4px; border: 1px solid var(--border); border-radius: 50%; color: var(--accent-2); background: var(--surface-2); }
.rc-attention__empty strong { color: var(--text); font: 620 15px/1.2 var(--font-display); }
.rc-attention__empty > span:last-child { max-width: 290px; color: var(--text-muted); font-size: var(--fs-xs); line-height: 1.5; }
@media (min-width: 768px) {
  .rc-attention__panel { inset: 0 0 0 auto; width: min(440px, 92vw); max-height: none; border-width: 0 0 0 1px; border-radius: 0; box-shadow: -16px 0 48px rgba(0,0,0,.48); animation: none; }
}
@media (prefers-reduced-motion: reduce) { .rc-attention__panel { animation: none; } }
`;
