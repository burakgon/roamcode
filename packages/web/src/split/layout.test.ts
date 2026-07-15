import { afterEach, describe, expect, test } from "vitest";
import {
  MIN_RATIO,
  findLeaf,
  findLeafBySession,
  leaves,
  loadLayout,
  makeLeaf,
  moveLeaf,
  normalize,
  removeLeaf,
  saveLayout,
  setLeafSession,
  setRatio,
  splitLeaf,
  swapLeafSessions,
  type BranchNode,
  type SplitTree,
} from "./layout";

afterEach(() => localStorage.clear());

/** a | b side-by-side (b added on a's right). */
function rowAB(): { tree: SplitTree; a: string; b: string } {
  const a = makeLeaf("sA");
  const b = makeLeaf("sB");
  return { tree: splitLeaf(a, a.id, "right", b), a: a.id, b: b.id };
}

describe("splitLeaf", () => {
  test("right/left → a row; top/bottom → a col; left/top place the NEW pane first", () => {
    const base = makeLeaf("s1");
    const fresh = makeLeaf("s2");

    const right = splitLeaf(base, base.id, "right", fresh) as BranchNode;
    expect(right.type).toBe("split");
    expect(right.dir).toBe("row");
    expect(right.ratio).toBe(0.5);
    expect(leaves(right).map((l) => l.sessionId)).toEqual(["s1", "s2"]); // existing stays first

    const left = splitLeaf(base, base.id, "left", fresh) as BranchNode;
    expect(left.dir).toBe("row");
    expect(leaves(left).map((l) => l.sessionId)).toEqual(["s2", "s1"]); // new pane lands on the left

    const top = splitLeaf(base, base.id, "top", fresh) as BranchNode;
    expect(top.dir).toBe("col");
    expect(leaves(top).map((l) => l.sessionId)).toEqual(["s2", "s1"]);

    const bottom = splitLeaf(base, base.id, "bottom", fresh) as BranchNode;
    expect(bottom.dir).toBe("col");
    expect(leaves(bottom).map((l) => l.sessionId)).toEqual(["s1", "s2"]);
  });

  test("splits a NESTED leaf without touching siblings (structural sharing elsewhere)", () => {
    const { tree, b } = rowAB();
    const c = makeLeaf("sC");
    const next = splitLeaf(tree, b, "bottom", c) as BranchNode;
    expect(leaves(next).map((l) => l.sessionId)).toEqual(["sA", "sB", "sC"]);
    expect((next as BranchNode).a).toBe((tree as BranchNode).a); // untouched branch keeps identity
  });

  test("unknown leaf id → identical tree back", () => {
    const { tree } = rowAB();
    expect(splitLeaf(tree, "nope", "right", makeLeaf())).toBe(tree);
  });
});

describe("removeLeaf", () => {
  test("collapses the parent — the sibling takes its place", () => {
    const { tree, a, b } = rowAB();
    const next = removeLeaf(tree, a);
    expect(next && next.type).toBe("leaf");
    expect(next && (next as { id: string }).id).toBe(b);
  });

  test("removing the root's only leaf returns undefined (caller decides the empty state)", () => {
    const solo = makeLeaf("s1");
    expect(removeLeaf(solo, solo.id)).toBeUndefined();
  });

  test("deep collapse keeps the rest of the tree intact", () => {
    const { tree, b } = rowAB();
    const c = makeLeaf("sC");
    const three = splitLeaf(tree, b, "bottom", c);
    const next = removeLeaf(three, b);
    expect(next && leaves(next).map((l) => l.sessionId)).toEqual(["sA", "sC"]);
  });
});

describe("moveLeaf (drag-to-rearrange)", () => {
  test("re-drops a pane on another pane's edge — also how the split DIRECTION changes", () => {
    const { tree, a, b } = rowAB(); // A | B
    const stacked = moveLeaf(tree, b, a, "top") as BranchNode; // drop B on A's top → B over A
    expect(stacked.dir).toBe("col");
    expect(leaves(stacked).map((l) => l.sessionId)).toEqual(["sB", "sA"]);
  });

  test("src === target, or a missing pane, is a no-op", () => {
    const { tree, a } = rowAB();
    expect(moveLeaf(tree, a, a, "left")).toBe(tree);
    expect(moveLeaf(tree, "nope", a, "left")).toBe(tree);
    expect(moveLeaf(tree, a, "nope", "left")).toBe(tree);
  });

  test("three panes: moving one across the tree preserves the other two's order", () => {
    const { tree, a, b } = rowAB();
    const c = makeLeaf("sC");
    const three = splitLeaf(tree, b, "bottom", c); // A | (B / C)
    const moved = moveLeaf(three, a, c.id, "bottom"); // A dropped below C
    expect(leaves(moved).map((l) => l.sessionId)).toEqual(["sB", "sC", "sA"]);
  });
});

