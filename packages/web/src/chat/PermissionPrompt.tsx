import { useEffect, useRef } from "react";
import { IrisCard } from "./IrisCard";
import type { PermissionPayload } from "../types/server";

export interface PermissionPromptProps {
  permission: PermissionPayload;
  onAnswer: (decision: "allow" | "deny") => void;
  /**
   * Optional client-side "Always allow" rule. When provided, an extra ghost button appears that
   * answers `allow` for the current request AND registers an auto-allow rule for this tool, scoped
   * to the session (the caller decides where to remember it). Omit the handler to hide the button —
   * we never ship a dead control.
   */
  onAlwaysAllow?: (toolName: string) => void;
}

/** Pull a short human-readable detail from the tool input for display (path/command/question). */
function summarizeInput(input: unknown): string | undefined {
  if (input && typeof input === "object") {
    const obj = input as Record<string, unknown>;
    for (const key of ["file_path", "command", "path", "url", "question"]) {
      if (typeof obj[key] === "string") return obj[key] as string;
    }
  }
  return undefined;
}

/**
 * Heuristic flag for a visibly destructive shell command so the mono panel is tinted with --err (the
 * mockup's `rm -rf` treatment). Presentation only — it never changes what the prompt does (the user
 * still decides), it just makes a dangerous command read as dangerous at a glance.
 */
function isDangerousCommand(detail: string | undefined): boolean {
  if (!detail) return false;
  return /\brm\s+-[a-z]*[rf]|\bsudo\b|\bmkfs\b|\bdd\s+if=|:\(\)\s*\{|>\s*\/dev\/sd|\bchmod\s+-R\s+777|\bgit\s+(reset\s+--hard|clean\s+-[a-z]*f)|\bcurl\b.*\|\s*(sh|bash)|\bnpm\s+publish|--force\b|-rf\b/i.test(
    detail,
  );
}

export function PermissionPrompt({ permission, onAnswer, onAlwaysAllow }: PermissionPromptProps) {
  const detail = summarizeInput(permission.toolInput);
  const toolName = permission.toolName ?? "tool";
  const dangerous = isDangerousCommand(detail);

  // a11y: when the prompt appears, move focus to it so a keyboard / screen-reader user lands on the
  // request immediately (Claude is waiting on the remote machine). The IrisCard region is the focus
  // target; the iris color is paired with the "Awaiting you" TEXT so color is never the sole signal.
  const regionRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    regionRef.current?.focus();
  }, [permission.requestId]);

  return (
    <IrisCard title="Awaiting you — permission" ariaLabel="Permission request" regionRef={regionRef}>
      <div style={{ fontSize: "var(--fs-base)" }}>
        Claude wants to run{" "}
        <strong style={{ color: "var(--text)", fontFamily: "var(--font-display)" }}>{toolName}</strong>
      </div>
      {detail && (
        <div
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "var(--fs-sm)",
            color: dangerous ? "var(--err)" : "var(--text)",
            background: dangerous ? "var(--err-bg)" : "var(--surface-2)",
            border: `1px solid ${dangerous ? "var(--err-border)" : "var(--border)"}`,
            borderRadius: "var(--radius-sm)",
            padding: "var(--sp-2) var(--sp-3)",
            wordBreak: "break-all",
          }}
        >
          {detail}
        </div>
      )}
      <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--sp-2)" }}>
        <button
          type="button"
          onClick={() => onAnswer("allow")}
          aria-label="Allow"
          style={{
            // The ONE coral primary in the awaiting card — a clay-coral gradient with the glow halo +
            // inset top highlight (spec .btn.allow), dark ink label. The card's loud accent affordance.
            flex: 1,
            minHeight: "var(--tap-min)",
            padding: "0 var(--sp-4)",
            borderRadius: 11,
            border: "1px solid transparent",
            background: "var(--accent-grad)",
            color: "var(--on-iris)",
            boxShadow: "var(--shadow-pop)",
            fontFamily: "var(--font-display)",
            fontWeight: 600,
            fontSize: "var(--fs-sm)",
            cursor: "pointer",
          }}
        >
          Allow
        </button>
        <button
          type="button"
          onClick={() => onAnswer("deny")}
          aria-label="Deny"
          style={{
            // Deny is NEUTRAL warm glass (spec .btn.deny) — a quiet surface + muted label + hairline.
            // It must not read as the destructive-red action; the danger flag lives on the command
            // panel above, not the Deny button.
            flex: 1,
            minHeight: "var(--tap-min)",
            padding: "0 var(--sp-4)",
            borderRadius: 11,
            border: "1px solid var(--border)",
            background: "var(--surface)",
            color: "var(--text-muted)",
            fontFamily: "var(--font-display)",
            fontWeight: 600,
            fontSize: "var(--fs-sm)",
            cursor: "pointer",
          }}
        >
          Deny
        </button>
        {onAlwaysAllow && permission.toolName && (
          <button
            type="button"
            onClick={() => {
              onAnswer("allow");
              onAlwaysAllow(permission.toolName!);
            }}
            aria-label={`Always allow ${permission.toolName}`}
            style={{
              flex: 1.35,
              minHeight: "var(--tap-min)",
              padding: "0 var(--sp-3)",
              borderRadius: 11,
              border: "1px solid var(--border)",
              background: "var(--surface-2)",
              color: "var(--text)",
              fontFamily: "var(--font-display)",
              fontWeight: 600,
              fontSize: "var(--fs-xs)",
              cursor: "pointer",
            }}
          >
            Always allow {permission.toolName}
          </button>
        )}
      </div>
    </IrisCard>
  );
}
