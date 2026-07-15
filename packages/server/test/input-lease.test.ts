import { describe, expect, test, vi } from "vitest";
import { InputLeaseCoordinator, type InputLeaseEvent } from "../src/input-lease.js";

const phone = { actorType: "device" as const, actorId: "phone", label: "Phone" };
const laptop = { actorType: "device" as const, actorId: "laptop", label: "Laptop" };

describe("input lease coordinator", () => {
  test("allows many observers but exactly one writer until explicit confirmed takeover", () => {
    let now = 1_000;
    let sequence = 0;
    const events: InputLeaseEvent[] = [];
    const leases = new InputLeaseCoordinator({
      now: () => now,
      generateId: () => `lease-${++sequence}`,
      scheduleExpiry: false,
      onEvent: (event) => events.push(event),
    });

    const first = leases.acquire("session", "socket-a", phone);
    expect(first.status).toBe("granted");
    expect(leases.canWrite("session", "socket-a")).toBe(true);
    expect(leases.acquire("session", "socket-b", laptop)).toMatchObject({
      status: "denied",
      current: { actorId: "phone" },
    });
    expect(leases.canWrite("session", "socket-b")).toBe(false);
    expect(leases.takeover("session", "socket-b", laptop, false)).toMatchObject({ status: "denied" });

    now += 10;
    expect(leases.takeover("session", "socket-b", laptop, true)).toMatchObject({
      status: "granted",
      lease: { actorId: "laptop", holderId: "socket-b" },
    });
    expect(leases.canWrite("session", "socket-a")).toBe(false);
    expect(leases.canWrite("session", "socket-b")).toBe(true);
    expect(events.map((event) => event.type)).toEqual(["granted", "taken-over"]);
  });

  test("renews the exact lease and expires or releases cleanly after disconnect", () => {
    let now = 1_000;
    const leases = new InputLeaseCoordinator({
      ttlMs: 2_000,
      now: () => now,
      generateId: () => "lease-1",
      scheduleExpiry: false,
    });
    const granted = leases.acquire("session", "socket-a", phone);
    if (granted.status === "denied") throw new Error("unexpected denial");
    now = 2_500;
    expect(leases.renew("session", "socket-a", granted.lease.id)?.expiresAt).toBe(4_500);
    expect(leases.renew("session", "socket-b", granted.lease.id)).toBeUndefined();
    now = 4_501;
    expect(leases.get("session")).toBeUndefined();

    const replacement = leases.acquire("session", "socket-b", laptop);
    expect(replacement.status).toBe("granted");
    expect(leases.releaseHolder("socket-b")).toBe(1);
    expect(leases.get("session")).toBeUndefined();
  });

  test("revokes every lease owned by a suspended or revoked actor", () => {
    const leases = new InputLeaseCoordinator({ scheduleExpiry: false });
    leases.acquire("session-a", "socket-a", phone);
    leases.acquire("session-b", "socket-b", phone);
    leases.acquire("session-c", "socket-c", laptop);
    expect(leases.revokeActor("device", "phone")).toBe(2);
    expect(leases.get("session-a")).toBeUndefined();
    expect(leases.get("session-b")).toBeUndefined();
    expect(leases.get("session-c")?.actorId).toBe("laptop");
  });

  test("notifies independent subscribers and isolates a broken listener", () => {
    const good = vi.fn();
    const leases = new InputLeaseCoordinator({ scheduleExpiry: false });
    leases.subscribe("session", () => {
      throw new Error("broken observer");
    });
    leases.subscribe("session", good);
    leases.acquire("session", "socket-a", phone);
    expect(good).toHaveBeenCalledOnce();
  });
});
