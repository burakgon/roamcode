import { useEffect, useId, useRef, useState } from "react";
import { Icon } from "../ui/Icon";
import { useFocusTrap } from "../ui/useFocusTrap";

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

function isLongContext(model: SessionModelChoice): boolean {
  return /\[1m\]$/i.test(model.value) || /\b1m context\b/i.test(model.displayName);
}

function isAutomatic(model: SessionModelChoice): boolean {
  return model.value.toLowerCase() === "best";
}

function optionDescription(model: SessionModelChoice, providerLabel: string): string | undefined {
  if (model.description) return model.description;
  if (isLongContext(model)) return "Extended 1M-token context window.";
  if (isAutomatic(model)) return `${providerLabel} chooses the best available model.`;
  return undefined;
}

interface ModelOptionProps {
  modelValue: string;
  label: string;
  description?: string;
  badge?: string;
  selected: boolean;
  onSelect(): void;
}

function ModelOption({ modelValue, label, description, badge, selected, onSelect }: ModelOptionProps) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      data-model-value={modelValue}
      className={`rc-model-picker__option${selected ? " rc-model-picker__option--selected" : ""}`}
      onClick={onSelect}
    >
      <span className="rc-model-picker__option-copy">
        <span className="rc-model-picker__option-title">
          {label}
          {badge && <span className="rc-model-picker__badge">{badge}</span>}
        </span>
        {description && <span className="rc-model-picker__option-description">{description}</span>}
      </span>
      <span className="rc-model-picker__check" aria-hidden="true">
        {selected && <Icon name="check" size={16} />}
      </span>
    </button>
  );
}

function ModelGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rc-model-picker__group">
      <h3 className="rc-model-picker__group-title">{title}</h3>
      <div className="rc-model-picker__options">{children}</div>
    </section>
  );
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
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useFocusTrap(panelRef, open);

  const selectedModel = models.find((model) => model.value === value);
  const customActive = customSelected || (!selectedModel && value !== "");
  const selectedValue = !showCustomOption
    ? (selectedModel?.value ?? "")
    : customSelected
      ? CUSTOM_VALUE
      : selectedModel
        ? selectedModel.value
        : customActive
          ? CUSTOM_VALUE
          : "";
  const label = `${providerLabel} model`;
  const automaticModels = orderedModels(models.filter(isAutomatic));
  const regularModels = orderedModels(models.filter((model) => !isAutomatic(model) && !isLongContext(model)));
  const longContextModels = orderedModels(models.filter(isLongContext));
  const triggerTitle = customActive
    ? customValue || "Custom model"
    : selectedModel?.displayName || `${providerLabel} default`;
  const triggerDescription = customActive
    ? "Custom model identifier"
    : selectedModel
      ? optionDescription(selectedModel, providerLabel)
      : `Uses the model from your ${providerLabel} settings.`;

  useEffect(() => {
    if (!open) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    }
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [open]);

  function select(next: string) {
    if (next === CUSTOM_VALUE) {
      setCustomSelected(true);
      setOpen(false);
      return;
    }
    setCustomSelected(false);
    onChange(next);
    setOpen(false);
  }

  function renderModel(model: SessionModelChoice) {
    return (
      <ModelOption
        key={model.value}
        modelValue={model.value}
        label={model.displayName.replace(/\s*·\s*1M context$/i, "")}
        description={optionDescription(model, providerLabel)}
        badge={isLongContext(model) ? "1M" : model.isDefault ? "Recommended" : undefined}
        selected={selectedValue === model.value}
        onSelect={() => select(model.value)}
      />
    );
  }

  return (
    <div className="rc-wizard__field rc-model-picker">
      <span className="rc-wizard__field-label">Model</span>
      <button
        type="button"
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        data-model-value={value}
        className="rc-wizard__control rc-model-picker__trigger"
        onClick={() => setOpen(true)}
      >
        <span className="rc-model-picker__trigger-copy">
          <span className="rc-model-picker__trigger-title">{triggerTitle}</span>
          <span className="rc-model-picker__trigger-description">{triggerDescription}</span>
        </span>
        <Icon name="chevron-down" size={17} />
      </button>

      {metadataState === "loading" && (
        <span role="status" className="rc-wizard__help">
          Loading {providerLabel} models…
        </span>
      )}
      {metadataState === "unavailable" && (
        <div className="rc-wizard__field">
          <span role="status" className="rc-wizard__help">
            {providerLabel} model catalog is unavailable. {providerLabel} default remains available.
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

      {open && (
        <div className="rc-model-picker__dialog" onClick={(event) => event.stopPropagation()}>
          <button
            type="button"
            className="rc-model-picker__scrim"
            aria-label={`Close ${label} picker`}
            onClick={() => setOpen(false)}
          />
          <div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            className="rc-model-picker__panel"
          >
            <header className="rc-model-picker__head">
              <div>
                <strong id={titleId}>Choose a model</strong>
                <span>{providerLabel}</span>
              </div>
              <button
                type="button"
                className="rc-model-picker__close"
                aria-label={`Close ${label} picker`}
                onClick={() => setOpen(false)}
              >
                <Icon name="x" size={18} />
              </button>
            </header>
            <div className="rc-model-picker__body">
              <ModelGroup title="Automatic">
                <ModelOption
                  modelValue=""
                  label={`Use ${providerLabel} default`}
                  description={`Keeps the model from your ${providerLabel} settings.`}
                  badge="Default"
                  selected={selectedValue === ""}
                  onSelect={() => select("")}
                />
                {automaticModels.map(renderModel)}
              </ModelGroup>
              {regularModels.length > 0 && <ModelGroup title="Models">{regularModels.map(renderModel)}</ModelGroup>}
              {longContextModels.length > 0 && (
                <ModelGroup title="Extended context">{longContextModels.map(renderModel)}</ModelGroup>
              )}
              {showCustomOption && (
                <ModelGroup title="Other">
                  <ModelOption
                    modelValue={CUSTOM_VALUE}
                    label="Custom model"
                    description="Enter a provider model identifier manually."
                    selected={selectedValue === CUSTOM_VALUE}
                    onSelect={() => select(CUSTOM_VALUE)}
                  />
                </ModelGroup>
              )}
            </div>
          </div>
        </div>
      )}

      <style>{modelPickerCss}</style>
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
        pattern={String.raw`[A-Za-z0-9][A-Za-z0-9._:/\[\]-]*`}
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
      />
      <span className="rc-wizard__help">Use a bounded provider model identifier not listed in the catalog.</span>
    </label>
  );
}

const modelPickerCss = `
.rc-model-picker__trigger {
  width: 100%; min-height: 58px; display: flex; align-items: center; justify-content: space-between;
  gap: var(--sp-3); text-align: left; cursor: pointer;
}
.rc-model-picker__trigger-copy { min-width: 0; display: grid; gap: 3px; }
.rc-model-picker__trigger-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text); }
.rc-model-picker__trigger-description { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-faint); font-size: var(--fs-xs); }
.rc-model-picker__trigger > svg { flex: none; color: var(--text-muted); }
.rc-model-picker__dialog { position: fixed; inset: 0; z-index: 80; display: grid; align-items: end; }
.rc-model-picker__scrim { position: absolute; inset: 0; border: 0; background: rgba(0,0,0,0.62); cursor: pointer; }
.rc-model-picker__panel {
  position: relative; width: 100%; max-height: min(76dvh, 680px); min-height: 0;
  display: flex; flex-direction: column; overflow: hidden;
  background: var(--glass-strong); border: 1px solid var(--border-strong); border-bottom: 0;
  border-radius: var(--radius-lg) var(--radius-lg) 0 0; box-shadow: 0 -18px 60px rgba(0,0,0,0.55);
  backdrop-filter: var(--glass-blur); -webkit-backdrop-filter: var(--glass-blur);
  animation: rc-model-picker-in 180ms cubic-bezier(0.16,1,0.3,1);
}
@keyframes rc-model-picker-in { from { transform: translateY(18px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
.rc-model-picker__head {
  flex: none; display: flex; align-items: center; justify-content: space-between; gap: var(--sp-3);
  padding: var(--sp-4) var(--sp-4) var(--sp-3); border-bottom: 1px solid var(--border);
}
.rc-model-picker__head > div { min-width: 0; display: grid; gap: 4px; }
.rc-model-picker__head strong { color: var(--text); font: 600 var(--fs-md)/1.2 var(--font-body); }
.rc-model-picker__head span { color: var(--text-faint); font-size: var(--fs-xs); }
.rc-model-picker__close {
  width: var(--tap-min); height: var(--tap-min); flex: none; display: grid; place-items: center;
  border: 0; border-radius: var(--radius-sm); background: transparent; color: var(--text-muted); cursor: pointer;
}
.rc-model-picker__close:hover { background: var(--surface-2); color: var(--text); }
.rc-model-picker__body {
  flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior-y: contain; -webkit-overflow-scrolling: touch;
  padding: var(--sp-3) var(--sp-3) calc(var(--sp-4) + env(safe-area-inset-bottom, 0px));
}
.rc-model-picker__group + .rc-model-picker__group { margin-top: var(--sp-3); }
.rc-model-picker__group-title {
  margin: 0; padding: 0 var(--sp-2) var(--sp-2); color: var(--text-faint);
  font: 600 var(--fs-xs)/1.2 var(--font-body); text-transform: uppercase; letter-spacing: 0.06em;
}
.rc-model-picker__options { display: grid; gap: 2px; padding: 3px; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-sm); }
.rc-model-picker__option {
  width: 100%; min-height: 54px; display: flex; align-items: center; gap: var(--sp-3);
  padding: 9px var(--sp-3); border: 0; border-radius: calc(var(--radius-sm) - 3px);
  background: transparent; color: var(--text); text-align: left; font: inherit; cursor: pointer;
}
.rc-model-picker__option:hover { background: var(--surface-2); }
.rc-model-picker__option--selected { background: var(--accent-soft); }
.rc-model-picker__option-copy { min-width: 0; flex: 1; display: grid; gap: 3px; }
.rc-model-picker__option-title { display: flex; align-items: center; gap: var(--sp-2); color: var(--text); font-size: var(--fs-sm); font-weight: 550; }
.rc-model-picker__option-description { color: var(--text-faint); font-size: var(--fs-xs); line-height: 1.35; }
.rc-model-picker__badge {
  flex: none; padding: 3px 6px; border: 1px solid var(--border-strong); border-radius: 999px;
  color: var(--text-muted); background: var(--surface-2); font-size: 10px; font-weight: 600; line-height: 1;
}
.rc-model-picker__check { width: 24px; height: 24px; flex: none; display: grid; place-items: center; color: var(--coral); }
@media (min-width: 640px) {
  .rc-model-picker__dialog { place-items: center; padding: var(--sp-5); }
  .rc-model-picker__panel { width: min(430px, 92vw); max-height: min(76dvh, 680px); border-bottom: 1px solid var(--border-strong); border-radius: var(--radius-lg); box-shadow: var(--glass-shadow); }
}
@media (prefers-reduced-motion: reduce) { .rc-model-picker__panel { animation: none; } }
`;
