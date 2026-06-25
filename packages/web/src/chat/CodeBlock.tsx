/**
 * Warm frosted-terminal code block (spec .term). A blurred deep-warm panel with a header bar carrying
 * three warm traffic-light dots + an optional language/filename label, and the code body in mono.
 *
 * Shiki highlighting is intentionally deferred to keep render synchronous and test-friendly; a plain
 * <pre> in the mono face is the always-available baseline. (A later enhancement can swap in shiki's
 * async highlight using the warm --code-keyword/--code-string/--code-comment/--code-function tokens
 * without changing this component's props.)
 *
 * SECURITY: `code` is rendered as a text child of <code>, never via dangerouslySetInnerHTML, so
 * untrusted model output cannot inject HTML. A future shiki pass must likewise receive `code` as
 * text and only set the (sanitized, shiki-produced) highlight HTML it generates itself.
 */
export interface CodeBlockProps {
  code: string;
  language?: string;
}

// The three warm traffic-light dots in the terminal header (spec .term .h s) — warm clay / amber / sage.
const DOT_COLORS = ["#d97757", "#d9a657", "#8a9a6b"];

export function CodeBlock({ code, language }: CodeBlockProps) {
  return (
    <div
      data-language={language}
      style={{
        borderRadius: "var(--radius-sm)",
        overflow: "hidden",
        margin: "4px 0 10px",
        // The warm frosted terminal: a deep warm-ink panel, blurred, with a hairline ring + a soft drop.
        background: "var(--code-bg)",
        backdropFilter: "blur(20px)",
        WebkitBackdropFilter: "blur(20px)",
        boxShadow: "inset 0 0 0 1px var(--code-border), 0 14px 32px -22px #000",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "8px 11px",
          background: "rgba(247, 241, 230, 0.035)",
          borderBottom: "1px solid var(--code-border)",
        }}
      >
        {DOT_COLORS.map((c) => (
          <span
            key={c}
            aria-hidden
            style={{ width: 9, height: 9, borderRadius: "50%", display: "inline-block", opacity: 0.85, background: c }}
          />
        ))}
        {language && (
          <span style={{ marginLeft: 6, color: "var(--text-faint)", fontFamily: "var(--font-mono)", fontSize: "10.5px" }}>
            {language}
          </span>
        )}
      </div>
      <pre
        style={{
          padding: "11px 13px",
          overflowX: "auto",
          fontFamily: "var(--font-mono)",
          fontSize: "var(--fs-sm)",
          lineHeight: 1.65,
          color: "var(--code-text)",
          margin: 0,
        }}
      >
        <code style={{ fontFamily: "var(--font-mono)", color: "inherit" }}>{code}</code>
      </pre>
    </div>
  );
}
