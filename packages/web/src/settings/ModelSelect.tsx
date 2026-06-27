import { useState } from "react";
import type { ModelInfo } from "../types/server";

/** Sentinel for the "Custom…" option (an unlikely real model value). */
const CUSTOM = "__custom__";

export interface ModelSelectProps {
  /** Stored model string; "" means "CLI default". */
  value: string;
  onChange: (value: string) => void;
  /** Account models from GET /models. Empty → pure free-text fallback (today's behavior). */
  models: ModelInfo[];
  id?: string;
  ariaLabel?: string;
  className?: string;
}

/**
 * Model picker: a dropdown of the account's models + a "Custom…" free-text escape hatch. Stored "" maps
 * to the `default` option (a synthetic one is prepended if the list lacks it), preserving the existing
 * wire semantics (createSession sends model:undefined for ""). An unknown stored value (e.g. a resumed
 * session's full id) shows as Custom… with the value preserved. Empty `models` → just the text input.
 */
export function ModelSelect({ value, onChange, models, id, ariaLabel, className }: ModelSelectProps) {
  // User explicitly chose Custom… (lets an empty value still mean "typing my own"). Otherwise custom is
  // derived from props, so it reacts when `models` loads async and the value becomes known/unknown.
  const [forcedCustom, setForcedCustom] = useState(false);

  const customLabel = ariaLabel ? `${ariaLabel} custom` : "custom model";

  if (models.length === 0) {
    // Fallback: the old free-text field, verbatim.
    return (
      <input
        id={id}
        aria-label={ariaLabel}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="default"
        className={className}
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
      />
    );
  }

  const options = models.some((m) => m.value === "default")
    ? models
    : [{ value: "default", displayName: "default" } as ModelInfo, ...models];
  const known = options.some((m) => m.value === value);
  const custom = forcedCustom || (value !== "" && !known);
  const selectionKey = custom ? CUSTOM : value === "" ? "default" : value;

  return (
    <>
      <select
        id={id}
        aria-label={ariaLabel}
        value={selectionKey}
        className={className}
        onChange={(e) => {
          const key = e.target.value;
          if (key === CUSTOM) {
            setForcedCustom(true);
            return;
          }
          setForcedCustom(false);
          onChange(key === "default" ? "" : key);
        }}
      >
        {options.map((m) => (
          <option key={m.value} value={m.value}>
            {m.displayName}
          </option>
        ))}
        <option value={CUSTOM}>Custom…</option>
      </select>
      {custom && (
        <input
          aria-label={customLabel}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="e.g. claude-opus-4-8"
          className={className}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
        />
      )}
    </>
  );
}
