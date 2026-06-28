import { expect, test } from "vitest";
import { ReplayBuffer, isCriticalKind } from "../src/index.js";

test("push assigns monotonic seq starting at 1 and snapshot preserves order", () => {
  const buf = new ReplayBuffer(100);
  const a = buf.push("event", { n: 1 });
  const b = buf.push("event", { n: 2 });
  expect(a.seq).toBe(1);
  expect(b.seq).toBe(2);
  expect(buf.snapshot().map((f) => f.seq)).toEqual([1, 2]);
});

test("isCriticalKind marks permission, result, question and attachment critical only", () => {
  expect(isCriticalKind("permission")).toBe(true);
  expect(isCriticalKind("result")).toBe(true);
  expect(isCriticalKind("question")).toBe(true);
  expect(isCriticalKind("attachment")).toBe(true);
  expect(isCriticalKind("event")).toBe(false);
  expect(isCriticalKind("diagnostic")).toBe(false);
  expect(isCriticalKind("exit")).toBe(false);
  expect(isCriticalKind("resolve")).toBe(true); // retained so a ?since= delta reconnect learns the prompt cleared
});

test("an attachment frame is NEVER evicted even under heavy non-critical churn (file survives reconnect)", () => {
  const buf = new ReplayBuffer(1);
  buf.push("attachment", { id: "att-1", path: "/r/a.png", name: "a.png", isImage: true });
  for (let i = 0; i < 50; i++) buf.push("event", { i });
  const atts = buf.snapshot().filter((f) => f.kind === "attachment");
  expect(atts).toHaveLength(1);
  expect((atts[0].payload as { id: string }).id).toBe("att-1");
});

test("over-capacity eviction drops oldest NON-critical frames only", () => {
  const buf = new ReplayBuffer(2); // capacity = 2 non-critical frames
  buf.push("event", { n: 1 }); // seq 1 (non-critical)
  buf.push("permission", { id: "p" }); // seq 2 (critical — never evicted)
  buf.push("event", { n: 2 }); // seq 3 (non-critical) -> now 2 non-critical, at capacity
  buf.push("event", { n: 3 }); // seq 4 (non-critical) -> evict oldest non-critical (seq 1)

  const seqs = buf.snapshot().map((f) => f.seq);
  expect(seqs).toContain(2); // the permission frame survives
  expect(seqs).not.toContain(1); // the oldest non-critical was evicted
  expect(seqs).toEqual([2, 3, 4]);
});

test("a permission frame is NEVER evicted even under heavy non-critical churn", () => {
  const buf = new ReplayBuffer(1);
  buf.push("permission", { id: "keep-me" }); // critical
  for (let i = 0; i < 50; i++) buf.push("event", { i });
  const perms = buf.snapshot().filter((f) => f.kind === "permission");
  expect(perms).toHaveLength(1);
  expect((perms[0].payload as { id: string }).id).toBe("keep-me");
});

test("since(seq) returns only frames after the given seq", () => {
  const buf = new ReplayBuffer(100);
  buf.push("event", { n: 1 });
  buf.push("result", { n: 2 });
  buf.push("event", { n: 3 });
  expect(buf.since(1).map((f) => f.seq)).toEqual([2, 3]);
  expect(buf.since(3)).toEqual([]);
});

test("stream_event frames are NOT retained for replay but still get a real seq (emitted live)", () => {
  const buf = new ReplayBuffer(200);
  const a = buf.push("event", { type: "assistant", message: { content: [] } }); // retained
  const s1 = buf.push("event", { type: "stream_event", event: { type: "content_block_delta" } }); // transient
  const s2 = buf.push("event", { type: "stream_event", event: { type: "content_block_delta" } }); // transient
  const r = buf.push("result", { ok: true }); // retained

  // Each push still assigns a contiguous seq (so live ordering + ?since= deltas stay correct)...
  expect([a.seq, s1.seq, s2.seq, r.seq]).toEqual([1, 2, 3, 4]);
  expect(buf.maxSeq()).toBe(4);

  // ...but the transient stream_event frames are NOT kept in the buffer (so they can't evict content).
  const snap = buf.snapshot();
  expect(snap.map((f) => f.seq)).toEqual([1, 4]);
  expect(snap.some((f) => (f.payload as { type?: string }).type === "stream_event")).toBe(false);

  // A reconnect with ?since= still gets the retained frames after the cutoff (the transient ones are
  // gone, which is intended — the final assistant/result carry the full content).
  expect(buf.since(1).map((f) => f.seq)).toEqual([4]);
});

