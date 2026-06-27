import { describe, it, expect, vi } from "vitest";
import { ModelsService } from "../src/models-service";

const M = [{ value: "opus[1m]", displayName: "Opus" }];

describe("ModelsService", () => {
  it("returns the probe result and caches it within the TTL (no re-probe)", async () => {
    const runProbe = vi.fn().mockResolvedValue(M);
    const svc = new ModelsService({ runProbe, now: () => 0, ttlMs: 1000 });
    expect(await svc.getModels()).toEqual(M);
    expect(await svc.getModels()).toEqual(M);
    expect(runProbe).toHaveBeenCalledTimes(1);
  });

  it("re-probes after the TTL expires", async () => {
    const runProbe = vi.fn().mockResolvedValue(M);
    let t = 0;
    const svc = new ModelsService({ runProbe, now: () => t, ttlMs: 1000 });
    await svc.getModels();
    t = 2000;
    await svc.getModels();
    expect(runProbe).toHaveBeenCalledTimes(2);
  });

  it("does NOT cache an empty probe; keeps last good and re-probes next time", async () => {
    const runProbe = vi.fn().mockResolvedValueOnce(M).mockResolvedValueOnce([]).mockResolvedValueOnce(M);
    let t = 0;
    const svc = new ModelsService({ runProbe, now: () => t, ttlMs: 1000 });
    expect(await svc.getModels()).toEqual(M); // t=0 → cache M
    t = 2000;
    expect(await svc.getModels()).toEqual(M); // empty probe → keep last good M
    t = 4000;
    expect(await svc.getModels()).toEqual(M); // re-probes (empty wasn't cached) → M
    expect(runProbe).toHaveBeenCalledTimes(3);
  });

  it("shares one in-flight probe across concurrent callers", async () => {
    const runProbe = vi.fn().mockResolvedValue(M);
    const svc = new ModelsService({ runProbe, now: () => 0, ttlMs: 1000 });
    const [a, b] = await Promise.all([svc.getModels(), svc.getModels()]);
    expect(a).toEqual(M);
    expect(b).toEqual(M);
    expect(runProbe).toHaveBeenCalledTimes(1);
  });
});
