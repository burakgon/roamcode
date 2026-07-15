import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ApiClient, InstalledExtension } from "../api/client";
import { ExtensionsPanel } from "./ExtensionsPanel";

const installed: InstalledExtension = {
  kind: "plugin",
  id: "ci-monitor",
  enabled: false,
  currentVersion: "1.0.0",
  updatedAt: 1,
  approvedPermissions: [],
  current: {
    manifest: {
      kind: "plugin",
      id: "ci-monitor",
      version: "1.0.0",
      displayName: "CI monitor",
      permissions: ["ci:read", "releases:read"],
    },
    integrity: `sha256-${"A".repeat(43)}=`,
    trust: "signed",
    signerFingerprint: "a".repeat(64),
    source: "verified-registry",
    installedAt: 1,
  },
  versions: [{ version: "1.0.0", integrity: `sha256-${"A".repeat(43)}=`, trust: "signed", installedAt: 1 }],
};

function api() {
  return {
    listExtensions: vi.fn().mockResolvedValue([installed]),
    inspectExtension: vi
      .fn()
      .mockResolvedValue({ manifest: installed.current.manifest, integrity: installed.current.integrity }),
    installExtension: vi.fn().mockResolvedValue(installed),
    setExtensionEnabled: vi.fn().mockResolvedValue({ ...installed, enabled: true }),
    rollbackExtension: vi.fn().mockResolvedValue(installed),
    uninstallExtension: vi.fn().mockResolvedValue(undefined),
  } as unknown as ApiClient;
}

describe("ExtensionsPanel", () => {
  it("shows provenance and requires an explicit permission review before enabling", async () => {
    const client = api();
    render(<ExtensionsPanel api={client} />);

    expect(await screen.findByText("CI monitor")).toBeVisible();
    expect(screen.getByText("signature verified")).toBeVisible();
    expect(screen.getByText("verified-registry")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Review and enable" }));
    expect(screen.getByRole("group", { name: "Approve ci-monitor" })).toHaveTextContent("ci:read, releases:read");
    await userEvent.click(screen.getByRole("button", { name: "Approve and enable" }));
    await waitFor(() =>
      expect(client.setExtensionEnabled).toHaveBeenCalledWith("plugin", "ci-monitor", true, [
        "ci:read",
        "releases:read",
      ]),
    );
  });

  it("pins the inspected integrity and requires explicit unsigned approval", async () => {
    const client = api();
    render(<ExtensionsPanel api={client} />);
    await screen.findByText("CI monitor");
    await userEvent.type(screen.getByLabelText("Package directory on this host"), "/safe/plugin");
    await userEvent.click(screen.getByRole("button", { name: "Inspect package" }));
    expect((await screen.findAllByText(installed.current.integrity)).at(0)).toBeVisible();
    const install = screen.getByRole("button", { name: "Install reviewed package" });
    expect(install).toBeDisabled();
    await userEvent.click(screen.getByRole("checkbox", { name: /install unsigned local bytes/i }));
    await userEvent.click(install);
    await waitFor(() =>
      expect(client.installExtension).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceDirectory: "/safe/plugin",
          expectedIntegrity: installed.current.integrity,
          allowUnsigned: true,
        }),
      ),
    );
  });
});
