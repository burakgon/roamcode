import { useEffect, useRef, useState } from "react";
import type { MouseEvent } from "react";
import { Mono } from "../ui/Mono";
import { Icon } from "../ui/Icon";
import { useFocusTrap } from "../ui/useFocusTrap";
import { DirectoryPicker } from "../picker/DirectoryPicker";
import { pushRecentDir } from "../picker/recents";
import type { SessionDefaults } from "../settings/defaults";
import { ApiError, type ApiClient, type CreateSessionResponse } from "../api/client";
import { ProviderPicker } from "../providers/ProviderPicker";
import type { ProviderAuthStates } from "../providers/ProviderPicker";
import { ClaudeSessionOptions } from "../providers/ClaudeSessionOptions";
import type { ClaudeOptionDraft } from "../providers/ClaudeSessionOptions";
import { CodexSessionOptions } from "../providers/CodexSessionOptions";
import type { CodexOptionDraft } from "../providers/CodexSessionOptions";
import type {
  ClaudeSessionOptions as ClaudeOptions,
  CodexModel,
  CodexSessionOptions as CodexOptions,
  ProviderId,
  ProviderSummaries,
} from "../providers/types";
import type { ModelInfo, SessionDefaultsEnvelope, SessionMeta } from "../types/server";

// Client-only session names live in localStorage under this key as a Record<sessionId, label> — the SAME
// store the rail's rename uses (see SessionList.tsx loadSessionNames/saveSessionName). Writing the new
// session's id → label here means the rail shows the chosen name immediately instead of the cwd basename.
const SESSION_NAMES_KEY = "rc-session-names";
const CLAUDE_BASELINE_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);
const CODEX_BASELINE_REASONING = new Set(["minimal", "low", "medium", "high", "xhigh"]);

