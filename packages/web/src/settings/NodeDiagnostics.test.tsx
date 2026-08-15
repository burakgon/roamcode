import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { NodeDiagnostics } from "./NodeDiagnostics";
import type { ApiClient } from "../api/client";

function apiWith(getDiagnostics: ApiClient["getDiagnostics"]): ApiClient {
  return { getDiagnostics } as unknown as ApiClient;
}

describe("NodeDiagnostics", () => {
  it("raises the alarm when the Node is not persisting anything", async () => {
    const api = apiWith(
      vi.fn().mockResolvedValue({
        storeMode: "memory-fallback",
        providers: { claude: { terminalAvailable: true, metadataAvailable: true, version: "1.2.3" } },
        runningVersion: "4.0.39",
        node: "v24.0.0",
      }),
    );
    render(<NodeDiagnostics api={api} />);

    // This state silently drops the session index on every restart, and used to be visible only via
    // `curl /diag` — the app looked entirely healthy.
    const alarm = await screen.findByRole("alert");
    expect(alarm).toHaveTextContent(/sessions are not being saved/i);
    expect(screen.getByText("In memory only")).toBeInTheDocument();
  });

  it("stays quiet on a durable Node but still reports what it found", async () => {
    const api = apiWith(
      vi.fn().mockResolvedValue({
        storeMode: "sqlite",
        providers: {
          claude: { terminalAvailable: true, metadataAvailable: true, version: "1.2.3" },
          codex: { terminalAvailable: true, metadataAvailable: false },
        },
        current: "v4.0.39",
        node: "v24.0.0",
      }),
    );
    render(<NodeDiagnostics api={api} />);

    expect(await screen.findByText("Durable (SQLite)")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
    // A provider whose terminal works while its metadata does not is a real, separately-reported state.
    expect(screen.getByText(/account and usage details are unavailable/i)).toBeInTheDocument();
  });

  it("offers a retry when the report itself can't be read", async () => {
    const getDiagnostics = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue({ storeMode: "sqlite" });
    render(<NodeDiagnostics api={apiWith(getDiagnostics)} />);

    expect(await screen.findByRole("alert")).toHaveTextContent(/couldn't read this node/i);
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Durable (SQLite)")).toBeInTheDocument();
  });
});
