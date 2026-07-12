import { ProviderError, type AgentProvider, type ProviderId } from "./types.js";

export class ProviderRegistry {
  private readonly byId: ReadonlyMap<ProviderId, AgentProvider>;

  constructor(providers: readonly AgentProvider[]) {
    const byId = new Map<ProviderId, AgentProvider>();
    for (const provider of providers) {
      if (byId.has(provider.id)) {
        throw new ProviderError("PROVIDER_UNAVAILABLE", `duplicate provider id: ${provider.id}`);
      }
      byId.set(provider.id, provider);
    }
    this.byId = byId;
  }

  get(id: ProviderId): AgentProvider {
    const provider = this.byId.get(id);
    if (!provider) throw new ProviderError("PROVIDER_UNAVAILABLE", `provider unavailable: ${id}`);
    return provider;
  }

  list(): AgentProvider[] {
    return [...this.byId.values()];
  }
}
