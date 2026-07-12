# Stable Session Rail Ordering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the session rail stable by default while retaining an opt-in recent-activity order and preserving the “needs you” priority group.

**Architecture:** A small browser-preference module owns the validated order mode. A pure sorter applies either created-time or activity-time order inside the existing awaiting/non-awaiting groups. `App` owns the live mode and passes it to the rail and settings so display, persistence, and active-session close fallback all use one policy.

**Tech Stack:** React 19, TypeScript, Zustand, Vitest, Testing Library, localStorage

## Global Constraints

- Default order is `created`, shown as **Stable (created)**.
- Optional order is `activity`, shown as **Recent activity**.
- Awaiting sessions stay above non-awaiting sessions in both modes.
- `created` mode sorts newest-created first and never reacts to activity timestamp changes.
- Existing relative activity timestamps remain visible in both modes.
- The preference is browser-local, applies immediately, and survives blocked or malformed localStorage.
- No server, database, manual pinning, drag ordering, or cross-device synchronization changes.

---

### Task 1: Validated session-order preference

**Files:**
- Create: `packages/web/src/session/order-preference.ts`
- Create: `packages/web/src/session/order-preference.test.ts`

**Interfaces:**
- Produces: `SessionOrder = "created" | "activity"`
- Produces: `loadSessionOrder(): SessionOrder`
- Produces: `saveSessionOrder(order: SessionOrder): void`

- [ ] **Step 1: Write the failing preference tests**

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadSessionOrder, saveSessionOrder } from "./order-preference";

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("session order preference", () => {
  it("defaults missing and invalid values to created", () => {
    expect(loadSessionOrder()).toBe("created");
    localStorage.setItem("roamcode.session-order", "manual");
    expect(loadSessionOrder()).toBe("created");
  });

  it("round-trips both supported values", () => {
    saveSessionOrder("activity");
    expect(loadSessionOrder()).toBe("activity");
    saveSessionOrder("created");
    expect(loadSessionOrder()).toBe("created");
  });

  it("falls back safely when storage reads or writes throw", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(loadSessionOrder()).toBe("created");
    vi.restoreAllMocks();
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(() => saveSessionOrder("activity")).not.toThrow();
  });
});
```

- [ ] **Step 2: Run the test and verify RED**

Run: `pnpm vitest run packages/web/src/session/order-preference.test.ts`

Expected: FAIL because `./order-preference` does not exist.

- [ ] **Step 3: Implement the minimal validated preference module**

```ts
export type SessionOrder = "created" | "activity";

const KEY = "roamcode.session-order";

export function loadSessionOrder(): SessionOrder {
  try {
    return localStorage.getItem(KEY) === "activity" ? "activity" : "created";
  } catch {
    return "created";
  }
}

export function saveSessionOrder(order: SessionOrder): void {
  try {
    localStorage.setItem(KEY, order);
  } catch {
    /* browser storage is optional; the in-memory preference still applies */
  }
}
```

- [ ] **Step 4: Run the preference test and verify GREEN**

Run: `pnpm vitest run packages/web/src/session/order-preference.test.ts`

Expected: 3 tests pass.

- [ ] **Step 5: Commit the preference module**

```bash
git add packages/web/src/session/order-preference.ts packages/web/src/session/order-preference.test.ts
git commit -m "feat(web): persist session rail order"
```

### Task 2: Mode-aware pure ordering and rail rendering

**Files:**
- Modify: `packages/web/src/session/order.ts`
- Modify: `packages/web/src/session/order.test.ts`
- Modify: `packages/web/src/session/SessionList.tsx`
- Modify: `packages/web/src/session/SessionList.test.tsx`
- Modify: `packages/web/src/screenshot/AppShot.tsx`

**Interfaces:**
- Consumes: `SessionOrder` from Task 1
- Produces: `sortSessions(sessions, lastActiveAt, order): SessionMeta[]`
- Produces: required `SessionListProps.order: SessionOrder`

- [ ] **Step 1: Replace the sorter tests with failing two-mode behavior tests**

```ts
import { describe, expect, it } from "vitest";
import { sortSessions } from "./order";
import type { SessionMeta } from "../types/server";

function s(id: string, createdAt: number, awaiting = false): SessionMeta {
  return { id, cwd: `/p/${id}`, dangerouslySkip: false, status: "running", createdAt, awaiting };
}

