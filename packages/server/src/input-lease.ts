import { randomUUID } from "node:crypto";

export const INPUT_LEASE_TTL_MS = 30_000;

export type InputLeaseActorType = "device" | "host" | "local" | "relay";

export interface InputLeasePrincipal {
  actorType: InputLeaseActorType;
  actorId: string;
  label: string;
}

export interface InputLease {
  id: string;
  sessionId: string;
  holderId: string;
  actorType: InputLeaseActorType;
  actorId: string;
  label: string;
  acquiredAt: number;
  renewedAt: number;
  expiresAt: number;
  revision: number;
}

export type InputLeaseEvent =
  | { type: "granted"; lease: InputLease }
  | { type: "renewed"; lease: InputLease }
  | { type: "released" | "expired" | "revoked"; lease: InputLease }
  | { type: "taken-over"; lease: InputLease; previous: InputLease };

export type InputLeaseAcquireResult =
  { status: "granted" | "owned"; lease: InputLease } | { status: "denied"; current: InputLease };

export interface InputLeaseCoordinatorOptions {
  ttlMs?: number;
  now?: () => number;
  generateId?: () => string;
  scheduleExpiry?: boolean;
  onEvent?: (event: InputLeaseEvent) => void;
}

function copy(lease: InputLease): InputLease {
  return { ...lease };
}

function safePart(value: string, field: string): string {
  if (!value || value.length > 256 || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(value)) {
    throw new Error(`invalid input lease ${field}`);
  }
  return value;
}

/**
 * Coordinates the one mutable terminal input stream shared by many read-only observers.
 *
 * Leases intentionally live in memory: a host restart invalidates every connection and therefore every holder.
 * Durable audit is supplied by the caller through onEvent. Expiry, release, and confirmed takeover are explicit;
 * merely sending input can never acquire or steal ownership.
 */
export class InputLeaseCoordinator {
  private readonly leases = new Map<string, InputLease>();
  private readonly listeners = new Map<string, Set<(event: InputLeaseEvent) => void>>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly generateId: () => string;
  private readonly scheduleExpiry: boolean;
  private readonly onEvent?: (event: InputLeaseEvent) => void;
  private revision = 0;

  constructor(options: InputLeaseCoordinatorOptions = {}) {
    this.ttlMs = options.ttlMs ?? INPUT_LEASE_TTL_MS;
    if (!Number.isSafeInteger(this.ttlMs) || this.ttlMs < 1_000 || this.ttlMs > 10 * 60_000) {
      throw new Error("invalid input lease TTL");
    }
    this.now = options.now ?? Date.now;
    this.generateId = options.generateId ?? randomUUID;
    this.scheduleExpiry = options.scheduleExpiry ?? true;
    this.onEvent = options.onEvent;
  }

  acquire(sessionId: string, holderId: string, principal: InputLeasePrincipal): InputLeaseAcquireResult {
    this.validate(sessionId, holderId, principal);
    const current = this.current(sessionId);
    if (current) {
      if (current.holderId !== holderId) return { status: "denied", current: copy(current) };
      return { status: "owned", lease: this.renewExisting(current) };
    }
    const now = this.now();
    const lease: InputLease = {
      id: safePart(this.generateId(), "id"),
      sessionId,
      holderId,
      actorType: principal.actorType,
      actorId: principal.actorId,
      label: principal.label,
      acquiredAt: now,
      renewedAt: now,
      expiresAt: now + this.ttlMs,
      revision: ++this.revision,
    };
    this.leases.set(sessionId, lease);
    this.schedule(lease);
    this.emit({ type: "granted", lease: copy(lease) });
    return { status: "granted", lease: copy(lease) };
  }

  takeover(
    sessionId: string,
    holderId: string,
    principal: InputLeasePrincipal,
    confirmed: boolean,
    authorized = true,
  ): InputLeaseAcquireResult {
    this.validate(sessionId, holderId, principal);
    const current = this.current(sessionId);
    if (!current) return this.acquire(sessionId, holderId, principal);
    if (current.holderId === holderId) return { status: "owned", lease: this.renewExisting(current) };
    if (!confirmed || !authorized) return { status: "denied", current: copy(current) };
    const previous = copy(current);
    const now = this.now();
    const lease: InputLease = {
      id: safePart(this.generateId(), "id"),
      sessionId,
      holderId,
      actorType: principal.actorType,
      actorId: principal.actorId,
      label: principal.label,
      acquiredAt: now,
      renewedAt: now,
      expiresAt: now + this.ttlMs,
      revision: ++this.revision,
    };
    this.leases.set(sessionId, lease);
    this.schedule(lease);
    this.emit({ type: "taken-over", lease: copy(lease), previous });
    return { status: "granted", lease: copy(lease) };
  }

