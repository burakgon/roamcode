import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { Icon } from "./Icon";

/**
 * A quiet, reusable "copy to clipboard" affordance — the same mechanism CodeBlock uses (write to the
 * clipboard, flip to a "copied" state, auto-revert; the reset timer is cleared on unmount so it never
 * setState on a gone component). Used across the chat to copy an assistant message, a tool result, or a
 * file path. Unobtrusive by default; the tap target is the 44px touch minimum so it's reachable one-handed.
 *
 * Clipboard writes can throw (an insecure context / denied permission) — caught and treated as a no-op,
 * exactly like CodeBlock, so a copy that can't happen never errors the chat.
 */
export interface CopyButtonProps {
  /** The text written to the clipboard on tap. */
  text: string;
  /** Accessible name for the IDLE state (e.g. "Copy message", "Copy output", "Copy path"). The copied
   *  state announces "Copied". */
  label: string;
  /** Glyph size in px. Default 14 (a quiet, in-line affordance). */
  size?: number;
  /** Extra styles merged onto the button (e.g. to pin it into a row). */
  style?: CSSProperties;
}

export function CopyButton({ text, label, size = 14, style }: CopyButtonProps) {
  const [copied, setCopied] = useState(false);
  // Clear the "copied" reset timer on unmount (don't setState on an unmounted component) — mirrors CodeBlock.
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1400);
    } catch {
      // clipboard unavailable (insecure context / denied) — silently no-op, like CodeBlock.
    }
  }

  return (
    <button
      type="button"
      onClick={copy}
      aria-label={copied ? "Copied" : label}
      title={copied ? "Copied" : label}
      className="rc-copy-btn"
      style={{
        // ≥44px tap target wrapping a compact glyph; transparent + quiet by default, brightens on hover.
        width: "var(--tap-min)",
        height: "var(--tap-min)",
        flex: "none",
        display: "grid",
        placeItems: "center",
        background: "transparent",
        border: 0,
        borderRadius: "var(--radius-sm)",
        color: copied ? "var(--ok)" : "var(--text-faint)",
        cursor: "pointer",
        padding: 0,
        ...style,
      }}
    >
      <Icon name={copied ? "check" : "copy"} size={size} />
      <style>{`.rc-copy-btn:hover:not([aria-label="Copied"]) { color: var(--text-muted); background: var(--surface-2); }`}</style>
    </button>
  );
}