describe("sortSessions", () => {
  it("keeps created order stable when activity changes", () => {
    const sessions = [s("old", 1), s("new", 9)];
    expect(sortSessions(sessions, { old: 100, new: 10 }, "created").map((x) => x.id)).toEqual(["new", "old"]);
    expect(sortSessions(sessions, { old: 1000, new: 10 }, "created").map((x) => x.id)).toEqual(["new", "old"]);
  });

  it("orders by recent activity when requested", () => {
    const sessions = [s("a", 1), s("b", 2), s("c", 3)];
    expect(sortSessions(sessions, { a: 100, b: 10, c: 50 }, "activity").map((x) => x.id)).toEqual([
      "a",
      "c",
      "b",
    ]);
  });

  it.each(["created", "activity"] as const)("pins awaiting sessions in %s mode", (order) => {
    const sessions = [s("new", 9), s("awaiting", 1, true)];
    expect(sortSessions(sessions, { new: 100, awaiting: 1 }, order).map((x) => x.id)).toEqual([
      "awaiting",
      "new",
    ]);
  });

  it("uses deterministic tie-breaks and does not mutate input", () => {
    const sessions = [s("b", 4), s("a", 4)];
    const snapshot = sessions.map((x) => x.id);
    expect(sortSessions(sessions, { a: 5, b: 5 }, "activity").map((x) => x.id)).toEqual(["a", "b"]);
    expect(sessions.map((x) => x.id)).toEqual(snapshot);
  });
});
```

Update the `renderList` helper and replace the existing order test with these exact cases:

```ts
const props: SessionListProps = {
  sessions,
  order: "created",
  lastActiveAt: { s1: 1, s2: 2 },
  now: 1000,
  onSelect: vi.fn(),
  onNew: vi.fn(),
  onClose: vi.fn(),
  ...overrides,
};

it("keeps newest-created first when activity timestamps disagree", () => {
  renderList({ order: "created", lastActiveAt: { s1: 999, s2: 10 } });
  const actions = screen.getAllByRole("button", { name: /actions for/i });
  expect(actions[0]).toHaveAccessibleName("Actions for notes");
  expect(actions[1]).toHaveAccessibleName("Actions for roamcode");
});

it("orders sessions most-recently-active first when requested", () => {
  renderList({ order: "activity", lastActiveAt: { s1: 999, s2: 10 } });
  const actions = screen.getAllByRole("button", { name: /actions for/i });
  expect(actions[0]).toHaveAccessibleName("Actions for roamcode");
  expect(actions[1]).toHaveAccessibleName("Actions for notes");
});
```

- [ ] **Step 2: Run focused tests and verify RED**

Run: `pnpm vitest run packages/web/src/session/order.test.ts packages/web/src/session/SessionList.test.tsx`

Expected: FAIL because `sortSessions` and `SessionListProps.order` are not implemented.

- [ ] **Step 3: Implement the pure generalized sorter**

```ts
import type { SessionMeta } from "../types/server";
import type { SessionOrder } from "./order-preference";

