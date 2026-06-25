import { useEffect, useRef } from "react";
import { Icon } from "../ui/Icon";
import { useFocusTrap } from "../ui/useFocusTrap";
import { Markdown } from "./Markdown";
import { MessageList } from "./MessageList";
import { emptyView, subagentResultText } from "../store/frame-reducer";
import type { SubagentThread } from "../store/frame-reducer";
import { AgentGlyph, SubagentDot, formatUsage, statusLabel } from "./subagent-ui";

/**
 * The SUBAGENT DRILL-IN — a full-bleed sheet (modeled on SettingsPanel) showing one subagent's live
 * chat: the Task it was given, its transcript (reusing <MessageList> so it looks identical to the main
 * chat — its tool calls + prose, and any NESTED subagent cards), and its final Result. A depth-2
 * subagent (no inline turns) shows Task + status + Result only, with a quiet "nested" note.
 */
export function SubagentView({
  thread,
  subagents,
  onOpenSubagent,
  onClose,
  downloadUrl,
}: {
  thread: SubagentThread;
  /** The full registry, so the transcript can render nested subagent cards. */
  subagents: Record<string, SubagentThread>;
  /** Open a nested subagent reachable from this transcript. */
  onOpenSubagent: (id: string) => void;
  onClose: () => void;
  downloadUrl?: (path: string) => string;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(dialogRef);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const type = thread.type ?? "subagent";
  const running = thread.status === "running";
  const usage = formatUsage(thread.usage);
  const nested = thread.parentId !== undefined;
  // Depth-2 subagents never inline their internal steps — only status + result are known.
  const hasTranscript = thread.turns.length > 0;
  const resultText = subagentResultText(thread.result?.content);

  // Synthesize a SessionView so <MessageList> renders this thread's turns identically to the main chat.
  const transcriptView = {
    ...emptyView(),
    turns: thread.turns,
    subagents,
    liveText: thread.liveText,
    thinkingText: thread.thinkingText,
    wireState: thread.wireState,
  };

  return (
    <div ref={dialogRef} role="dialog" aria-modal="true" aria-label={`${type} subagent`} className="rc-sa-view">
      <header className="rc-sa-view__head">
        <button type="button" className="rc-sa-view__close" onClick={onClose} aria-label="Back">
          <Icon name="chevron-right" size={18} style={{ transform: "rotate(180deg)" }} />
        </button>
        <AgentGlyph status={thread.status} size={36} />
        <span className="rc-sa-view__titles">
          <span className="rc-sa-view__type">{type}</span>
          {thread.description && <span className="rc-sa-view__desc">{thread.description}</span>}
        </span>
        <span className="rc-sa-view__status">
          <SubagentDot status={thread.status} />
          <span style={{ color: thread.status === "failed" ? "var(--err)" : "var(--text-muted)" }}>
            {statusLabel(thread.status)}
          </span>
        </span>
      </header>

      <div className="rc-sa-view__body">
        {usage && (
          <div className="rc-sa-view__usage" aria-label="usage">
            {usage}
          </div>
        )}

        {/* (1) The Task this subagent was dispatched with. */}
        {thread.prompt && (
          <section className="rc-sa-view__section">
            <div className="rc-sa-view__label">Task</div>
            <div className="rc-sa-view__task">{thread.prompt}</div>
          </section>
        )}

        {/* (2) The subagent's transcript (its tool calls + prose), or the nested note for depth-2. */}
        {hasTranscript ? (
          <section className="rc-sa-view__section">
            <div className="rc-sa-view__label">Transcript</div>
            <MessageList view={transcriptView} subagents={subagents} onOpenSubagent={onOpenSubagent} downloadUrl={downloadUrl} />
            {running && (
              <div className="rc-sa-view__working" role="status">
                <SubagentDot status="running" />
                Working…
              </div>
            )}
          </section>
        ) : nested ? (
          <p className="rc-sa-view__note">Nested — its internal steps run inside its parent subagent.</p>
        ) : running ? (
          <div className="rc-sa-view__working" role="status">
            <SubagentDot status="running" />
            Working…
          </div>
        ) : null}

        {/* (3) The final return value. */}
        {resultText && (
          <section className="rc-sa-view__section">
            <div className="rc-sa-view__label">Result</div>
            <div className="rc-sa-view__result">
              <Markdown>{resultText}</Markdown>
            </div>
          </section>
        )}
      </div>

      <style>{viewCss}</style>
    </div>
  );
}

const viewCss = `
.rc-sa-view {
  position: fixed; inset: 0; z-index: 60;
  background-color: var(--bg);
  background-image: var(--top-glow);
  display: flex; flex-direction: column;
  animation: rc-sa-view-in 0.2s ease-out;
}
@keyframes rc-sa-view-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
.rc-sa-view__head {
  display: flex; align-items: center; gap: var(--sp-3);
  padding: var(--sp-3) var(--sp-4);
  border-bottom: 1px solid var(--border);
  background: var(--surface);
}
.rc-sa-view__close {
  width: var(--tap-min); height: var(--tap-min); flex: none;
  display: grid; place-items: center;
  background: transparent; border: none; cursor: pointer;
  color: var(--text-muted); border-radius: var(--radius);
}
.rc-sa-view__close:hover { color: var(--text); background: var(--surface-2); }
.rc-sa-view__titles { display: grid; gap: 2px; min-width: 0; flex: 1; }
.rc-sa-view__type {
  font-family: var(--font-mono); font-size: 11px; letter-spacing: 0.06em; text-transform: uppercase;
  color: var(--text-muted);
}
.rc-sa-view__desc {
  font-family: var(--font-display); font-weight: 600; font-size: var(--fs-base); color: var(--text);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.rc-sa-view__status {
  display: inline-flex; align-items: center; gap: 6px; flex: none;
  font-family: var(--font-mono); font-size: var(--fs-xs);
}
.rc-sa-view__body { flex: 1; overflow-y: auto; padding: var(--sp-4); display: grid; gap: var(--sp-4); align-content: start; }
.rc-sa-view__usage {
  font-family: var(--font-mono); font-size: var(--fs-xs); color: var(--text-faint);
  background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--radius-pill);
  padding: 2px var(--sp-3); justify-self: start;
}
.rc-sa-view__section { display: grid; gap: var(--sp-2); }
.rc-sa-view__label {
  font-family: var(--font-display); font-size: 10px; letter-spacing: 0.08em; text-transform: uppercase;
  color: var(--text-faint);
}
.rc-sa-view__task {
  background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius);
  box-shadow: var(--shadow-1);
  padding: var(--sp-3); color: var(--text-muted); font-size: var(--fs-sm); line-height: 1.5;
  white-space: pre-wrap; overflow-wrap: anywhere;
}
.rc-sa-view__result {
  background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius);
  box-shadow: var(--shadow-1); padding: var(--sp-3) var(--sp-4); color: var(--text);
}
.rc-sa-view__working {
  display: inline-flex; align-items: center; gap: var(--sp-2);
  color: var(--text-muted); font-family: var(--font-mono); font-size: var(--fs-xs);
}
.rc-sa-view__note {
  color: var(--text-muted); font-size: var(--fs-sm); margin: 0;
  background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius);
  padding: var(--sp-3); line-height: 1.5;
}
`;
