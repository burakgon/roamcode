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
  private readonly sources = new Map<ProviderId, "built-in" | "installed">();
  private readonly enabled = new Set<ProviderId>();

  constructor(providers: readonly AgentProvider[]) {
    for (const provider of providers) {
      this.register(provider, "built-in", true);
    }
  }

  register(provider: AgentProvider, source: "built-in" | "installed" = "installed", enabled = true): void {
    if (this.byId.has(provider.id) && this.sources.get(provider.id) === "built-in") {
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
    this.sources.set(provider.id, source);
    if (enabled) this.enabled.add(provider.id);
    else this.enabled.delete(provider.id);
  }

  setEnabled(id: ProviderId, enabled: boolean): void {
    if (!this.byId.has(id)) throw new ProviderError("PROVIDER_UNAVAILABLE", `provider unavailable: ${id}`);
    if (enabled) this.enabled.add(id);
    else this.enabled.delete(id);
  }

  isEnabled(id: ProviderId): boolean {
    return this.enabled.has(id);
  }

  source(id: ProviderId): "built-in" | "installed" | undefined {
    return this.sources.get(id);
  }

  unregisterInstalled(id: ProviderId): void {
    if (this.sources.get(id) !== "installed") return;
    this.byId.delete(id);
    this.manifests.delete(id);
    this.sources.delete(id);
    this.enabled.delete(id);
  }

  get(id: ProviderId): AgentProvider {
    const provider = this.byId.get(id);
    if (!provider) throw new ProviderError("PROVIDER_UNAVAILABLE", `provider unavailable: ${id}`);
    return provider;
  }

  list(): AgentProvider[] {
    return [...this.byId.values()];
  }

  listEnabled(): AgentProvider[] {
    return this.list().filter((provider) => this.enabled.has(provider.id));
  }

  manifest(id: ProviderId): Readonly<AdapterManifestV1> {
    const manifest = this.manifests.get(id);
    if (!manifest) throw new ProviderError("PROVIDER_UNAVAILABLE", `provider unavailable: ${id}`);
    return manifest;
  }

  descriptors() {
    return [...this.manifests.entries()].map(([id, manifest]) => ({
      ...publicAdapterDescriptor(manifest, this.sources.get(id) ?? "installed"),
      enabled: this.enabled.has(id),
    }));
  }
}

export type ReturnTypeOfDescriptors = ReturnType<ProviderRegistry["descriptors"]>;
