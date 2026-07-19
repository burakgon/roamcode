import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { PrimaryNav, type PrimaryNavVariant } from "./PrimaryNav";

describe("PrimaryNav", () => {
  it("renders exactly the three product destinations with canonical links", () => {
    render(<PrimaryNav activeDestination="sessions" onDestinationChange={() => {}} />);

    const nav = screen.getByRole("navigation", { name: "Primary navigation" });
    const links = within(nav).getAllByRole("link");
    expect(links).toHaveLength(3);
    expect(links.map((link) => link.textContent)).toEqual(["Sessions", "Automations", "Agents"]);
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      "/app/sessions",
      "/app/automations",
      "/app/agents",
    ]);

    for (const excludedDestination of ["Settings", "Attention", "Workspace", "Computers", "Projects"]) {
      expect(within(nav).queryByRole("link", { name: excludedDestination })).not.toBeInTheDocument();
    }
  });

  it("marks only the active destination as the current page", () => {
    render(<PrimaryNav activeDestination="automations" onDestinationChange={() => {}} />);

    expect(screen.getByRole("link", { name: "Automations" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Sessions" })).not.toHaveAttribute("aria-current");
    expect(screen.getByRole("link", { name: "Agents" })).not.toHaveAttribute("aria-current");
  });

  it("reports a normal link activation through the typed callback", async () => {
    const onDestinationChange = vi.fn();
    render(<PrimaryNav activeDestination="sessions" onDestinationChange={onDestinationChange} />);

    await userEvent.click(screen.getByRole("link", { name: "Agents" }));

    expect(onDestinationChange).toHaveBeenCalledOnce();
    expect(onDestinationChange).toHaveBeenCalledWith("agents");
  });

  it.each<PrimaryNavVariant>(["vertical", "compact", "bottom"])("supports the %s layout variant", (variant) => {
    render(
      <PrimaryNav
        activeDestination="sessions"
        onDestinationChange={() => {}}
        variant={variant}
        label={`${variant} navigation`}
      />,
    );

    const nav = screen.getByRole("navigation", { name: `${variant} navigation` });
    expect(nav).toHaveClass(`rc-primary-nav--${variant}`);
    expect(within(nav).getAllByRole("link")).toHaveLength(3);
  });
});
