import { useState } from "react";
import { Icon } from "../ui/Icon";
import { Mono } from "../ui/Mono";
import { ModelSelect } from "../settings/ModelSelect";
import { EFFORTS, PERMISSION_MODES } from "../settings/defaults";
import type { ModelInfo } from "../types/server";

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

export function ClaudeSessionOptions({ value, onChange, models }: ClaudeSessionOptionsProps) {
  const [dangerArm, setDangerArm] = useState(false);
  return (
    <>
      <label className="rc-wizard__field">
        <span className="rc-wizard__field-label">Effort</span>
        <select
          aria-label="Effort"
          value={value.effort}
          onChange={(event) => onChange({ ...value, effort: event.target.value })}
          className="rc-wizard__control"
        >
          {EFFORTS.map((effort) => (
            <option key={effort} value={effort}>
              {effort}
            </option>
          ))}
        </select>
        <span className="rc-wizard__help">
          How much the model thinks per turn — low is fastest, max is deepest (and slowest).
        </span>
      </label>
      <label className="rc-wizard__field">
        <span className="rc-wizard__field-label">Model (optional)</span>
        <ModelSelect
          value={value.model}
          onChange={(model) => onChange({ ...value, model })}
          models={models}
          ariaLabel="Claude model"
          className="rc-wizard__control rc-wizard__control--mono"
        />
        <span className="rc-wizard__help">Leave blank to use your Claude plan&apos;s default model.</span>
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
              {mode}
            </option>
          ))}
        </select>
        <span className="rc-wizard__help">
          default: asks before running tools · acceptEdits: auto-accepts file edits · plan: read-only, plans first.
        </span>
      </label>
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
    </>
  );
}