  renew(sessionId: string, holderId: string, leaseId: string): InputLease | undefined {
    const current = this.current(sessionId);
    if (!current || current.holderId !== holderId || current.id !== leaseId) return undefined;
    return this.renewExisting(current);
  }

  canWrite(sessionId: string, holderId: string, leaseId?: string): boolean {
    const current = this.current(sessionId);
    return !!current && current.holderId === holderId && (leaseId === undefined || current.id === leaseId);
  }

  release(sessionId: string, holderId: string, leaseId?: string): boolean {
    const current = this.current(sessionId);
    if (!current || current.holderId !== holderId || (leaseId !== undefined && current.id !== leaseId)) return false;
    this.remove(current, "released");
    return true;
  }

  releaseHolder(holderId: string): number {
    let released = 0;
    for (const lease of [...this.leases.values()]) {
      if (lease.holderId !== holderId) continue;
      this.remove(lease, "released");
      released += 1;
    }
    return released;
  }

  revoke(sessionId: string): boolean {
    const current = this.current(sessionId);
    if (!current) return false;
    this.remove(current, "revoked");
    return true;
  }

  revokeActor(actorType: InputLeaseActorType, actorId: string): number {
    let revoked = 0;
    for (const lease of [...this.leases.values()]) {
      if (lease.actorType !== actorType || lease.actorId !== actorId) continue;
      this.remove(lease, "revoked");
      revoked += 1;
    }
    return revoked;
  }

  get(sessionId: string): InputLease | undefined {
    const current = this.current(sessionId);
    return current ? copy(current) : undefined;
  }

  subscribe(sessionId: string, listener: (event: InputLeaseEvent) => void): () => void {
    safePart(sessionId, "session id");
    const listeners = this.listeners.get(sessionId) ?? new Set();
    listeners.add(listener);
    this.listeners.set(sessionId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(sessionId);
    };
  }

  close(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.leases.clear();
    this.listeners.clear();
  }

  private validate(sessionId: string, holderId: string, principal: InputLeasePrincipal): void {
    safePart(sessionId, "session id");
    safePart(holderId, "holder id");
    safePart(principal.actorId, "actor id");
    safePart(principal.label, "label");
  }

  private current(sessionId: string): InputLease | undefined {
    const lease = this.leases.get(sessionId);
    if (!lease) return undefined;
    if (lease.expiresAt > this.now()) return lease;
    this.remove(lease, "expired");
    return undefined;
  }

  private renewExisting(lease: InputLease): InputLease {
    const now = this.now();
    lease.renewedAt = now;
    lease.expiresAt = now + this.ttlMs;
    lease.revision = ++this.revision;
    this.schedule(lease);
    this.emit({ type: "renewed", lease: copy(lease) });
    return copy(lease);
  }

  private remove(lease: InputLease, type: "released" | "expired" | "revoked"): void {
    if (this.leases.get(lease.sessionId)?.id !== lease.id) return;
    this.leases.delete(lease.sessionId);
    const timer = this.timers.get(lease.sessionId);
    if (timer) clearTimeout(timer);
    this.timers.delete(lease.sessionId);
    lease.revision = ++this.revision;
    this.emit({ type, lease: copy(lease) });
  }

  private schedule(lease: InputLease): void {
    const existing = this.timers.get(lease.sessionId);
    if (existing) clearTimeout(existing);
    if (!this.scheduleExpiry) return;
    const timer = setTimeout(
      () => {
        const current = this.leases.get(lease.sessionId);
        if (!current || current.id !== lease.id) return;
        if (current.expiresAt <= this.now()) this.remove(current, "expired");
        else this.schedule(current);
      },
      Math.max(1, lease.expiresAt - this.now() + 1),
    );
    timer.unref?.();
    this.timers.set(lease.sessionId, timer);
  }

  private emit(event: InputLeaseEvent): void {
    try {
      this.onEvent?.(event);
    } catch {
      /* lease ownership remains authoritative when audit/event sinks fail */
    }
    for (const listener of [...(this.listeners.get(event.lease.sessionId) ?? [])]) {
      try {
        listener(event);
      } catch {
        /* one observer cannot prevent another from seeing the ownership transition */
      }
    }
  }
}
