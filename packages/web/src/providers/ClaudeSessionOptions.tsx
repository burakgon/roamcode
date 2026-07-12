import { useEffect, useRef, useState } from "react";
import { Icon } from "../ui/Icon";
import { Mono } from "../ui/Mono";
import { EFFORTS, PERMISSION_MODES } from "../settings/defaults";
import type { ModelInfo } from "../types/server";
import { SessionCustomModelInput, SessionModelPicker } from "./SessionModelPicker";
import { claudePermissionCopy, copyForEffort } from "./setting-copy";

export interface ClaudeOptionDraft {
  effort: string;
  model: string;
  permissionMode: string;
  addDirs: string[];
  dangerouslySkip: boolean;
}

export interface ClaudeSessionOptionsProps {
  value: ClaudeOptionDraft;
  onChange: (value: ClaudeOptionDraft) => void;
  models: ModelInfo[];
  metadataState?: "loading" | "ready" | "unavailable";
  onRetryMetadata?: () => void;
}

export interface AdditionalDirectoriesProps {
  value: string[];
  onChange: (value: string[]) => void;
}

export function AdditionalDirectories({ value, onChange }: AdditionalDirectoriesProps) {
  const [draft, setDraft] = useState("");
  const add = () => {
    const path = draft.trim();
    if (!path || value.includes(path)) return;
    onChange([...value, path]);
    setDraft("");
  };
  return (
    <div className="rc-wizard__field">
      <span className="rc-wizard__field-label">Additional directories (optional)</span>
      {value.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--sp-2)", marginBottom: "var(--sp-2)" }}>
          {value.map((path) => (
            <span
              key={path}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "var(--sp-1)",
                background: "var(--surface-2)",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius-sm)",
                padding: "2px var(--sp-2)",
                fontFamily: "var(--font-mono)",
                fontSize: "var(--fs-xs)",
              }}
            >
              <Mono muted>{path}</Mono>
              <button
                type="button"
                aria-label={`Remove ${path}`}
                onClick={() => onChange(value.filter((candidate) => candidate !== path))}
                style={{ background: "transparent", border: "none", cursor: "pointer", color: "var(--text-faint)" }}
              >
                <Icon name="x" size={12} />
              </button>
            </span>
          ))}
        </div>
      )}
      <div style={{ display: "flex", gap: "var(--sp-2)" }}>
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              add();
            }
          }}
          placeholder="/absolute/path"
          aria-label="additional directory path"
          className="rc-wizard__control rc-wizard__control--mono"
          style={{ flex: 1, minWidth: 0 }}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
        />
        <button
          type="button"
          className="rc-wizard__cancel"
          onClick={add}
          disabled={draft.trim().length === 0}
          aria-label="Add directory"
        >
          Add
        </button>
      </div>
    </div>
  );
}

function defaultModel(models: ModelInfo[]): ModelInfo | undefined {
  return models.find((model) => model.isDefault) ?? models[0];
}

function effortValues(model: ModelInfo | undefined, custom: boolean): string[] {
  if (model) return model.supportedEffortLevels ?? [...EFFORTS];
  return custom ? [...EFFORTS] : [];
}

function normalizedEffort(model: ModelInfo | undefined, custom: boolean, current: string): string {
  if (current === "") return "";
  const values = effortValues(model, custom);
  if (values.includes(current)) return current;
  if (custom) return "";
  if (values.includes("medium")) return "medium";
  return values[0] ?? "";
}

