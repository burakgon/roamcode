import { describe, expect, it, vi } from "vitest";
import { parseUsage, UsageService } from "../src/index.js";
import type { RunUsage } from "../src/index.js";

// The real `claude /usage` .result string (empirically verified on the live machine).
const SAMPLE = `You are currently using your subscription to power your Claude Code usage

Current session: 12% used · resets Jun 25 at 11:30pm (Europe/Istanbul)
Current week (all models): 72% used · resets Jun 25 at 10pm (Europe/Istanbul)
Current week (Sonnet only): 2% used · resets Jun 25 at 9:59pm (Europe/Istanbul)

What's contributing to your limits usage?
...`;

describe("parseUsage", () => {
  it("parses the real sample: session 12 / week 72 / sonnet 2 + reset strings", () => {
    const info = parseUsage(SAMPLE, 1000);
    expect(info).not.toBeNull();
    expect(info!.fetchedAt).toBe(1000);
    expect(info!.session).toEqual({ percent: 12, resets: "Jun 25 at 11:30pm (Europe/Istanbul)" });
    expect(info!.week).toEqual({ percent: 72, resets: "Jun 25 at 10pm (Europe/Istanbul)" });
    expect(info!.weekSonnet).toEqual({ percent: 2, resets: "Jun 25 at 9:59pm (Europe/Istanbul)" });
  });

  it("tolerates spacing / 'reset' vs 'resets' / a missing middle dot, case-insensitively", () => {
    const text = [
      "current SESSION:  5%  used  resets in 2h",
      "Current week (all models): 40% used reset Jun 26 at 1am",
    ].join("\n");
    const info = parseUsage(text, 0);
    expect(info!.session).toEqual({ percent: 5, resets: "in 2h" });
    expect(info!.week).toEqual({ percent: 40, resets: "Jun 26 at 1am" });
    expect(info!.weekSonnet).toBeUndefined();
  });

  it("parses partial text (only the session line)", () => {
    const info = parseUsage("Current session: 3% used · resets Jun 25 at 11pm", 0);
    expect(info).not.toBeNull();
    expect(info!.session).toEqual({ percent: 3, resets: "Jun 25 at 11pm" });
    expect(info!.week).toBeUndefined();
    expect(info!.weekSonnet).toBeUndefined();
  });

  it("returns null on garbage / empty / no-bars text", () => {
    expect(parseUsage("", 0)).toBeNull();
    expect(parseUsage("   ", 0)).toBeNull();
    expect(parseUsage("totally unrelated output", 0)).toBeNull();
    // A Sonnet-only line WITHOUT session or all-models week → null (the rail's two bars can't render).
    expect(parseUsage("Current week (Sonnet only): 2% used · resets Jun 25 at 9pm", 0)).toBeNull();
  });
});

describe("UsageService cache (TTL + force + graceful failure)", () => {
  function make(runUsage: RunUsage, now: () => number, ttlMs = 1000) {
    return new UsageService({ runUsage, now, ttlMs });
  }

  it("a second call within the TTL does NOT re-run runUsage (serves the cache)", async () => {
    let clock = 0;
    const runUsage = vi.fn<[], Promise<string>>().mockResolvedValue(SAMPLE);
    const svc = make(runUsage, () => clock, 1000);

    const first = await svc.getUsage();
    expect(first!.session!.percent).toBe(12);
    expect(runUsage).toHaveBeenCalledTimes(1);

    clock = 500; // still inside the TTL
    const second = await svc.getUsage();
    expect(second).toEqual(first);
    expect(runUsage).toHaveBeenCalledTimes(1); // not re-run
  });

  it("re-runs after the TTL expires, and force re-runs even within the TTL", async () => {
    let clock = 0;
    const runUsage = vi.fn<[], Promise<string>>().mockResolvedValue(SAMPLE);
    const svc = make(runUsage, () => clock, 1000);

    await svc.getUsage();
    expect(runUsage).toHaveBeenCalledTimes(1);

    // force re-runs despite being inside the TTL.
    await svc.getUsage(true);
    expect(runUsage).toHaveBeenCalledTimes(2);

    // Past the TTL → re-runs on a normal call.
    clock = 5000;
    await svc.getUsage();
    expect(runUsage).toHaveBeenCalledTimes(3);
  });

  it("a failed refresh keeps the last good value (degrades gracefully, never throws)", async () => {
    const clock = 0;
    const runUsage = vi
      .fn<[], Promise<string>>()
      .mockResolvedValueOnce(SAMPLE) // first fetch: good
      .mockResolvedValue(""); // subsequent fetches: failure (empty)
    const svc = make(runUsage, () => clock, 1000);

    const good = await svc.getUsage();
    expect(good!.week!.percent).toBe(72);

    // Force a refresh that fails → the last good snapshot is returned, not null.
    const afterFail = await svc.getUsage(true);
    expect(afterFail).toEqual(good);
    expect(runUsage).toHaveBeenCalledTimes(2);
  });

  it("returns null when the very first fetch fails and there is no prior good value", async () => {
    const runUsage = vi.fn<[], Promise<string>>().mockResolvedValue("");
    const svc = make(runUsage, () => 0, 1000);
    expect(await svc.getUsage()).toBeNull();
  });
});
