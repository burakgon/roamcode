import type { ProviderId, ProviderSummaries } from "./types";

export interface ProviderPickerProps {
  providers: ProviderSummaries;
  value: ProviderId | undefined;
  onChange: (provider: ProviderId) => void;
  availabilityState?: "loading" | "ready" | "error";
  onRetryAvailability?: () => void;
  authStates?: ProviderAuthStates;
}

export type ProviderAuthState = "checking" | "signed-in" | "signed-out" | "unavailable";
export type ProviderAuthStates = Partial<Record<ProviderId, ProviderAuthState>>;

const PROVIDERS: Array<{ id: ProviderId; name: string; detail: string }> = [
  { id: "claude", name: "Claude Code", detail: "Anthropic's coding agent" },
  { id: "codex", name: "Codex", detail: "OpenAI's coding agent" },
];

export function ProviderPicker({
  providers,
  value,
  onChange,
  availabilityState = "ready",
  onRetryAvailability,
  authStates = {},
}: ProviderPickerProps) {
  const hasUnavailableTerminal = PROVIDERS.some(({ id }) => providers[id]?.terminalAvailable === false);
  const hasUnavailableAuth = PROVIDERS.some(({ id }) => authStates[id] === "unavailable");
  return (
    <fieldset className="rc-provider-picker">
      <legend className="rc-wizard__field-label">Coding agent</legend>
      <div role="radiogroup" aria-label="Coding agent" className="rc-provider-picker__grid">
        {PROVIDERS.map(({ id, name, detail }) => {
          const summary = providers[id];
          const terminalAvailable = summary?.terminalAvailable === true;
          const terminalUnavailable = summary?.terminalAvailable === false;
          const checking = !summary && availabilityState === "loading";
          const availabilityUnknown = !summary && availabilityState !== "loading";
          const metadataDegraded = terminalAvailable && summary?.metadataAvailable !== true;
          const authState = authStates[id];
          const cliName = id === "claude" ? "claude" : "codex";
          return (
            <label
              key={id}
              className={`rc-provider-picker__card${value === id ? " rc-provider-picker__card--selected" : ""}${
                !terminalAvailable ? " rc-provider-picker__card--disabled" : ""
              }`}
            >
              <input
                type="radio"
                name="session-provider"
                value={id}
                checked={value === id}
                disabled={!terminalAvailable}
                onChange={() => onChange(id)}
              />
              <span className="rc-provider-picker__copy">
                <strong>{name}</strong>
                <span>{detail}</span>
                {terminalUnavailable && (
                  <span className="rc-provider-picker__state">
                    Terminal unavailable — install or repair the {cliName} CLI on the host.
                  </span>
                )}
                {checking && <span className="rc-provider-picker__state">Checking availability…</span>}
                {availabilityUnknown && <span className="rc-provider-picker__state">Availability unknown</span>}
                {metadataDegraded && (
                  <span className="rc-provider-picker__state">
                    Metadata unavailable — defaults and bounded custom values remain available.
                  </span>
                )}
                {authState === "checking" && <span className="rc-provider-picker__auth">Checking sign-in…</span>}
                {authState === "signed-in" && <span className="rc-provider-picker__auth">Signed in</span>}
                {authState === "signed-out" && (
                  <span className="rc-provider-picker__auth">
                    Signed out — sign in with the {cliName} CLI on the host.
                  </span>
                )}
                {authState === "unavailable" && (
                  <span className="rc-provider-picker__auth">
                    {name} sign-in status unavailable — check the {cliName} CLI on the host.
                  </span>
                )}
              </span>
            </label>
          );
        })}
      </div>
      {availabilityState === "error" && (
        <div role="alert" className="rc-provider-picker__load-error">
          <span>Could not load provider availability.</span>
        </div>
      )}
      {onRetryAvailability && (availabilityState === "error" || hasUnavailableTerminal || hasUnavailableAuth) && (
        <button
          type="button"
          className="rc-wizard__cancel rc-provider-picker__retry"
          onClick={onRetryAvailability}
          aria-label="Retry provider availability"
        >
          Retry availability
        </button>
      )}
      <style>{providerPickerCss}</style>
    </fieldset>
  );
}

const providerPickerCss = `
.rc-provider-picker { border: 0; padding: 0; margin: 0; min-width: 0; display: grid; gap: var(--sp-2); }
.rc-provider-picker__grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--sp-2); }
.rc-provider-picker__card {
  min-width: 0; display: flex; align-items: flex-start; gap: var(--sp-2); padding: var(--sp-3);
  border: 1px solid var(--border); border-radius: var(--radius-md); background: var(--surface-2); cursor: pointer;
}
.rc-provider-picker__card--selected { border-color: var(--accent-line); box-shadow: var(--focus-glow); }
.rc-provider-picker__card--disabled { opacity: .58; cursor: not-allowed; }
.rc-provider-picker__card input { flex: none; width: 18px; height: 18px; margin-top: 2px; accent-color: var(--accent); }
.rc-provider-picker__copy { min-width: 0; display: grid; gap: 3px; color: var(--text-muted); font-size: var(--fs-xs); line-height: 1.35; }
.rc-provider-picker__copy strong { color: var(--text); font-size: var(--fs-sm); }
.rc-provider-picker__state { color: var(--warn); }
.rc-provider-picker__auth { color: var(--text-faint); }
.rc-provider-picker__load-error { color: var(--err); font-size: var(--fs-sm); }
.rc-provider-picker__retry { justify-self: start; }
@media (max-width: 520px) { .rc-provider-picker__grid { grid-template-columns: 1fr; } }
`;