export function sortSessions(
  sessions: SessionMeta[],
  lastActiveAt: Record<string, number>,
  order: SessionOrder,
): SessionMeta[] {
  const activity = (session: SessionMeta): number => lastActiveAt[session.id] ?? session.createdAt;
  const primary = (session: SessionMeta): number => (order === "activity" ? activity(session) : session.createdAt);
  const awaitingRank = (session: SessionMeta): number => (session.awaiting ? 1 : 0);
  return [...sessions].sort(
    (a, b) =>
      awaitingRank(b) - awaitingRank(a) ||
      primary(b) - primary(a) ||
      b.createdAt - a.createdAt ||
      a.id.localeCompare(b.id),
  );
}
```

Update `SessionList` to require `order`, call `sortSessions(sessions, lastActiveAt, order)`, and update its comments from “always recent-first” to the selected policy. Pass `order="created"` from the screenshot fixture.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `pnpm vitest run packages/web/src/session/order.test.ts packages/web/src/session/SessionList.test.tsx`

Expected: all order and rail tests pass.

- [ ] **Step 5: Commit ordering behavior**

```bash
git add packages/web/src/session/order.ts packages/web/src/session/order.test.ts packages/web/src/session/SessionList.tsx packages/web/src/session/SessionList.test.tsx packages/web/src/screenshot/AppShot.tsx
git commit -m "feat(web): add stable session rail order"
```

### Task 3: Settings control and App-wide policy wiring

**Files:**
- Modify: `packages/web/src/settings/SettingsPanel.tsx`
- Modify: `packages/web/src/settings/SettingsPanel.test.tsx`
- Modify: `packages/web/src/App.tsx`
- Modify: `packages/web/src/App.test.tsx`

**Interfaces:**
- Consumes: `SessionOrder`, `loadSessionOrder`, `saveSessionOrder`, and `sortSessions`
- `SettingsPanel` consumes `sessionOrder?: SessionOrder` and `onSessionOrderChange?: (order: SessionOrder) => void`
- `App` owns the production-required handler and passes it to both settings surfaces

- [ ] **Step 1: Add failing Settings and App integration tests**

Add this Settings test:

```ts
it("changes session order immediately from Appearance", async () => {
  const onSessionOrderChange = vi.fn();
  render(
    <SettingsPanel
      session={undefined}
      defaults={defaults}
      sessionOrder="activity"
      onSessionOrderChange={onSessionOrderChange}
      onSaveDefaults={vi.fn()}
      onClose={vi.fn()}
    />,
  );
  expect(screen.getByLabelText(/session order/i)).toHaveValue("activity");
  await userEvent.selectOptions(screen.getByLabelText(/session order/i), "created");
  expect(onSessionOrderChange).toHaveBeenCalledWith("created");
  expect(screen.getByText(/need you.*always stay on top/i)).toBeVisible();
});
```

Add these App integration tests inside the existing session-list and close-session describes (they use the file's existing `fetchMock`, `jsonResponse`, `saveToken`, and no-op WebSocket setup):

```ts
it("defaults to stable created order and applies a persisted activity-order change immediately", async () => {
  const stableA = { ...a, createdAt: 1, lastActivityAt: 100 };
  const stableB = { ...b, createdAt: 2, lastActivityAt: 10 };
  saveToken("good-token");
  fetchMock.mockImplementation((input: RequestInfo | URL) => {
    const url = String(input);
    if (/\/sessions$/.test(url)) return Promise.resolve(jsonResponse({ sessions: [stableA, stableB] }));
    return Promise.resolve(jsonResponse({}, 404));
  });

  render(<App />);
  await screen.findByRole("button", { name: /show sessions/i });
  await userEvent.click(screen.getByRole("button", { name: /show sessions/i }));
  const rail = within(screen.getByTestId("sessions-rail"));
  expect(rail.getAllByRole("button", { name: /actions for/i }).map((node) => node.getAttribute("aria-label"))).toEqual([
    "Actions for beta",
    "Actions for alpha",
  ]);

  await userEvent.click(rail.getByRole("button", { name: "Settings" }));
  await userEvent.selectOptions(screen.getByLabelText(/session order/i), "activity");
  expect(localStorage.getItem("roamcode.session-order")).toBe("activity");
  await userEvent.click(screen.getByRole("button", { name: "Close settings" }));
  await userEvent.click(screen.getByRole("button", { name: /show sessions/i }));
  expect(rail.getAllByRole("button", { name: /actions for/i }).map((node) => node.getAttribute("aria-label"))).toEqual([
    "Actions for alpha",
    "Actions for beta",
  ]);
});

it("reselects the visible activity-order top after closing the active session", async () => {
  const c: SessionMeta = {
    id: "c",
    cwd: "/home/u/gamma",
    dangerouslySkip: false,
    status: "running",
    createdAt: 3,
    lastActivityAt: 20,
  };
  localStorage.setItem("roamcode.session-order", "activity");
  saveToken("good-token");
  fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === "DELETE") return Promise.resolve(new Response(null, { status: 204 }));
    if (/\/sessions$/.test(url))
      return Promise.resolve(
        jsonResponse({ sessions: [{ ...a, lastActivityAt: 100 }, { ...b, lastActivityAt: 10 }, c] }),
      );
    const match = url.match(/\/sessions\/([^/?]+)/);
    if (match) return Promise.resolve(jsonResponse({ session: match[1] === "a" ? a : match[1] === "b" ? b : c, history: [] }));
    return Promise.resolve(jsonResponse({}, 404));
  });

  render(<App />);
  await screen.findByRole("button", { name: /show sessions/i });
  await userEvent.click(screen.getByRole("button", { name: /show sessions/i }));
  const rail = within(screen.getByTestId("sessions-rail"));
  await userEvent.click(rail.getByText("alpha"));
  await waitFor(() => expect(useStore.getState().activeSessionId).toBe("a"));
  await userEvent.click(screen.getByRole("button", { name: /show sessions/i }));
  await userEvent.click(rail.getByRole("button", { name: "Actions for alpha" }));
  await userEvent.click(rail.getByRole("button", { name: "Close session alpha" }));
  await waitFor(() => expect(useStore.getState().activeSessionId).toBe("c"));
});
```

- [ ] **Step 2: Run focused tests and verify RED**

Run: `pnpm vitest run packages/web/src/settings/SettingsPanel.test.tsx packages/web/src/App.test.tsx`

Expected: FAIL because the preference control and App wiring do not exist.

- [ ] **Step 3: Add the accessible Appearance control**

Add optional component defaults so isolated tests/screenshots remain simple while production passes both props:

```ts
sessionOrder?: SessionOrder;
onSessionOrderChange?: (order: SessionOrder) => void;
```

Destructure `sessionOrder = "created"`, then render inside Appearance:

```tsx
<label className="rc-settings__field">
  <span className="rc-settings__field-label">Session order</span>
  <select
    className="rc-settings__control"
    aria-label="Session order"
    value={sessionOrder}
    onChange={(event) => onSessionOrderChange?.(event.target.value as SessionOrder)}
  >
    <option value="created">Stable (created)</option>
    <option value="activity">Recent activity</option>
  </select>
