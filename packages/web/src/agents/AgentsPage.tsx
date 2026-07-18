import { useCallback, useEffect, useState } from "react";
import type { ProductApiV2Client } from "../api/v2/client";
import type { AgentRuntimeRecord, NodeRecord } from "../api/v2/types";
import { Button } from "../ui/Button";
import { Icon } from "../ui/Icon";
import "../styles/product-page.css";

export interface AgentRuntimeSelection {
  node: NodeRecord;
  runtime: AgentRuntimeRecord;
}

export interface AgentsPageProps {
  client: Pick<ProductApiV2Client, "listNodes" | "listNodeRuntimes">;
  onStartSession: (selection: AgentRuntimeSelection) => void;
  onManageRuntime?: (selection: AgentRuntimeSelection) => void;
}

interface RuntimeLoadState {
  state: "loading" | "ready" | "error";
  runtimes: AgentRuntimeRecord[];
}

function runtimePriority(runtime: AgentRuntimeRecord): number {
  if (runtime.provider === "codex") return 0;
  if (runtime.provider === "claude") return 1;
  return 2;
}

function runtimeStatus(node: NodeRecord, runtime: AgentRuntimeRecord): { label: string; ready: boolean } {
  if (node.status === "offline") return { label: "Node offline", ready: false };
  if (runtime.availability === "unavailable") return { label: "Unavailable", ready: false };
  if (runtime.authState === "required") return { label: "Sign-in required", ready: false };
  if (runtime.authState === "error") return { label: "Authentication error", ready: false };
  if (!runtime.capabilities.includes("launch")) return { label: "Launch unsupported", ready: false };
  if (runtime.authState === "unknown") return { label: "Auth not reported", ready: true };
  if (node.status === "degraded") return { label: "Ready · Node degraded", ready: true };
  return { label: "Ready", ready: true };
}

function lastSeenLabel(node: NodeRecord): string {
  if (node.status === "online") return "Connected now";
  if (!Number.isFinite(node.lastSeenAt) || node.lastSeenAt <= 0) return "Last seen unknown";
  return `Last seen ${new Date(node.lastSeenAt).toLocaleString()}`;
}

function activeSessionLabel(count: number): string {
  return `${count} active ${count === 1 ? "session" : "sessions"}`;
}

