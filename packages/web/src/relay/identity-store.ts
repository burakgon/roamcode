import { generateBrowserRelayIdentity, validateBrowserRelayIdentity, type BrowserRelayIdentity } from "./crypto";

const DATABASE_NAME = "roamcode-relay";
const DATABASE_VERSION = 1;
const STORE_NAME = "identities";

interface StoredIdentity extends BrowserRelayIdentity {
  key: string;
  createdAt: number;
  version: 1;
}

export interface BrowserRelayIdentityRecord {
  identity: BrowserRelayIdentity;
  createdAt: number;
  generated: boolean;
}

export interface BrowserRelayIdentityRepository {
  get(key: string): Promise<StoredIdentity | undefined>;
  add(record: StoredIdentity): Promise<boolean>;
  delete(key: string): Promise<void>;
  listMetadata(): Promise<Array<{ key: string; createdAt: number }>>;
}

function safeIdentityKey(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 1024 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error("invalid relay identity storage key");
  }
  return normalized;
}

/**
 * The private browser identity belongs to one relay route/device pair, not to a mutable UI host id.
 * Include the pinned host fingerprint so two independent relays that happen to reuse the same opaque
 * route identifiers can never share a signing identity by accident.
 */
export function browserRelayIdentityStorageKey(input: {
  hostIdentityFingerprint: string;
  routeId: string;
  deviceId: string;
}): string {
  return safeIdentityKey(`relay:${input.hostIdentityFingerprint}:${input.routeId}:${input.deviceId}`);
}

function openDatabase(): Promise<IDBDatabase> {
  if (!globalThis.indexedDB) return Promise.reject(new Error("IndexedDB is unavailable"));
  return new Promise((resolve, reject) => {
    const request = globalThis.indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) database.createObjectStore(STORE_NAME, { keyPath: "key" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("could not open relay identity storage"));
    request.onblocked = () => reject(new Error("relay identity storage upgrade is blocked by another tab"));
  });
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("relay identity storage failed"));
  });
}

export function createIndexedDbRelayIdentityRepository(): BrowserRelayIdentityRepository {
  return {
    async get(key) {
      const database = await openDatabase();
      try {
        const transaction = database.transaction(STORE_NAME, "readonly");
        return (await requestResult(transaction.objectStore(STORE_NAME).get(key))) as StoredIdentity | undefined;
      } finally {
        database.close();
      }
    },
    async add(record) {
      const database = await openDatabase();
      try {
        return await new Promise<boolean>((resolve, reject) => {
          const transaction = database.transaction(STORE_NAME, "readwrite");
          let conflict = false;
          const request = transaction.objectStore(STORE_NAME).add(record);
          request.onerror = (event) => {
            if (request.error?.name !== "ConstraintError") return;
            conflict = true;
            event.preventDefault();
            event.stopPropagation();
          };
          transaction.oncomplete = () => resolve(!conflict);
          transaction.onerror = () => reject(transaction.error ?? new Error("could not store relay identity"));
          transaction.onabort = () =>
            conflict ? resolve(false) : reject(transaction.error ?? new Error("could not store relay identity"));
        });
      } finally {
        database.close();
      }
    },
    async delete(key) {
      const database = await openDatabase();
      try {
        const transaction = database.transaction(STORE_NAME, "readwrite");
        await new Promise<void>((resolve, reject) => {
          transaction.objectStore(STORE_NAME).delete(key);
          transaction.oncomplete = () => resolve();
          transaction.onerror = () => reject(transaction.error ?? new Error("could not delete relay identity"));
          transaction.onabort = () => reject(transaction.error ?? new Error("could not delete relay identity"));
        });
      } finally {
        database.close();
      }
    },
    async listMetadata() {
      const database = await openDatabase();
      try {
        const transaction = database.transaction(STORE_NAME, "readonly");
        const records = (await requestResult(transaction.objectStore(STORE_NAME).getAll())) as Array<
          Partial<StoredIdentity>
        >;
        return records.flatMap((record) =>
          typeof record.key === "string" && Number.isSafeInteger(record.createdAt) && record.createdAt! >= 0
            ? [{ key: record.key, createdAt: record.createdAt! }]
            : [],
        );
      } finally {
        database.close();
      }
    },
  };
}

async function validatedRecord(record: StoredIdentity | undefined): Promise<BrowserRelayIdentityRecord | undefined> {
  if (!record) return undefined;
  if (record.version !== 1 || !Number.isSafeInteger(record.createdAt) || record.createdAt < 0) {
    throw new Error("stored relay identity has an unsupported format");
  }
  try {
    const identity = await validateBrowserRelayIdentity(record);
    return { identity, createdAt: record.createdAt, generated: false };
  } catch {
    throw new Error("stored relay identity is invalid; unpair this device before creating a new identity");
  }
}

