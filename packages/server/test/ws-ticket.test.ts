import { expect, test } from "vitest";
import { WsTicketStore, WS_TICKET_TTL_MS } from "../src/ws-ticket.js";

test("issue returns a distinct base64url ticket with the TTL; consume succeeds exactly once", () => {
  const store = new WsTicketStore();
  const a = store.issue();
  const b = store.issue();
  expect(a.expiresInMs).toBe(WS_TICKET_TTL_MS);
  expect(a.ticket).toMatch(/^[A-Za-z0-9_-]{43,}$/); // 32 CSPRNG bytes, base64url
  expect(a.ticket).not.toBe(b.ticket);
  expect(store.consume(a.ticket)).toBe(true);
  expect(store.consume(a.ticket)).toBe(false); // single-use: a replayed WS URL is dead
  expect(store.consume(b.ticket)).toBe(true); // an unrelated ticket is unaffected
});

test("an unknown ticket never consumes", () => {
  const store = new WsTicketStore();
  expect(store.consume("nope")).toBe(false);
});

test("an expired ticket is rejected (injected clock) and swept lazily", () => {
  let t = 1_000;
  const store = new WsTicketStore({ now: () => t });
  const { ticket } = store.issue();
  // Just inside the TTL → still valid.
  const inWindow = new WsTicketStore({ now: () => t });
  const live = inWindow.issue();
  t += WS_TICKET_TTL_MS; // exactly at expiry is still accepted (<=)
  expect(inWindow.consume(live.ticket)).toBe(true);
  // Past the TTL → rejected.
  t += 1;
  expect(store.consume(ticket)).toBe(false);
  // The lazy sweep dropped the expired entry (no timer needed to keep the map bounded).
  expect(store.size()).toBe(0);
});

test("expired tickets don't accumulate: issuing sweeps the dead ones", () => {
  let t = 0;
  const store = new WsTicketStore({ now: () => t });
  store.issue();
  store.issue();
  t += WS_TICKET_TTL_MS + 1;
  store.issue(); // triggers the lazy sweep of the two dead tickets
  expect(store.size()).toBe(1);
});

test("a ticket carries its issuing principal exactly once without exposing it in the response", () => {
  const store = new WsTicketStore({ generate: () => "ticket" });
  const issued = store.issue({ actorType: "device", actorId: "phone", label: "Phone" });
  expect(issued).toEqual({ ticket: "ticket", expiresInMs: WS_TICKET_TTL_MS });
  expect(store.consumeWithContext("ticket")).toEqual({
    context: { actorType: "device", actorId: "phone", label: "Phone" },
  });
  expect(store.consumeWithContext("ticket")).toBeUndefined();
});
