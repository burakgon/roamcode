import { beforeEach, describe, expect, it } from "vitest";
import { useStore } from "./store";
import type { SessionMeta } from "../types/server";

const meta: SessionMeta = { id: "s1", cwd: "/p", dangerouslySkip: false, status: "running", createdAt: 1 };

beforeEach(() => {
  useStore.setState({ token: undefined, sessions: [], activeSessionId: undefined, lastActiveAt: {} });
});

describe("useStore", () => {
  it("setToken / setSessions / setActive update state", () => {
    useStore.getState().setToken("tok");
    useStore.getState().setSessions([meta]);
    useStore.getState().setActive("s1");
    const s = useStore.getState();
    expect(s.token).toBe("tok");
    expect(s.sessions).toEqual([meta]);
    expect(s.activeSessionId).toBe("s1");
  });

  it("setUpdateInfo / setUpdateState drive the OTA update UX", () => {
    const info = {
      current: "v1.0.0",
      latest: "v1.1.0",
      behind: 3,
      releaseCount: 3,
      updatable: true,
      updateAvailable: true,
      updateAction: "update" as const,
      installation: "managed" as const,
      changelog: [],
      runningVersion: "1.0.0",
      activeVersion: "1.0.0",
      installDrift: false,
      checkStatus: "fresh" as const,
      runningBuild: "1.0.0",
      buildDrift: false,
    };
    useStore.getState().setUpdateInfo(info);
    useStore.getState().setUpdateState("updating");
    expect(useStore.getState().updateInfo).toEqual(info);
    expect(useStore.getState().updateState).toBe("updating");
    useStore.getState().setUpdateState("failed");
    expect(useStore.getState().updateState).toBe("failed");
    useStore.getState().setUpdateInfo(undefined);
    expect(useStore.getState().updateInfo).toBeUndefined();
  });

  it("setUsage stores the latest usage snapshot (and clears it with null)", () => {
    expect(useStore.getState().usage).toBeUndefined();
    const usage = {
      session: { percent: 12, resets: "Jun 25 at 11:30pm" },
      week: { percent: 72, resets: "Jun 25 at 10pm" },
      fetchedAt: 1000,
    };
    useStore.getState().setUsage(usage);
    expect(useStore.getState().usage).toEqual(usage);
    // A null poll result hides the bars (the feature is unavailable).
    useStore.getState().setUsage(null);
    expect(useStore.getState().usage).toBeNull();
  });

  it("mergeSessionMeta is SERVER-authoritative for awaiting (the poll can raise a prompt)", () => {
    // The poll re-confirms awaiting and can RAISE it for a genuine prompt — it must not be overridden.
    const { setSessions, setActive, mergeSessionMeta } = useStore.getState();
    setSessions([meta, { ...meta, id: "s2" }]);
    setActive("s1");
    mergeSessionMeta([
      { ...meta, awaiting: true },
      { ...meta, id: "s2", awaiting: true },
    ]);
    expect(useStore.getState().sessions.find((s) => s.id === "s1")?.awaiting).toBe(true);
    expect(useStore.getState().sessions.find((s) => s.id === "s2")?.awaiting).toBe(true);
  });

  it("setSessions seeds a missing lastActiveAt from createdAt and keeps existing stamps", () => {
    useStore.setState({ lastActiveAt: { s2: 12345 } });
    const a: SessionMeta = { id: "s1", cwd: "/a", dangerouslySkip: false, status: "running", createdAt: 7 };
    const b: SessionMeta = { id: "s2", cwd: "/b", dangerouslySkip: false, status: "running", createdAt: 8 };
    useStore.getState().setSessions([a, b]);
    const { lastActiveAt } = useStore.getState();
    expect(lastActiveAt["s1"]).toBe(7); // seeded from createdAt
    expect(lastActiveAt["s2"]).toBe(12345); // pre-existing stamp preserved
  });

  it("setActive does NOT bump lastActiveAt — viewing a chat must not reorder the rail", () => {
    useStore.setState({ lastActiveAt: { s1: 5 } });
    useStore.getState().setActive("s1");
    expect(useStore.getState().activeSessionId).toBe("s1");
    // The stamp is untouched by selection — only send/receive moves a session up the rail.
    expect(useStore.getState().lastActiveAt["s1"]).toBe(5);
    // Clearing the selection touches nothing else.
    useStore.getState().setActive(undefined);
    expect(useStore.getState().activeSessionId).toBeUndefined();
    expect(useStore.getState().lastActiveAt["s1"]).toBe(5);
  });

  it("mergeSessionMeta merges meta + drops vanished sessions", () => {
    // Two live sessions, s1 with a higher local optimistic stamp.
    useStore.setState({ lastActiveAt: { s1: 999, s2: 5 } });
    const s1: SessionMeta = {
      id: "s1",
      cwd: "/a",
      dangerouslySkip: false,
      status: "running",
      createdAt: 1,
      awaiting: true,
      lastActivityAt: 50,
    };
    // A poll returns ONLY s1 (s2 vanished/closed) with fresh awaiting + a server lastActivityAt below
    // the local stamp.
    useStore.getState().mergeSessionMeta([s1]);
    const st = useStore.getState();
    // s2 (no longer returned) is dropped from the list and its stamp pruned.
    expect(st.sessions.map((s) => s.id)).toEqual(["s1"]);
    expect(st.lastActiveAt["s2"]).toBeUndefined();
    // s1's awaiting flag refreshed from the poll.
    expect(st.sessions[0]!.awaiting).toBe(true);
    // The local optimistic stamp (999) wins over the lower server lastActivityAt (50).
    expect(st.lastActiveAt["s1"]).toBe(999);
  });

  it("addSession re-adds a removed session (idempotent) — used to undo a failed close", () => {
    const s: SessionMeta = {
      id: "s1",
      cwd: "/p",
      dangerouslySkip: false,
      status: "running",
      createdAt: 1,
      lastActivityAt: 42,
    };
    useStore.getState().addSession(s);
    expect(useStore.getState().sessions.map((x) => x.id)).toEqual(["s1"]);
    expect(useStore.getState().lastActiveAt["s1"]).toBe(42);
    // Re-adding the same id is a no-op (no duplicate row).
    useStore.getState().addSession(s);
    expect(useStore.getState().sessions).toHaveLength(1);
  });

  it("removeSession drops the session and its activity stamp", () => {
    useStore.setState({ sessions: [meta], lastActiveAt: { s1: 5 } });
    useStore.getState().removeSession("s1");
    const s = useStore.getState();
    expect(s.sessions).toEqual([]);
    expect(s.lastActiveAt["s1"]).toBeUndefined();
  });
});
