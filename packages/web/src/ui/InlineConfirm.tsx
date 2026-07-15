import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import "./InlineConfirm.css";

export interface InlineConfirmProps {
  message: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  busy?: boolean;
  requireText?: string;
  tone?: "danger" | "caution";
  className?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * A mobile-safe, accessible replacement for browser confirm/prompt dialogs.
 *
 * Native dialogs can be suppressed in installed iOS PWAs and give the product no
 * control over focus, copy, or touch targets. This deliberately keeps destructive
 * confirmation in context and always offers an equally visible escape route.
 */
export function InlineConfirm({
  message,
  confirmLabel,
  cancelLabel = "Cancel",
  busy = false,
  requireText,
  tone = "danger",
  className,
  onConfirm,
  onCancel,
}: InlineConfirmProps) {
  const messageId = useId();
  const inputId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState("");
  const confirmed = requireText === undefined || draft === requireText;

  useEffect(() => {
    (requireText ? inputRef.current : cancelRef.current)?.focus();
  }, [requireText]);

  return (
    <div
      className={`rc-inline-confirm rc-inline-confirm--${tone}${className ? ` ${className}` : ""}`}
      role="group"
      aria-labelledby={messageId}
      aria-live="polite"
      onKeyDown={(event) => {
        if (event.key === "Escape" && !busy) {
          event.stopPropagation();
          onCancel();
        }
      }}
    >
      <p id={messageId}>{message}</p>
      {requireText !== undefined && (
        <label htmlFor={inputId}>
          Type <strong>{requireText}</strong> to continue
        </label>
      )}
      {requireText !== undefined && (
        <input
          ref={inputRef}
          id={inputId}
          value={draft}
          disabled={busy}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => setDraft(event.target.value)}
        />
      )}
      <div className="rc-inline-confirm__actions">
        <button ref={cancelRef} type="button" disabled={busy} onClick={onCancel}>
          {cancelLabel}
        </button>
        <button type="button" className="rc-inline-confirm__confirm" disabled={busy || !confirmed} onClick={onConfirm}>
          {busy ? "Working…" : confirmLabel}
        </button>
      </div>
    </div>
  );
}
