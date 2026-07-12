import { useState } from "react";

export interface SessionModelChoice {
  value: string;
  displayName: string;
  description?: string;
  isDefault?: boolean;
}

export interface SessionModelPickerProps {
  providerLabel: string;
  value: string;
  models: SessionModelChoice[];
  metadataState: "loading" | "ready" | "unavailable";
  onChange(value: string): void;
  onRetry?(): void;
  customValue: string;
  onCustomValueChange(value: string): void;
  showCustomOption?: boolean;
}

const CUSTOM_VALUE = "__custom__";

function orderedModels(models: SessionModelChoice[]): SessionModelChoice[] {
  return [...models].sort((left, right) => Number(Boolean(right.isDefault)) - Number(Boolean(left.isDefault)));
}

export function SessionModelPicker({
  providerLabel,
  value,
  models,
  metadataState,
  onChange,
  onRetry,
  customValue,
  onCustomValueChange,
  showCustomOption = true,
}: SessionModelPickerProps) {
  const [customSelected, setCustomSelected] = useState(() =>
    Boolean(value && !models.some((model) => model.value === value)),
  );
  const selectedModel = models.find((model) => model.value === value);
  const customActive = customSelected || (!selectedModel && value !== "");
  const selectValue = !showCustomOption
    ? (selectedModel?.value ?? "")
    : customSelected
      ? CUSTOM_VALUE
      : selectedModel
        ? selectedModel.value
        : customActive
          ? CUSTOM_VALUE
          : "";
  const label = `${providerLabel} model`;

  return (
    <div className="rc-wizard__field">
      <label className="rc-wizard__field">
        <span className="rc-wizard__field-label">Model</span>
        <select
          aria-label={label}
          className="rc-wizard__control"
          value={selectValue}
          onChange={(event) => {
            const next = event.target.value;
            if (next === CUSTOM_VALUE) {
              setCustomSelected(true);
              return;
            }
            setCustomSelected(false);
            onChange(next);
          }}
        >
          <option value="">Provider default</option>
          {orderedModels(models).map((model) => (
            <option key={model.value} value={model.value}>
              {model.displayName}
              {model.isDefault ? " (default)" : ""}
            </option>
          ))}
          {showCustomOption && <option value={CUSTOM_VALUE}>Custom model…</option>}
        </select>
      </label>

      {selectedModel?.description && <span className="rc-wizard__help">{selectedModel.description}</span>}

      {metadataState === "loading" && (
        <span role="status" className="rc-wizard__help">
          Loading {providerLabel} models…
        </span>
      )}
      {metadataState === "unavailable" && (
        <div className="rc-wizard__field">
          <span role="status" className="rc-wizard__help">
            {providerLabel} model catalog is unavailable. Provider default remains available.
          </span>
          {onRetry && (
            <button type="button" className="rc-wizard__cancel" onClick={onRetry} aria-label={`Retry ${label}s`}>
              Retry models
            </button>
          )}
        </div>
      )}

      {showCustomOption && customActive && (
        <SessionCustomModelInput providerLabel={providerLabel} value={customValue} onChange={onCustomValueChange} />
      )}
    </div>
  );
}

export function SessionCustomModelInput({
  providerLabel,
  value,
  onChange,
}: {
  providerLabel: string;
  value: string;
  onChange(value: string): void;
}) {
  return (
    <label className="rc-wizard__field">
      <span className="rc-wizard__field-label">Custom model</span>
      <input
        aria-label={`Custom ${providerLabel} model`}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="provider/model"
        className="rc-wizard__control rc-wizard__control--mono"
        maxLength={128}
        pattern="[A-Za-z0-9][A-Za-z0-9._:/-]*"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
      />
      <span className="rc-wizard__help">Use a bounded provider model identifier not listed in the catalog.</span>
    </label>
  );
}
