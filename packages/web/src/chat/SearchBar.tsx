import { useEffect, useRef } from "react";
import { Icon } from "../ui/Icon";

export interface SearchBarProps {
  /** The live query (controlled). */
  query: string;
  onChange: (q: string) => void;
  /** Total matches across the conversation (incl. collapsed tool output + thinking) — the "N matches" readout. */
  matchCount: number;
  /** Number of turns the query matched (the filtered list size) — drives the "in M messages" hint. */
  resultCount: number;
  /** Close the search (the host clears the query + hides the bar). */
  onClose: () => void;
}

/**
 * IN-CONVERSATION SEARCH bar — a slim strip under the chat header. A ≥16px input (no iOS zoom), a live
 * match count, a clear button, and a close. The list itself filters to matching turns + highlights the
 * term (MessageList), so this bar is the control surface. Keyboard: Escape closes (handled here so it
 * works while the input is focused); the input autofocuses on open.
 */
export function SearchBar({ query, onChange, matchCount, resultCount, onClose }: SearchBarProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  // Focus the field on open so the user can type immediately (one tap from the header magnifier).
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const trimmed = query.trim();
  return (
    <div
      role="search"
      style={{
        display: "flex",
        alignItems: "center",
        gap: "var(--sp-2)",
        padding: "var(--sp-2) var(--sp-3)",
        borderBottom: "1px solid var(--border)",
        background: "var(--bg)",
      }}
    >
      <span aria-hidden="true" style={{ color: "var(--text-faint)", display: "grid", flex: "none" }}>
        <Icon name="search" size={16} />
      </span>
      <input
        ref={inputRef}
        type="search"
        aria-label="Search conversation"
        value={query}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onClose();
          }
        }}
        placeholder="Search this conversation…"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        style={{
          flex: 1,
          minWidth: 0,
          minHeight: "var(--tap-min)",
          background: "transparent",
          border: "none",
          outline: "none",
          color: "var(--text)",
          // ≥16px so iOS Safari doesn't zoom the page when the field focuses.
          fontSize: "16px",
        }}
      />
      {/* Live match count — present whenever there's a query (incl. a no-match "0 matches"). */}
      {trimmed.length > 0 && (
        <span
          aria-live="polite"
          style={{
            flex: "none",
            fontFamily: "var(--font-mono)",
            fontSize: "var(--fs-xs)",
            color: "var(--text-muted)",
            whiteSpace: "nowrap",
          }}
        >
          {matchCount === 0
            ? "No matches"
            : `${matchCount} ${matchCount === 1 ? "match" : "matches"} · ${resultCount} ${
                resultCount === 1 ? "message" : "messages"
              }`}
        </span>
      )}
      {/* Clear the query (keeps the bar open) — only when there's something to clear. */}
      {query.length > 0 && (
        <button
          type="button"
          onClick={() => {
            onChange("");
            inputRef.current?.focus();
          }}
          aria-label="Clear search"
          style={iconBtnStyle}
        >
          <Icon name="x" size={15} />
        </button>
      )}
      {/* Close search entirely. */}
      <button type="button" onClick={onClose} aria-label="Close search" style={iconBtnStyle}>
        Done
      </button>
    </div>
  );
}

const iconBtnStyle: React.CSSProperties = {
  flex: "none",
  minWidth: "var(--tap-min)",
  minHeight: "var(--tap-min)",
  display: "grid",
  placeItems: "center",
  background: "transparent",
  border: "none",
  color: "var(--text-muted)",
  cursor: "pointer",
  font: "inherit",
  fontSize: "var(--fs-sm)",
  padding: "0 var(--sp-2)",
};
