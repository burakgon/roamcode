import { randomBytes } from "node:crypto";

/**
 * Single-use, short-lived tickets for the terminal WebSocket handshake.
 *
 * WHY: a browser WebSocket cannot send an Authorization header, so the client historically put the
 * LONG-LIVED access token in the WS URL (`?token=`). Query strings are routinely written into proxy /
 * tunnel / access logs, so that leaked a full-access credential. The flow now is: POST /ws-ticket (over
 * the normal header-authed API) → get a 32-byte ticket → open the WS with `?ticket=`. A logged ticket is
 * worthless: it is consumed by the very connection that carried it (single-use) and dies within TTL_MS
 * anyway. The legacy `?token=` path is kept for old bundles (see transport.ts) but is deprecated.
 */

/** Ticket lifetime. Long enough for the client to turn the POST response into a WS connect (even on a
 *  slow mobile link), short enough that a logged/leaked ticket is stale almost immediately. */
export const WS_TICKET_TTL_MS = 30_000;

export interface WsTicketStoreOptions {
  /** Override the TTL (tests). Default {@link WS_TICKET_TTL_MS}. */
  ttlMs?: number;
  /** Injectable clock for tests. Default Date.now. */
  now?: () => number;
  /** Injectable ticket generator for tests. Default: 32 CSPRNG bytes, base64url. */
  generate?: () => string;
}

export interface WsTicketContext {
  actorType: "device" | "host" | "local" | "relay";
  actorId: string;
  label: string;
}

/**
 * In-memory single-use ticket store. Deliberately NOT persisted: a ticket outliving a server restart
 * would defeat its 30s point, and the client just re-POSTs on reconnect. Expired entries are swept
 * LAZILY on each issue/consume — issuance is token-gated + rate-limited, so the map stays tiny without
 * a timer.
 */
export class WsTicketStore {
  /** ticket → expiry + the authenticated principal that minted it. */
  private readonly tickets = new Map<string, { expiresAt: number; context?: WsTicketContext }>();
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly generate: () => string;

  constructor(opts: WsTicketStoreOptions = {}) {
    this.ttlMs = opts.ttlMs ?? WS_TICKET_TTL_MS;
    this.now = opts.now ?? Date.now;
    this.generate = opts.generate ?? (() => randomBytes(32).toString("base64url"));
  }

  /** Mint a fresh single-use ticket. The response shape is exactly what POST /ws-ticket returns. */
  issue(context?: WsTicketContext): { ticket: string; expiresInMs: number } {
    this.sweep();
    const ticket = this.generate();
    this.tickets.set(ticket, { expiresAt: this.now() + this.ttlMs, ...(context ? { context: { ...context } } : {}) });
    return { ticket, expiresInMs: this.ttlMs };
  }

  /** Consume a ticket: true exactly ONCE for a live ticket; false for unknown, expired, or already-used
   *  (the entry is deleted on first consume, so a replayed WS URL is rejected). */
  consume(ticket: string): boolean {
    return this.consumeWithContext(ticket) !== undefined;
  }

  /** Consume once and recover the authenticated principal bound at issuance. The wrapper object makes a
   *  context-free legacy/test ticket distinguishable from an invalid ticket. */
  consumeWithContext(ticket: string): { context?: WsTicketContext } | undefined {
    this.sweep();
    const record = this.tickets.get(ticket);
    if (record === undefined) return undefined;
    this.tickets.delete(ticket); // single-use: gone whether it validates or not
    if (this.now() > record.expiresAt) return undefined;
    return record.context ? { context: { ...record.context } } : {};
  }

  /** Drop expired entries so an unconsumed flood can't grow the map (lazy — no timer to leak). */
  private sweep(): void {
    const t = this.now();
    for (const [ticket, record] of this.tickets) {
      if (record.expiresAt < t) this.tickets.delete(ticket);
    }
  }

  /** TEST ONLY: how many un-consumed tickets are currently held (post-sweep count). */
  size(): number {
    this.sweep();
    return this.tickets.size;
  }
}
