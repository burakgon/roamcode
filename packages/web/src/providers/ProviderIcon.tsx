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
  const providerName = provider === "claude" ? "Claude" : "Codex";
  const iconUrl = provider === "claude" ? claudeIconUrl : openAiIconUrl;
  const classes = ["rc-provider-icon", `rc-provider-icon--${provider}`, className].filter(Boolean).join(" ");

  return (
    <span className={classes} role="img" aria-label={label ?? providerName} title={providerName}>
      <img src={iconUrl} alt="" draggable={false} />
    </span>
  );
}
