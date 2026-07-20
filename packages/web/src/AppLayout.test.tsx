import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AppLayout } from "./AppLayout";
import { PrimaryNav } from "./navigation/PrimaryNav";

function navigation(variant: "vertical" | "bottom" = "vertical") {
  return <PrimaryNav activeDestination="sessions" onDestinationChange={() => {}} variant={variant} />;
}

describe("AppLayout product navigation", () => {
  it("uses one desktop rail plane for primary navigation and Sessions", () => {
    const { container } = render(
      <AppLayout navigation={navigation()} sessionList={<div>Session list</div>}>
        <div>Workbench</div>
      </AppLayout>,
    );

    expect(container.querySelectorAll("aside")).toHaveLength(1);
    const rail = screen.getByTestId("sessions-rail");
    // jsdom uses the mobile-first branch (no matchMedia), so the closed rail is hidden from the
    // accessibility tree. Its DOM structure is still the exact permanent desktop rail structure.
    expect(within(rail).getByRole("navigation", { name: "Primary navigation", hidden: true })).toBeInTheDocument();
    expect(within(rail).getByText("Session list")).toBeInTheDocument();
  });

  it("keeps all three mobile destinations visible inside an active terminal workbench", () => {
    render(
      <AppLayout
        navigation={navigation()}
        mobileNavigation={navigation("bottom")}
        sessionList={<div>Session list</div>}
        conversationActive
      >
        <div>Terminal</div>
      </AppLayout>,
    );

    const mobileNavigation = document.querySelector<HTMLElement>(".rc-shell__mobile-navigation")!;
    expect(mobileNavigation).toBeInTheDocument();
    expect(
      within(mobileNavigation)
        .getAllByRole("link")
        .map((link) => link.textContent),
    ).toEqual(["Sessions", "Automations", "Agents"]);
  });

  it("keeps all three destinations reachable when the terminal opens its Sessions sheet", () => {
    render(
      <AppLayout
        navigation={navigation()}
        mobileNavigation={navigation("bottom")}
        sessionList={<div>Session list</div>}
        conversationActive
        sessionsOpen
      >
        <div>Terminal</div>
      </AppLayout>,
    );

    const dialog = screen.getByRole("dialog", { name: "Sessions" });
    expect(
      within(dialog)
        .getAllByRole("link")
        .map((link) => link.textContent),
    ).toEqual(["Sessions", "Automations", "Agents"]);
  });
});
