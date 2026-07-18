import { useMemo, useState } from "react";
import { Icon } from "../ui/Icon";
import type {
  DirectHostRegistry,
  DirectHostSummary,
  GlobalDirectAttentionItem,
  GlobalDirectSearchResult,
} from "./direct-hosts";
import { sortGlobalAttentionHosts } from "./direct-hosts";

export interface HostSwitcherProps {
  registry: DirectHostRegistry;
  summaries: Record<string, DirectHostSummary>;
  onActivate: (id: string) => void;
  onAdd: (input: { label: string; baseUrl: string; token: string }) => void;
  onRename: (id: string, label: string) => void;
  onMove: (id: string, sortOrder: number) => void;
  onRemove: (id: string) => void;
  onRefresh: () => void;
  globalAttentionItems?: GlobalDirectAttentionItem[];
  onSearch?: (query: string) => Promise<GlobalDirectSearchResult[]>;
  onOpenResource?: (hostId: string, sessionId?: string) => void;
}

const STATE_LABEL: Record<DirectHostSummary["state"], string> = {
  checking: "checking",
  online: "online",
  offline: "offline",
  "certificate-error": "certificate",
  revoked: "pair again",
  "protocol-mismatch": "update needed",
  "stale-version": "version differs",
  "clock-skew": "fix Node clock",
};