test("a flood of stream_event frames never evicts real content from the buffer", () => {
  const buf = new ReplayBuffer(2); // tiny capacity to prove eviction would bite if they were retained
  const a = buf.push("event", { type: "assistant", message: { content: [] } });
  for (let i = 0; i < 500; i++) {
    buf.push("event", { type: "stream_event", event: { type: "content_block_delta", i } });
  }
  const r = buf.push("result", { ok: true });
  // Despite 500 stream deltas, the assistant + result content both survive (deltas were never retained).
  expect(buf.snapshot().map((f) => f.seq)).toEqual([a.seq, r.seq]);
  expect(buf.maxSeq()).toBe(r.seq);
});

test("maxSeq() is 0 before any push", () => {
  expect(new ReplayBuffer().maxSeq()).toBe(0);
});

test("hasGap is false when nothing was ever evicted (a ?since= delta is complete)", () => {
  const buf = new ReplayBuffer(100);
  buf.push("event", { n: 1 });
  buf.push("event", { n: 2 });
  expect(buf.hasGap(0)).toBe(false);
  expect(buf.hasGap(1)).toBe(false);
});

test("hasGap is true when the reconnect would miss an evicted frame, false once past it", () => {
  const buf = new ReplayBuffer(2); // capacity = 2 non-critical
  buf.push("event", { n: 1 }); // seq 1
  buf.push("event", { n: 2 }); // seq 2
  buf.push("event", { n: 3 }); // seq 3 → evicts seq 1 (evictedThrough = 1)
  buf.push("event", { n: 4 }); // seq 4 → evicts seq 2 (evictedThrough = 2)
  // A client at since=1 needed seq 2 (evicted) → it cannot be made whole by a delta → gap.
  expect(buf.hasGap(1)).toBe(true);
  // A client at since=0 is even further behind → gap.
  expect(buf.hasGap(0)).toBe(true);
  // A client at since=2 has already seen everything that was evicted → no gap, the delta (3,4) is whole.
  expect(buf.hasGap(2)).toBe(false);
  expect(buf.hasGap(3)).toBe(false);
});

test("evicting transient stream_event frames never reports a false gap", () => {
  const buf = new ReplayBuffer(2);
  buf.push("event", { type: "assistant", message: { content: [] } }); // seq 1 retained
  for (let i = 0; i < 100; i++) buf.push("event", { type: "stream_event", event: { i } }); // never retained
  buf.push("result", { ok: true });
  // No NON-transient frame was ever evicted, so a reconnect at since=1 is whole.
  expect(buf.hasGap(1)).toBe(false);
});

test("resolvePrompt prunes the matching question/permission so a reconnect won't re-show an answered prompt", () => {
  const buf = new ReplayBuffer(100);
  buf.push("question", { requestId: "ask-1", askId: "ask-1", questions: [] });
  buf.push("permission", { requestId: "perm-1", toolName: "Bash" });
  buf.push("event", { n: 1 });
  buf.resolvePrompt("ask-1");
  let kinds = buf.snapshot().map((f) => f.kind);
  expect(kinds).not.toContain("question"); // the ANSWERED question is gone from the replay
  expect(kinds).toContain("permission"); // a still-pending permission stays
  buf.resolvePrompt("perm-1");
  kinds = buf.snapshot().map((f) => f.kind);
  expect(kinds).not.toContain("permission");
  expect(kinds).toContain("event"); // unrelated frames untouched
});

test("a `resolve` frame is RETAINED (so a ?since= delta reconnect learns the prompt cleared)", () => {
  const buf = new ReplayBuffer(100);
  buf.push("question", { requestId: "ask-1", questions: [] }); // seq 1
  buf.resolvePrompt("ask-1"); // prune the question
  const r = buf.push("resolve", { requestId: "ask-1" }); // seq 2 (retained)
  expect(buf.snapshot().some((f) => f.kind === "question")).toBe(false); // question pruned
  expect(buf.snapshot().some((f) => f.kind === "resolve")).toBe(true); // resolve kept
  expect(buf.since(1).some((f) => f.kind === "resolve")).toBe(true); // delta reconnect sees it
  // resolvePrompt also drops a prior resolve for the same id (no pile-up on a re-used requestId).
  buf.resolvePrompt("ask-1");
  expect(buf.snapshot().some((f) => f.kind === "resolve")).toBe(false);
  expect(r.seq).toBe(2);
});
