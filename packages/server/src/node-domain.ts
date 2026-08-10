import { createHash } from "node:crypto";
import type { HostRecord } from "./command-center-store.js";
import type { ProviderAvailability } from "./providers/types.js";

export interface OwnerRef {
  type: "person";
  id: string;
}

export interface ProductContext {
  kind: "personal";
  id: string;
  name: string;
}

export interface NodeRecord {
  id: string;
  owner: OwnerRef;
  name: string;
  status: "online" | "offline" | "degraded";
  platform: string;
  lastSeenAt: number;
}

export type AgentRuntimeAuthState = "ready" | "required" | "unknown" | "error";

export interface AgentRuntimeRecord {
  id: string;
  nodeId: string;
  provider: string;
  displayName: string;
  availability: "available" | "unavailable";
  authState: AgentRuntimeAuthState;
  version?: string;
  capabilities: string[];
  activeSessionCount: number;
  observedAt: number;
}

export interface NodeProjectionInput {
  host: Pick<HostRecord, "id" | "label">;
  owner: OwnerRef;
  status: NodeRecord["status"];
  platform: string;
  lastSeenAt: number;
}

export interface AgentRuntimeDescriptor {
  id: string;
  displayName: string;
  version?: string;
  capabilities: Readonly<Record<string, boolean>>;
}

export type ProviderValueMap<T> = Readonly<Record<string, T | undefined>> | ReadonlyMap<string, T>;

export interface AgentRuntimeProjectionInput {
  nodeId: string;
  descriptors: readonly AgentRuntimeDescriptor[];
  availabilityByProvider: ProviderValueMap<ProviderAvailability>;
  authStateByProvider?: ProviderValueMap<AgentRuntimeAuthState>;
  activeSessionCountByProvider?: ProviderValueMap<number>;
  /** Product-level capabilities that are intentionally outside the versioned adapter manifest contract. */
  additionalCapabilitiesByProvider?: Readonly<Record<string, readonly string[] | undefined>>;
  observedAt: number;
}

/**
 * Runtime ids are opaque because node and adapter ids can originate in different trust domains.
 * JSON tuple framing prevents ambiguous concatenation, while base64url keeps the result route-safe.
 */
export function agentRuntimeId(nodeId: string, provider: string): string {
  const digest = createHash("sha256")
    .update("roamcode-agent-runtime-v1\0", "utf8")
    .update(JSON.stringify([nodeId, provider]), "utf8")
    .digest("base64url")
    .slice(0, 24);
  return `runtime_${digest}`;
}

/** Project the persistent command host into the product Node model without changing its identity. */
export function projectNodeRecord(input: NodeProjectionInput): NodeRecord {
  return {
    id: input.host.id,
    owner: { ...input.owner },
    name: input.host.label,
    status: input.status,
    platform: input.platform,
    lastSeenAt: input.lastSeenAt,
  };
}

function lookup<T>(values: ProviderValueMap<T> | undefined, key: string): T | undefined {
  if (!values) return undefined;
  const map = values as ReadonlyMap<string, T>;
  if (typeof map.get === "function") return map.get(key);
  return (values as Readonly<Record<string, T | undefined>>)[key];
}

function normalizeAuthState(value: AgentRuntimeAuthState | undefined): AgentRuntimeAuthState {
  return value === "ready" || value === "required" || value === "error" ? value : "unknown";
}

function normalizeActiveSessionCount(value: number | undefined): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

/**
 * Build the public runtime inventory from bounded provider facts. The projection deliberately picks
 * fields instead of spreading descriptors or probes, so probe detail, paths, credentials, and option
 * payloads cannot cross this boundary.
 */
export function projectAgentRuntimeRecords(input: AgentRuntimeProjectionInput): AgentRuntimeRecord[] {
  return input.descriptors.map((descriptor) => {
    const observedAvailability = lookup(input.availabilityByProvider, descriptor.id);
    const version = observedAvailability?.version ?? descriptor.version;
    return {
      id: agentRuntimeId(input.nodeId, descriptor.id),
      nodeId: input.nodeId,
      provider: descriptor.id,
      displayName: descriptor.displayName,
      availability: observedAvailability?.terminalAvailable === true ? "available" : "unavailable",
      authState: normalizeAuthState(lookup(input.authStateByProvider, descriptor.id)),
      ...(version ? { version } : {}),
      capabilities: [
        ...new Set([
          ...Object.entries(descriptor.capabilities)
            .filter(([, supported]) => supported)
            .map(([capability]) => capability),
          ...(input.additionalCapabilitiesByProvider?.[descriptor.id] ?? []),
        ]),
      ].sort(),
      activeSessionCount: normalizeActiveSessionCount(lookup(input.activeSessionCountByProvider, descriptor.id)),
      observedAt: input.observedAt,
    };
  });
}