export function HostSwitcher({
  registry,
  summaries,
  onActivate,
  onAdd,
  onRename,
  onMove,
  onRemove,
  onRefresh,
  globalAttentionItems = [],
  onSearch,
  onOpenResource,
}: HostSwitcherProps) {
  const [manage, setManage] = useState(false);
  const [adding, setAdding] = useState(false);
  const [label, setLabel] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [token, setToken] = useState("");
  const [error, setError] = useState<string>();
  const [armedRemove, setArmedRemove] = useState<string>();
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchResults, setSearchResults] = useState<GlobalDirectSearchResult[]>([]);
  const active = registry.hosts.find((host) => host.id === registry.activeHostId)!;
  const ordered = useMemo(() => sortGlobalAttentionHosts(registry, summaries), [registry, summaries]);
  const globalAttention = ordered.reduce((count, item) => count + (item.summary?.attentionCount ?? 0), 0);

  return (
    <section className="rc-hosts" aria-label="RoamCode Nodes">
      <div className="rc-hosts__bar">
        <label className="rc-hosts__select-label">
          <span className="sr-only">Active Node</span>
          <select value={active.id} onChange={(event) => onActivate(event.target.value)} aria-label="Active Node">
            {registry.hosts.map((host) => {
              const summary = summaries[host.id];
              const count = summary?.attentionCount ?? 0;
              return (
                <option key={host.id} value={host.id}>
                  {host.label}
                  {count > 0 ? ` · ${count}` : ""}
                </option>
              );
            })}
          </select>
        </label>
        {globalAttention > 0 && (
          <span
            className="rc-hosts__attention"
            role="status"
            aria-label={`${globalAttention} sessions need you across Nodes`}
          >
            {globalAttention > 99 ? "99+" : globalAttention} need you
          </span>
        )}
        <button
          type="button"
          className="rc-hosts__icon"
          onClick={() => setManage((value) => !value)}
          aria-label="Manage Nodes"
          aria-expanded={manage}
        >
          <Icon name="terminal" size={16} />
        </button>
      </div>

      {manage && (
        <div className="rc-hosts__manager">
          <div className="rc-hosts__manager-head">
            <strong className="display">Nodes</strong>
            <button type="button" className="rc-hosts__text-button" onClick={onRefresh}>
              Refresh
            </button>
            <button type="button" className="rc-hosts__text-button" onClick={() => setAdding((value) => !value)}>
              {adding ? "Cancel" : "Add Node"}
            </button>
          </div>

          {adding && (
            <form
              className="rc-hosts__add"
              onSubmit={(event) => {
                event.preventDefault();
                setError(undefined);
                try {
                  onAdd({ label, baseUrl, token });
                  setLabel("");
                  setBaseUrl("");
                  setToken("");
                  setAdding(false);
                } catch (caught) {
                  setError((caught as Error).message);
                }
              }}
            >
              <label>
                Name
                <input value={label} onChange={(event) => setLabel(event.target.value)} maxLength={80} required />
              </label>
              <label>
                HTTPS Node address
                <input
                  value={baseUrl}
                  onChange={(event) => setBaseUrl(event.target.value)}
                  inputMode="url"
                  placeholder="https://code.example"
                  autoCapitalize="off"
                  autoCorrect="off"
                  required
                />
              </label>
              <label>
                Device credential
                <input
                  value={token}
                  onChange={(event) => setToken(event.target.value)}
                  type="password"
                  autoComplete="off"
                  required
                />
              </label>
              <small>The credential is stored only for this Node and is never included in its URL.</small>
              <button type="submit" className="rc-hosts__primary">
                Add and connect
              </button>
            </form>
          )}

          {error && (
            <p className="rc-hosts__error" role="alert">
              {error}
            </p>
          )}

          {registry.hosts.length > 1 && onSearch && (
            <form
              className="rc-hosts__search"
              role="search"
              onSubmit={(event) => {
                event.preventDefault();
                const normalized = query.trim();
                if (!normalized) {
                  setSearchResults([]);
                  return;
                }
                setSearching(true);
                setError(undefined);
                void onSearch(normalized)
                  .then(setSearchResults)
                  .catch(() => setError("Global search could not reach the Nodes."))
                  .finally(() => setSearching(false));
              }}
            >
              <label>
                <span className="sr-only">Search all Nodes</span>
                <input
                  type="search"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search all Nodes"
                  maxLength={100}
                />
              </label>
              <button type="submit" className="rc-hosts__text-button" disabled={searching}>
                {searching ? "Searching…" : "Search"}
              </button>
            </form>
          )}

          {searchResults.length > 0 && (
            <ol className="rc-hosts__results" aria-label="Global search results">
              {searchResults.slice(0, 20).map((result) => (
                <li key={`${result.hostId}:${result.kind}:${result.id}`}>
                  <button type="button" onClick={() => onOpenResource?.(result.hostId, result.sessionId)}>
                    <strong>{result.label}</strong>
                    <small>
                      {result.hostLabel} · {result.kind}
                    </small>
                  </button>
                </li>
              ))}
            </ol>
          )}

          {registry.hosts.length > 1 && globalAttentionItems.length > 0 && (
            <section className="rc-hosts__global-attention" aria-labelledby="rc-global-attention-title">
              <strong id="rc-global-attention-title">Across Nodes</strong>
              <ol className="rc-hosts__results">
                {globalAttentionItems.slice(0, 12).map((item) => (
                  <li key={`${item.hostId}:${item.id}`}>
                    <button type="button" onClick={() => onOpenResource?.(item.hostId, item.sessionId)}>
                      <strong>{item.title}</strong>
                      <small>{item.hostLabel}</small>
                    </button>
                  </li>
                ))}
              </ol>
            </section>
          )}

          <ol className="rc-hosts__list">
            {registry.hosts.map((host, index) => {
              const summary = summaries[host.id];
              const state = summary?.state ?? "checking";
              return (
                <li key={host.id} className="rc-hosts__row">
                  <button
                    type="button"
                    className="rc-hosts__connect"
                    onClick={() => onActivate(host.id)}
                    aria-current={host.id === active.id ? "true" : undefined}
                  >
                    <span className={`rc-hosts__dot rc-hosts__dot--${state}`} aria-hidden="true" />
                    <span>
                      <strong>{host.label}</strong>
                      <small>{STATE_LABEL[state]}</small>
                    </span>
                  </button>
                  <input
                    className="rc-hosts__rename"
                    defaultValue={host.label}
                    aria-label={`Rename ${host.label}`}
                    maxLength={80}
                    onBlur={(event) => {
                      if (event.target.value.trim() !== host.label) {
                        try {
                          onRename(host.id, event.target.value);
                          setError(undefined);
                        } catch (caught) {
                          setError((caught as Error).message);
                          event.target.value = host.label;
                        }
                      }
                    }}
                  />
                  <button
                    type="button"
                    className="rc-hosts__icon"
                    disabled={index === 0}
                    onClick={() => onMove(host.id, index - 1)}
                    aria-label={`Move ${host.label} up`}
                  >
                    <Icon name="arrow-up" size={15} />
                  </button>
                  <button
                    type="button"
                    className="rc-hosts__icon"
                    disabled={index === registry.hosts.length - 1}
                    onClick={() => onMove(host.id, index + 1)}
                    aria-label={`Move ${host.label} down`}
                  >
                    <Icon name="chevron-down" size={15} />
                  </button>
                  <button
                    type="button"
                    className="rc-hosts__remove"
                    disabled={registry.hosts.length === 1 && !host.relay}
                    onClick={() => {
                      if (armedRemove === host.id) {
                        onRemove(host.id);
                        setArmedRemove(undefined);
                      } else {
                        setArmedRemove(host.id);
                      }
                    }}
                    aria-label={armedRemove === host.id ? `Confirm remove ${host.label}` : `Remove ${host.label}`}
                  >
                    {armedRemove === host.id ? "Confirm" : "Remove"}
                  </button>
                  {summary?.detail && state !== "online" && (
                    <small className="rc-hosts__detail">{summary.detail}</small>
                  )}
                </li>
              );
            })}
          </ol>
        </div>
      )}

      <style>{`
        .rc-hosts { border-bottom: 1px solid var(--border); padding: var(--sp-2); position: relative; }
        .rc-hosts__bar { display: flex; align-items: center; gap: var(--sp-2); }
        .rc-hosts__select-label { min-width: 0; flex: 1; }
        .rc-hosts select, .rc-hosts input { width: 100%; min-height: var(--tap-min); color: var(--text); background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 8px; }
        .rc-hosts__attention { min-width: 22px; height: 24px; padding: 0 7px; display: grid; place-items: center; border-radius: var(--radius-pill); background: var(--coral); color: var(--on-accent); font-size: 10px; font-weight: 700; white-space: nowrap; }
        .rc-hosts__icon, .rc-hosts__text-button, .rc-hosts__remove, .rc-hosts__primary { min-height: var(--tap-min); border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface-2); color: var(--text); cursor: pointer; }
        .rc-hosts__icon { min-width: var(--tap-min); display: grid; place-items: center; }
        .rc-hosts__manager { display: grid; gap: var(--sp-2); margin-top: var(--sp-2); padding: var(--sp-3); border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface); }
        .rc-hosts__manager-head { display: flex; align-items: center; gap: var(--sp-2); }
        .rc-hosts__manager-head strong { margin-right: auto; }
        .rc-hosts__text-button { padding-inline: 9px; }
        .rc-hosts__add { display: grid; gap: var(--sp-2); }
        .rc-hosts__add label { display: grid; gap: 4px; color: var(--text-muted); font-size: var(--fs-xs); }
        .rc-hosts__add small, .rc-hosts__detail { color: var(--text-muted); }
        .rc-hosts__primary { background: var(--coral); color: var(--bg); font-weight: 700; }
        .rc-hosts__error { color: var(--err); margin: 0; font-size: var(--fs-sm); }
        .rc-hosts__search { display: grid; grid-template-columns: 1fr auto; gap: 6px; }
        .rc-hosts__results { display: grid; gap: 4px; list-style: none; padding: 0; margin: 0; }
        .rc-hosts__results button { width: 100%; min-height: var(--tap-min); display: grid; gap: 2px; padding: 8px; text-align: left; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface-2); color: var(--text); cursor: pointer; }
        .rc-hosts__results small { color: var(--text-muted); }
        .rc-hosts__global-attention { display: grid; gap: 6px; }
        .rc-hosts__list { display: grid; gap: var(--sp-2); list-style: none; margin: 0; padding: 0; }
        .rc-hosts__row { display: grid; grid-template-columns: minmax(88px, 1fr) minmax(72px, 1fr) auto auto auto; gap: 4px; align-items: center; }
        .rc-hosts__connect { min-width: 0; min-height: var(--tap-min); display: flex; align-items: center; gap: 7px; border: 0; background: transparent; color: var(--text); text-align: left; cursor: pointer; }
        .rc-hosts__connect span:last-child { min-width: 0; display: grid; }
        .rc-hosts__connect strong, .rc-hosts__connect small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .rc-hosts__connect small { color: var(--text-muted); }
        .rc-hosts__dot { width: 8px; height: 8px; border-radius: 999px; background: var(--text-faint); flex: none; }
        .rc-hosts__dot--online { background: var(--text); }
        .rc-hosts__dot--revoked, .rc-hosts__dot--certificate-error { background: var(--err); }
        .rc-hosts__dot--protocol-mismatch, .rc-hosts__dot--stale-version, .rc-hosts__dot--clock-skew { background: var(--warn); }
        .rc-hosts__rename { min-width: 0; }
        .rc-hosts__remove { padding-inline: 7px; color: var(--text-muted); }
        .rc-hosts__detail { grid-column: 1 / -1; }
        @media (max-width: 460px) { .rc-hosts__row { grid-template-columns: 1fr auto auto auto; } .rc-hosts__rename { grid-column: 1 / -1; grid-row: 2; } }
      `}</style>
    </section>
  );
}