describe("swapLeafSessions", () => {
  test("trades pane contents, keeps geometry (incl. an EMPTY pane)", () => {
    const { tree, a, b } = rowAB();
    const swapped = swapLeafSessions(tree, a, b);
    expect(leaves(swapped).map((l) => l.sessionId)).toEqual(["sB", "sA"]);
    // Swapping with an empty pane moves the session and empties the source.
    const withEmpty = setLeafSession(tree, b, undefined);
    const s2 = swapLeafSessions(withEmpty, a, b);
    expect(leaves(s2).map((l) => l.sessionId)).toEqual([undefined, "sA"]);
  });
});

describe("setRatio", () => {
  test("clamps so neither side can collapse", () => {
    const { tree } = rowAB();
    const id = (tree as BranchNode).id;
    expect((setRatio(tree, id, 0.02) as BranchNode).ratio).toBe(MIN_RATIO);
    expect((setRatio(tree, id, 0.98) as BranchNode).ratio).toBe(1 - MIN_RATIO);
    expect((setRatio(tree, id, 0.42) as BranchNode).ratio).toBe(0.42);
  });
});

describe("normalize (live-session reconciliation)", () => {
  test("a pane whose session died collapses; a SOLO dead pane clears to the picker", () => {
    const { tree } = rowAB();
    const next = normalize(tree, new Set(["sB"]));
    expect(leaves(next).map((l) => l.sessionId)).toEqual(["sB"]);
    const solo = makeLeaf("gone");
    const clearedSolo = normalize(solo, new Set());
    expect(leaves(clearedSolo).map((l) => l.sessionId)).toEqual([undefined]);
  });

  test("a session shown twice keeps only the FIRST pane (two attachments fight over the pty size)", () => {
    const a = makeLeaf("dup");
    const twin = makeLeaf("dup");
    const tree = splitLeaf(a, a.id, "right", twin);
    const next = normalize(tree, new Set(["dup"]));
    expect(leaves(next).map((l) => l.sessionId)).toEqual(["dup", undefined]);
  });
});

describe("persistence", () => {
  test("round-trips tree + focus; a stale focus id falls back to the first leaf", () => {
    const { tree, a, b } = rowAB();
    saveLayout({ tree, focusedLeafId: b });
    expect(loadLayout()).toEqual({ tree, focusedLeafId: b });
    saveLayout({ tree, focusedLeafId: "stale" });
    expect(loadLayout()?.focusedLeafId).toBe(a);
  });

  test("keeps layouts isolated per direct host and migrates legacy state only when requested", () => {
    const hostA = makeLeaf("session-a");
    const hostB = makeLeaf("session-b");
    saveLayout({ tree: hostA, focusedLeafId: hostA.id }, "host_a");
    saveLayout({ tree: hostB, focusedLeafId: hostB.id }, "host_b");
    expect(leaves(loadLayout("host_a")!.tree)[0]?.sessionId).toBe("session-a");
    expect(leaves(loadLayout("host_b")!.tree)[0]?.sessionId).toBe("session-b");

    const legacy = makeLeaf("legacy");
    saveLayout({ tree: legacy, focusedLeafId: legacy.id });
    expect(loadLayout("host_c")).toBeUndefined();
    expect(leaves(loadLayout("host_c", true)!.tree)[0]?.sessionId).toBe("legacy");
  });

  test("garbage / malformed nodes / out-of-range ratios invalidate the WHOLE stored layout", () => {
    localStorage.setItem("roamcode.split-layout", "{not json");
    expect(loadLayout()).toBeUndefined();
    localStorage.setItem(
      "roamcode.split-layout",
      JSON.stringify({ tree: { type: "split", id: "x", dir: "diag", ratio: 0.5, a: {}, b: {} }, focusedLeafId: "x" }),
    );
    expect(loadLayout()).toBeUndefined();
    localStorage.setItem(
      "roamcode.split-layout",
      JSON.stringify({
        tree: {
          type: "split",
          id: "x",
          dir: "row",
          ratio: 0.01,
          a: { type: "leaf", id: "l" },
          b: { type: "leaf", id: "m" },
        },
        focusedLeafId: "l",
      }),
    );
    expect(loadLayout()).toBeUndefined(); // ratio below MIN_RATIO → rejected
  });
});

describe("lookups", () => {
  test("findLeaf / findLeafBySession", () => {
    const { tree, a } = rowAB();
    expect(findLeaf(tree, a)?.sessionId).toBe("sA");
    expect(findLeafBySession(tree, "sB")?.id).toBeDefined();
    expect(findLeafBySession(tree, "nope")).toBeUndefined();
  });
});
