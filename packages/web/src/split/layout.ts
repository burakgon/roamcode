/**
 * The split-screen layout model — an iTerm2-style BINARY SPLIT TREE, kept deliberately pure (no DOM, no
 * React) so every operation is unit-testable and the renderer (SplitWorkspace) is a dumb projection of it.
 *
 *   leaf  — one pane, showing one session (or empty → the pane renders a session picker).
 *   split — two children side by side (`row`, vertical divider) or stacked (`col`, horizontal divider),
 *           with `ratio` = the first child's share (0..1, clamped so no pane can collapse).
 *
 * All operations return a NEW tree (never mutate) — React state-friendly. The tree + focus persist per
 * browser in localStorage (a device preference, like session names / the theme).
 */

export type SplitDir = "row" | "col";
/** Which side of a target pane a drop lands on — determines the split direction + order. */
export type DropEdge = "left" | "right" | "top" | "bottom";

export interface LeafNode {
  type: "leaf";
  id: string;
  /** The session this pane shows; undefined = an empty pane (renders the picker). */
  sessionId?: string;
}
export interface BranchNode {
  type: "split";
  id: string;
  dir: SplitDir;
  /** First child's share of the axis, clamped to [MIN_RATIO, 1-MIN_RATIO] so a pane can't collapse. */
  ratio: number;
  a: SplitTree;
  b: SplitTree;
}
export type SplitTree = LeafNode | BranchNode;

/** No pane may shrink below 15% of its axis — keeps every divider grabbable and every terminal readable. */
export const MIN_RATIO = 0.15;

const clampRatio = (r: number): number => Math.min(1 - MIN_RATIO, Math.max(MIN_RATIO, r));

let idCounter = 0;
/** Node ids only need uniqueness within one tree; a counter + random suffix avoids a crypto dependency. */
function newId(): string {
  idCounter += 1;
  return `n${idCounter.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function makeLeaf(sessionId?: string): LeafNode {
  return sessionId === undefined ? { type: "leaf", id: newId() } : { type: "leaf", id: newId(), sessionId };
}

/** All leaves, left-to-right / top-to-bottom (the visual reading order). */
export function leaves(tree: SplitTree): LeafNode[] {
  if (tree.type === "leaf") return [tree];
  return [...leaves(tree.a), ...leaves(tree.b)];
}

export function findLeaf(tree: SplitTree, leafId: string): LeafNode | undefined {
  return leaves(tree).find((l) => l.id === leafId);
}

export function findLeafBySession(tree: SplitTree, sessionId: string): LeafNode | undefined {
  return leaves(tree).find((l) => l.sessionId === sessionId);
}

/** Map a drop edge to the split geometry: left/right → side-by-side, top/bottom → stacked; left/top puts
 *  the NEW pane first. */
function edgeToSplit(edge: DropEdge): { dir: SplitDir; newFirst: boolean } {
  switch (edge) {
    case "left":
      return { dir: "row", newFirst: true };
    case "right":
      return { dir: "row", newFirst: false };
    case "top":
      return { dir: "col", newFirst: true };
    case "bottom":
      return { dir: "col", newFirst: false };
  }
}

/** Split the leaf `leafId` along `edge`, placing `newLeaf` on that edge (50/50). No-op if the leaf is missing. */
export function splitLeaf(tree: SplitTree, leafId: string, edge: DropEdge, newLeaf: LeafNode): SplitTree {
  if (tree.type === "leaf") {
    if (tree.id !== leafId) return tree;
    const { dir, newFirst } = edgeToSplit(edge);
    return {
      type: "split",
      id: newId(),
      dir,
      ratio: 0.5,
      a: newFirst ? newLeaf : tree,
      b: newFirst ? tree : newLeaf,
    };
  }
  const a = splitLeaf(tree.a, leafId, edge, newLeaf);
  const b = a === tree.a ? splitLeaf(tree.b, leafId, edge, newLeaf) : tree.b;
  if (a === tree.a && b === tree.b) return tree;
  return { ...tree, a, b };
}

/** Remove a leaf; its sibling replaces the parent split (iTerm2 collapse). Removing the ROOT leaf returns
 *  undefined — the caller decides what an empty workspace means (App keeps a single empty leaf). */
export function removeLeaf(tree: SplitTree, leafId: string): SplitTree | undefined {
  if (tree.type === "leaf") return tree.id === leafId ? undefined : tree;
  const a = removeLeaf(tree.a, leafId);
  if (a === undefined) return tree.b;
  const b = removeLeaf(tree.b, leafId);
  if (b === undefined) return a === tree.a ? tree.a : { ...tree, a };
  if (a === tree.a && b === tree.b) return tree;
  return { ...tree, a, b };
}

/** Point a leaf at a (different) session — or clear it (undefined → empty pane / picker). */
export function setLeafSession(tree: SplitTree, leafId: string, sessionId: string | undefined): SplitTree {
  if (tree.type === "leaf") {
    if (tree.id !== leafId) return tree;
    // Rebuild the leaf plainly (no spread-with-omit) so clearing really DROPS the key — a `sessionId:
    // undefined` property would survive JSON round-trips as null-ish noise and trip the loader's validation.
    return sessionId === undefined ? { type: "leaf", id: tree.id } : { type: "leaf", id: tree.id, sessionId };
  }
  const a = setLeafSession(tree.a, leafId, sessionId);
  const b = a === tree.a ? setLeafSession(tree.b, leafId, sessionId) : tree.b;
  if (a === tree.a && b === tree.b) return tree;
  return { ...tree, a, b };
}