function launchEffort(
  value: string,
  metadataState: "loading" | "ready" | "unavailable",
  model: string,
  customModelIntent: boolean,
  baseline: ReadonlySet<string>,
): string | undefined {
  if (!value) return undefined;
  if (metadataState === "ready") return value;
  return model && customModelIntent && baseline.has(value) ? value : undefined;
}
function saveSessionName(id: string, name: string): void {
  const trimmed = name.trim();
  if (!trimmed) return;
  try {
    const raw = window.localStorage?.getItem(SESSION_NAMES_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : {};
    const all = parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
    all[id] = trimmed;
    window.localStorage?.setItem(SESSION_NAMES_KEY, JSON.stringify(all));
  } catch {
    /* storage blocked (private mode) — the name just won't persist; the rail falls back to the basename */
  }
}

/** The trailing path segment (folder name) — mirrors SessionList's basename so the Name placeholder hints
 * the label the rail would fall back to. */
function basename(p: string): string {
  const parts = p.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || p;
}

export interface NewSessionWizardProps {
  /** mkdir/searchDirs are optional so minimal hosts (tests) can pass only the two the wizard itself
   * needs; when present they light up the picker's "New folder" + "Deeper matches" features. */
  api: Pick<ApiClient, "listDir" | "createSession"> & Partial<Pick<ApiClient, "mkdir" | "searchDirs">>;
  /** Server-owned choices from the last successful launch, captured once so an open draft never changes. */
  defaults: SessionDefaults;
  recents: string[];
  /** Wall clock (ms) — passed in so the wizard stays free of Date.now() (the app owns the tick).
   * Defaults to Date.now() at mount when omitted. */
  now?: number;
  /** Account models from GET /models. Empty → free-text fallback (today's behavior). */
  models?: ModelInfo[];
  providerSummaries: ProviderSummaries;
  codexModels?: CodexModel[];
  codexProfiles?: string[];
  providerAvailabilityState?: "loading" | "ready" | "error";
  claudeMetadataState?: "loading" | "ready" | "unavailable";
  codexMetadataState?: "loading" | "ready" | "unavailable";
  providerAuthStates?: ProviderAuthStates;
  onRetryProviderAvailability?: () => void;
  /** Prefilled directory (e.g. "New session in this folder" from Settings). When set, the wizard skips
   * the directory picker and opens straight on the confirm step (the folder is still changeable). */
  initialCwd?: string;
  onCreated: (session: SessionMeta, remembered?: SessionDefaultsEnvelope) => void;
  onClose: () => void;
}

function claudeDraft(defaults: SessionDefaults): ClaudeOptionDraft {
  return {
    effort: defaults.effort,
    model: defaults.model ?? "",
    permissionMode: defaults.permissionMode ?? "default",
    addDirs: defaults.addDirs ? [...defaults.addDirs] : [],
    dangerouslySkip: defaults.dangerouslySkip,
  };
}

function codexDraft(defaults: SessionDefaults): CodexOptionDraft {
  const options = defaults.codex;
  return {
    model: options?.model ?? "",
    reasoningEffort: options?.reasoningEffort ?? "medium",
    sandbox: options?.sandbox ?? "workspace-write",
    approvalPolicy: options?.approvalPolicy ?? "on-request",
    profile: options?.profile ?? "",
    webSearch: options?.webSearch ?? false,
    addDirs: options?.addDirs ? [...options.addDirs] : [],
    dangerouslyBypassApprovalsAndSandbox: options?.dangerouslyBypassApprovalsAndSandbox ?? false,
  };
}

/**
 * Start a new TERMINAL session: pick a directory, then review the provider-native choices remembered from the
 * last successful launch. Callers may prefill the directory (skipping the picker step); choices remain editable.
 */
export function NewSessionWizard({
  api,
  defaults,
  recents,
  now,
  models = [],
  providerSummaries,
  codexModels = [],
  codexProfiles = [],
  providerAvailabilityState = "ready",
  claudeMetadataState = models.length > 0 ? "ready" : "unavailable",
  codexMetadataState = codexModels.length > 0 ? "ready" : "unavailable",
  providerAuthStates,
  onRetryProviderAvailability,
  initialCwd,
  onCreated,
  onClose,
}: NewSessionWizardProps) {
  const seeded = useRef(defaults).current;
  // When a caller prefills a cwd, open straight on the confirm step (the "Change" button still returns
  // to the picker). Otherwise start at the picker (cwd undefined).
  const [cwd, setCwd] = useState<string | undefined>(initialCwd);
  const [provider, setProvider] = useState<ProviderId>(() => defaults.provider ?? "claude");
  const [claudeOptions, setClaudeOptions] = useState<ClaudeOptionDraft>(() => claudeDraft(seeded));
  const [codexOptions, setCodexOptions] = useState<CodexOptionDraft>(() => codexDraft(seeded));
  const [claudeCustomModelIntent, setClaudeCustomModelIntent] = useState(false);
  const [codexCustomModelIntent, setCodexCustomModelIntent] = useState(false);
  // Optional human label for the new session, written to the rail's rc-session-names store on create so the
  // list shows it immediately instead of the cwd basename. Blank → the rail keeps the basename fallback.
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [createdWarning, setCreatedWarning] = useState<CreateSessionResponse>();
  const dialogRef = useRef<HTMLDivElement>(null);
  const nowMs = now ?? Date.now();

  // Real modal semantics for the settings step: focus its first control on entry, trap Tab
  // within it, and restore focus on close. Inert while the picker (step 1) owns the viewport —
  // the picker runs its own trap. (Hooks must run unconditionally, so `active` gates it.)
  const onSettingsStep = Boolean(cwd);
  useFocusTrap(dialogRef, onSettingsStep);

  useEffect(() => {
    if (!onSettingsStep) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [onSettingsStep]);

  // The settings step closes on Escape (the picker handles its own Escape in step 1).
  useEffect(() => {
    if (!onSettingsStep || busy || createdWarning) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, createdWarning, onSettingsStep, onClose]);

  // A backdrop click dismisses — but only when the click lands on the scrim itself, never when
  // it bubbles up from the inner content.
  function onBackdrop(e: MouseEvent<HTMLDivElement>) {
    if (!busy && !createdWarning && e.target === e.currentTarget) onClose();
  }

  // Step 1 — the directory picker (the headline). It owns the whole viewport.
  if (!cwd) {
    return (
      <DirectoryPicker
        listDir={api.listDir}
        mkdir={api.mkdir}
        searchDirs={api.searchDirs}
        recents={recents}
        onPick={(path) => setCwd(path)}
        onCancel={onClose}
      />
    );
  }

  function chooseProvider(next: ProviderId) {
    if (busy || createdWarning) return;
    // A switch starts a fresh provider-native draft. Values are never translated between providers.
    setProvider(next);
    setClaudeOptions(claudeDraft(seeded));
    setCodexOptions(codexDraft(seeded));
    setClaudeCustomModelIntent(false);
    setCodexCustomModelIntent(false);
    setError(undefined);
  }

  function finishCreated(response: CreateSessionResponse) {
    if (!cwd) return;
    saveSessionName(response.session.id, name);
    pushRecentDir(cwd);
    onCreated(response.session, response.rememberedSessionOptions);
  }

  async function start() {
    if (!cwd || !provider || createdWarning) return;
    setBusy(true);
    setError(undefined);
    try {
      const response =
        provider === "claude"
          ? await api.createSession({
              provider,
              cwd,
              options: (() => {
                const effort = launchEffort(
                  claudeOptions.effort,
                  claudeMetadataState,
                  claudeOptions.model,
                  claudeCustomModelIntent,
                  CLAUDE_BASELINE_EFFORTS,
                );
                const common = {
                  ...(effort ? { effort: effort as ClaudeOptions["effort"] } : {}),
                  ...(claudeOptions.model ? { model: claudeOptions.model } : {}),
                  ...(claudeOptions.addDirs.length > 0 ? { addDirs: claudeOptions.addDirs } : {}),
                };
                return claudeOptions.dangerouslySkip
                  ? ({ ...common, dangerouslySkip: true } satisfies ClaudeOptions)
                  : ({
                      ...common,
                      ...(claudeOptions.permissionMode !== "default"
                        ? { permissionMode: claudeOptions.permissionMode as ClaudeOptions["permissionMode"] }
                        : {}),
                    } satisfies ClaudeOptions);
              })(),
              mode: "terminal",
            })
          : await api.createSession({
              provider,
              cwd,
              options: (() => {
                const reasoningEffort = launchEffort(
                  codexOptions.reasoningEffort,
                  codexMetadataState,
                  codexOptions.model,
                  codexCustomModelIntent,
                  CODEX_BASELINE_REASONING,
                );
                const common = {
                  ...(codexOptions.model ? { model: codexOptions.model } : {}),
                  ...(reasoningEffort ? { reasoningEffort: reasoningEffort as CodexOptions["reasoningEffort"] } : {}),
                  ...(codexOptions.profile ? { profile: codexOptions.profile } : {}),
                  ...(codexOptions.webSearch ? { webSearch: true } : {}),
                  ...(codexOptions.addDirs.length > 0 ? { addDirs: codexOptions.addDirs } : {}),
                };
                return codexOptions.dangerouslyBypassApprovalsAndSandbox
                  ? ({ ...common, dangerouslyBypassApprovalsAndSandbox: true } satisfies CodexOptions)
                  : ({
                      ...common,
                      sandbox: codexOptions.sandbox as CodexOptions["sandbox"],
                      approvalPolicy: codexOptions.approvalPolicy as CodexOptions["approvalPolicy"],
                    } satisfies CodexOptions);
              })(),
              mode: "terminal",
            });
      if (response.warnings?.length) {
        setCreatedWarning(response);
        setBusy(false);
        return;
      }
      finishCreated(response);
    } catch (e) {
      if (e instanceof ApiError && e.code === "INVALID_PROVIDER_OPTIONS") {
        setError("The provider catalog changed. Review the selected model and effort or reasoning, then try again.");
        onRetryProviderAvailability?.();
      } else {
        setError(e instanceof Error ? e.message : "failed to start session");
      }
      setBusy(false);
    }
  }

  // nowMs is currently unused by the terminal-only flow but kept in the signature so callers stay stable.
  void nowMs;

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label="New session settings"
      className="rc-wizard"
      onClick={onBackdrop}
    >
      <section className="rc-wizard__card">
        <div className="rc-wizard__body">
          <header className="rc-wizard__head">
            <span className="rc-wizard__head-icon" aria-hidden="true">
              <Icon name="plus" size={18} />
            </span>
            <strong className="display rc-wizard__title">Start a session</strong>
          </header>

          {/* The chosen directory — a clean row with a folder icon, the mono path, and a quiet
              "Change" affordance that returns to the picker. */}
          <div className="rc-wizard__dir">
            <span className="rc-wizard__dir-icon" aria-hidden="true">
              <Icon name="folder" size={16} />
            </span>
            <Mono>{cwd}</Mono>
            <button
              type="button"
              className="rc-wizard__change"
              onClick={() => setCwd(undefined)}
              aria-label="Change directory"
              disabled={busy || Boolean(createdWarning)}
            >
              Change
            </button>
          </div>

          <label className="rc-wizard__field">
            <span className="rc-wizard__field-label">Name (optional)</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={basename(cwd)}
              aria-label="session name"
              className="rc-wizard__control"
              disabled={busy}
              maxLength={80}
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
            />
            <span className="rc-wizard__help">
              Shows in the session list instead of the folder name. You can rename it later.
            </span>
          </label>

          <fieldset className="rc-wizard__provider-controls" disabled={busy || Boolean(createdWarning)}>
            <ProviderPicker
              providers={providerSummaries}
              value={provider}
              onChange={chooseProvider}
              availabilityState={providerAvailabilityState}
              authStates={providerAuthStates}
              onRetryAvailability={onRetryProviderAvailability}
            />

            {provider === "claude" && (
              <ClaudeSessionOptions
                value={claudeOptions}
                onChange={setClaudeOptions}
                customModelIntent={claudeCustomModelIntent}
                onCustomModelIntentChange={setClaudeCustomModelIntent}
                models={models}
                metadataState={claudeMetadataState}
                onRetryMetadata={onRetryProviderAvailability}
              />
            )}
            {provider === "codex" && (
              <CodexSessionOptions
                value={codexOptions}
                onChange={setCodexOptions}
                customModelIntent={codexCustomModelIntent}
                onCustomModelIntentChange={setCodexCustomModelIntent}
                models={codexModels}
                profiles={codexProfiles}
                metadataState={codexMetadataState}
                onRetryMetadata={onRetryProviderAvailability}
              />
            )}
          </fieldset>

          {createdWarning && (
            <div role="alert" className="rc-wizard__error">
              <Icon name="alert" size={16} />
              <span>{createdWarning.warnings?.map((warning) => warning.message).join(" · ")}</span>
            </div>
          )}

          {error && (
            <div role="alert" className="rc-wizard__error">
              <Icon name="alert" size={16} />
              <span>{error}</span>
            </div>
          )}

          <div className="rc-wizard__actions">
            {createdWarning ? (
              <button
                type="button"
                className="rc-wizard__start"
                onClick={() => finishCreated(createdWarning)}
                aria-label="Open session"
              >
                Open session
              </button>
            ) : (
              <button
                type="button"
                className="rc-wizard__start"
                disabled={busy || !provider || providerSummaries[provider]?.terminalAvailable !== true}
                onClick={start}
                aria-label="Start session"
              >
                {busy ? "Starting…" : "Start session"}
              </button>
            )}
            {!createdWarning && (
              <button type="button" className="rc-wizard__cancel" onClick={onClose} disabled={busy}>
                Cancel
              </button>
            )}
          </div>
        </div>
      </section>

      <style>{wizardCss}</style>
    </div>
  );
}

const wizardCss = `
.rc-wizard {
  position: fixed; inset: 0; z-index: 50;
  background: var(--scrim);
  display: grid; place-items: center;
  padding: var(--sp-5);
  animation: rc-wizard-in 180ms ease;
}
@keyframes rc-wizard-in { from { opacity: 0; } to { opacity: 1; } }
/* The wizard card — a clean floating-glass dialog (subtle fill + blur + a --line-2 border) over the
   scrim. The one accent is the Start CTA. */
.rc-wizard__card {
  width: min(92vw, 460px);
  max-height: calc(100dvh - 2 * var(--sp-5));
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--glass-strong);
  backdrop-filter: var(--glass-blur);
  -webkit-backdrop-filter: var(--glass-blur);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-lg);
  box-shadow: var(--glass-shadow);
}
.rc-wizard__body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior-y: contain;
  -webkit-overflow-scrolling: touch;
  padding: var(--sp-5);
  display: grid; gap: var(--sp-4);
}
.rc-wizard__provider-controls {
  border: 0; padding: 0; margin: 0; min-width: 0;
  display: grid; gap: var(--sp-4);
}
.rc-wizard__advanced {
  border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface);
}
.rc-wizard__advanced > summary {
  min-height: var(--tap-min); display: flex; align-items: center; cursor: pointer;
  padding: 0 var(--sp-3); color: var(--text-muted); font-size: var(--fs-sm); font-weight: 600;
}
.rc-wizard__advanced-body { display: grid; gap: var(--sp-4); padding: 0 var(--sp-3) var(--sp-3); }
.rc-wizard__head { display: flex; align-items: center; gap: var(--sp-2); }
/* The wizard head-icon tile — NEUTRAL (spec: coral lives on the Start CTA only): an elevated surface +
   a --line-2 edge, the glyph in muted text. No coral. */
.rc-wizard__head-icon {
  width: 28px; height: 28px; flex: none;
  display: grid; place-items: center;
  border-radius: var(--radius-sm);
  background: var(--surface-2);
  border: 1px solid var(--border-strong);
  color: var(--text-muted);
}
.rc-wizard__title { font-size: var(--fs-lg); }
.rc-wizard__dir {
  display: flex; align-items: center; gap: var(--sp-2); flex-wrap: wrap;
  font-size: var(--fs-sm);
  background: var(--surface-2); border: 1px solid var(--border);
  border-radius: var(--radius-sm); padding: var(--sp-2) var(--sp-3);
}
.rc-wizard__dir-icon { color: var(--text-muted); display: grid; place-items: center; }
.rc-wizard__dir > :nth-child(2) { color: var(--text); overflow-wrap: anywhere; flex: 1; min-width: 0; }
.rc-wizard__change {
  flex: none; min-height: var(--tap-min); padding: 0 var(--sp-2);
  background: transparent; border: none; cursor: pointer;
  color: var(--text-muted); font: inherit; font-weight: 500;
  border-radius: var(--radius-sm);
}
.rc-wizard__change:hover { background: var(--surface); }
.rc-wizard__field { display: grid; gap: var(--sp-2); }
.rc-wizard__field-label { font-size: var(--fs-sm); color: var(--text-muted); }
/* One-line help under a control — explains what the effort / permission-mode / model choices mean. */
.rc-wizard__help { font-size: var(--fs-xs); color: var(--text-faint); line-height: 1.4; }
.rc-wizard__control {
  min-height: var(--tap-min);
  background: var(--surface-2); border: 1px solid var(--border);
  border-radius: var(--radius-sm); color: var(--text);
  padding: 0 var(--sp-3); font: inherit;
  transition: border-color 120ms ease;
}
.rc-wizard__control:focus-within, .rc-wizard__control:focus { border-color: var(--accent-line); box-shadow: var(--focus-glow); }
.rc-wizard__control--mono { font-family: var(--font-mono); }
.rc-wizard__danger {
  display: flex; gap: var(--sp-2); align-items: center;
  color: var(--text); font-size: var(--fs-sm);
  min-height: var(--tap-min);
}
.rc-wizard__danger--on { color: var(--err); }
.rc-wizard__danger input { width: 20px; height: 20px; accent-color: var(--err); }
/* Inline two-step confirm for enabling danger (window.confirm is unreliable in iOS standalone PWAs). */
.rc-wizard__danger-arm {
  display: flex; flex-direction: column; gap: var(--sp-2);
  padding: var(--sp-3); border-radius: var(--radius-sm);
  background: var(--err-soft); border: 1px solid var(--err-line);
}
.rc-wizard__danger-arm-text { margin: 0; font-size: var(--fs-sm); color: var(--text); line-height: 1.45; }
.rc-wizard__danger-arm-row { display: flex; gap: var(--sp-2); }
.rc-wizard__danger-arm-yes {
  flex: none; padding: 8px 14px; border-radius: var(--radius-sm); cursor: pointer;
  background: var(--err); border: 1px solid var(--err); color: #fff; font-weight: 600; font-size: var(--fs-sm);
}
.rc-wizard__danger-arm-no {
  flex: none; padding: 8px 14px; border-radius: var(--radius-sm); cursor: pointer;
  background: transparent; border: 1px solid var(--border-strong); color: var(--text-muted); font-size: var(--fs-sm);
}
.rc-wizard__error {
  display: flex; align-items: center; gap: var(--sp-2);
  color: var(--err); background: var(--err-bg); border: 1px solid var(--err-border);
  border-radius: var(--radius-sm); padding: var(--sp-2) var(--sp-3);
  font-size: var(--fs-sm);
}
.rc-wizard__actions { display: flex; gap: var(--sp-3); }
/* The single coral primary — Start. A FLAT coral fill, DARK ink label (--on-accent). No glow. */
.rc-wizard__start {
  flex: 1; min-height: var(--tap-min);
  border: none; border-radius: var(--radius-sm); cursor: pointer;
  background: var(--accent-grad); color: var(--on-accent);
  font: inherit; font-weight: 600; padding: 0 var(--sp-4);
  transition: filter 120ms ease;
}
.rc-wizard__start:hover:not(:disabled) { filter: brightness(1.08); }
.rc-wizard__start:disabled { opacity: 0.5; cursor: default; }
.rc-wizard__cancel {
  min-height: var(--tap-min);
  background: transparent; border: 1px solid var(--border-strong); border-radius: var(--radius-sm);
  color: var(--text); cursor: pointer; font: inherit; padding: 0 var(--sp-4);
}
.rc-wizard__cancel:hover { border-color: var(--text-faint); }
`;
