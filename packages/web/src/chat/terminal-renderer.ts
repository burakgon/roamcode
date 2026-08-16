import type { IDisposable, ITerminalAddon } from "@xterm/xterm";

export type TerminalRenderer = "dom" | "webgl";

export interface TerminalRendererHandle {
  readonly renderer: TerminalRenderer;
  onRendererChange(listener: (renderer: TerminalRenderer) => void): { dispose(): void };
  dispose(): void;
}

export interface TerminalAddonHost {
  loadAddon(addon: ITerminalAddon): void;
}

export interface TerminalRendererDeps {
  probe(): { supported: boolean; renderer?: string };
  load(): Promise<typeof import("@xterm/addon-webgl")>;
}

type WebglAddon = InstanceType<(typeof import("@xterm/addon-webgl"))["WebglAddon"]>;

const SOFTWARE_RENDERER_PATTERN = /swiftshader|llvmpipe|software rasterizer/iu;

class RendererHandle implements TerminalRendererHandle {
  private currentRenderer: TerminalRenderer;
  private addon: WebglAddon | undefined;
  private contextLossSubscription: IDisposable | undefined;
  private readonly listeners = new Set<(renderer: TerminalRenderer) => void>();
  private disposed = false;

  constructor(renderer: TerminalRenderer, addon?: WebglAddon) {
    this.currentRenderer = renderer;
    this.addon = addon;
  }

  get renderer(): TerminalRenderer {
    return this.currentRenderer;
  }

  attachContextLossSubscription(subscription: IDisposable): void {
    if (this.disposed || this.currentRenderer !== "webgl") {
      subscription.dispose();
      return;
    }
    this.contextLossSubscription = subscription;
  }

  fallBackToDom(): void {
    if (this.disposed || this.currentRenderer !== "webgl") return;
    this.releaseWebgl();
    this.currentRenderer = "dom";
    for (const listener of this.listeners) {
      try {
        listener("dom");
      } catch {
        // Renderer recovery must continue even if an observer has already been torn down.
      }
    }
  }

  onRendererChange(listener: (renderer: TerminalRenderer) => void): { dispose(): void } {
    if (this.disposed) return { dispose() {} };
    this.listeners.add(listener);
    listener(this.currentRenderer);
    return { dispose: () => this.listeners.delete(listener) };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.releaseWebgl();
    this.listeners.clear();
  }

  private releaseWebgl(): void {
    const subscription = this.contextLossSubscription;
    this.contextLossSubscription = undefined;
    subscription?.dispose();

    const addon = this.addon;
    this.addon = undefined;
    addon?.dispose();
  }
}

function createDomHandle(): TerminalRendererHandle {
  return new RendererHandle("dom");
}

function probeWebglRenderer(): { supported: boolean; renderer?: string } {
  if (typeof document === "undefined") return { supported: false };

  const canvas = document.createElement("canvas");
  const attributes: WebGLContextAttributes = { powerPreference: "high-performance" };
  const context = canvas.getContext("webgl2", attributes) ?? canvas.getContext("webgl", attributes);
  if (!context) return { supported: false };

  let renderer: string | undefined;
  try {
    const debugInfo = context.getExtension("WEBGL_debug_renderer_info");
    const value = context.getParameter(debugInfo?.UNMASKED_RENDERER_WEBGL ?? context.RENDERER);
    if (typeof value === "string" && value.trim()) renderer = value;
  } finally {
    context.getExtension("WEBGL_lose_context")?.loseContext();
  }
  return renderer ? { supported: true, renderer } : { supported: true };
}

const defaultDeps: TerminalRendererDeps = {
  probe: probeWebglRenderer,
  load: () => import("@xterm/addon-webgl"),
};

export async function startTerminalRenderer(
  host: TerminalAddonHost,
  deps: Partial<TerminalRendererDeps> = {},
): Promise<TerminalRendererHandle> {
  let probe: { supported: boolean; renderer?: string };
  try {
    probe = (deps.probe ?? defaultDeps.probe)();
  } catch {
    return createDomHandle();
  }
  if (!probe.supported || (probe.renderer && SOFTWARE_RENDERER_PATTERN.test(probe.renderer))) {
    return createDomHandle();
  }

  let addon: WebglAddon | undefined;
  try {
    const module = await (deps.load ?? defaultDeps.load)();
    addon = new module.WebglAddon();
    host.loadAddon(addon);
  } catch {
    addon?.dispose();
    return createDomHandle();
  }

  const handle = new RendererHandle("webgl", addon);
  try {
    handle.attachContextLossSubscription(addon.onContextLoss(() => handle.fallBackToDom()));
  } catch {
    handle.dispose();
    return createDomHandle();
  }
  return handle;
}
