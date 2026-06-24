import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { CodeBlock } from "./CodeBlock";

/**
 * SECURITY: react-markdown does NOT render raw HTML embedded in the source by default (no
 * `rehype-raw` plugin is configured), so a `<script>` / `<img onerror>` payload in untrusted
 * model output is rendered as inert text, never as live DOM. Code blocks receive code as a text
 * prop, not HTML. Do not add `rehype-raw`/`dangerouslySetInnerHTML` without a sanitizer.
 *
 * `remark-gfm` enables GitHub-Flavored Markdown — tables, strikethrough, task lists, autolinks —
 * which plain CommonMark (react-markdown's default) does NOT support, so model output containing a
 * table previously rendered as raw pipe text instead of a table.
 */
const components: Components = {
  code({ className, children, ...props }) {
    const text = String(children).replace(/\n$/, "");
    const match = /language-(\w+)/.exec(className ?? "");
    // Fenced block (has a language class or contains a newline) → CodeBlock; else inline mono.
    if (match || text.includes("\n")) {
      return <CodeBlock code={text} language={match?.[1]} />;
    }
    return (
      <code
        {...props}
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: "0.92em",
          background: "var(--code-bg)",
          border: "1px solid var(--code-border)",
          color: "var(--code-text)",
          padding: "1px 5px",
          borderRadius: 5,
        }}
      >
        {children}
      </code>
    );
  },
  // `maxWidth: 100%` + `overflowX: auto` keep a wide table inside the message column and scroll it
  // INSIDE this box, instead of pushing the whole conversation off to the right. The Nebula table is
  // a glassy rounded surface: a hairline border + soft elevation, with a quiet surface-2 header band.
  table: ({ children }) => (
    <div
      style={{
        maxWidth: "100%",
        overflowX: "auto",
        margin: "var(--sp-2) 0",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius-sm)",
        background: "var(--surface)",
        boxShadow: "var(--shadow-1)",
      }}
    >
      <table style={{ borderCollapse: "collapse", fontSize: "var(--fs-sm)", width: "100%" }}>{children}</table>
    </div>
  ),
  th: ({ children, style }) => (
    <th
      style={{
        ...style,
        borderBottom: "1px solid var(--border)",
        padding: "var(--sp-2) var(--sp-3)",
        background: "var(--surface-2)",
        textAlign: (style?.textAlign as "left" | "right" | "center" | undefined) ?? "left",
        fontFamily: "var(--font-display)",
        fontSize: "var(--fs-xs)",
        letterSpacing: "0.04em",
        textTransform: "uppercase",
        color: "var(--text-muted)",
        fontWeight: 600,
        overflowWrap: "anywhere",
      }}
    >
      {children}
    </th>
  ),
  td: ({ children, style }) => (
    <td
      style={{
        ...style,
        borderBottom: "1px solid var(--border)",
        padding: "var(--sp-2) var(--sp-3)",
        textAlign: (style?.textAlign as "left" | "right" | "center" | undefined) ?? "left",
        overflowWrap: "anywhere",
      }}
    >
      {children}
    </td>
  ),
  // Links pick up the violet accent with a soft underline edge.
  a: ({ children, href }) => (
    <a
      href={href}
      style={{ color: "var(--accent)", textDecoration: "none", borderBottom: "1px solid var(--accent-line)" }}
    >
      {children}
    </a>
  ),
};

export interface MarkdownProps {
  children: string;
}

export function Markdown({ children }: MarkdownProps) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
      {children}
    </ReactMarkdown>
  );
}
