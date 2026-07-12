import { isConcreteSessionStore, type SessionStore } from "../session-store.js";

const capabilities = new WeakSet<object>();

export interface CodexThreadPersistence {
  markProvisional(id: string): void;
  clear(id: string): void;
  commit(id: string): void;
}

class StoreBoundCodexThreadPersistence implements CodexThreadPersistence {
  constructor(
    private readonly store: SessionStore,
    private readonly roamSessionId: string,
  ) {}

  markProvisional(id: string): void {
    this.requireCodexSession();
    this.store.markProvisionalProviderSessionId(this.roamSessionId, id);
    if (this.store.get(this.roamSessionId)?.providerSessionId !== undefined) throw new Error("Persistence failed");
  }

  clear(id: string): void {
    this.requireCodexSession();
    this.store.clearProvisionalProviderSessionId(this.roamSessionId, id);
    if (this.store.get(this.roamSessionId)?.providerSessionId !== undefined) throw new Error("Rollback failed");
  }

  commit(id: string): void {
    this.requireCodexSession();
    this.store.commitProvisionalProviderSessionId(this.roamSessionId, id);
    if (this.store.get(this.roamSessionId)?.providerSessionId !== id) throw new Error("Persistence identity changed");
  }

  private requireCodexSession() {
    const session = this.store.get(this.roamSessionId);
    if (!session || session.provider !== "codex") throw new Error("Codex session is unavailable");
    return session;
  }
}

/** Creates the only persistence object accepted by the exact-thread resolver. */
export function createCodexThreadPersistence(store: SessionStore, roamSessionId: string): CodexThreadPersistence {
  if (!isConcreteSessionStore(store) || roamSessionId.length === 0) throw new Error("Invalid Codex persistence");
  const capability = new StoreBoundCodexThreadPersistence(store, roamSessionId);
  capabilities.add(capability);
  return capability;
}

export function isCodexThreadPersistence(value: unknown): value is CodexThreadPersistence {
  return typeof value === "object" && value !== null && capabilities.has(value);
}
