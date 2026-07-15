import claudeIconUrl from "./assets/claude.svg";
import openAiIconUrl from "./assets/openai.svg";
import type { ProviderId } from "./types";
import "./ProviderIcon.css";

export interface ProviderIconProps {
  provider: ProviderId;
  className?: string;
  /** Provider identity stays available to assistive technology even when its visible word is omitted. */
  label?: string;
}

export function ProviderIcon({ provider, className, label }: ProviderIconProps) {
  const providerName =
    provider === "claude"
      ? "Claude"
      : provider === "codex"
        ? "Codex"
        : provider
            .split("-")
            .filter(Boolean)
            .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
            .join(" ");
  const iconUrl = provider === "claude" ? claudeIconUrl : provider === "codex" ? openAiIconUrl : undefined;
  const classes = ["rc-provider-icon", `rc-provider-icon--${provider}`, className].filter(Boolean).join(" ");

  return (
    <span className={classes} role="img" aria-label={label ?? providerName} title={providerName}>
      {iconUrl ? (
        <img src={iconUrl} alt="" draggable={false} />
      ) : (
        <span aria-hidden="true">{provider.slice(0, 2)}</span>
      )}
    </span>
  );
}