const inFlight = new Map<string, Promise<BrowserRelayIdentityRecord>>();

/**
 * Load an existing relay identity without creating replacement key material. Repair flows use this
 * distinction to tell a complete saved Node from a registry entry whose IndexedDB identity was cleared.
 */
export async function loadBrowserRelayIdentity(
  rawKey: string,
  repository: BrowserRelayIdentityRepository = createIndexedDbRelayIdentityRepository(),
): Promise<BrowserRelayIdentityRecord | undefined> {
  const key = safeIdentityKey(rawKey);
  return validatedRecord(await repository.get(key));
}

export async function loadOrCreateBrowserRelayIdentity(
  rawKey: string,
  options: {
    repository?: BrowserRelayIdentityRepository;
    generate?: () => Promise<BrowserRelayIdentity>;
    now?: () => number;
  } = {},
): Promise<BrowserRelayIdentityRecord> {
  const key = safeIdentityKey(rawKey);
  const work = async () => {
    const repository = options.repository ?? createIndexedDbRelayIdentityRepository();
    const existing = await validatedRecord(await repository.get(key));
    if (existing) return existing;
    const identity = await validateBrowserRelayIdentity(await (options.generate ?? generateBrowserRelayIdentity)());
    const createdAt = (options.now ?? Date.now)();
    if (!Number.isSafeInteger(createdAt) || createdAt < 0) throw new Error("invalid relay identity creation time");
    const installed = await repository.add({ key, version: 1, createdAt, ...identity });
    if (installed) return { identity, createdAt, generated: true };
    const winner = await validatedRecord(await repository.get(key));
    if (!winner) throw new Error("relay identity creation raced but no durable identity was found");
    return winner;
  };
  if (options.repository) return work();
  const active = inFlight.get(key);
  if (active) return active;
  const promise = work().finally(() => inFlight.delete(key));
  inFlight.set(key, promise);
  return promise;
}

export async function deleteBrowserRelayIdentity(
  rawKey: string,
  repository?: BrowserRelayIdentityRepository,
): Promise<void> {
  const key = safeIdentityKey(rawKey);
  // Cancellation can race the first WebCrypto generation. Wait for that write before deleting so an
  // abandoned attempt cannot recreate its private key after the user has explicitly discarded it.
  if (!repository) await inFlight.get(key)?.catch(() => undefined);
  await (repository ?? createIndexedDbRelayIdentityRepository()).delete(key);
}

/**
 * Copy a validated non-exportable identity to its final route-bound key. CryptoKey is structured-cloneable,
 * so the private key never becomes extractable or leaves IndexedDB. Replays are idempotent and reject a
 * conflicting identity instead of silently replacing one that may already protect a saved Node.
 */
export async function installBrowserRelayIdentity(
  rawKey: string,
  identity: BrowserRelayIdentity,
  options: {
    repository?: BrowserRelayIdentityRepository;
    now?: () => number;
  } = {},
): Promise<BrowserRelayIdentityRecord> {
  const key = safeIdentityKey(rawKey);
  const validated = await validateBrowserRelayIdentity(identity);
  const repository = options.repository ?? createIndexedDbRelayIdentityRepository();
  const existing = await validatedRecord(await repository.get(key));
  if (existing) {
    if (existing.identity.fingerprint !== validated.fingerprint) {
      throw new Error("a different relay identity is already installed for this Node device");
    }
    return existing;
  }
  const createdAt = (options.now ?? Date.now)();
  if (!Number.isSafeInteger(createdAt) || createdAt < 0) throw new Error("invalid relay identity creation time");
  const installed = await repository.add({ key, version: 1, createdAt, ...validated });
  if (installed) return { identity: validated, createdAt, generated: true };
  const winner = await validatedRecord(await repository.get(key));
  if (!winner || winner.identity.fingerprint !== validated.fingerprint) {
    throw new Error("relay identity installation raced with a different identity");
  }
  return winner;
}

/** Remove abandoned pairing identities without touching keys referenced by a saved or in-flight relay host. */
export async function pruneOrphanedBrowserRelayIdentities(
  activeKeys: Iterable<string>,
  options: {
    repository?: BrowserRelayIdentityRepository;
    now?: number;
    graceMs?: number;
  } = {},
): Promise<number> {
  const now = options.now ?? Date.now();
  const graceMs = options.graceMs ?? 10 * 60_000;
  if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(graceMs) || graceMs < 60_000) {
    throw new Error("invalid relay identity pruning window");
  }
  const active = new Set([...activeKeys].map(safeIdentityKey));
  const repository = options.repository ?? createIndexedDbRelayIdentityRepository();
  let deleted = 0;
  for (const record of await repository.listMetadata()) {
    if (active.has(record.key) || record.createdAt > now - graceMs) continue;
    await repository.delete(safeIdentityKey(record.key));
    deleted += 1;
  }
  return deleted;
}
