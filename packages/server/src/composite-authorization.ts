import type { CloudAuthorizationDecision, CloudAuthorizationStore } from "./cloud-authorization-store.js";
import type {
  TeamAuthorizationDecision,
  TeamAuthorizationResource,
  TeamMember,
  TeamPermission,
  TeamPrincipalType,
  TeamRole,
  TeamStore,
} from "./team-store.js";

export type CompositeAuthorizationReason = TeamAuthorizationDecision["reason"] | CloudAuthorizationDecision["reason"];

export interface CompositeAuthorizationDecision {
  allowed: boolean;
  reason: CompositeAuthorizationReason;
  source: "local" | "team" | "cloud";
  roles: TeamRole[];
  member?: TeamMember;
  cloudRevision?: number;
}

export interface CompositeAuthorizer {
  authorize(
    actorType: TeamPrincipalType,
    actorId: string,
    permission: TeamPermission,
    resource?: TeamAuthorizationResource,
  ): CompositeAuthorizationDecision;
}

export interface CreateCompositeAuthorizerOptions {
  teamStore: TeamStore;
  /** Omit for self-hosted mode; presence makes a valid cloud grant an additional requirement for remote actors. */
  cloudStore?: CloudAuthorizationStore;
  /**
   * The managed control plane may assign the same physical Node a cloud Host id that differs from the
   * command-center store's local Host id. TeamStore must continue authorizing against the local id while the
   * signed cloud snapshot must see its own target id, so translate only the cloud layer at this composition
   * boundary instead of leaking a connection alias into every local resource.
   */
  cloudHostId?: string;
  /** Persisted managed ownership without a usable cloud store remains fail-closed for every remote actor. */
  requireCloud?: boolean;
  now?: () => number;
}

function fromTeam(decision: TeamAuthorizationDecision, source: "local" | "team"): CompositeAuthorizationDecision {
  return {
    allowed: decision.allowed,
    reason: decision.reason,
    source,
    roles: [...decision.roles],
    ...(decision.member ? { member: { ...decision.member } } : {}),
  };
}

/**
 * Composes cloud grants with the existing local TeamStore policy. Self-hosted callers keep TeamStore behavior
 * exactly; cloud-managed callers must pass both layers. Host and local recovery principals never depend on cloud
 * availability, so an expired or unreachable control plane cannot lock an operator out of their own machine.
 */
export function createCompositeAuthorizer(options: CreateCompositeAuthorizerOptions): CompositeAuthorizer {
  return {
    authorize(actorType, actorId, permission, resource) {
      if (actorType === "host" || actorType === "local") {
        return {
          allowed: true,
          reason: "local-break-glass",
          source: "local",
          roles: ["organization-admin"],
        };
      }

      const teamDecision = options.teamStore.authorize(actorType, actorId, permission, resource);
      if (!teamDecision.allowed) return fromTeam(teamDecision, "team");
      if (!options.cloudStore) {
        if (options.requireCloud) {
          return {
            allowed: false,
            reason: "cloud-authorization-unavailable",
            source: "cloud",
            roles: [...teamDecision.roles],
            ...(teamDecision.member ? { member: { ...teamDecision.member } } : {}),
          };
        }
        return fromTeam(teamDecision, "team");
      }

      const cloudResource =
        resource && options.cloudHostId
          ? {
              ...resource,
              ...(resource.hostId === undefined ? {} : { hostId: options.cloudHostId }),
            }
          : resource;
      // Relay is a transport shape, not a second managed identity namespace. The broker channel is authenticated
      // with the same host-canonical DeviceStore actor id that the control plane records in host_devices, so signed
      // snapshots consistently bind it as a device while local TeamStore policy can still distinguish relay access.
      const cloudActorType = actorType === "relay" ? "device" : actorType;
      const cloudDecision = options.cloudStore.authorize(
        cloudActorType,
        actorId,
        permission,
        cloudResource,
        (options.now ?? Date.now)(),
      );
      return {
        allowed: cloudDecision.allowed,
        reason: cloudDecision.reason,
        source: "cloud",
        roles: [...teamDecision.roles],
        ...(teamDecision.member ? { member: { ...teamDecision.member } } : {}),
        ...(cloudDecision.revision === undefined ? {} : { cloudRevision: cloudDecision.revision }),
      };
    },
  };
}
