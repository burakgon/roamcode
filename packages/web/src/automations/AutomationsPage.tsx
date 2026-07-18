import { useEffect, useMemo, useRef, useState } from "react";
import { ProductApiV2Error, type ProductApiV2Client } from "../api/v2/client";
import type {
  AgentRuntimeRecord,
  NodeRecord,
  SessionAutomationDefinition,
  SessionAutomationRun,
  SessionAutomationRunFailureBody,
  V2Session,
} from "../api/v2/types";
import { Button } from "../ui/Button";
import { Icon } from "../ui/Icon";
import { InlineConfirm } from "../ui/InlineConfirm";
import { useFocusTrap } from "../ui/useFocusTrap";
import type { CodexModel, ProviderDescriptor } from "../providers/types";
import type { ModelInfo } from "../types/server";
import { AutomationRuntimeOptions } from "./AutomationRuntimeOptions";
import "../styles/product-page.css";

export interface AutomationsPageProps {
  client: Pick<
    ProductApiV2Client,
    | "listAutomations"
    | "createAutomation"
    | "updateAutomation"
    | "deleteAutomation"
    | "runAutomation"
    | "listAutomationRuns"
    | "listNodes"
    | "listNodeRuntimes"
  >;
  onOpenSession: (session: V2Session) => void;
  onOpenSessionId?: (sessionId: string) => void;
  providerCatalog?: ProviderDescriptor[];
  claudeModels?: ModelInfo[];
  codexModels?: CodexModel[];
  codexProfiles?: string[];
  claudeMetadataState?: "loading" | "ready" | "unavailable";
  codexMetadataState?: "loading" | "ready" | "unavailable";
}

interface AutomationDraft {
  name: string;
  enabled: boolean;
  nodeId: string;
  agentRuntimeId: string;
  cwd: string;
  instruction: string;
  runtimeOptions: Record<string, unknown>;
}

type Editor =
  | { mode: "create"; draft: AutomationDraft }
  | { mode: "edit"; source: SessionAutomationDefinition; draft: AutomationDraft };

type HistoryLoadState = "loading" | "ready" | "error";

function draftFor(automation?: SessionAutomationDefinition, nodeId = "", agentRuntimeId = ""): AutomationDraft {
  return {
    name: automation?.name ?? "",
    enabled: automation?.enabled ?? true,
    nodeId: automation?.nodeId ?? nodeId,
    agentRuntimeId: automation?.agentRuntimeId ?? agentRuntimeId,
    cwd: automation?.cwd ?? "",
    instruction: automation?.instruction ?? "",
    runtimeOptions: automation?.runtimeOptions ?? {},
  };
}

function runFailureBody(value: unknown): SessionAutomationRunFailureBody | undefined {
  if (!value || typeof value !== "object") return undefined;
  const body = value as Partial<SessionAutomationRunFailureBody>;
  return typeof body.code === "string" && typeof body.error === "string"
    ? (body as SessionAutomationRunFailureBody)
    : undefined;
}

