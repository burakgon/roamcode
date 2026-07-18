import { useRef } from "react";
import type { ApiClient } from "../api/client";
import type { AgentRuntimeRecord } from "../api/v2/types";
import { ClaudeAuthSection } from "../settings/ClaudeAuthSection";
import { CodexAuthSection } from "../settings/CodexAuthSection";
import { Icon } from "../ui/Icon";
import { useFocusTrap } from "../ui/useFocusTrap";

export function RuntimeAuthDialog({
  api,
  nodeName,
  runtime,
  onClose,
}: {
  api: ApiClient;
  nodeName: string;
  runtime: AgentRuntimeRecord;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref, true);
  return (
    <div
      className="rc-runtime-auth__backdrop"
      role="presentation"
      onClick={(event) => event.target === event.currentTarget && onClose()}
    >
      <div
        ref={ref}
        className="rc-runtime-auth rc-glass--float"
        role="dialog"
        aria-modal="true"
        aria-label={`${runtime.displayName} sign-in on ${nodeName}`}
        onKeyDown={(event) => {
          if (event.key === "Escape") onClose();
        }}
      >
        <header>
          <span aria-hidden="true">
            <Icon name="agent" size={18} />
          </span>
          <span className="rc-runtime-auth__identity">
            <strong>{runtime.displayName}</strong>
            <small>{nodeName}</small>
          </span>
          <button type="button" aria-label="Close" onClick={onClose}>
            <Icon name="x" size={16} />
          </button>
        </header>
        {runtime.provider === "claude" ? <ClaudeAuthSection api={api} /> : <CodexAuthSection api={api} />}
      </div>
      <style>{`
        .rc-runtime-auth__backdrop { position: fixed; inset: 0; z-index: 70; display: grid; place-items: end center; padding: var(--sp-4); padding-bottom: max(var(--sp-4), env(safe-area-inset-bottom)); background: var(--scrim); }
        .rc-runtime-auth { width: min(480px, 100%); max-height: calc(100dvh - 2 * var(--sp-4)); overflow-y: auto; display: grid; gap: var(--sp-4); padding: var(--sp-4); border-radius: var(--radius-lg); }
        .rc-runtime-auth > header { display: flex; align-items: center; gap: var(--sp-2); }
        .rc-runtime-auth > header > span { color: var(--accent); }
        .rc-runtime-auth__identity { min-width: 0; display: grid; gap: 2px; }
        .rc-runtime-auth__identity strong, .rc-runtime-auth__identity small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .rc-runtime-auth__identity strong { font-family: var(--font-display); }
        .rc-runtime-auth__identity small { color: var(--text-faint); font-size: var(--fs-xs); }
        .rc-runtime-auth > header > button { margin-left: auto; width: var(--tap-min); height: var(--tap-min); display: grid; place-items: center; background: transparent; border: 0; border-radius: var(--radius-sm); color: var(--text-muted); cursor: pointer; }
      `}</style>
    </div>
  );
}
