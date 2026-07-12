import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../api/client";
import { ProviderAccounts } from "./ProviderAccounts";

describe("ProviderAccounts", () => {
  it("keeps Claude and Codex account cards independent", async () => {
    const api = {
      getAuthStatus: vi.fn().mockRejectedValue(new Error("raw claude auth failure")),
      getProviderAuthStatus: vi.fn(async (provider: string) => {
        if (provider === "codex") return { available: true, authenticated: true, authMethod: "apiKey" };
        throw new Error("raw claude provider frame");
      }),
      getProviderUsage: vi.fn().mockResolvedValue(null),
      getProviderVersion: vi.fn(async (provider: string) =>
        provider === "codex"
          ? { installed: "1.2.3", provenance: "homebrew", updateHint: "Update with Homebrew" }
          : { installed: "2.0.0", latest: null },
      ),
    } as unknown as ApiClient;

    render(<ProviderAccounts api={api} />);

    expect(await screen.findByRole("region", { name: /claude code account/i })).toBeVisible();
    expect(screen.getByRole("region", { name: /codex account/i })).toBeVisible();
    expect(await screen.findByText(/signed in.*api key/i)).toBeVisible();
    expect(screen.getByText(/codex 1\.2\.3/i)).toBeVisible();
    expect(screen.getByText(/update with homebrew/i)).toBeVisible();
    expect(screen.queryByText(/raw claude/i)).not.toBeInTheDocument();
  });

  it("keeps Codex usage visible when Claude usage fails", async () => {
    const api = {
      getAuthStatus: vi.fn().mockResolvedValue({ available: true, loggedIn: true }),
      getProviderAuthStatus: vi.fn().mockResolvedValue({ available: true, authenticated: true }),
      getProviderVersion: vi.fn().mockResolvedValue({ installed: null, latest: null }),
      getProviderUsage: vi.fn(async (provider: string) => {
        if (provider === "claude") throw new Error("raw claude usage frame");
        return {
          bars: [{ id: "codex-primary", label: "Codex primary", percent: 48 }],
          credits: { hasCredits: true, unlimited: true },
          fetchedAt: 1,
        };
      }),
    } as unknown as ApiClient;

    render(<ProviderAccounts api={api} />);
    expect(await screen.findByRole("progressbar", { name: /codex primary limit 48% used/i })).toBeVisible();
    expect(screen.getByText(/unlimited credits/i)).toBeVisible();
    expect(screen.queryByText(/raw claude usage/i)).not.toBeInTheDocument();
  });
});
