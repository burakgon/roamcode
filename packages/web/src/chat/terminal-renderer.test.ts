import { expect, test, vi } from "vitest";
import { startTerminalRenderer } from "./terminal-renderer";

test("loads hardware WebGL and falls back to DOM on context loss", async () => {
  let loseContext!: () => void;
  const contextSubscription = { dispose: vi.fn() };
  const addon = {
    dispose: vi.fn(),
    onContextLoss: (listener: () => void) => {
      loseContext = listener;
      return contextSubscription;
    },
  };
  const host = { loadAddon: vi.fn() };
  const handle = await startTerminalRenderer(host, {
    probe: () => ({ supported: true, renderer: "Apple M-series" }),
    load: async () => ({
      WebglAddon: class {
        constructor() {
          return addon;
        }
      } as never,
    }),
  });

  expect(host.loadAddon).toHaveBeenCalledWith(addon);
  expect(handle.renderer).toBe("webgl");

  const changes: string[] = [];
  const subscription = handle.onRendererChange((renderer) => changes.push(renderer));
  expect(changes).toEqual(["webgl"]);

  loseContext();
  loseContext();

  expect(contextSubscription.dispose).toHaveBeenCalledOnce();
  expect(addon.dispose).toHaveBeenCalledOnce();
  expect(handle.renderer).toBe("dom");
  expect(changes).toEqual(["webgl", "dom"]);

  subscription.dispose();
  handle.dispose();
  expect(addon.dispose).toHaveBeenCalledOnce();
});

test.each(["Google SwiftShader", "llvmpipe (LLVM 18)", "Software Rasterizer"])(
  "keeps DOM for software renderer %s",
  async (renderer) => {
    const load = vi.fn();
    const host = { loadAddon: vi.fn() };
    const handle = await startTerminalRenderer(host, {
      probe: () => ({ supported: true, renderer }),
      load,
    });

    expect(handle.renderer).toBe("dom");
    expect(load).not.toHaveBeenCalled();
    expect(host.loadAddon).not.toHaveBeenCalled();
  },
);

test("keeps DOM when the hardware probe fails", async () => {
  const load = vi.fn();
  const handle = await startTerminalRenderer(
    { loadAddon: vi.fn() },
    {
      probe: () => {
        throw new Error("probe failed");
      },
      load,
    },
  );

  expect(handle.renderer).toBe("dom");
  expect(load).not.toHaveBeenCalled();
});

test("keeps DOM when the lazy import fails", async () => {
  const handle = await startTerminalRenderer(
    { loadAddon: vi.fn() },
    {
      probe: () => ({ supported: true, renderer: "hardware" }),
      load: async () => {
        throw new Error("import failed");
      },
    },
  );

  expect(handle.renderer).toBe("dom");
});

test("keeps DOM when constructing the addon fails", async () => {
  const host = { loadAddon: vi.fn() };
  const handle = await startTerminalRenderer(host, {
    probe: () => ({ supported: true, renderer: "hardware" }),
    load: async () => ({
      WebglAddon: class {
        constructor() {
          throw new Error("construction failed");
        }
      } as never,
    }),
  });

  expect(handle.renderer).toBe("dom");
  expect(host.loadAddon).not.toHaveBeenCalled();
});

test("disposes a constructed addon when loading it fails", async () => {
  const addon = { dispose: vi.fn(), onContextLoss: vi.fn() };
  const handle = await startTerminalRenderer(
    {
      loadAddon: () => {
        throw new Error("load failed");
      },
    },
    {
      probe: () => ({ supported: true, renderer: "hardware" }),
      load: async () => ({
        WebglAddon: class {
          constructor() {
            return addon;
          }
        } as never,
      }),
    },
  );

  expect(handle.renderer).toBe("dom");
  expect(addon.dispose).toHaveBeenCalledOnce();
  expect(addon.onContextLoss).not.toHaveBeenCalled();
});
