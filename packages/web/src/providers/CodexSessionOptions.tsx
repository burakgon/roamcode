import { useEffect, useRef, useState } from "react";
import { AdditionalDirectories } from "./ClaudeSessionOptions";
import { SessionCustomModelInput, SessionModelPicker } from "./SessionModelPicker";
import { codexApprovalCopy, codexSandboxCopy, copyForEffort } from "./setting-copy";
import type { CodexModel } from "./types";

const BASELINE_REASONING = ["minimal", "low", "medium", "high", "xhigh"];

function defaultModel(models: CodexModel[]): CodexModel | undefined {
  return models.find((model) => model.isDefault) ?? models[0];
}

function optionsFor(model: CodexModel | undefined) {
  if (model) {
    if (model.reasoningOptions?.length) return model.reasoningOptions;
    return model.supportedReasoningEfforts.map((value) => ({
      value,
      description: "",
      isDefault: value === model.defaultReasoningEffort,
    }));
  }
  return BASELINE_REASONING.map((value) => ({ value, description: "", isDefault: value === "medium" }));
}

function normalizedReasoning(model: CodexModel | undefined, custom: boolean, current: string): string {
  if (current === "") return "";
  const options = optionsFor(model);
  if (options.some((option) => option.value === current)) return current;
  if (custom) return "";
  return options.find((option) => option.isDefault)?.value ?? options[0]?.value ?? "";
}

export interface CodexOptionDraft {
  model: string;
  reasoningEffort: string;
  sandbox: string;
  approvalPolicy: string;
  profile: string;
  webSearch: boolean;
  addDirs: string[];
  dangerouslyBypassApprovalsAndSandbox: boolean;
}

export interface CodexSessionOptionsProps {
  value: CodexOptionDraft;
  onChange: (value: CodexOptionDraft) => void;
  models: CodexModel[];
  profiles: string[];
  metadataState?: "loading" | "ready" | "unavailable";
  onRetryMetadata?: () => void;
  /** Backward-compatible bridge for callers predating provider-specific metadata state. */
  metadataAvailable?: boolean;
  /** Session creation uses this explicit user intent to distinguish a custom model from an unverifiable catalog value. */
  onCustomModelIntentChange?: (custom: boolean) => void;
  /** Controlled custom-model intent for session launch; omitted by defaults editing callers. */
  customModelIntent?: boolean;
}

