import { Fragment } from "react";

/**
 * Wrap every case-insensitive occurrence of `query` in `text` with a highlighted <mark> (the in-chat
 * search match marker). Plain text in, React nodes out — used to highlight a matched search term inside an
 * assistant/user message or a tool result without touching the surrounding markup. An empty query (search
 * inactive) renders the text unchanged.
 */
export function Highlight({ text, query }: { text: string; query: string }) {
  const q = query.trim();
  if (!q) return <>{text}</>;
  const lower = text.toLowerCase();
  const needle = q.toLowerCase();
  const parts: Array<{ s: string; hit: boolean }> = [];
  let from = 0;
  for (;;) {
    const idx = lower.indexOf(needle, from);
    if (idx < 0) {
      parts.push({ s: text.slice(from), hit: false });
      break;
    }
    if (idx > from) parts.push({ s: text.slice(from, idx), hit: false });
    parts.push({ s: text.slice(idx, idx + q.length), hit: true });
    from = idx + q.length;
  }
  return (
    <>
      {parts.map((p, i) =>
        p.hit ? (
          <mark
            key={i}
            style={{
              // A warm, legible highlight that reads on the dark surfaces — a coral wash strong enough to
              // spot at a glance (the faint --accent-soft is too subtle for a search hit). Inherits the
              // surrounding text color so the matched text stays readable.
              background: "rgba(247, 124, 68, 0.32)",
              color: "inherit",
              borderRadius: 2,
              padding: "0 1px",
            }}
          >
            {p.s}
          </mark>
        ) : (
          <Fragment key={i}>{p.s}</Fragment>
        ),
      )}
    </>
  );
}
