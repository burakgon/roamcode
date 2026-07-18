import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import { HostSwitcher } from "./HostSwitcher";
import type { DirectHostRegistry } from "./direct-hosts";

const registry: DirectHostRegistry = {
  version: 1,
  activeHostId: "host-a",
  hosts: [
    { id: "host-a", label: "Laptop", baseUrl: "https://a.example", sortOrder: 0, createdAt: 1, updatedAt: 1 },
    { id: "host-b", label: "Build", baseUrl: "https://b.example", sortOrder: 1, createdAt: 2, updatedAt: 2 },
  ],
};

describe("HostSwitcher", () => {
  test("switches hosts and exposes deterministic global attention without revealing credentials", () => {
    const onActivate = vi.fn();
    const { container } = render(
      <HostSwitcher
        registry={registry}
        summaries={{
          "host-a": { hostId: "host-a", state: "online", attentionCount: 1, urgency: 40, checkedAt: 1 },
          "host-b": { hostId: "host-b", state: "offline", attentionCount: 2, urgency: 100, checkedAt: 1 },
        }}
        onActivate={onActivate}
        onAdd={vi.fn()}
        onRename={vi.fn()}
        onMove={vi.fn()}
        onRemove={vi.fn()}
        onRefresh={vi.fn()}
      />,
    );
    expect(screen.getByRole("status", { name: "3 sessions need you across Nodes" })).toHaveTextContent("3 need you");
    fireEvent.change(screen.getByLabelText("Active Node"), { target: { value: "host-b" } });
    expect(onActivate).toHaveBeenCalledWith("host-b");
    expect(container.textContent).not.toContain("token");
  });

  test("adds securely, supports reorder, and requires a second remove click", () => {
    const onAdd = vi.fn();
    const onMove = vi.fn();
    const onRemove = vi.fn();
    render(
      <HostSwitcher
        registry={registry}
        summaries={{}}
        onActivate={vi.fn()}
        onAdd={onAdd}
        onRename={vi.fn()}
        onMove={onMove}
        onRemove={onRemove}
        onRefresh={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByLabelText("Manage Nodes"));
    fireEvent.click(screen.getByText("Add Node"));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Cloud" } });
    fireEvent.change(screen.getByLabelText("HTTPS Node address"), { target: { value: "https://cloud.example" } });
    fireEvent.change(screen.getByLabelText("Device credential"), { target: { value: "secret-device" } });
    fireEvent.click(screen.getByText("Add and connect"));
    expect(onAdd).toHaveBeenCalledWith({ label: "Cloud", baseUrl: "https://cloud.example", token: "secret-device" });

    fireEvent.click(screen.getByLabelText("Move Build up"));
    expect(onMove).toHaveBeenCalledWith("host-b", 0);
    fireEvent.click(screen.getByLabelText("Remove Build"));
    expect(onRemove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText("Confirm remove Build"));
    expect(onRemove).toHaveBeenCalledWith("host-b");
  });

  test("lets a user explicitly forget the last saved relay Node", () => {
    const onRemove = vi.fn();
    render(
      <HostSwitcher
        registry={{
          version: 1,
          activeHostId: "relay-a",
          hosts: [
            {
              id: "relay-a",
              label: "Studio Node",
              baseUrl: "https://app.example",
              sortOrder: 0,
              createdAt: 1,
              updatedAt: 1,
              relay: {
                relayUrl: "wss://relay.example/v1/connect",
                routeId: "route-a",
                deviceId: "device-a",
                hostIdentityPublicKey: "A".repeat(122),
                hostIdentityFingerprint: `sha256:${"h".repeat(43)}`,
                deviceIdentityFingerprint: `sha256:${"i".repeat(43)}`,
              },
            },
          ],
        }}
        summaries={{}}
        onActivate={vi.fn()}
        onAdd={vi.fn()}
        onRename={vi.fn()}
        onMove={vi.fn()}
        onRemove={onRemove}
        onRefresh={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByLabelText("Manage Nodes"));
    expect(screen.getByLabelText("Remove Studio Node")).toBeEnabled();
    fireEvent.click(screen.getByLabelText("Remove Studio Node"));
    fireEvent.click(screen.getByLabelText("Confirm remove Studio Node"));
    expect(onRemove).toHaveBeenCalledWith("relay-a");
  });
});
