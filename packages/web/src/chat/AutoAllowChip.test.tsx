import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AutoAllowChip } from "./AutoAllowChip";

describe("AutoAllowChip", () => {
  it("renders nothing when there are no rules", () => {
    const { container } = render(<AutoAllowChip tools={[]} onClear={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows N and the 'auto-allowed' label, collapsed by default (rules hidden)", () => {
    render(<AutoAllowChip tools={["Bash", "Write", "send_file"]} onClear={() => {}} />);
    const chip = screen.getByRole("button", { name: /3 auto-allowed tools/i });
    expect(chip).toBeInTheDocument();
    expect(chip).toHaveTextContent("3");
    expect(chip).toHaveAttribute("aria-expanded", "false");
    // Collapsed: the individual rules are not yet listed.
    expect(screen.queryByRole("listitem")).toBeNull();
  });

  it("expands to a list of the rules, each with a clear control", async () => {
    render(<AutoAllowChip tools={["Bash", "Write"]} onClear={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: /2 auto-allowed/i }));
    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(screen.getByRole("button", { name: /clear auto-allow for bash/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /clear auto-allow for write/i })).toBeInTheDocument();
  });

  it("calls onClear with the tool name when its x is tapped", async () => {
    const onClear = vi.fn();
    render(<AutoAllowChip tools={["Bash"]} onClear={onClear} />);
    await userEvent.click(screen.getByRole("button", { name: /1 auto-allowed/i }));
    await userEvent.click(screen.getByRole("button", { name: /clear auto-allow for bash/i }));
    expect(onClear).toHaveBeenCalledWith("Bash");
  });

  it("live-decrements N as the controlling props shrink (parent owns the set)", () => {
    const { rerender } = render(<AutoAllowChip tools={["Bash", "Write"]} onClear={() => {}} />);
    expect(screen.getByRole("button", { name: /2 auto-allowed/i })).toBeInTheDocument();
    rerender(<AutoAllowChip tools={["Write"]} onClear={() => {}} />);
    expect(screen.getByRole("button", { name: /1 auto-allowed tool\b/i })).toBeInTheDocument();
    rerender(<AutoAllowChip tools={[]} onClear={() => {}} />);
    expect(screen.queryByText("auto-allowed")).toBeNull();
  });
});
