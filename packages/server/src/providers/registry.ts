import { ProviderError, type AgentProvider, type ProviderId } from "./types.js";
import {
  ADAPTER_CONTRACT_VERSION,
  defineAdapterManifest,
  publicAdapterDescriptor,
  type AdapterManifestV1,
} from "./adapter-contract.js";

export class ProviderRegistry {
  private readonly byId = new Map<ProviderId, AgentProvider>();
  private readonly manifests = new Map<ProviderId, Readonly<AdapterManifestV1>>();

  constructor(providers: readonly AgentProvider[]) {
    for (const provider of providers) {
      this.register(provider);
    }
  }

  private register(provider: AgentProvider): void {
    if (this.byId.has(provider.id)) {
      throw new ProviderError("PROVIDER_UNAVAILABLE", `duplicate provider id: ${provider.id}`);
    }
    const manifest = provider.manifest
      ? defineAdapterManifest(provider.manifest)
      : process.env.NODE_ENV === "test"
        ? defineAdapterManifest({
            schemaVersion: ADAPTER_CONTRACT_VERSION,
            id: provider.id,
            version: "0.0.0-test",
            displayName: provider.displayName,
            platforms: ["darwin", "linux"],
            resumeIdentity: provider.resumeIdentity,
            capabilities: {
              probe: true,
              launch: true,
              resume: true,
              state: true,
              identity: true,
              metadata: typeof provider.runtimeMetadata === "function",
              usage: false,
              login: false,
              attachments: false,
              cleanup: true,
            },
            stateAuthority: ["pane-heuristics"],
            optionSchema: { type: "object" },
          })
        : undefined;
    if (!manifest) {
      throw new ProviderError("PROVIDER_UNAVAILABLE", `provider adapter manifest is required: ${provider.id}`);
    }
    if (
      manifest.id !== provider.id ||
      manifest.displayName !== provider.displayName ||
      manifest.resumeIdentity !== provider.resumeIdentity
    ) {
      throw new ProviderError("PROVIDER_UNAVAILABLE", `provider adapter manifest mismatch: ${provider.id}`);
    }
    this.byId.set(provider.id, provider);
    this.manifests.set(provider.id, manifest);
  }

  has(id: ProviderId): boolean {
    return this.byId.has(id);
  }

  get(id: ProviderId): AgentProvider {
    const provider = this.byId.get(id);
    if (!provider) throw new ProviderError("PROVIDER_UNAVAILABLE", `provider unavailable: ${id}`);
    return provider;
  }

  list(): AgentProvider[] {
    return [...this.byId.values()];
  }

  manifest(id: ProviderId): Readonly<AdapterManifestV1> {
    const manifest = this.manifests.get(id);
    if (!manifest) throw new ProviderError("PROVIDER_UNAVAILABLE", `provider unavailable: ${id}`);
    return manifest;
  }

  descriptors() {
    return [...this.manifests.values()].map(publicAdapterDescriptor);
  }
}

export type ReturnTypeOfDescriptors = ReturnType<ProviderRegistry["descriptors"]>;
