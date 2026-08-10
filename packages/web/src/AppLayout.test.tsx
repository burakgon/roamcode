import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AppLayout } from "./AppLayout";

describe("AppLayout session shell", () => {
  it("uses one Session rail and one content area", () => {
    const { container } = render(
      <AppLayout sessionList={<div>Session list</div>}>
        <div>Workbench</div>
      </AppLayout>,
    );

    expect(container.querySelectorAll("aside")).toHaveLength(1);
    expect(screen.getByTestId("sessions-rail")).toHaveTextContent("Session list");
    expect(container.querySelector("nav")).not.toBeInTheDocument();
  });

  it("does not mount the hidden mobile session list behind an active terminal", () => {
    render(
      <AppLayout sessionList={<div>Session list</div>} conversationActive>
        <div>Terminal</div>
      </AppLayout>,
    );
    expect(screen.queryByText("Session list")).not.toBeInTheDocument();
  });

  it("mounts the session list when the mobile sheet opens", () => {
    render(
      <AppLayout sessionList={<div>Session list</div>} conversationActive sessionsOpen>
        <div>Terminal</div>
      </AppLayout>,
    );

    expect(screen.getByRole("dialog", { name: "Sessions" })).toHaveTextContent("Session list");
  });
});
