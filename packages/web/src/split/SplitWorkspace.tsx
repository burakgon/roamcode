import { useRef, type ReactNode } from "react";
import type { SessionMeta } from "../types/server";
import { leaves, setRatio, type BranchNode, type DropEdge, type LeafNode, type SplitTree } from "./layout";

/**
 * The desktop split-screen workspace — a dumb projection of the layout tree (split/layout.ts): recursive
 * flex rows/cols, a draggable divider per split, a focus ring on the active pane, and a session picker in
 * empty panes. All MUTATIONS go through the callbacks (App owns the tree + persistence); the terminal
 * itself is rendered by the App-provided `renderTerminal` so every TerminalView keeps its existing wiring
 * (close/settings/needs-you) — this component never touches sockets or xterm.
 */
export interface SplitWorkspaceProps {
  tree: SplitTree;
  focusedLeafId: string;
  sessions: SessionMeta[];
  onFocusPane: (leafId: string) => void;
  /** Ratio changes from divider drags (the only tree mutation this component performs itself). */
  onTreeChange: (tree: SplitTree) => void;
  onPickSession: (leafId: string, sessionId: string) => void;
  onNewSessionInPane: (leafId: string) => void;
  renderTerminal: (session: SessionMeta, pane: { leafId: string; focused: boolean; multi: boolean }) => ReactNode;
}