/** Set a split's ratio (divider drag), clamped so neither side can collapse. */
export function setRatio(tree: SplitTree, splitId: string, ratio: number): SplitTree {
  if (tree.type === "leaf") return tree;
  if (tree.id === splitId) return { ...tree, ratio: clampRatio(ratio) };
  const a = setRatio(tree.a, splitId, ratio);
  const b = a === tree.a ? setRatio(tree.b, splitId, ratio) : tree.b;
  if (a === tree.a && b === tree.b) return tree;
  return { ...tree, a, b };
}

/**
 * Move leaf `srcId` onto `targetId`'s `edge` (the drag-to-rearrange gesture): the source pane is removed
 * (its old spot collapses) and re-inserted as a new split of the target. Also how "change the split
 * direction" works — drop the same neighbour on a different edge. No-op when src === target, when either
 * is missing, or when removing src would orphan the target (they're the only two panes? that's fine —
 * removing src collapses to target, then target splits again; handled naturally).
 */
export function moveLeaf(tree: SplitTree, srcId: string, targetId: string, edge: DropEdge): SplitTree {
  if (srcId === targetId) return tree;
  const src = findLeaf(tree, srcId);
  if (!src || !findLeaf(tree, targetId)) return tree;
  const without = removeLeaf(tree, srcId);
  if (without === undefined) return tree; // src was the root's only leaf — nothing to move onto
  if (!findLeaf(without, targetId)) return tree; // defensive: target vanished with the collapse (shouldn't happen)
  return splitLeaf(without, targetId, edge, src);
}

/** Swap the SESSIONS of two panes (drop on a pane's center) — geometry stays, contents trade places. */
export function swapLeafSessions(tree: SplitTree, aId: string, bId: string): SplitTree {
  const la = findLeaf(tree, aId);
  const lb = findLeaf(tree, bId);
  if (!la || !lb || aId === bId) return tree;
  return setLeafSession(setLeafSession(tree, aId, lb.sessionId), bId, la.sessionId);
}

/**
 * Reconcile the tree with the LIVE session list: panes pointing at sessions that no longer exist collapse
 * (single pane → cleared to the empty picker instead), and a session shown in TWO panes keeps only the
 * first (duplicates cleared) — two attachments of one session would fight over the pty size.
 */
export function normalize(tree: SplitTree, liveSessionIds: ReadonlySet<string>): SplitTree {
  const seen = new Set<string>();
  let out = tree;
  for (const leaf of leaves(tree)) {
    if (leaf.sessionId === undefined) continue;
    if (!liveSessionIds.has(leaf.sessionId)) {
      const removed = removeLeaf(out, leaf.id);
      out = removed ?? setLeafSession(out, leaf.id, undefined);
    } else if (seen.has(leaf.sessionId)) {
      out = setLeafSession(out, leaf.id, undefined);
    } else {
      seen.add(leaf.sessionId);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Persistence — the tree + focused pane, per browser. Defensive load: any malformed node invalidates the
// whole stored layout (fall back to a fresh single pane) rather than rendering a corrupt workspace.
// ---------------------------------------------------------------------------

const KEY = "remote-coder.split-layout";

export interface StoredLayout {
  tree: SplitTree;
  focusedLeafId: string;
}

function isValidNode(n: unknown): n is SplitTree {
  if (typeof n !== "object" || n === null) return false;
  const node = n as Record<string, unknown>;
  if (node.type === "leaf") {
    return typeof node.id === "string" && (node.sessionId === undefined || typeof node.sessionId === "string");
  }
  if (node.type === "split") {
    return (
      typeof node.id === "string" &&
      (node.dir === "row" || node.dir === "col") &&
      typeof node.ratio === "number" &&
      node.ratio >= MIN_RATIO &&
      node.ratio <= 1 - MIN_RATIO &&
      isValidNode(node.a) &&
      isValidNode(node.b)
    );
  }
  return false;
}

export function loadLayout(): StoredLayout | undefined {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as Partial<StoredLayout>;
    if (!parsed.tree || !isValidNode(parsed.tree) || typeof parsed.focusedLeafId !== "string") return undefined;
    const focused = findLeaf(parsed.tree, parsed.focusedLeafId) ?? leaves(parsed.tree)[0];
    if (!focused) return undefined;
    return { tree: parsed.tree, focusedLeafId: focused.id };
  } catch {
    return undefined;
  }
}

export function saveLayout(layout: StoredLayout): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(layout));
  } catch {
    /* private mode — the layout just won't persist */
  }
}