</label>
<p className="rc-settings__hint">Sessions that need you always stay on top.</p>
```

- [ ] **Step 4: Wire the single policy through App**

Initialize state once:

```ts
const [sessionOrder, setSessionOrderState] = useState<SessionOrder>(() => loadSessionOrder());
const changeSessionOrder = (order: SessionOrder) => {
  setSessionOrderState(order);
  saveSessionOrder(order);
};
```

Pass `order={sessionOrder}` to `SessionList`, pass `sessionOrder` and `onSessionOrderChange={changeSessionOrder}` to both `SettingsPanel` instances, and replace close fallback with:

```ts
const remaining = sortSessions(
  sessions.filter((session) => session.id !== id),
  lastActiveAt,
  sessionOrder,
);
```

Update stale comments that claim the rail is always activity-first.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run: `pnpm vitest run packages/web/src/session/order-preference.test.ts packages/web/src/session/order.test.ts packages/web/src/session/SessionList.test.tsx packages/web/src/settings/SettingsPanel.test.tsx packages/web/src/App.test.tsx`

Expected: all focused tests pass.

- [ ] **Step 6: Commit settings and integration**

```bash
git add packages/web/src/settings/SettingsPanel.tsx packages/web/src/settings/SettingsPanel.test.tsx packages/web/src/App.tsx packages/web/src/App.test.tsx
git commit -m "feat(web): expose session rail order setting"
```

### Task 4: Full verification and publication

**Files:**
- Verify all files changed by Tasks 1–3

**Interfaces:**
- Produces: a reviewed branch and pull request that closes GitHub issue #57

- [ ] **Step 1: Run the complete local verification suite**

Run each command and require exit code 0:

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm test
pnpm typecheck
pnpm lint
pnpm format:check
pnpm audit --prod
git diff --check origin/main...HEAD
```

Expected: build succeeds, every test passes, static checks are clean, audit reports no known production vulnerabilities, and the diff has no whitespace errors.

- [ ] **Step 2: Review the complete diff against the design**

Confirm all six test-strategy requirements in `docs/superpowers/specs/2026-07-12-stable-session-order-design.md`, confirm no server files changed, and confirm no contributor/co-author trailer was added.

- [ ] **Step 3: Push and open a ready pull request**

```bash
git push -u origin codex/issue-57-stable-session-order
gh pr create --repo burakgon/roamcode --base main --head codex/issue-57-stable-session-order \
  --title "feat(web): add stable session rail ordering" \
  --body $'## Summary\n- make Stable (created) the default session rail order\n- keep Recent activity as an immediate, persisted Appearance preference\n- preserve the needs-you priority group in both modes\n- use the visible order when selecting a replacement after close\n\n## Verification\n- pnpm build\n- pnpm test\n- pnpm typecheck\n- pnpm lint\n- pnpm format:check\n- pnpm audit --prod\n\nCloses #57'
```

- [ ] **Step 4: Require remote CI before merge**

Run:

```bash
PR_NUMBER=$(gh pr view --repo burakgon/roamcode --json number --jq .number)
gh pr checks "$PR_NUMBER" --repo burakgon/roamcode --watch --interval 10
```

Expected: every required check passes. If a check fails, inspect its logs and return to the failing task before merging.

- [ ] **Step 5: Squash-merge and verify main**

Run:

```bash
PR_NUMBER=$(gh pr view --repo burakgon/roamcode --json number --jq .number)
gh pr merge "$PR_NUMBER" --repo burakgon/roamcode --squash --delete-branch
MAIN_SHA=$(gh api repos/burakgon/roamcode/commits/main --jq .sha)
RUN_ID=$(gh run list --repo burakgon/roamcode --branch main --limit 10 --json databaseId,headSha --jq ".[] | select(.headSha == \"$MAIN_SHA\") | .databaseId" | head -1)
gh run watch "$RUN_ID" --repo burakgon/roamcode --interval 10
```

Expected: PR is merged, issue #57 is closed by the PR, and final main CI passes.