export function AutomationsPage({
  client,
  onOpenSession,
  onOpenSessionId,
  providerCatalog,
  claudeModels,
  codexModels,
  codexProfiles,
  claudeMetadataState,
  codexMetadataState,
}: AutomationsPageProps) {
  const [automations, setAutomations] = useState<SessionAutomationDefinition[]>([]);
  const [nodes, setNodes] = useState<NodeRecord[]>([]);
  const [runtimes, setRuntimes] = useState<Record<string, AgentRuntimeRecord[]>>({});
  const [runtimeErrors, setRuntimeErrors] = useState<Set<string>>(() => new Set());
  const [state, setState] = useState<"loading" | "ready" | "unsupported" | "error">("loading");
  const [error, setError] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const [recoverySession, setRecoverySession] = useState<V2Session>();
  const [editor, setEditor] = useState<Editor>();
  const [busy, setBusy] = useState<string>();
  const [deleteId, setDeleteId] = useState<string>();
  const [openHistoryId, setOpenHistoryId] = useState<string>();
  const [runs, setRuns] = useState<Record<string, SessionAutomationRun[]>>({});
  const [historyStates, setHistoryStates] = useState<Record<string, HistoryLoadState>>({});
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let alive = true;
    setState("loading");
    setError(undefined);
    void Promise.all([client.listAutomations(), client.listNodes()])
      .then(async ([nextAutomations, nextNodes]) => {
        const entries = await Promise.all(
          nextNodes.map(async (node) => {
            try {
              return [node.id, await client.listNodeRuntimes(node.id), false] as const;
            } catch {
              return [node.id, [] as AgentRuntimeRecord[], true] as const;
            }
          }),
        );
        if (!alive) return;
        setAutomations(nextAutomations);
        setNodes(nextNodes);
        setRuntimes(Object.fromEntries(entries.map(([nodeId, nodeRuntimes]) => [nodeId, nodeRuntimes])));
        setRuntimeErrors(new Set(entries.filter(([, , failed]) => failed).map(([nodeId]) => nodeId)));
        setState("ready");
      })
      .catch((caught: unknown) => {
        if (!alive) return;
        if (caught instanceof ProductApiV2Error && (caught.status === 404 || caught.status === 501)) {
          setState("unsupported");
          return;
        }
        setState("error");
        setError(caught instanceof Error ? caught.message : "Automations could not be loaded.");
      });
    return () => {
      alive = false;
    };
  }, [client, reload]);

  const runtimeById = useMemo(
    () =>
      new Map(
        Object.values(runtimes)
          .flat()
          .map((runtime) => [runtime.id, runtime]),
      ),
    [runtimes],
  );

  function openCreate() {
    const node =
      nodes.find(
        (candidate) =>
          candidate.status !== "offline" &&
          runtimes[candidate.id]?.some(
            (runtime) => runtime.availability === "available" && runtime.capabilities.includes("task-bootstrap"),
          ),
      ) ??
      nodes.find((candidate) => candidate.status !== "offline") ??
      nodes[0];
    const runtime = node
      ? runtimes[node.id]?.find(
          (candidate) => candidate.availability === "available" && candidate.capabilities.includes("task-bootstrap"),
        )
      : undefined;
    setEditor({ mode: "create", draft: draftFor(undefined, node?.id, runtime?.id) });
    setActionError(undefined);
  }

  async function saveEditor() {
    if (!editor) return;
    const common = {
      name: editor.draft.name.trim(),
      enabled: editor.draft.enabled,
      nodeId: editor.draft.nodeId,
      agentRuntimeId: editor.draft.agentRuntimeId,
      cwd: editor.draft.cwd.trim(),
      instruction: editor.draft.instruction.trim(),
      runtimeOptions: editor.draft.runtimeOptions,
      trigger: { type: "manual" as const },
    };
    setBusy("save");
    setActionError(undefined);
    try {
      const saved =
        editor.mode === "create"
          ? await client.createAutomation(common)
          : await client.updateAutomation(editor.source.id, { ...common, expectedRevision: editor.source.revision });
      setAutomations((current) =>
        editor.mode === "create" ? [saved, ...current] : current.map((item) => (item.id === saved.id ? saved : item)),
      );
      setEditor(undefined);
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : "Automation could not be saved.");
    } finally {
      setBusy(undefined);
    }
  }

  async function removeAutomation(id: string) {
    setBusy(`delete:${id}`);
    setActionError(undefined);
    try {
      await client.deleteAutomation(id);
      setAutomations((current) => current.filter((item) => item.id !== id));
      setDeleteId(undefined);
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : "Automation could not be deleted.");
    } finally {
      setBusy(undefined);
    }
  }

  async function runAutomation(automation: SessionAutomationDefinition) {
    setBusy(`run:${automation.id}`);
    setActionError(undefined);
    setRecoverySession(undefined);
    try {
      const result = await client.runAutomation(automation.id);
      setRuns((current) => ({ ...current, [automation.id]: [result.run, ...(current[automation.id] ?? [])] }));
      onOpenSession(result.session);
    } catch (caught) {
      if (caught instanceof ProductApiV2Error) {
        const body = runFailureBody(caught.body);
        if (body?.run)
          setRuns((current) => ({ ...current, [automation.id]: [body.run!, ...(current[automation.id] ?? [])] }));
        if (body?.session) setRecoverySession(body.session);
      }
      setActionError(caught instanceof Error ? caught.message : "Automation could not be started.");
    } finally {
      setBusy(undefined);
    }
  }

  async function toggleHistory(id: string) {
    if (openHistoryId === id) {
      setOpenHistoryId(undefined);
      return;
    }
    setOpenHistoryId(id);
    if (historyStates[id] === "ready") return;
    setHistoryStates((current) => ({ ...current, [id]: "loading" }));
    try {
      const history = await client.listAutomationRuns(id, 20);
      setRuns((current) => ({ ...current, [id]: history }));
      setHistoryStates((current) => ({ ...current, [id]: "ready" }));
    } catch (caught) {
      setHistoryStates((current) => ({ ...current, [id]: "error" }));
      setActionError(caught instanceof Error ? caught.message : "Run history could not be loaded.");
    }
  }

  return (
    <div className="rc-automations-page">
      <header className="rc-product-page__header">
        <div>
          <span className="rc-product-page__eyebrow">Repeatable coding work</span>
          <h1>Automations</h1>
          <p>
            Bind one instruction to an exact Node, agent runtime, and working directory. Every run creates a new
            Session.
          </p>
        </div>
        <Button variant="primary" onClick={openCreate} disabled={state !== "ready" || nodes.length === 0}>
          <Icon name="plus" size={16} /> New automation
        </Button>
      </header>

      {actionError && (
        <div className="rc-automation-alert" role="alert">
          <Icon name="alert" size={16} />
          <span>{actionError}</span>
          {recoverySession && <Button onClick={() => onOpenSession(recoverySession)}>Open started session</Button>}
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => {
              setActionError(undefined);
              setRecoverySession(undefined);
            }}
          >
            <Icon name="x" size={15} />
          </button>
        </div>
      )}

      {state === "ready" && runtimeErrors.size > 0 && (
        <div className="rc-automation-warning" role="status">
          <Icon name="alert" size={16} />
          <span>
            Runtime inventory is unavailable for {runtimeErrors.size === 1 ? "one Node" : `${runtimeErrors.size} Nodes`}
            . Existing automations remain visible, but affected targets cannot run.
          </span>
          <Button onClick={() => setReload((value) => value + 1)}>Retry</Button>
        </div>
      )}

      {state === "loading" && (
        <div className="rc-product-state" role="status">
          Loading coding automations…
        </div>
      )}
      {state === "unsupported" && (
        <div className="rc-product-state">
          <Icon name="bolt" size={22} />
          <strong>Coding automations are not available on this Node yet.</strong>
          <span>Update the Node to a release that supports the native v2 automation contract.</span>
        </div>
      )}
      {state === "error" && (
        <div className="rc-product-state rc-product-state--error" role="alert">
          <Icon name="alert" size={18} />
          <span>{error}</span>
          <Button onClick={() => setReload((value) => value + 1)}>Try again</Button>
        </div>
      )}
      {state === "ready" && automations.length === 0 && (
        <div className="rc-product-state">
          <Icon name="bolt" size={22} />
          <strong>{nodes.length === 0 ? "No Nodes available" : "No coding automations yet"}</strong>
          <span>
            {nodes.length === 0
              ? "Connect a Node or ask an administrator for access before creating an automation."
              : "Turn a task you repeat into a one-click Session."}
          </span>
        </div>
      )}
      {state === "ready" && automations.length > 0 && (
        <div className="rc-automation-list">
          {automations.map((automation) => {
            const runtime = runtimeById.get(automation.agentRuntimeId);
            const node = nodes.find((candidate) => candidate.id === automation.nodeId);
            const runtimeReady =
              node?.status !== "offline" &&
              runtime?.availability === "available" &&
              runtime.capabilities.includes("task-bootstrap") &&
              runtime.authState !== "required" &&
              runtime.authState !== "error";
            const targetStatus = !automation.enabled
              ? "Disabled"
              : runtimeErrors.has(automation.nodeId)
                ? "Runtime inventory unavailable"
                : !node
                  ? "Node unavailable"
                  : node.status === "offline"
                    ? "Node offline"
                    : !runtime
                      ? "Runtime unavailable"
                      : runtime.authState === "required"
                        ? "Sign-in required"
                        : runtime.authState === "error"
                          ? "Authentication error"
                          : runtimeReady
                            ? "Manual · Ready to run"
                            : "Runtime unavailable";
            return (
              <article className="rc-automation-card" key={automation.id}>
                <header>
                  <span className="rc-automation-card__icon" aria-hidden="true">
                    <Icon name="bolt" size={17} />
                  </span>
                  <span className="rc-automation-card__identity">
                    <h2>{automation.name}</h2>
                    <span>{targetStatus}</span>
                  </span>
                  <span
                    className={`rc-automation-card__enabled${automation.enabled ? " rc-automation-card__enabled--on" : ""}`}
                  >
                    {automation.enabled ? "Enabled" : "Disabled"}
                  </span>
                </header>
                <p>{automation.instruction}</p>
                <dl>
                  <div>
                    <dt>Node</dt>
                    <dd>{node?.name ?? automation.nodeId}</dd>
                  </div>
                  <div>
                    <dt>Agent</dt>
                    <dd>{runtime?.displayName ?? automation.provider}</dd>
                  </div>
                  <div>
                    <dt>Directory</dt>
                    <dd>{automation.cwd}</dd>
                  </div>
                </dl>
                <footer>
                  <Button
                    disabled={!automation.enabled || !runtimeReady || busy === `run:${automation.id}`}
                    onClick={() => void runAutomation(automation)}
                  >
                    <Icon name="arrow-right" size={15} />
                    {busy === `run:${automation.id}` ? "Starting…" : "Run now"}
                  </Button>
                  <Button
                    onClick={() => void toggleHistory(automation.id)}
                    aria-label={`${openHistoryId === automation.id ? "Hide" : "Show"} history for ${automation.name}`}
                    aria-expanded={openHistoryId === automation.id}
                    aria-controls={`automation-history-${automation.id}`}
                  >
                    History
                  </Button>
                  <Button onClick={() => setEditor({ mode: "edit", source: automation, draft: draftFor(automation) })}>
                    Edit
                  </Button>
                  <Button variant="danger" onClick={() => setDeleteId(automation.id)}>
                    Delete
                  </Button>
                </footer>
                {deleteId === automation.id && (
                  <InlineConfirm
                    message={`Delete ${automation.name}? Past runs and their Sessions stay available.`}
                    confirmLabel="Delete automation"
                    busy={busy === `delete:${automation.id}`}
                    onConfirm={() => void removeAutomation(automation.id)}
                    onCancel={() => setDeleteId(undefined)}
                  />
                )}
                {openHistoryId === automation.id && (
                  <div className="rc-automation-history" id={`automation-history-${automation.id}`} aria-live="polite">
                    {historyStates[automation.id] === "loading" ? (
                      <span role="status">Loading run history…</span>
                    ) : historyStates[automation.id] === "error" ? (
                      <span className="rc-automation-history__error" role="alert">
                        Run history could not be loaded. Close and retry.
                      </span>
                    ) : (runs[automation.id] ?? []).length === 0 ? (
                      <span>No runs yet.</span>
                    ) : (
                      (runs[automation.id] ?? []).map((run) => (
                        <button
                          type="button"
                          key={run.id}
                          onClick={() => onOpenSessionId?.(run.sessionId)}
                          disabled={!onOpenSessionId}
                        >
                          <span>{run.status.replace("-", " ")}</span>
                          <code>{run.sessionId}</code>
                          <Icon name="chevron-right" size={14} />
                        </button>
                      ))
                    )}
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}

      {editor && (
        <AutomationEditor
          editor={editor}
          nodes={nodes}
          runtimes={runtimes}
          busy={busy === "save"}
          error={actionError}
          providerCatalog={providerCatalog}
          claudeModels={claudeModels}
          codexModels={codexModels}
          codexProfiles={codexProfiles}
          claudeMetadataState={claudeMetadataState}
          codexMetadataState={codexMetadataState}
          onChange={setEditor}
          onSave={() => void saveEditor()}
          onClose={() => {
            setEditor(undefined);
            setActionError(undefined);
          }}
        />
      )}
      <style>{automationsCss}</style>
    </div>
  );
}

function AutomationEditor({
  editor,
  nodes,
  runtimes,
  busy,
  error,
  providerCatalog,
  claudeModels,
  codexModels,
  codexProfiles,
  claudeMetadataState,
  codexMetadataState,
  onChange,
  onSave,
  onClose,
}: {
  editor: Editor;
  nodes: NodeRecord[];
  runtimes: Record<string, AgentRuntimeRecord[]>;
  busy: boolean;
  error?: string;
  providerCatalog?: ProviderDescriptor[];
  claudeModels?: ModelInfo[];
  codexModels?: CodexModel[];
  codexProfiles?: string[];
  claudeMetadataState?: "loading" | "ready" | "unavailable";
  codexMetadataState?: "loading" | "ready" | "unavailable";
  onChange: (editor: Editor) => void;
  onSave: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  useFocusTrap(ref, true);
  useEffect(() => {
    nameRef.current?.focus();
  }, []);
  const draft = editor.draft;
  const availableRuntimes = (runtimes[draft.nodeId] ?? []).filter((runtime) =>
    runtime.capabilities.includes("task-bootstrap"),
  );
  const update = (next: Partial<AutomationDraft>) => onChange({ ...editor, draft: { ...draft, ...next } });
  const selectedRuntime = availableRuntimes.find((runtime) => runtime.id === draft.agentRuntimeId);
  const valid = draft.name.trim() && draft.nodeId && selectedRuntime && draft.cwd.trim() && draft.instruction.trim();
  return (
    <div
      className="rc-automation-editor__backdrop"
      role="presentation"
      onClick={(event) => event.target === event.currentTarget && !busy && onClose()}
    >
      <div
        ref={ref}
        className="rc-automation-editor rc-glass--float"
        role="dialog"
        aria-modal="true"
        aria-label={editor.mode === "create" ? "Create automation" : "Edit automation"}
        onKeyDown={(event) => {
          if (event.key === "Escape" && !busy) onClose();
        }}
      >
        <header>
          <div>
            <span>{editor.mode === "create" ? "New automation" : "Edit automation"}</span>
            <strong>Exact target, predictable run</strong>
          </div>
          <button type="button" aria-label="Close" onClick={onClose} disabled={busy}>
            <Icon name="x" size={17} />
          </button>
        </header>
        <div className="rc-automation-editor__fields">
          <label>
            <span>Name</span>
            <input
              ref={nameRef}
              aria-label="Automation name"
              value={draft.name}
              onChange={(event) => update({ name: event.target.value })}
              maxLength={80}
            />
          </label>
          <label>
            <span>Instruction</span>
            <textarea
              aria-label="Automation instruction"
              value={draft.instruction}
              onChange={(event) => update({ instruction: event.target.value })}
              rows={5}
            />
          </label>
          <div className="rc-automation-editor__target">
            <label>
              <span>Node</span>
              <select
                aria-label="Automation Node"
                value={draft.nodeId}
                onChange={(event) => {
                  const nodeId = event.target.value;
                  update({
                    nodeId,
                    agentRuntimeId:
                      runtimes[nodeId]?.find(
                        (runtime) =>
                          runtime.availability === "available" && runtime.capabilities.includes("task-bootstrap"),
                      )?.id ??
                      runtimes[nodeId]?.find((runtime) => runtime.capabilities.includes("task-bootstrap"))?.id ??
                      "",
                    runtimeOptions: {},
                  });
                }}
              >
                {nodes.map((node) => (
                  <option key={node.id} value={node.id}>
                    {node.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>Agent runtime</span>
              <select
                aria-label="Automation agent runtime"
                value={draft.agentRuntimeId}
                disabled={availableRuntimes.length === 0}
                onChange={(event) => update({ agentRuntimeId: event.target.value, runtimeOptions: {} })}
              >
                {availableRuntimes.map((runtime) => (
                  <option key={runtime.id} value={runtime.id}>
                    {runtime.displayName}
                  </option>
                ))}
              </select>
              {availableRuntimes.length === 0 && (
                <small>No automation-capable runtime is installed on this Node.</small>
              )}
            </label>
          </div>
          <label>
            <span>Working directory</span>
            <input
              aria-label="Automation working directory"
              value={draft.cwd}
              onChange={(event) => update({ cwd: event.target.value })}
              placeholder="/absolute/path/to/project"
            />
          </label>
          {selectedRuntime && (
            <details className="rc-automation-editor__advanced" open>
              <summary>
                Runtime options <span>{selectedRuntime.displayName}</span>
              </summary>
              <AutomationRuntimeOptions
                key={selectedRuntime.id}
                provider={selectedRuntime.provider}
                displayName={selectedRuntime.displayName}
                value={draft.runtimeOptions}
                onChange={(runtimeOptions) => update({ runtimeOptions })}
                providerCatalog={providerCatalog}
                claudeModels={claudeModels}
                codexModels={codexModels}
                codexProfiles={codexProfiles}
                claudeMetadataState={claudeMetadataState}
                codexMetadataState={codexMetadataState}
                disabled={busy}
              />
            </details>
          )}
          <label className="rc-automation-editor__toggle">
            <input
              type="checkbox"
              checked={draft.enabled}
              onChange={(event) => update({ enabled: event.target.checked })}
            />
            <span>Enabled</span>
          </label>
        </div>
        {error && (
          <div className="rc-automation-editor__error" role="alert">
            {error}
          </div>
        )}
        <footer>
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!valid || busy} onClick={onSave}>
            {busy ? "Saving…" : editor.mode === "create" ? "Create automation" : "Save changes"}
          </Button>
        </footer>
      </div>
    </div>
  );
}

const automationsCss = `
.rc-automations-page { width: min(100%,1120px); min-height:100%; margin:0 auto; display:grid; align-content:start; gap:var(--sp-5); padding:var(--sp-6); }
.rc-automation-alert { display:flex; align-items:center; gap:var(--sp-3); padding:var(--sp-3); color:var(--err); background:var(--err-soft); border:1px solid var(--err-line); border-radius:var(--radius); }
.rc-automation-alert > span { flex:1; }.rc-automation-alert > button:last-child { width:var(--tap-min); height:var(--tap-min); display:grid; place-items:center; background:transparent; border:0; color:inherit; cursor:pointer; }
.rc-automation-warning { display:flex; align-items:center; gap:var(--sp-3); padding:var(--sp-3); color:var(--warn); background:color-mix(in srgb,var(--warn) 8%,var(--surface)); border:1px solid color-mix(in srgb,var(--warn) 36%,var(--border)); border-radius:var(--radius); }
.rc-automation-warning > span { flex:1; color:var(--text-muted); line-height:1.45; }
.rc-automation-list { display:grid; grid-template-columns:repeat(auto-fit,minmax(min(100%,420px),1fr)); gap:var(--sp-4); }
.rc-automation-card { display:grid; align-content:start; gap:var(--sp-4); padding:var(--sp-4); background:var(--surface); border:1px solid var(--border); border-radius:var(--radius-lg); }
.rc-automation-card > header { display:flex; align-items:center; gap:var(--sp-3); }.rc-automation-card__icon { width:36px; height:36px; display:grid; place-items:center; background:var(--surface-2); border:1px solid var(--border); border-radius:var(--radius-sm); }
.rc-automation-card__identity { min-width:0; display:grid; gap:3px; flex:1; }.rc-automation-card__identity h2 { margin:0; overflow:hidden; font-size:var(--fs-base); text-overflow:ellipsis; white-space:nowrap; }.rc-automation-card__identity span,.rc-automation-card__enabled { color:var(--text-faint); font-size:var(--fs-xs); }.rc-automation-card__enabled--on { color:var(--text-muted); }
.rc-automation-card > p { margin:0; color:var(--text-muted); line-height:1.5; display:-webkit-box; -webkit-line-clamp:3; -webkit-box-orient:vertical; overflow:hidden; }
.rc-automation-card dl { display:grid; gap:var(--sp-2); margin:0; padding:var(--sp-3); background:var(--surface-2); border-radius:var(--radius-sm); }.rc-automation-card dl>div { display:grid; grid-template-columns:72px minmax(0,1fr); gap:var(--sp-2); }.rc-automation-card dt { color:var(--text-faint); font-size:var(--fs-xs); }.rc-automation-card dd { margin:0; overflow:hidden; color:var(--text); font-family:var(--font-mono); font-size:var(--fs-xs); text-overflow:ellipsis; white-space:nowrap; }
.rc-automation-card > footer { display:flex; gap:var(--sp-2); flex-wrap:wrap; }.rc-automation-card > footer button { display:inline-flex; align-items:center; gap:var(--sp-2); }
.rc-automation-history { display:grid; border-top:1px solid var(--border); padding-top:var(--sp-2); }.rc-automation-history>span { padding:var(--sp-3); color:var(--text-faint); font-size:var(--fs-sm); }.rc-automation-history>.rc-automation-history__error { color:var(--err); }.rc-automation-history>button { min-height:var(--tap-min); display:flex; align-items:center; gap:var(--sp-2); background:transparent; border:0; color:var(--text-muted); cursor:pointer; }.rc-automation-history code { min-width:0; flex:1; overflow:hidden; text-align:left; text-overflow:ellipsis; }
.rc-automation-editor__backdrop { position:fixed; inset:0; z-index:70; display:grid; place-items:center; padding:var(--sp-4); background:var(--scrim); }.rc-automation-editor { width:min(680px,100%); max-height:calc(100dvh - 2 * var(--sp-4)); display:flex; flex-direction:column; overflow:hidden; border-radius:var(--radius-lg); }
.rc-automation-editor>header { display:flex; align-items:center; gap:var(--sp-3); padding:var(--sp-4); border-bottom:1px solid var(--border); }.rc-automation-editor>header>div { display:grid; gap:3px; flex:1; }.rc-automation-editor>header span { color:var(--text-faint); font-size:var(--fs-xs); }.rc-automation-editor>header strong { font-family:var(--font-display); }.rc-automation-editor>header button { width:var(--tap-min); height:var(--tap-min); display:grid; place-items:center; background:transparent; border:0; color:var(--text-muted); cursor:pointer; }
.rc-automation-editor__fields { display:grid; gap:var(--sp-4); padding:var(--sp-4); overflow-y:auto; }.rc-automation-editor label { display:grid; gap:var(--sp-2); color:var(--text-muted); font-size:var(--fs-xs); }.rc-automation-editor input,.rc-automation-editor textarea,.rc-automation-editor select { width:100%; min-height:var(--tap-min); padding:var(--sp-2) var(--sp-3); background:var(--surface-2); border:1px solid var(--border-strong); border-radius:var(--radius-sm); color:var(--text); font:inherit; }.rc-automation-editor textarea { resize:vertical; line-height:1.5; }.rc-automation-editor__target { display:grid; grid-template-columns:1fr 1fr; gap:var(--sp-3); }
.rc-automation-editor__advanced { padding:var(--sp-3); background:var(--surface); border:1px solid var(--border); border-radius:var(--radius-sm); }.rc-automation-editor__advanced summary { cursor:pointer; color:var(--text); }.rc-automation-editor__advanced summary span { margin-left:var(--sp-2); color:var(--text-faint); font-size:var(--fs-xs); }.rc-automation-editor__advanced label { margin-top:var(--sp-3); }.rc-automation-editor__advanced textarea { font-family:var(--font-mono); font-size:var(--fs-xs); }.rc-automation-editor__advanced p { margin:var(--sp-2) 0 0; color:var(--text-faint); font-size:var(--fs-xs); line-height:1.45; }.rc-automation-editor__advanced [role="alert"] { display:block; margin-top:var(--sp-2); color:var(--err); }
.rc-automation-runtime-options { min-width:0; display:grid; gap:var(--sp-4); margin:var(--sp-3) 0 0; padding:var(--sp-3); border:1px solid var(--border); border-radius:var(--radius-sm); }
.rc-automation-runtime-options>legend { padding:0 var(--sp-1); color:var(--text-muted); font-size:var(--fs-xs); }
.rc-automation-runtime-options .rc-wizard__field { display:grid; gap:var(--sp-2); }
.rc-automation-runtime-options .rc-wizard__field-label { color:var(--text-muted); font-size:var(--fs-sm); }
.rc-automation-runtime-options .rc-wizard__help { color:var(--text-faint); font-size:var(--fs-xs); line-height:1.4; }
.rc-automation-runtime-options .rc-wizard__control { min-height:var(--tap-min); padding:0 var(--sp-3); background:var(--surface-2); border:1px solid var(--border); border-radius:var(--radius-sm); color:var(--text); font:inherit; }
.rc-automation-runtime-options .rc-wizard__advanced { background:var(--surface); border:1px solid var(--border); border-radius:var(--radius-sm); }
.rc-automation-runtime-options .rc-wizard__advanced>summary { min-height:var(--tap-min); display:flex; align-items:center; padding:0 var(--sp-3); color:var(--text-muted); cursor:pointer; font-size:var(--fs-sm); font-weight:600; }
.rc-automation-runtime-options .rc-wizard__advanced-body { display:grid; gap:var(--sp-4); padding:0 var(--sp-3) var(--sp-3); }
.rc-automation-runtime-options .rc-wizard__danger { min-height:var(--tap-min); display:flex; align-items:center; gap:var(--sp-2); color:var(--text); font-size:var(--fs-sm); }
.rc-automation-runtime-options .rc-wizard__danger input { width:20px; height:20px; accent-color:var(--err); }
.rc-automation-runtime-options .rc-wizard__danger--on { color:var(--err); }
.rc-automation-runtime-options .rc-wizard__danger-arm { display:grid; gap:var(--sp-2); padding:var(--sp-3); background:var(--err-soft); border:1px solid var(--err-line); border-radius:var(--radius-sm); }
.rc-automation-runtime-options .rc-wizard__danger-arm-text { margin:0; color:var(--text); font-size:var(--fs-sm); line-height:1.45; }
.rc-automation-runtime-options .rc-wizard__danger-arm-row { display:flex; gap:var(--sp-2); }
.rc-automation-runtime-options .rc-wizard__danger-arm-yes,.rc-automation-runtime-options .rc-wizard__danger-arm-no { min-height:var(--tap-min); padding:0 var(--sp-3); border-radius:var(--radius-sm); cursor:pointer; font:inherit; }
.rc-automation-runtime-options .rc-wizard__danger-arm-yes { background:var(--err); border:1px solid var(--err); color:#fff; font-weight:600; }
.rc-automation-runtime-options .rc-wizard__danger-arm-no { background:transparent; border:1px solid var(--border-strong); color:var(--text-muted); }
.rc-automation-runtime-options .rc-wizard__cancel { min-height:var(--tap-min); padding:0 var(--sp-3); background:transparent; border:1px solid var(--border-strong); border-radius:var(--radius-sm); color:var(--text); cursor:pointer; }
.rc-automation-editor__toggle { display:flex!important; grid-template-columns:auto 1fr; align-items:center; }.rc-automation-editor__toggle input { width:18px; min-height:18px; accent-color:var(--accent); }.rc-automation-editor__error { margin:0 var(--sp-4); padding:var(--sp-3); color:var(--err); background:var(--err-soft); border:1px solid var(--err-line); border-radius:var(--radius-sm); }.rc-automation-editor>footer { display:flex; justify-content:flex-end; gap:var(--sp-2); padding:var(--sp-4); border-top:1px solid var(--border); }
@media(max-width:767px){.rc-automations-page{padding:var(--sp-4);gap:var(--sp-4)}.rc-product-page__header{align-items:start;flex-direction:column;padding-top:env(safe-area-inset-top,0px)}.rc-product-page__header>button{width:100%;justify-content:center}.rc-automation-warning{align-items:stretch;flex-direction:column}.rc-automation-editor__backdrop{place-items:end center;padding:0}.rc-automation-editor{max-height:92dvh;border-bottom-left-radius:0;border-bottom-right-radius:0}.rc-automation-editor__target{grid-template-columns:1fr}.rc-automation-card>footer{display:grid;grid-template-columns:1fr 1fr}.rc-automation-card>footer button{justify-content:center}}
`;
