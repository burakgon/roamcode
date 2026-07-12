import { render, screen, within } from "@testing-library/react";
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
  {
    value: "best",
    displayName: "Best available",
  },
  {
    value: "claude-opus[1m]",
    displayName: "Claude Opus · 1M context",
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

async function openPicker() {
  await userEvent.click(screen.getByRole("button", { name: "Claude model" }));
  return screen.getByRole("dialog", { name: "Choose a model" });
}

describe("SessionModelPicker", () => {
  test("uses an in-app dialog instead of a native select and groups the catalog by intent", async () => {
    const { container } = renderPicker();

    expect(screen.queryByRole("combobox", { name: /claude model/i })).not.toBeInTheDocument();
    expect(container.querySelector("select")).toBeNull();

    const dialog = await openPicker();
    expect(within(dialog).getByRole("heading", { name: "Automatic" })).toBeInTheDocument();
    expect(within(dialog).getByRole("heading", { name: "Models" })).toBeInTheDocument();
    expect(within(dialog).getByRole("heading", { name: "Extended context" })).toBeInTheDocument();
    expect(within(dialog).getByRole("heading", { name: "Other" })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: /use claude default/i })).toHaveAttribute("aria-pressed", "true");
    expect(within(dialog).getByText("Claude chooses the best available model.")).toBeInTheDocument();
    expect(within(dialog).getByText("Extended 1M-token context window.")).toBeInTheDocument();
  });

  test("puts the recommended catalog model before the other named models", async () => {
    const dialog = await openPickerAfterRender();
    const modelGroup = within(dialog).getByRole("heading", { name: "Models" }).closest("section");
    expect(modelGroup).not.toBeNull();
    expect(
      Array.from(modelGroup!.querySelectorAll(".rc-model-picker__option-title")).map((option) => option.textContent),
    ).toEqual(["Claude OpusRecommended", "Claude Sonnet"]);
  });

  test("shows the current selection and its description in the compact trigger", () => {
    renderPicker({ value: "claude-opus" });

    const trigger = screen.getByRole("button", { name: "Claude model" });
    expect(trigger).toHaveTextContent("Claude Opus");
    expect(trigger).toHaveTextContent("Deep reasoning for difficult changes.");
    expect(screen.queryByText("Fast and capable for everyday coding.")).not.toBeInTheDocument();
  });

  test("selects a model in one tap, closes the panel, and restores trigger focus", async () => {
    const onChange = vi.fn();
    renderPicker({ onChange });
    const trigger = screen.getByRole("button", { name: "Claude model" });
    const dialog = await openPicker();

    await userEvent.click(within(dialog).getByRole("button", { name: /claude sonnet/i }));

    expect(onChange).toHaveBeenCalledWith("claude-sonnet");
    expect(screen.queryByRole("dialog", { name: "Choose a model" })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  test("closes the nested panel with Escape without selecting a model", async () => {
    const onChange = vi.fn();
    renderPicker({ onChange });
    await openPicker();

    await userEvent.keyboard("{Escape}");

    expect(screen.queryByRole("dialog", { name: "Choose a model" })).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  test("announces loading and unavailable metadata and offers a retry", async () => {
    const retry = vi.fn();
    const loading = renderPicker({ metadataState: "loading", models: [] });
    expect(screen.getByRole("status")).toHaveTextContent(/loading claude models/i);
    loading.unmount();

    renderPicker({ metadataState: "unavailable", models: [], onRetry: retry });
    expect(screen.getByRole("status")).toHaveTextContent(/claude model catalog is unavailable.*claude default/i);
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
    const dialog = await openPicker();
    await userEvent.click(within(dialog).getByRole("button", { name: /custom model/i }));

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

    expect(screen.getByRole("button", { name: "Claude model" })).toHaveTextContent("Claude Sonnet");
    expect(screen.queryByRole("textbox", { name: /custom claude model/i })).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });
});

async function openPickerAfterRender() {
  renderPicker();
  return openPicker();
}