export function ClaudeSessionOptions({
  value,
  onChange,
  models,
  metadataState = models.length > 0 ? "ready" : "unavailable",
  onRetryMetadata,
}: ClaudeSessionOptionsProps) {
  const [dangerArm, setDangerArm] = useState(false);
  const [effortNotice, setEffortNotice] = useState<string>();
  const selectedModelRef = useRef<ModelInfo | undefined>(undefined);
  const currentSelected = models.find((model) => model.value === value.model);
  if (currentSelected) selectedModelRef.current = currentSelected;
  const selected =
    currentSelected ?? (selectedModelRef.current?.value === value.model ? selectedModelRef.current : undefined);
  const pickerModels =
    selected && !models.some((model) => model.value === selected.value) ? [selected, ...models] : models;
  const effectiveModel = value.model === "" ? defaultModel(models) : selected;
  const customModel = value.model !== "" && !selected;
  const [customEditor, setCustomEditor] = useState(customModel);
  const normalizedInitialCatalog = useRef(false);
  const efforts = effortValues(effectiveModel, customModel);
  const effortNeedsReview = value.effort !== "" && !efforts.includes(value.effort);
  const effort = copyForEffort(value.effort);
  const permission = claudePermissionCopy[value.permissionMode] ?? {
    label: value.permissionMode,
    help: "Provider permission mode.",
  };

  useEffect(() => {
    if (metadataState === "loading" || normalizedInitialCatalog.current) return;
    normalizedInitialCatalog.current = true;
    const next = normalizedEffort(effectiveModel, customModel, value.effort);
    if (next === value.effort) return;
    setEffortNotice(
      effectiveModel && next
        ? `Effort reset to ${next} for ${effectiveModel.displayName}.`
        : "Using provider-default effort.",
    );
    onChange({ ...value, effort: next });
  }, [customModel, effectiveModel, metadataState, onChange, value]);

  const changeModel = (model: string) => {
    const known = model === "" ? defaultModel(models) : models.find((candidate) => candidate.value === model);
    const custom = model !== "" && !known;
    const nextEffort = normalizedEffort(known, custom, value.effort);
    setEffortNotice(
      nextEffort !== value.effort && known && nextEffort
        ? `Effort reset to ${nextEffort} for ${known.displayName}.`
        : undefined,
    );
    setCustomEditor(custom);
    onChange({ ...value, model, effort: nextEffort });
  };

  return (
    <>
      <SessionModelPicker
        providerLabel="Claude"
        value={value.model}
        models={pickerModels}
        metadataState={metadataState}
        onChange={changeModel}
        onRetry={onRetryMetadata}
        customValue={customModel ? value.model : ""}
        onCustomValueChange={changeModel}
        showCustomOption={false}
      />
      <label className="rc-wizard__field">
        <span className="rc-wizard__field-label">Effort</span>
        <select
          aria-label="Effort"
          value={value.effort}
          onChange={(event) => {
            setEffortNotice(undefined);
            onChange({ ...value, effort: event.target.value });
          }}
          className="rc-wizard__control"
        >
          <option value="">Provider default</option>
          {effortNeedsReview && <option value={value.effort}>{effort.label} (review required)</option>}
          {efforts.map((option) => (
            <option key={option} value={option}>
              {copyForEffort(option).label}
            </option>
          ))}
        </select>
        <span className="rc-wizard__help">
          {value.effort === "" ? "Let Claude choose the reasoning level." : effort.help}
        </span>
        {effortNeedsReview ? (
          <span role="status" className="rc-wizard__help">
            {value.effort} is no longer advertised for {effectiveModel?.displayName ?? "this model"}. Review required;
            the draft remains unchanged until you choose another effort.
          </span>
        ) : effortNotice ? (
          <span role="status" className="rc-wizard__help">
            {effortNotice}
          </span>
        ) : null}
      </label>
      <label className="rc-wizard__field">
        <span className="rc-wizard__field-label">Permission mode</span>
        <select
          value={value.permissionMode}
          onChange={(event) => onChange({ ...value, permissionMode: event.target.value })}
          className="rc-wizard__control"
          aria-label="Permission mode"
          disabled={value.dangerouslySkip}
        >
          {PERMISSION_MODES.map((mode) => (
            <option key={mode} value={mode}>
              {claudePermissionCopy[mode]?.label ?? mode}
            </option>
          ))}
        </select>
        <span className="rc-wizard__help">{permission.help}</span>
      </label>
      <details
        className="rc-wizard__advanced"
        open={value.dangerouslySkip || customModel || undefined}
        onToggle={(event) => {
          if (value.dangerouslySkip && !event.currentTarget.open) event.currentTarget.open = true;
        }}
      >
        <summary>Advanced</summary>
        <div className="rc-wizard__advanced-body">
          <label className="rc-wizard__danger">
            <input
              type="checkbox"
              checked={customEditor}
              onChange={(event) => {
                setCustomEditor(event.target.checked);
                if (!event.target.checked && customModel) changeModel("");
              }}
            />
            <span>Use a custom Claude model</span>
          </label>
          {customEditor && (
            <SessionCustomModelInput
              providerLabel="Claude"
              value={customModel ? value.model : ""}
              onChange={changeModel}
            />
          )}
          <AdditionalDirectories value={value.addDirs} onChange={(addDirs) => onChange({ ...value, addDirs })} />
          <label className={`rc-wizard__danger${value.dangerouslySkip ? " rc-wizard__danger--on" : ""}`}>
            <input
              type="checkbox"
              checked={value.dangerouslySkip}
              onChange={(event) => {
                if (event.target.checked) setDangerArm(true);
                else {
                  setDangerArm(false);
                  onChange({ ...value, dangerouslySkip: false });
                }
              }}
            />
            <span>Dangerously skip permissions (RCE risk)</span>
          </label>
          {dangerArm && !value.dangerouslySkip && (
            <div className="rc-wizard__danger-arm" role="alert">
              <p className="rc-wizard__danger-arm-text">
                This session will run tools <strong>without asking</strong> — remote code execution risk. Enable?
              </p>
              <div className="rc-wizard__danger-arm-row">
                <button
                  type="button"
                  className="rc-wizard__danger-arm-yes"
                  onClick={() => {
                    setDangerArm(false);
                    onChange({ ...value, dangerouslySkip: true });
                  }}
                  aria-label="Yes, enable dangerously skip permissions"
                >
                  Yes, enable
                </button>
                <button
                  type="button"
                  className="rc-wizard__danger-arm-no"
                  onClick={() => setDangerArm(false)}
                  aria-label="Cancel enabling dangerously skip permissions"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      </details>
    </>
  );
}
