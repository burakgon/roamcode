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
    expect(screen.getByRole("status", { name: "3 items across hosts" })).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Active host"), { target: { value: "host-b" } });
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
    fireEvent.click(screen.getByLabelText("Manage hosts"));
    fireEvent.click(screen.getByText("Add host"));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Cloud" } });
    fireEvent.change(screen.getByLabelText("HTTPS host origin"), { target: { value: "https://cloud.example" } });
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
});
