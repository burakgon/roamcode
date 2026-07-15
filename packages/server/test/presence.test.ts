import { describe, expect, test, vi } from "vitest";
import { PresenceCoordinator, type PresenceEvent } from "../src/presence.js";

const principal = { actorType: "device" as const, actorId: "device-private", label: "Burak's browser" };

describe("presence coordinator", () => {
  test("publishes bounded metadata, refreshes heartbeats, and expires cleanly", () => {
    let now = 1_000;
    let id = 0;
    const events: PresenceEvent[] = [];
    const presence = new PresenceCoordinator({
      ttlMs: 5_000,
      now: () => now,
      generateId: () => `presence-${++id}`,
      scheduleExpiry: false,
    });
    presence.subscribe((event) => events.push(event));
    const joined = presence.heartbeat(principal, {
      clientId: "tab-1",
      memberId: "member-1",
      mode: "viewing",
      hostId: "host-1",
      workspaceId: "workspace-1",
      sessionId: "session-1",
      agentId: "agent-1",
    });
    expect(joined).toMatchObject({
      id: "presence-1",
      memberId: "member-1",
      label: "Burak's browser",
      mode: "viewing",
      expiresAt: 6_000,
    });
    expect(JSON.stringify(joined)).not.toContain("device-private");
    expect(JSON.stringify(joined)).not.toContain("clientId");

    now = 3_000;
    const refreshed = presence.heartbeat(principal, {
      clientId: "tab-1",
      memberId: "member-1",
      mode: "operating",
      hostId: "host-1",
      sessionId: "session-1",
    });
    expect(refreshed).toMatchObject({ id: joined.id, mode: "operating", connectedAt: 1_000, expiresAt: 8_000 });
    now = 8_000;
    expect(presence.list()).toEqual([]);
    expect(events.map((event) => event.type)).toEqual(["joined", "updated", "expired"]);
    presence.close();
  });

  test("caps each credential and isolates broken subscribers", () => {
    let now = 1_000;
    let id = 0;
    const good = vi.fn();
    const presence = new PresenceCoordinator({
      now: () => now++,
      generateId: () => `p-${++id}`,
      maxRecords: 3,
      maxPerActor: 2,
      scheduleExpiry: false,
    });
    presence.subscribe(() => {
      throw new Error("broken UI");
    });
    presence.subscribe(good);
    for (const clientId of ["one", "two", "three"]) {
      presence.heartbeat(principal, { clientId, mode: "viewing", hostId: "host-1" });
    }
    expect(presence.list()).toHaveLength(2);
    expect(good).toHaveBeenCalled();
    expect(presence.releaseActor(principal)).toBe(2);
    expect(presence.list()).toEqual([]);
    presence.close();
  });

  test("downgrades stale operating labels when input ownership ends", () => {
    const events: PresenceEvent[] = [];
    const presence = new PresenceCoordinator({ scheduleExpiry: false });
    presence.subscribe((event) => events.push(event));
    presence.heartbeat(principal, {
      clientId: "operator-tab",
      mode: "operating",
      hostId: "host-1",
      sessionId: "session-1",
    });
    presence.heartbeat(principal, {
      clientId: "other-tab",
      mode: "operating",
      hostId: "host-1",
      sessionId: "session-2",
    });

    expect(presence.downgradeOperating(principal, "session-1")).toBe(1);
    expect(presence.list({ sessionId: "session-1" })[0]?.mode).toBe("viewing");
    expect(presence.list({ sessionId: "session-2" })[0]?.mode).toBe("operating");
    expect(events.at(-1)).toMatchObject({ type: "updated", presence: { mode: "viewing", sessionId: "session-1" } });
    presence.close();
  });
});