export function AgentsPage({ client, onStartSession, onManageRuntime }: AgentsPageProps) {
  const [nodes, setNodes] = useState<NodeRecord[]>([]);
  const [runtimeLoads, setRuntimeLoads] = useState<Record<string, RuntimeLoadState>>({});
  const [expandedRuntimeId, setExpandedRuntimeId] = useState<string>();
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string>();
  const [reload, setReload] = useState(0);

  const refresh = useCallback(() => setReload((current) => current + 1), []);

  useEffect(() => {
    let alive = true;
    setState("loading");
    setError(undefined);
    void client
      .listNodes()
      .then(async (nextNodes) => {
        if (!alive) return;
        setNodes(nextNodes);
        setState("ready");
        setRuntimeLoads(Object.fromEntries(nextNodes.map((node) => [node.id, { state: "loading", runtimes: [] }])));
        await Promise.all(
          nextNodes.map(async (node) => {
            try {
              const runtimes = await client.listNodeRuntimes(node.id);
              if (!alive) return;
              setRuntimeLoads((current) => ({
                ...current,
                [node.id]: {
                  state: "ready",
                  runtimes: [...runtimes].sort(
                    (left, right) =>
                      runtimePriority(left) - runtimePriority(right) ||
                      left.displayName.localeCompare(right.displayName),
                  ),
                },
              }));
            } catch {
              if (!alive) return;
              setRuntimeLoads((current) => ({
                ...current,
                [node.id]: { state: "error", runtimes: current[node.id]?.runtimes ?? [] },
              }));
            }
          }),
        );
      })
      .catch((caught: unknown) => {
        if (!alive) return;
        setState("error");
        setError(caught instanceof Error ? caught.message : "Nodes could not be loaded.");
      });
    return () => {
      alive = false;
    };
  }, [client, reload]);

  return (
    <div className="rc-agents-page">
      <header className="rc-product-page__header">
        <div>
          <span className="rc-product-page__eyebrow">Runtime control</span>
          <h1>Agents</h1>
          <p>Every coding runtime belongs to the Node where it is installed and authenticated.</p>
        </div>
        <Button onClick={refresh} aria-label="Refresh agents">
          <Icon name="history" size={16} />
          Refresh
        </Button>
      </header>

      {state === "loading" && (
        <div className="rc-product-state" role="status">
          Loading connected Nodes…
        </div>
      )}
      {state === "error" && (
        <div className="rc-product-state rc-product-state--error" role="alert">
          <Icon name="alert" size={17} />
          <span>{error ?? "Nodes could not be loaded."}</span>
          <Button onClick={refresh}>Try again</Button>
        </div>
      )}
      {state === "ready" && nodes.length === 0 && (
        <div className="rc-product-state">
          <Icon name="agent" size={21} />
          <strong>No Nodes available</strong>
          <span>Connect a Node or ask an administrator to grant this context access to one.</span>
        </div>
      )}

      {state === "ready" && nodes.length > 0 && (
        <div className="rc-agents-page__nodes">
          {nodes.map((node) => {
            const load = runtimeLoads[node.id] ?? { state: "loading", runtimes: [] };
            return (
              <section className="rc-node-card" key={node.id} aria-labelledby={`node-${node.id}`}>
                <header className="rc-node-card__header">
                  <span className="rc-node-card__mark" aria-hidden="true">
                    <Icon name="terminal" size={19} />
                  </span>
                  <span className="rc-node-card__identity">
                    <h2 id={`node-${node.id}`}>{node.name}</h2>
                    <span>
                      {node.platform || "Platform unknown"} · {lastSeenLabel(node)}
                    </span>
                  </span>
                  <span className={`rc-node-card__status rc-node-card__status--${node.status}`}>
                    <span aria-hidden="true" />
                    {node.status}
                  </span>
                </header>

                {load.state === "loading" && (
                  <div className="rc-node-card__loading" role="status">
                    Inspecting runtimes…
                  </div>
                )}
                {load.state === "error" && (
                  <div className="rc-node-card__loading rc-node-card__loading--error" role="status">
                    Runtime inventory unavailable. Node connection status is still available.
                  </div>
                )}
                {load.state === "ready" && load.runtimes.length === 0 && (
                  <div className="rc-node-card__loading">No agent runtimes reported by this Node.</div>
                )}
                {load.runtimes.length > 0 && (
                  <ul className="rc-runtime-list" aria-label={`Agent runtimes on ${node.name}`}>
                    {load.runtimes.map((runtime) => {
                      const status = runtimeStatus(node, runtime);
                      const expanded = expandedRuntimeId === runtime.id;
                      return (
                        <li className="rc-runtime-row" key={runtime.id}>
                          <button
                            type="button"
                            className="rc-runtime-row__summary"
                            aria-expanded={expanded}
                            aria-controls={`runtime-${runtime.id}`}
                            onClick={() => setExpandedRuntimeId(expanded ? undefined : runtime.id)}
                          >
                            <span className="rc-runtime-row__icon" aria-hidden="true">
                              <Icon name="agent" size={17} />
                            </span>
                            <span className="rc-runtime-row__name">
                              <strong>{runtime.displayName}</strong>
                              <span>{activeSessionLabel(runtime.activeSessionCount)}</span>
                            </span>
                            <span
                              className={`rc-runtime-row__state${status.ready ? " rc-runtime-row__state--ready" : ""}`}
                            >
                              {status.label}
                            </span>
                            <Icon name="chevron-down" size={15} />
                          </button>
                          {expanded && (
                            <div className="rc-runtime-row__details" id={`runtime-${runtime.id}`}>
                              <dl>
                                <div>
                                  <dt>Version</dt>
                                  <dd>{runtime.version ?? "Unknown"}</dd>
                                </div>
                                <div>
                                  <dt>Provider</dt>
                                  <dd>{runtime.provider}</dd>
                                </div>
                                <div>
                                  <dt>Capabilities</dt>
                                  <dd>
                                    {runtime.capabilities.length > 0
                                      ? runtime.capabilities.join(", ")
                                      : "None reported"}
                                  </dd>
                                </div>
                              </dl>
                              <div className="rc-runtime-row__actions">
                                {onManageRuntime && (runtime.provider === "claude" || runtime.provider === "codex") && (
                                  <Button
                                    variant={
                                      runtime.authState === "required" || runtime.authState === "error"
                                        ? "primary"
                                        : "ghost"
                                    }
                                    disabled={node.status === "offline" || runtime.availability === "unavailable"}
                                    onClick={() => onManageRuntime({ node, runtime })}
                                  >
                                    Manage sign-in
                                  </Button>
                                )}
                                <Button
                                  variant={status.ready ? "primary" : "ghost"}
                                  disabled={!status.ready}
                                  onClick={() => onStartSession({ node, runtime })}
                                >
                                  <Icon name="plus" size={16} />
                                  Start session
                                </Button>
                              </div>
                            </div>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>
            );
          })}
        </div>
      )}

      <style>{agentsCss}</style>
    </div>
  );
}

const agentsCss = `
.rc-agents-page {
  width: min(100%, 1120px); min-height: 100%; margin: 0 auto;
  display: grid; align-content: start; gap: var(--sp-5);
  padding: var(--sp-6);
}
.rc-agents-page__nodes { display: grid; gap: var(--sp-4); }
.rc-node-card { overflow: hidden; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-lg); }
.rc-node-card__header {
  min-height: 76px; display: flex; align-items: center; gap: var(--sp-3);
  padding: var(--sp-4); border-bottom: 1px solid var(--border);
}
.rc-node-card__mark {
  width: 38px; height: 38px; display: grid; place-items: center; flex: none;
  color: var(--text); background: var(--surface-2); border: 1px solid var(--border-strong); border-radius: var(--radius-sm);
}
.rc-node-card__identity { min-width: 0; display: grid; gap: 3px; flex: 1; }
.rc-node-card__identity h2 { margin: 0; overflow: hidden; color: var(--text); font-family: var(--font-display); font-size: var(--fs-base); text-overflow: ellipsis; white-space: nowrap; }
.rc-node-card__identity span { overflow: hidden; color: var(--text-faint); font-size: var(--fs-xs); text-overflow: ellipsis; white-space: nowrap; }
.rc-node-card__status {
  display: inline-flex; align-items: center; gap: 6px; flex: none;
  color: var(--text-muted); font-size: var(--fs-xs); text-transform: capitalize;
}
.rc-node-card__status > span { width: 7px; height: 7px; border-radius: 50%; background: var(--text-faint); }
.rc-node-card__status--offline > span { background: var(--text-faint); }
.rc-node-card__status--degraded > span { background: var(--warn); }
.rc-node-card__status--online > span { background: var(--text); }
.rc-node-card__loading { padding: var(--sp-5); color: var(--text-muted); font-size: var(--fs-sm); text-align: center; }
.rc-node-card__loading--error { color: var(--warn); }
.rc-runtime-list { margin: 0; padding: 0; list-style: none; }
.rc-runtime-row + .rc-runtime-row { border-top: 1px solid var(--border); }
.rc-runtime-row__summary {
  width: 100%; min-height: 64px; display: flex; align-items: center; gap: var(--sp-3);
  padding: var(--sp-3) var(--sp-4); background: transparent; border: 0; color: var(--text-muted);
  font: inherit; text-align: left; cursor: pointer;
}
.rc-runtime-row__summary:hover { background: var(--surface-2); }
.rc-runtime-row__summary[aria-expanded="true"] { background: var(--surface-2); color: var(--text); }
.rc-runtime-row__summary[aria-expanded="true"] > svg { transform: rotate(180deg); }
.rc-runtime-row__icon { width: 32px; height: 32px; display: grid; place-items: center; flex: none; border-radius: var(--radius-sm); background: var(--surface-2); }
.rc-runtime-row__name { min-width: 0; display: grid; gap: 3px; flex: 1; }
.rc-runtime-row__name strong { color: var(--text); font-size: var(--fs-sm); }
.rc-runtime-row__name span { color: var(--text-faint); font-size: var(--fs-xs); }
.rc-runtime-row__state { color: var(--text-muted); font-size: var(--fs-xs); }
.rc-runtime-row__state--ready { color: var(--text); }
.rc-runtime-row__details {
  display: flex; align-items: end; justify-content: space-between; gap: var(--sp-5);
  padding: 0 var(--sp-4) var(--sp-4) 60px; background: var(--surface-2);
}
.rc-runtime-row__details dl { min-width: 0; display: flex; flex-wrap: wrap; gap: var(--sp-4); margin: 0; }
.rc-runtime-row__details dl > div { display: grid; gap: 3px; }
.rc-runtime-row__details dt { color: var(--text-faint); font-size: var(--fs-xs); }
.rc-runtime-row__details dd { margin: 0; color: var(--text); font-family: var(--font-mono); font-size: var(--fs-xs); overflow-wrap: anywhere; }
.rc-runtime-row__details button { display: inline-flex; align-items: center; gap: var(--sp-2); flex: none; }
.rc-runtime-row__actions { display: flex; align-items: center; justify-content: flex-end; gap: var(--sp-2); flex-wrap: wrap; }
@media (max-width: 767px) {
  .rc-agents-page { padding: var(--sp-4); gap: var(--sp-4); }
  .rc-product-page__header { align-items: start; padding-top: env(safe-area-inset-top, 0px); }
  .rc-product-page__header p { font-size: var(--fs-sm); }
  .rc-product-page__header button { min-width: var(--tap-min); width: var(--tap-min); padding: 0; justify-content: center; font-size: 0; }
  .rc-runtime-row__summary { display: grid; grid-template-columns: 32px minmax(0, 1fr) 15px; }
  .rc-runtime-row__icon { grid-column: 1; grid-row: 1 / 3; }
  .rc-runtime-row__name { grid-column: 2; grid-row: 1; }
  .rc-runtime-row__state { grid-column: 2; grid-row: 2; }
  .rc-runtime-row__summary > svg { grid-column: 3; grid-row: 1 / 3; }
  .rc-runtime-row__details { align-items: stretch; flex-direction: column; padding-left: var(--sp-4); }
  .rc-runtime-row__actions { display: grid; }
  .rc-runtime-row__details button { justify-content: center; }
}
`;
