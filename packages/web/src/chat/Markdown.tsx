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
        style={{ fontFamily: "var(--font-mono)", background: "var(--surface-2)", padding: "0 4px", borderRadius: 4 }}
      >
        {children}
      </code>
    );
  },
  table: ({ children }) => (
    <div style={{ overflowX: "auto", margin: "var(--sp-2) 0" }}>
      <table style={{ borderCollapse: "collapse", width: "100%", fontSize: "var(--fs-sm)" }}>{children}</table>
    </div>
  ),
  th: ({ children, style }) => (
    <th
      style={{
        ...style,
        border: "1px solid var(--border)",
        padding: "var(--sp-1) var(--sp-2)",
        background: "var(--surface-2)",
        textAlign: (style?.textAlign as "left" | "right" | "center" | undefined) ?? "left",
        fontWeight: 600,
      }}
    >
      {children}
    </th>
  ),
  td: ({ children, style }) => (
    <td
      style={{
        ...style,
        border: "1px solid var(--border)",
        padding: "var(--sp-1) var(--sp-2)",
        textAlign: (style?.textAlign as "left" | "right" | "center" | undefined) ?? "left",
      }}
    >
      {children}
    </td>
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