export function CodexSessionOptions({
  value,
  onChange,
  models,
  profiles,
  metadataState,
  onRetryMetadata,
  metadataAvailable,
  onCustomModelIntentChange,
  customModelIntent,
}: CodexSessionOptionsProps) {
  const resolvedMetadataState = metadataState ?? (metadataAvailable === false ? "unavailable" : "ready");
  const [dangerArm, setDangerArm] = useState(false);
  const [reasoningNotice, setReasoningNotice] = useState<string>();
  const selectedModelRef = useRef<CodexModel | undefined>(undefined);
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
  const reasoningOptions = optionsFor(effectiveModel);
  const launchIntentTracked = onCustomModelIntentChange !== undefined;
  const explicitReasoningAvailable =
    !launchIntentTracked || resolvedMetadataState === "ready" || (customModelIntent === true && customModel);
  const visibleReasoningEffort = explicitReasoningAvailable ? value.reasoningEffort : "";
  const visibleReasoningOptions = explicitReasoningAvailable ? reasoningOptions : [];
  const reasoningNeedsReview =
    visibleReasoningEffort !== "" && !visibleReasoningOptions.some((option) => option.value === visibleReasoningEffort);
  const selectedReasoning = visibleReasoningOptions.find((option) => option.value === visibleReasoningEffort);
  const reasoningCopy = copyForEffort(visibleReasoningEffort, selectedReasoning?.description);
  const sandbox = codexSandboxCopy[value.sandbox] ?? { label: value.sandbox, help: "Provider sandbox mode." };
  const approval = codexApprovalCopy[value.approvalPolicy] ?? {
    label: value.approvalPolicy,
    help: "Provider approval policy.",
  };

  useEffect(() => {
    if (resolvedMetadataState !== "ready" || normalizedInitialCatalog.current) return;
    normalizedInitialCatalog.current = true;
    const next = normalizedReasoning(effectiveModel, customModel, value.reasoningEffort);
    if (next === value.reasoningEffort) return;
    setReasoningNotice(
      effectiveModel && next
        ? `Reasoning reset to ${next} for ${effectiveModel.displayName}.`
        : "Using provider-default reasoning.",
    );
    onChange({ ...value, reasoningEffort: next });
  }, [customModel, effectiveModel, onChange, resolvedMetadataState, value]);

  const changeModel = (model: string) => {
    const known = model === "" ? defaultModel(models) : models.find((candidate) => candidate.value === model);
    const custom = model !== "" && !known;
    const nextEffort = normalizedReasoning(known, custom, value.reasoningEffort);
    setReasoningNotice(
      nextEffort !== value.reasoningEffort && known && nextEffort
        ? `Reasoning reset to ${nextEffort} for ${known.displayName}.`
        : undefined,
    );
    setCustomEditor(custom);
    onChange({ ...value, model, reasoningEffort: nextEffort });
  };

  return (
    <>
      <SessionModelPicker
        providerLabel="Codex"
        value={value.model}
        models={pickerModels}
        metadataState={resolvedMetadataState}
        onChange={changeModel}
        onRetry={onRetryMetadata}
        customValue={customModel ? value.model : ""}
        onCustomValueChange={changeModel}
        showCustomOption={false}
      />
      <label className="rc-wizard__field">
        <span className="rc-wizard__field-label">Reasoning effort</span>
        <select
          aria-label="Reasoning effort"
          className="rc-wizard__control"
          value={visibleReasoningEffort}
          disabled={!explicitReasoningAvailable}
          onChange={(event) => {
            setReasoningNotice(undefined);
            if (customModel) onCustomModelIntentChange?.(true);
            onChange({ ...value, reasoningEffort: event.target.value });
          }}
        >
          <option value="">Provider default</option>
          {reasoningNeedsReview && (
            <option value={visibleReasoningEffort}>{reasoningCopy.label} (review required)</option>
          )}
          {visibleReasoningOptions.map((option) => (
            <option key={option.value} value={option.value}>
              {copyForEffort(option.value, option.description).label}
              {option.isDefault ? " (default)" : ""}
            </option>
          ))}
        </select>
        <span className="rc-wizard__help">
          {visibleReasoningEffort === "" ? "Let Codex choose the reasoning level." : reasoningCopy.help}
        </span>
        {reasoningNeedsReview ? (
          <span role="status" className="rc-wizard__help">
            {value.reasoningEffort} is no longer advertised for {effectiveModel?.displayName ?? "this model"}. Review
            required; the draft remains unchanged until you choose another reasoning effort.
          </span>
        ) : reasoningNotice ? (
          <span role="status" className="rc-wizard__help">
            {reasoningNotice}
          </span>
        ) : null}
      </label>
      <label className="rc-wizard__field">
        <span className="rc-wizard__field-label">Sandbox</span>
        <select
          aria-label="Sandbox"
          className="rc-wizard__control"
          value={value.sandbox}
          disabled={value.dangerouslyBypassApprovalsAndSandbox}
          onChange={(event) => onChange({ ...value, sandbox: event.target.value })}
        >
          {Object.entries(codexSandboxCopy).map(([option, copy]) => (
            <option key={option} value={option}>
              {copy.label}
            </option>
          ))}
        </select>
        <span className="rc-wizard__help">{sandbox.help}</span>
      </label>
      <label className="rc-wizard__field">
        <span className="rc-wizard__field-label">Approval policy</span>
        <select
          aria-label="Approval policy"
          className="rc-wizard__control"
          value={value.approvalPolicy}
          disabled={value.dangerouslyBypassApprovalsAndSandbox}
          onChange={(event) => onChange({ ...value, approvalPolicy: event.target.value })}
        >
          {Object.entries(codexApprovalCopy).map(([option, copy]) => (
            <option key={option} value={option}>
              {copy.label}
            </option>
          ))}
        </select>
        <span className="rc-wizard__help">{approval.help}</span>
      </label>
      <details
        className="rc-wizard__advanced"
        open={value.dangerouslyBypassApprovalsAndSandbox || customModel || undefined}
        onToggle={(event) => {
          if (value.dangerouslyBypassApprovalsAndSandbox && !event.currentTarget.open) {
            event.currentTarget.open = true;
          }
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
                onCustomModelIntentChange?.(event.target.checked);
                if (!event.target.checked && customModel) changeModel("");
              }}
            />
            <span>Use a custom Codex model</span>
          </label>
          {customEditor && (
            <SessionCustomModelInput
              providerLabel="Codex"
              value={customModel ? value.model : ""}
              onChange={(model) => {
                onCustomModelIntentChange?.(true);
                changeModel(model);
              }}
            />
          )}
          <label className="rc-wizard__field">
            <span className="rc-wizard__field-label">Profile (optional)</span>
            <select
              aria-label="Profile"
              className="rc-wizard__control"
              value={value.profile}
              disabled={profiles.length === 0}
              onChange={(event) => onChange({ ...value, profile: event.target.value })}
            >
              <option value="">Default profile</option>
              {profiles.map((profile) => (
                <option key={profile} value={profile}>
                  {profile}
                </option>
              ))}
            </select>
            <span className="rc-wizard__help">Only secure profile names validated by the server are shown.</span>
          </label>
          <label className="rc-wizard__danger">
            <input
              type="checkbox"
              checked={value.webSearch}
              onChange={(event) => onChange({ ...value, webSearch: event.target.checked })}
            />
            <span>Enable web search</span>
          </label>
          <AdditionalDirectories value={value.addDirs} onChange={(addDirs) => onChange({ ...value, addDirs })} />
          <label
            className={`rc-wizard__danger${value.dangerouslyBypassApprovalsAndSandbox ? " rc-wizard__danger--on" : ""}`}
          >
            <input
              type="checkbox"
              checked={value.dangerouslyBypassApprovalsAndSandbox}
              onChange={(event) => {
                if (event.target.checked) setDangerArm(true);
                else {
                  setDangerArm(false);
                  onChange({ ...value, dangerouslyBypassApprovalsAndSandbox: false });
                }
              }}
            />
            <span>Bypass approvals and sandbox (RCE risk)</span>
          </label>
          {dangerArm && !value.dangerouslyBypassApprovalsAndSandbox && (
            <div className="rc-wizard__danger-arm" role="alert">
              <p className="rc-wizard__danger-arm-text">
                Codex will run without approval or sandbox protection. Enable?
              </p>
              <div className="rc-wizard__danger-arm-row">
                <button
                  type="button"
                  className="rc-wizard__danger-arm-yes"
                  onClick={() => {
                    setDangerArm(false);
                    onChange({ ...value, dangerouslyBypassApprovalsAndSandbox: true });
                  }}
                  aria-label="Yes, enable bypass"
                >
                  Yes, enable
                </button>
                <button
                  type="button"
                  className="rc-wizard__danger-arm-no"
                  onClick={() => setDangerArm(false)}
                  aria-label="Cancel enabling bypass"
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
