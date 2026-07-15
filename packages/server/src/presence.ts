import { randomUUID } from "node:crypto";
import type { InputLeasePrincipal } from "./input-lease.js";

export const PRESENCE_TTL_MS = 45_000;
export const PRESENCE_HEARTBEAT_MS = 15_000;

export type PresenceMode = "viewing" | "operating";

export interface PresenceTarget {
  hostId: string;
  workspaceId?: string;
  sessionId?: string;
  agentId?: string;
}

export interface PresenceRecord extends PresenceTarget {
  id: string;
  memberId?: string;
  label: string;
  mode: PresenceMode;
  connectedAt: number;
  lastSeenAt: number;
  expiresAt: number;
  revision: number;
}

export type PresenceEvent = {
  type: "joined" | "updated" | "left" | "expired";
  presence: PresenceRecord;
};

export interface PresenceHeartbeatInput extends PresenceTarget {
  clientId: string;
  mode: PresenceMode;
  memberId?: string;
}

export interface PresenceCoordinatorOptions {
  ttlMs?: number;
  now?: () => number;
  generateId?: () => string;
  maxRecords?: number;
  maxPerActor?: number;
  scheduleExpiry?: boolean;
}

interface InternalPresence extends PresenceRecord {
  key: string;
  actorKey: string;
}

function clone(record: PresenceRecord): PresenceRecord {
  return { ...record };
}

function safeId(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{1,256}$/.test(value)) {
    throw new Error(`invalid presence ${field}`);
  }
  return value;
}

function safeLabel(value: unknown): string {
  if (typeof value !== "string") throw new Error("invalid presence label");
  const normalized = value.trim().replace(/\s+/g, " ");
  if (!normalized || normalized.length > 120 || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(normalized)) {
    throw new Error("invalid presence label");
  }
  return normalized;
}

/**
 * Ephemeral, privacy-bounded presence. No IP, bearer credential, path, prompt, or terminal data is retained.
 * Heartbeats expire cleanly after disconnect and are capped both globally and per authenticated actor.
 */
export class PresenceCoordinator {
  private readonly records = new Map<string, InternalPresence>();
  private readonly listeners = new Set<(event: PresenceEvent) => void>();
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly generateId: () => string;
  private readonly maxRecords: number;
  private readonly maxPerActor: number;
  private readonly timer?: ReturnType<typeof setInterval>;
  private revision = 0;

  constructor(options: PresenceCoordinatorOptions = {}) {
    this.ttlMs = options.ttlMs ?? PRESENCE_TTL_MS;
    this.maxRecords = options.maxRecords ?? 5_000;
    this.maxPerActor = options.maxPerActor ?? 20;
    if (!Number.isSafeInteger(this.ttlMs) || this.ttlMs < 5_000 || this.ttlMs > 5 * 60_000) {
      throw new Error("invalid presence TTL");
    }
    if (!Number.isSafeInteger(this.maxRecords) || this.maxRecords < 1 || this.maxRecords > 100_000) {
      throw new Error("invalid presence record limit");
    }
    if (!Number.isSafeInteger(this.maxPerActor) || this.maxPerActor < 1 || this.maxPerActor > 1_000) {
      throw new Error("invalid presence actor limit");
    }
    this.now = options.now ?? Date.now;
    this.generateId = options.generateId ?? randomUUID;
    if (options.scheduleExpiry ?? true) {
      this.timer = setInterval(() => this.sweep(), Math.min(15_000, Math.max(1_000, Math.floor(this.ttlMs / 2))));
      this.timer.unref?.();
    }
  }

  heartbeat(principal: InputLeasePrincipal, input: PresenceHeartbeatInput): PresenceRecord {
    this.sweep();
    const actorKey = `${principal.actorType}\0${safeId(principal.actorId, "actor id")}`;
    const clientId = safeId(input.clientId, "client id");
    const key = `${actorKey}\0${clientId}`;
    const now = this.now();
    const existing = this.records.get(key);
    if (!existing) this.enforceBounds(actorKey);
    const record: InternalPresence = {
      id: existing?.id ?? safeId(this.generateId(), "id"),
      key,
      actorKey,
      ...(input.memberId ? { memberId: safeId(input.memberId, "member id") } : {}),
      label: safeLabel(principal.label),
      mode: input.mode === "operating" ? "operating" : "viewing",
      hostId: safeId(input.hostId, "host id"),
      ...(input.workspaceId ? { workspaceId: safeId(input.workspaceId, "workspace id") } : {}),
      ...(input.sessionId ? { sessionId: safeId(input.sessionId, "session id") } : {}),
      ...(input.agentId ? { agentId: safeId(input.agentId, "agent id") } : {}),
      connectedAt: existing?.connectedAt ?? now,
      lastSeenAt: now,
      expiresAt: now + this.ttlMs,
      revision: ++this.revision,
    };
    this.records.set(key, record);
    this.emit({ type: existing ? "updated" : "joined", presence: this.publicRecord(record) });
    return this.publicRecord(record);
  }

