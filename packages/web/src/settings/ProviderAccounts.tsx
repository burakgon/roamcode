import { useEffect, useState } from "react";
import type { ApiClient } from "../api/client";
import type { CodexUsage, ProviderId } from "../providers/types";
import type { UsageInfo } from "../types/server";
import { UsageBars, normalizeProviderUsage, shortenReset } from "../session/UsageBars";
import { ClaudeAuthSection } from "./ClaudeAuthSection";
import { CodexAuthSection } from "./CodexAuthSection";

export function ProviderAccounts(props: { api: ApiClient; claudeUsage?: UsageInfo | null }) {
  const { api, claudeUsage } = props;
  const hasClaudeUsage = Object.prototype.hasOwnProperty.call(props, "claudeUsage");
  return (
    <div style={{ display: "grid", gap: "var(--sp-3)" }}>
      <ProviderCard
        provider="claude"
        label="Claude Code account"
        api={api}
        usageOverride={claudeUsage}
        usageOverrideProvided={hasClaudeUsage}
      >
        <ClaudeAuthSection api={api} />
      </ProviderCard>
      <ProviderCard provider="codex" label="Codex account" api={api}>
        <CodexAuthSection api={api} />
      </ProviderCard>
    </div>
  );
}

function ProviderCard({
  provider,
  label,
  api,
  children,
  usageOverride,
  usageOverrideProvided = false,
}: {
  provider: ProviderId;
  label: string;
  api: ApiClient;
  children: React.ReactNode;
  usageOverride?: UsageInfo | CodexUsage | null;
  usageOverrideProvided?: boolean;
}) {
  const [version, setVersion] = useState<string>();
  const [versionHint, setVersionHint] = useState<string>();
  const [usage, setUsage] = useState<UsageInfo | CodexUsage | null>();
  const [metadataUnavailable, setMetadataUnavailable] = useState(false);

  useEffect(() => {
    let alive = true;
    setVersion(undefined);
    setVersionHint(undefined);
    setUsage(undefined);
    setMetadataUnavailable(false);
    const versionRequest = provider === "codex" ? api.getProviderVersion("codex") : api.getProviderVersion("claude");
    void versionRequest
      .then((next) => {
        if (!alive) return;
        const installed = next.installed;
        setVersion(installed ? `${provider === "codex" ? "Codex" : "Claude Code"} ${installed}` : undefined);
        if (provider === "codex" && "provenance" in next) {
          setVersionHint(
            next.updateHint ??
              (next.updateAvailable && next.latest ? `Latest Codex version: ${next.latest}` : undefined),
          );
        } else if (provider === "claude" && "latest" in next && next.latest && next.latest !== next.installed) {
          setVersionHint(`Latest Claude Code version: ${next.latest}`);
        }
      })
      .catch(() => {
        if (alive) setMetadataUnavailable(true);
      });

    if (usageOverrideProvided) {
      setUsage(usageOverride ?? null);
    } else {
      const usageRequest = provider === "codex" ? api.getProviderUsage("codex") : api.getProviderUsage("claude");
      void usageRequest
        .then((next) => {
          if (alive) setUsage(next);
        })
        .catch(() => {
          if (alive) setMetadataUnavailable(true);
        });
    }
    return () => {
      alive = false;
    };
  }, [api, provider, usageOverride, usageOverrideProvided]);

  const nearLimit = usage
    ? normalizeProviderUsage(provider, usage, true).bars.find((bar) => Math.round(bar.percent) >= 90)
    : undefined;

  return (
    <section
      role="region"
      aria-label={label}
      style={{
        display: "grid",
        gap: "var(--sp-2)",
        padding: "var(--sp-3)",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius-md)",
      }}
    >
      <strong>{label}</strong>
      {version && <span style={{ color: "var(--text-muted)", fontSize: "var(--fs-xs)" }}>{version}</span>}
      {versionHint && <span style={{ color: "var(--text-faint)", fontSize: "var(--fs-xs)" }}>{versionHint}</span>}
      {metadataUnavailable && (
        <span style={{ color: "var(--text-faint)", fontSize: "var(--fs-xs)" }}>
          {provider === "codex"
            ? "Codex account details are unavailable."
            : "Claude Code account details are unavailable."}
        </span>
      )}
      {nearLimit && (
        <span role="status" style={{ color: "var(--warn)", fontSize: "var(--fs-xs)" }}>
          Near a {provider === "codex" ? "Codex" : "Claude"} usage limit — {nearLimit.label}{" "}
          {Math.round(nearLimit.percent)}% used{nearLimit.resets ? `, resets ${shortenReset(nearLimit.resets)}` : ""}.
        </span>
      )}
      {usage && <UsageBars provider={provider} usage={usage} allLimits />}
      {children}
    </section>
  );
}
