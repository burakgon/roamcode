import { useEffect, useState } from "react";
import { AdditionalDirectories } from "./ClaudeSessionOptions";
import type { CodexModel } from "./types";

const ALL_REASONING = ["minimal", "low", "medium", "high", "xhigh"] as const;
const ALLOWED_REASONING = new Set<string>(ALL_REASONING);

function recognizedReasoning(model: CodexModel): string[] {
  return model.supportedReasoningEfforts.filter((effort) => ALLOWED_REASONING.has(effort));
}

function normalizedReasoning(model: CodexModel, current: string): string {
  if (current === "") return "";
  const recognized = recognizedReasoning(model);
  if (recognized.includes(current)) return current;
  if (recognized.includes(model.defaultReasoningEffort)) return model.defaultReasoningEffort;
  return recognized[0] ?? "";
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
  metadataAvailable: boolean;
}

export function CodexSessionOptions({
  value,
  onChange,
  models,
  profiles,
  metadataAvailable,
}: CodexSessionOptionsProps) {
  const [dangerArm, setDangerArm] = useState(false);
  const [reasoningNotice, setReasoningNotice] = useState<string>();
  const selected = models.find((model) => model.value === value.model);
  const reasoningValues = selected ? recognizedReasoning(selected) : [...ALL_REASONING];
  const reasoningDegraded = Boolean(selected && reasoningValues.length === 0);

  useEffect(() => {
    if (!selected) return;
    const nextEffort = normalizedReasoning(selected, value.reasoningEffort);
    if (nextEffort === value.reasoningEffort) return;
    setReasoningNotice(nextEffort ? `Reasoning reset to ${nextEffort} for ${selected.displayName}.` : undefined);
    onChange({ ...value, reasoningEffort: nextEffort });
  }, [onChange, selected, value]);

  const changeModel = (modelValue: string) => {
    const known = models.find((model) => model.value === modelValue);
    if (known) {
      const nextEffort = normalizedReasoning(known, value.reasoningEffort);
      setReasoningNotice(
        nextEffort !== value.reasoningEffort && nextEffort
          ? `Reasoning reset to ${nextEffort} for ${known.displayName}.`
          : undefined,
      );
      onChange({ ...value, model: modelValue, reasoningEffort: nextEffort });
      return;
    }
    setReasoningNotice(undefined);
    onChange({ ...value, model: modelValue });
  };

  return (
    <>
      {!metadataAvailable && (
        <div className="rc-wizard__help" role="status">
          Codex metadata is unavailable. Use defaults or a bounded custom model value.
        </div>
      )}
      <label className="rc-wizard__field">
        <span className="rc-wizard__field-label">Model (optional)</span>
        <input
          aria-label="Codex model"
          list="rc-codex-models"
          value={value.model}
          onChange={(event) => changeModel(event.target.value)}
          placeholder="e.g. gpt-5-codex"
          className="rc-wizard__control rc-wizard__control--mono"
          maxLength={128}
          pattern="[A-Za-z0-9][A-Za-z0-9._:/-]*"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
        />
        <datalist id="rc-codex-models">
          {models.map((model) => (
            <option key={model.value} value={model.value}>
              {model.displayName}
            </option>
          ))}
        </datalist>
        <span className="rc-wizard__help">
          Known models constrain reasoning; safe custom model tokens remain available.
        </span>
      </label>
      <label className="rc-wizard__field">
        <span className="rc-wizard__field-label">Reasoning effort</span>
        <select
          aria-label="Reasoning effort"
          className="rc-wizard__control"
          value={value.reasoningEffort}
          onChange={(event) => {
            setReasoningNotice(undefined);
            onChange({ ...value, reasoningEffort: event.target.value });
          }}
        >
          <option value="">Provider default</option>
          {reasoningValues.map((effort) => (
            <option key={effort} value={effort}>
              {effort}
            </option>
          ))}
        </select>
        {reasoningDegraded && (
          <span role="status" className="rc-wizard__help">
            This model advertises no supported reasoning values; the provider default will be used.
          </span>
        )}
        {reasoningNotice && (
          <span role="status" className="rc-wizard__help">
            {reasoningNotice}
          </span>
        )}
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
          <option value="read-only">read-only</option>
          <option value="workspace-write">workspace-write</option>
          <option value="danger-full-access">danger-full-access</option>
        </select>
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
          <option value="untrusted">untrusted</option>
          <option value="on-request">on-request</option>
          <option value="never">never</option>
        </select>
      </label>
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
          <p className="rc-wizard__danger-arm-text">Codex will run without approval or sandbox protection. Enable?</p>
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
    </>
  );
}
