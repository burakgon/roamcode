import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { UpdateBanner } from "./UpdateBanner";
import type { VersionInfo } from "../types/server";

function info(over: Partial<VersionInfo> = {}): VersionInfo {
  return {
    current: "v1.0.0",
    latest: "v1.1.0",
    behind: 3,
    releaseCount: 3,
    updatable: true,
    updateAvailable: true,
    updateAction: "update",
    installation: "managed",
    changelog: [],
    runningVersion: "1.0.0",
    activeVersion: "1.0.0",
    installDrift: false,
    checkStatus: "fresh",
    runningBuild: "1.0.0",
    buildDrift: false,
    ...over,
  };
}

describe("UpdateBanner", () => {
  it("renders nothing when no update is available", () => {
    const { container } = render(
      <UpdateBanner
        info={info({ updateAvailable: false, behind: 0 })}
        onWhatsNew={vi.fn()}
        onUpdate={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing when the server isn't updatable", () => {
    const { container } = render(
      <UpdateBanner info={info({ updatable: false })} onWhatsNew={vi.fn()} onUpdate={vi.fn()} onDismiss={vi.fn()} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("announces the available update with text + version + change count (not color alone)", () => {
    render(<UpdateBanner info={info()} onWhatsNew={vi.fn()} onUpdate={vi.fn()} onDismiss={vi.fn()} />);
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent(/update available/i);
    expect(status).toHaveTextContent("v1.1.0");
    expect(status).toHaveTextContent(/3 releases/);
  });

  it("singularizes the release count", () => {
    render(
      <UpdateBanner
        info={info({ behind: 1, releaseCount: 1 })}
        onWhatsNew={vi.fn()}
        onUpdate={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent(/· 1 release/);
    expect(screen.getByRole("status")).not.toHaveTextContent(/1 releases/);
  });

  it("wires What's new, Update now, and Dismiss", async () => {
    const onWhatsNew = vi.fn();
    const onUpdate = vi.fn();
    const onDismiss = vi.fn();
    render(<UpdateBanner info={info()} onWhatsNew={onWhatsNew} onUpdate={onUpdate} onDismiss={onDismiss} />);
    await userEvent.click(screen.getByRole("button", { name: /what's new/i }));
    await userEvent.click(screen.getByRole("button", { name: /update now/i }));
    await userEvent.click(screen.getByRole("button", { name: /dismiss/i }));
    expect(onWhatsNew).toHaveBeenCalledTimes(1);
    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