  list(filter: Partial<PresenceTarget> = {}): PresenceRecord[] {
    this.sweep();
    return [...this.records.values()]
      .filter(
        (record) =>
          (filter.hostId === undefined || record.hostId === filter.hostId) &&
          (filter.workspaceId === undefined || record.workspaceId === filter.workspaceId) &&
          (filter.sessionId === undefined || record.sessionId === filter.sessionId) &&
          (filter.agentId === undefined || record.agentId === filter.agentId),
      )
      .sort((a, b) => b.lastSeenAt - a.lastSeenAt || a.id.localeCompare(b.id))
      .map((record) => this.publicRecord(record));
  }

  release(principal: Pick<InputLeasePrincipal, "actorType" | "actorId">, clientId: string): boolean {
    const key = `${principal.actorType}\0${safeId(principal.actorId, "actor id")}\0${safeId(clientId, "client id")}`;
    const record = this.records.get(key);
    if (!record) return false;
    this.records.delete(key);
    record.revision = ++this.revision;
    this.emit({ type: "left", presence: this.publicRecord(record) });
    return true;
  }

  releaseActor(principal: Pick<InputLeasePrincipal, "actorType" | "actorId">): number {
    const actorKey = `${principal.actorType}\0${safeId(principal.actorId, "actor id")}`;
    let removed = 0;
    for (const record of [...this.records.values()]) {
      if (record.actorKey !== actorKey) continue;
      this.records.delete(record.key);
      record.revision = ++this.revision;
      this.emit({ type: "left", presence: this.publicRecord(record) });
      removed += 1;
    }
    return removed;
  }

  /**
   * Input ownership is authoritative for the public "operating" label. When a lease ends or moves, keep the
   * connected observer visible but immediately downgrade stale operating heartbeats instead of waiting for TTL.
   */
  downgradeOperating(principal: Pick<InputLeasePrincipal, "actorType" | "actorId">, sessionId: string): number {
    const actorKey = `${principal.actorType}\0${safeId(principal.actorId, "actor id")}`;
    const safeSessionId = safeId(sessionId, "session id");
    let updated = 0;
    for (const record of this.records.values()) {
      if (record.actorKey !== actorKey || record.sessionId !== safeSessionId || record.mode !== "operating") continue;
      record.mode = "viewing";
      record.revision = ++this.revision;
      this.emit({ type: "updated", presence: this.publicRecord(record) });
      updated += 1;
    }
    return updated;
  }

  subscribe(listener: (event: PresenceEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  sweep(): number {
    const now = this.now();
    let expired = 0;
    for (const record of [...this.records.values()]) {
      if (record.expiresAt > now) continue;
      this.records.delete(record.key);
      record.revision = ++this.revision;
      this.emit({ type: "expired", presence: this.publicRecord(record) });
      expired += 1;
    }
    return expired;
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.records.clear();
    this.listeners.clear();
  }

  private enforceBounds(actorKey: string): void {
    const actorRecords = [...this.records.values()]
      .filter((record) => record.actorKey === actorKey)
      .sort((a, b) => a.lastSeenAt - b.lastSeenAt || a.id.localeCompare(b.id));
    while (actorRecords.length >= this.maxPerActor) this.evict(actorRecords.shift()!);
    if (this.records.size >= this.maxRecords) {
      const oldest = [...this.records.values()].sort(
        (a, b) => a.lastSeenAt - b.lastSeenAt || a.id.localeCompare(b.id),
      )[0];
      if (oldest) this.evict(oldest);
    }
  }

  private evict(record: InternalPresence): void {
    if (!this.records.delete(record.key)) return;
    record.revision = ++this.revision;
    this.emit({ type: "expired", presence: this.publicRecord(record) });
  }

  private publicRecord(record: InternalPresence): PresenceRecord {
    return clone({
      id: record.id,
      ...(record.memberId ? { memberId: record.memberId } : {}),
      label: record.label,
      mode: record.mode,
      hostId: record.hostId,
      ...(record.workspaceId ? { workspaceId: record.workspaceId } : {}),
      ...(record.sessionId ? { sessionId: record.sessionId } : {}),
      ...(record.agentId ? { agentId: record.agentId } : {}),
      connectedAt: record.connectedAt,
      lastSeenAt: record.lastSeenAt,
      expiresAt: record.expiresAt,
      revision: record.revision,
    });
  }

  private emit(event: PresenceEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener({ type: event.type, presence: clone(event.presence) });
      } catch {
        /* one client cannot disrupt presence expiry or other subscribers */
      }
    }
  }
}
