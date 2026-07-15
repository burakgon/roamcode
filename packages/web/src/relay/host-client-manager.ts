import {
  loadDirectHostToken,
  loadRelayHostCredential,
  type DirectHostRecord,
  type RelayHostConnection,
  type StorageLike,
} from "../hosts/direct-hosts";
import {
  createBrowserRelayClient,
  type BrowserRelayClient,
  type BrowserRelayClientOptions,
  type BrowserRelayStatus,
} from "./client";
import { browserRelayIdentityFingerprint } from "./crypto";
import {
  browserRelayIdentityStorageKey,
  loadOrCreateBrowserRelayIdentity,
  type BrowserRelayIdentityRecord,
} from "./identity-store";

interface RelayConnectionMaterial {
  relay: RelayHostConnection;
  deviceCredential: string;
  deviceToken: string;
}

interface RelayClientEntry {
  material: RelayConnectionMaterial;
  client: BrowserRelayClient;
}

interface PendingRelayClient {
  generation: number;
  material: RelayConnectionMaterial;
  promise: Promise<BrowserRelayClient>;
}

export type RelayHostStatusListener = (hostId: string, status: BrowserRelayStatus) => void;

export interface RelayHostClientManager {
  resume(): void;
  clientFor(host: DirectHostRecord): Promise<BrowserRelayClient>;
  fetch(host: DirectHostRecord, input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  reconnect(hostId: string): boolean;
  status(hostId: string): BrowserRelayStatus | undefined;
  closeHost(hostId: string): void;
  reconcile(hosts: readonly DirectHostRecord[]): void;
  subscribe(listener: RelayHostStatusListener): () => void;
  close(): void;
}

export interface RelayHostClientManagerOptions {
  storage?: StorageLike;
  loadDeviceCredential?: (hostId: string, storage?: StorageLike) => string | undefined;
  loadDeviceToken?: (hostId: string, storage?: StorageLike) => string | undefined;
  loadIdentity?: (key: string) => Promise<BrowserRelayIdentityRecord>;
  fingerprint?: (publicKey: string) => Promise<string>;
  createClient?: (options: BrowserRelayClientOptions) => BrowserRelayClient;
}

function sameRelay(a: RelayHostConnection, b: RelayHostConnection): boolean {
  return (
    a.relayUrl === b.relayUrl &&
    a.routeId === b.routeId &&
    a.deviceId === b.deviceId &&
    a.hostIdentityPublicKey === b.hostIdentityPublicKey &&
    a.hostIdentityFingerprint === b.hostIdentityFingerprint &&
    a.deviceIdentityFingerprint === b.deviceIdentityFingerprint
  );
}

function sameMaterial(a: RelayConnectionMaterial, b: RelayConnectionMaterial): boolean {
  return a.deviceCredential === b.deviceCredential && a.deviceToken === b.deviceToken && sameRelay(a.relay, b.relay);
}

/**
 * Owns the single browser connection for each paired relay device.
 *
 * Active terminal traffic, background attention scans, and global search must share this owner. Opening a
 * second socket for the same device would make the broker supersede the first one and create a reconnect loop.
 */
export function createRelayHostClientManager(options: RelayHostClientManagerOptions = {}): RelayHostClientManager {
  const loadCredential = options.loadDeviceCredential ?? loadRelayHostCredential;
  const loadToken = options.loadDeviceToken ?? loadDirectHostToken;
  const loadIdentity = options.loadIdentity ?? loadOrCreateBrowserRelayIdentity;
  const fingerprint = options.fingerprint ?? browserRelayIdentityFingerprint;
  const createClient = options.createClient ?? createBrowserRelayClient;
  const clients = new Map<string, RelayClientEntry>();
  const pending = new Map<string, PendingRelayClient>();
  const generations = new Map<string, number>();
  const listeners = new Set<RelayHostStatusListener>();
  let closed = false;

  const materialFor = (host: DirectHostRecord): RelayConnectionMaterial => {
    if (!host.relay) throw new Error("This host does not use an encrypted relay.");
    const deviceCredential = loadCredential(host.id, options.storage);
    const deviceToken = loadToken(host.id, options.storage);
    if (!deviceCredential || !deviceToken) {
      throw new Error("This relay connection is missing its local device credential. Pair this browser again.");
    }
    return { relay: host.relay, deviceCredential, deviceToken };
  };

  const nextGeneration = (hostId: string): number => {
    const generation = (generations.get(hostId) ?? 0) + 1;
    generations.set(hostId, generation);
    return generation;
  };

  const emit = (hostId: string, status: BrowserRelayStatus) => {
    for (const listener of listeners) listener(hostId, status);
  };

  const closeHost = (hostId: string) => {
    nextGeneration(hostId);
    pending.delete(hostId);
    const entry = clients.get(hostId);
    clients.delete(hostId);
    entry?.client.close();
  };

  const clientFor = async (host: DirectHostRecord): Promise<BrowserRelayClient> => {
    if (closed) throw new Error("The relay connection manager is closed.");
    const material = materialFor(host);
    const current = clients.get(host.id);
    if (current && sameMaterial(current.material, material) && current.client.status() !== "closed") {
      return current.client;
    }
    const inFlight = pending.get(host.id);
    if (inFlight && sameMaterial(inFlight.material, material)) return inFlight.promise;

    if (current) {
      clients.delete(host.id);
      current.client.close();
    }
    const generation = nextGeneration(host.id);
    const work = (async () => {
      const identityRecord = await loadIdentity(browserRelayIdentityStorageKey(material.relay));
      const [deviceFingerprint, hostFingerprint] = await Promise.all([
        fingerprint(identityRecord.identity.publicKey),
        fingerprint(material.relay.hostIdentityPublicKey),
      ]);
      if (deviceFingerprint !== material.relay.deviceIdentityFingerprint) {
        throw new Error(
          "This browser’s relay identity no longer matches the paired device. RoamCode will not silently replace it.",
        );
      }
      if (hostFingerprint !== material.relay.hostIdentityFingerprint) {
        throw new Error("The saved host identity is inconsistent. RoamCode stopped before opening the relay.");
      }
      if (closed || generations.get(host.id) !== generation) {
        throw new Error("The relay connection changed while it was starting.");
      }
      const client = createClient({
        relayUrl: material.relay.relayUrl,
        routeId: material.relay.routeId,
        deviceId: material.relay.deviceId,
        deviceCredential: material.deviceCredential,
        deviceToken: material.deviceToken,
        identity: identityRecord.identity,
        hostIdentityPublicKey: material.relay.hostIdentityPublicKey,
        onStatus: (status) => emit(host.id, status),
      });
      if (closed || generations.get(host.id) !== generation) {
        client.close();
        throw new Error("The relay connection changed while it was starting.");
      }
      clients.set(host.id, { material, client });
      client.start();
      return client;
    })();
    const tracked: Promise<BrowserRelayClient> = work.finally(() => {
      if (pending.get(host.id)?.promise === tracked) pending.delete(host.id);
    });
    pending.set(host.id, { generation, material, promise: tracked });
    return tracked;
  };

  return {
    resume() {
      closed = false;
    },
    clientFor,
    async fetch(host, input, init) {
      return (await clientFor(host)).fetch(input, init);
    },
    reconnect(hostId) {
      const client = clients.get(hostId)?.client;
      if (!client) return false;
      client.reconnect();
      return true;
    },
    status(hostId) {
      return clients.get(hostId)?.client.status();
    },
    closeHost,
    reconcile(hosts) {
      const relayHosts = new Map(hosts.filter((host) => host.relay).map((host) => [host.id, host]));
      for (const hostId of new Set([...clients.keys(), ...pending.keys()])) {
        const host = relayHosts.get(hostId);
        if (!host) {
          closeHost(hostId);
          continue;
        }
        let material: RelayConnectionMaterial;
        try {
          material = materialFor(host);
        } catch {
          closeHost(hostId);
          continue;
        }
        const activeMaterial = clients.get(hostId)?.material ?? pending.get(hostId)?.material;
        if (activeMaterial && !sameMaterial(activeMaterial, material)) closeHost(hostId);
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close() {
      if (closed) return;
      closed = true;
      listeners.clear();
      for (const hostId of new Set([...clients.keys(), ...pending.keys()])) closeHost(hostId);
    },
  };
}
