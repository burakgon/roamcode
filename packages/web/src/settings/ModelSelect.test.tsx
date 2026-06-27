import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { ModelSelect } from "./ModelSelect";
import type { ModelInfo } from "../types/server";

const MODELS: ModelInfo[] = [
  { value: "default", displayName: "Default (recommended)" },
  { value: "opus[1m]", displayName: "Opus" },
  { value: "sonnet", displayName: "Sonnet" },
];

describe("ModelSelect", () => {
  it("renders an option per model plus Custom…", () => {
    render(<ModelSelect value="" onChange={() => {}} models={MODELS} ariaLabel="model" />);
    expect(screen.getByRole("combobox", { name: "model" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Opus" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Custom…" })).toBeInTheDocument();
  });

  it("selecting a model calls onChange with its value", () => {
    const onChange = vi.fn();
    render(<ModelSelect value="" onChange={onChange} models={MODELS} ariaLabel="model" />);
    fireEvent.change(screen.getByRole("combobox", { name: "model" }), { target: { value: "sonnet" } });
    expect(onChange).toHaveBeenCalledWith("sonnet");
  });

  it("selecting Default emits the empty string (CLI default)", () => {
    const onChange = vi.fn();
    render(<ModelSelect value="sonnet" onChange={onChange} models={MODELS} ariaLabel="model" />);
    fireEvent.change(screen.getByRole("combobox", { name: "model" }), { target: { value: "default" } });
    expect(onChange).toHaveBeenCalledWith("");
  });

  it("an unknown value pre-selects Custom and reveals the prefilled input", () => {
    render(<ModelSelect value="claude-opus-4-8" onChange={() => {}} models={MODELS} ariaLabel="model" />);
    expect((screen.getByRole("combobox", { name: "model" }) as HTMLSelectElement).value).toBe("__custom__");
    expect(screen.getByRole("textbox", { name: "model custom" })).toHaveValue("claude-opus-4-8");
  });

  it("typing in the custom input updates onChange", () => {
    const onChange = vi.fn();
    render(<ModelSelect value="" onChange={onChange} models={MODELS} ariaLabel="model" />);
    fireEvent.change(screen.getByRole("combobox", { name: "model" }), { target: { value: "__custom__" } });
    fireEvent.change(screen.getByRole("textbox", { name: "model custom" }), { target: { value: "claude-x" } });
    expect(onChange).toHaveBeenCalledWith("claude-x");
  });

  it("empty models renders a free-text input (fallback)", () => {
    render(<ModelSelect value="opus" onChange={() => {}} models={[]} ariaLabel="model" />);
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "model" })).toHaveValue("opus");
  });

  it("a value that becomes known leaves Custom when models arrive (async load)", () => {
    const { rerender } = render(<ModelSelect value="claude-x" onChange={() => {}} models={[]} ariaLabel="model" />);
    // free-text fallback while models are empty — no select yet
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();

    rerender(
      <ModelSelect
        value="claude-x"
        onChange={() => {}}
        models={[
          { value: "default", displayName: "Default" },
          { value: "claude-x", displayName: "Claude X" },
        ]}
        ariaLabel="model"
      />,
    );
    // value is now a known model → the option is selected, NOT Custom, and no custom input is shown
    expect((screen.getByRole("combobox", { name: "model" }) as HTMLSelectElement).value).toBe("claude-x");
    expect(screen.queryByRole("textbox", { name: "model custom" })).not.toBeInTheDocument();
  });
});