export function SplitWorkspace({
  tree,
  focusedLeafId,
  sessions,
  onFocusPane,
  onTreeChange,
  onPickSession,
  onNewSessionInPane,
  renderTerminal,
}: SplitWorkspaceProps) {
  const multi = leaves(tree).length > 1;
  // Sessions already visible in some pane — the empty-pane picker offers only the REST (one session may
  // show in at most one pane; two attachments would fight over the pty size).
  const visible = new Set(leaves(tree).map((l) => l.sessionId));

  function renderNode(node: SplitTree): ReactNode {
    if (node.type === "leaf") {
      return (
        <PaneShell
          key={node.id}
          leaf={node}
          focused={multi && node.id === focusedLeafId}
          onFocus={() => onFocusPane(node.id)}
        >
          {renderLeafContent(node)}
        </PaneShell>
      );
    }
    return (
      <BranchBox key={node.id} node={node} onRatio={(r) => onTreeChange(setRatio(tree, node.id, r))}>
        {renderNode(node.a)}
        {renderNode(node.b)}
      </BranchBox>
    );
  }

  function renderLeafContent(leaf: LeafNode): ReactNode {
    const session = leaf.sessionId ? sessions.find((s) => s.id === leaf.sessionId) : undefined;
    if (session) return renderTerminal(session, { leafId: leaf.id, focused: leaf.id === focusedLeafId, multi });
    // Empty pane → pick a session that isn't already on screen, or start a new one.
    const pickable = sessions.filter((s) => !visible.has(s.id));
    return (
      <div className="rc-split__empty">
        <span className="rc-split__empty-title">Pick a session for this pane</span>
        {pickable.length > 0 && (
          <ul className="rc-split__empty-list">
            {pickable.map((s) => (
              <li key={s.id}>
                <button type="button" className="rc-split__empty-row" onClick={() => onPickSession(leaf.id, s.id)}>
                  <span className="rc-split__empty-name">{basename(s.cwd)}</span>
                  <span className="rc-split__empty-meta">{s.awaiting ? "needs you" : (s.activity ?? s.status)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <button type="button" className="rc-split__empty-new" onClick={() => onNewSessionInPane(leaf.id)}>
          + New session
        </button>
      </div>
    );
  }

  return (
    <div className="rc-split-root">
      {renderNode(tree)}
      <style>{workspaceCss}</style>
    </div>
  );
}

function basename(p: string): string {
  const parts = p.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || p;
}

/** One pane cell: fills its flex slot, reports focus on ANY pointer-down inside (capture phase so xterm
 *  still receives the event — focusing must never steal the click). */
function PaneShell({
  leaf,
  focused,
  onFocus,
  children,
}: {
  leaf: LeafNode;
  focused: boolean;
  onFocus: () => void;
  children: ReactNode;
}) {
  return (
    <div
      className={`rc-split__pane${focused ? " rc-split__pane--focused" : ""}`}
      data-leaf={leaf.id}
      onPointerDownCapture={onFocus}
    >
      {children}
    </div>
  );
}

/** A split container: two children + the draggable divider. The divider drags with pointer capture and
 *  reports the ratio from the pointer's position within THIS box (clamping lives in the tree op). */
function BranchBox({
  node,
  onRatio,
  children,
}: {
  node: BranchNode;
  onRatio: (ratio: number) => void;
  children: [ReactNode, ReactNode];
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const row = node.dir === "row";
  return (
    <div ref={boxRef} className={`rc-split__box rc-split__box--${node.dir}`}>
      <div className="rc-split__cell" style={{ flexGrow: node.ratio }}>
        {children[0]}
      </div>
      <div
        className={`rc-split__divider rc-split__divider--${node.dir}`}
        role="separator"
        aria-orientation={row ? "vertical" : "horizontal"}
        aria-label="Resize panes"
        onPointerDown={(e) => {
          // Capture on the divider so the drag keeps reporting even when the pointer crosses the panes
          // (and the terminals underneath never see the moves).
          e.preventDefault();
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
          const rect = boxRef.current?.getBoundingClientRect();
          if (!rect) return;
          onRatio(row ? (e.clientX - rect.left) / rect.width : (e.clientY - rect.top) / rect.height);
        }}
        onPointerUp={(e) => e.currentTarget.releasePointerCapture(e.pointerId)}
      />
      <div className="rc-split__cell" style={{ flexGrow: 1 - node.ratio }}>
        {children[1]}
      </div>
    </div>
  );
}

const workspaceCss = /* css */ `
.rc-split-root { display: flex; flex: 1 1 auto; min-height: 0; min-width: 0; }
.rc-split-root > * { flex: 1 1 auto; min-height: 0; min-width: 0; }
.rc-split__box { display: flex; min-height: 0; min-width: 0; }
.rc-split__box--row { flex-direction: row; }
.rc-split__box--col { flex-direction: column; }
/* flex-grow carries the ratio; basis 0 so shares are exact regardless of content. */
.rc-split__cell { display: flex; flex-basis: 0; min-height: 0; min-width: 0; }
.rc-split__cell > * { flex: 1 1 auto; min-height: 0; min-width: 0; }
/* The divider: a hairline with a comfortable grab area; brightens while grabbed/hovered. */
.rc-split__divider { flex: none; position: relative; background: var(--border-strong); touch-action: none; }
.rc-split__divider--row { width: 5px; cursor: col-resize; }
.rc-split__divider--col { height: 5px; cursor: row-resize; }
.rc-split__divider:hover, .rc-split__divider:active { background: var(--accent-line); }
/* A pane: the flex cell around one TerminalView (or the picker). In multi-pane layouts the FOCUSED pane
   carries a quiet inset ring so "which pane my keys go to" is always visible (never color-only for state —
   focus also follows the terminal cursor). */
.rc-split__pane { display: flex; flex-direction: column; min-height: 0; min-width: 0; position: relative; }
.rc-split__pane--focused { box-shadow: inset 0 0 0 1px var(--accent-line); }
/* The empty pane's session picker — quiet, centered, mono. */
.rc-split__empty {
  flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: var(--sp-3); padding: var(--sp-5); background: var(--bg); min-height: 0; overflow-y: auto;
}
.rc-split__empty-title { color: var(--text-muted); font-size: var(--fs-sm); }
.rc-split__empty-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; width: min(320px, 90%); }
.rc-split__empty-row {
  width: 100%; display: flex; align-items: center; justify-content: space-between; gap: var(--sp-3);
  padding: 9px 12px; border-radius: var(--radius-sm); cursor: pointer;
  background: var(--surface); border: 1px solid var(--border); color: var(--text);
  font-family: var(--font-mono); font-size: var(--fs-sm);
}
.rc-split__empty-row:hover { border-color: var(--border-strong); background: var(--surface-2); }
.rc-split__empty-name { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.rc-split__empty-meta { color: var(--text-faint); font-size: var(--fs-xs); flex: none; }
.rc-split__empty-new {
  padding: 9px 16px; border-radius: var(--radius-sm); cursor: pointer;
  background: transparent; border: 1px solid var(--border-strong); color: var(--text-muted);
  font-size: var(--fs-sm);
}
.rc-split__empty-new:hover { color: var(--text); border-color: var(--accent-line); }
`;
