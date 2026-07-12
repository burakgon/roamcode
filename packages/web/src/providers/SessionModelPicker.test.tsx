import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, test, vi } from "vitest";
import { SessionModelPicker, type SessionModelChoice } from "./SessionModelPicker";

const models: SessionModelChoice[] = [
  {
    value: "claude-sonnet",
    displayName: "Claude Sonnet",
    description: "Fast and capable for everyday coding.",
  },
  {
    value: "claude-opus",
    displayName: "Claude Opus",
    description: "Deep reasoning for difficult changes.",
    isDefault: true,
  },
];

function renderPicker(overrides: Partial<React.ComponentProps<typeof SessionModelPicker>> = {}) {
  const props: React.ComponentProps<typeof SessionModelPicker> = {
    providerLabel: "Claude",
    value: "",
    models,
    metadataState: "ready",
    onChange: vi.fn(),
    onRetry: vi.fn(),
    customValue: "",
    onCustomValueChange: vi.fn(),
    ...overrides,
  };
  return { ...render(<SessionModelPicker {...props} />), props };
}

describe("SessionModelPicker", () => {
  test("puts Provider default first and renders every account model as an option", () => {
    renderPicker();

    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual([
      "Provider default",
      "Claude Opus (default)",
      "Claude Sonnet",
      "Custom model…",
    ]);
  });

  test("shows help only for the currently selected account model", () => {
    renderPicker({ value: "claude-opus" });

    expect(screen.getByText("Deep reasoning for difficult changes.")).toBeInTheDocument();
    expect(screen.queryByText("Fast and capable for everyday coding.")).not.toBeInTheDocument();
  });

  test("announces loading and unavailable metadata and offers a retry", async () => {
    const retry = vi.fn();
    const loading = renderPicker({ metadataState: "loading", models: [] });
    expect(screen.getByRole("status")).toHaveTextContent(/loading claude models/i);
    loading.unmount();

    renderPicker({ metadataState: "unavailable", models: [], onRetry: retry });
    expect(screen.getByRole("status")).toHaveTextContent(/claude model catalog is unavailable.*provider default/i);
    await userEvent.click(screen.getByRole("button", { name: /retry claude models/i }));
    expect(retry).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("textbox", { name: /custom claude model/i })).not.toBeInTheDocument();
  });

  test("reveals bounded custom input only after Custom model is selected", async () => {
    const onChange = vi.fn();
    const onCustomValueChange = vi.fn();
    function Harness() {
      const [value, setValue] = useState("");
      const [customValue, setCustomValue] = useState("");
      return (
        <SessionModelPicker
          providerLabel="Claude"
          value={value}
          models={models}
          metadataState="ready"
          onChange={(next) => {
            onChange(next);
            setValue(next);
          }}
          customValue={customValue}
          onCustomValueChange={(next) => {
            onCustomValueChange(next);
            setCustomValue(next);
          }}
        />
      );
    }
    render(<Harness />);

    expect(screen.queryByRole("textbox", { name: /custom claude model/i })).not.toBeInTheDocument();
    await userEvent.selectOptions(screen.getByRole("combobox", { name: /claude model/i }), "__custom__");

    const input = screen.getByRole("textbox", { name: /custom claude model/i });
    expect(input).toHaveAttribute("maxlength", "128");
    expect(input).toHaveAttribute("pattern", String.raw`[A-Za-z0-9][A-Za-z0-9._:/\[\]-]*`);
    expect(input).toHaveAttribute("autocapitalize", "off");
    expect(input).toHaveAttribute("autocorrect", "off");
    expect(input).toHaveAttribute("spellcheck", "false");
    await userEvent.type(input, "vendor/model-next");
    expect(onCustomValueChange).toHaveBeenLastCalledWith("vendor/model-next");
    expect(onChange).not.toHaveBeenCalledWith("claude-opus");
  });

  test("does not silently replace a known selection when custom state changes", () => {
    const onChange = vi.fn();
    const { rerender, props } = renderPicker({ value: "claude-sonnet", onChange });

    rerender(<SessionModelPicker {...props} customValue="vendor/model-next" />);

    expect(screen.getByRole("combobox", { name: /claude model/i })).toHaveValue("claude-sonnet");
    expect(screen.queryByRole("textbox", { name: /custom claude model/i })).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });
});
