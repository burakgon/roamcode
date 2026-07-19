import type {
  TeamAuthorizationDecision,
  TeamAuthorizationResource,
  TeamPermission,
  TeamPrincipalType,
  TeamStore,
} from "./team-store.js";

export interface AuthorizationDecision extends TeamAuthorizationDecision {
  source: "local" | "team";
}

export interface Authorizer {
  authorize(
    actorType: TeamPrincipalType,
    actorId: string,
    permission: TeamPermission,
    resource?: TeamAuthorizationResource,
  ): AuthorizationDecision;
}

/** Standalone authorization is owned entirely by the local durable TeamStore. */
export function createTeamAuthorizer(teamStore: TeamStore): Authorizer {
  return {
    authorize(actorType, actorId, permission, resource) {
      const decision = teamStore.authorize(actorType, actorId, permission, resource);
      return {
        ...decision,
        source: actorType === "host" || actorType === "local" ? "local" : "team",
      };
    },
  };
}
