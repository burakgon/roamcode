/**
 * Mono code block. Shiki highlighting is intentionally deferred to keep render synchronous and
 * test-friendly; a plain <pre> in JetBrains Mono is the always-available baseline. (A later
 * enhancement can swap in shiki's async highlight without changing this component's props.)
 *
 * SECURITY: `code` is rendered as a text child of <code>, never via dangerouslySetInnerHTML, so
 * untrusted model output cannot inject HTML. A future shiki pass must likewise receive `code` as
 * text and only set the (sanitized, shiki-produced) highlight HTML it generates itself.
 */
export interface CodeBlockProps {
  code: string;
  language?: string;
}

export function CodeBlock({ code, language }: CodeBlockProps) {
  return (
    <pre
      data-language={language}
      style={{
        background: "var(--code-bg)",
        border: "1px solid var(--code-border)",
        borderRadius: "var(--radius-sm)",
        padding: "var(--sp-3)",
        overflowX: "auto",
        fontFamily: "var(--font-mono)",
        fontSize: "var(--fs-sm)",
        color: "var(--code-text)",
        boxShadow: "var(--shadow-1)",
        margin: 0,
      }}
    >
      <code style={{ fontFamily: "var(--font-mono)", color: "inherit" }}>{code}</code>
    </pre>
  );
}
