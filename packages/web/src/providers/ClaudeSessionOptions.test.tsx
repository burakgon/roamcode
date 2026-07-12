import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, test, vi } from "vitest";
import { ClaudeSessionOptions, type ClaudeOptionDraft } from "./ClaudeSessionOptions";
import type { ModelInfo } from "../types/server";

const models: ModelInfo[] = [
  {
    value: "claude-sonnet",
    displayName: "Claude Sonnet",
    description: "Fast account model.",
    supportedEffortLevels: ["low", "medium"],
    isDefault: true,
  },
  {
    value: "claude-opus",
    displayName: "Claude Opus",
    description: "Deep account model.",
    supportedEffortLevels: ["high", "future-depth"],
  },
];

function Harness({
  initial,
  catalog = models,
  metadataState = "ready",
  retry = vi.fn(),
}: {
  initial?: Partial<ClaudeOptionDraft>;
  catalog?: ModelInfo[];
  metadataState?: "loading" | "ready" | "unavailable";
  retry?: () => void;
}) {
  const [value, setValue] = useState<ClaudeOptionDraft>({
    model: "",
    effort: "medium",
    permissionMode: "default",
    addDirs: [],
    dangerouslySkip: false,
    ...initial,
  });
  return (
    <ClaudeSessionOptions
      value={value}
      onChange={setValue}
      models={catalog}
      metadataState={metadataState}
      onRetryMetadata={retry}
    />
  );
}

describe("ClaudeSessionOptions", () => {
  test("uses the catalog default for blank model effort choices and resets incompatible effort on change", async () => {
    render(<Harness initial={{ effort: "medium" }} />);

    expect(screen.getByRole("combobox", { name: /^claude model$/i })).toHaveValue("");
    expect(screen.getByRole("option", { name: "Medium" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "High" })).not.toBeInTheDocument();

    await userEvent.selectOptions(screen.getByRole("combobox", { name: /^claude model$/i }), "claude-opus");
    await waitFor(() => expect(screen.getByLabelText(/^effort$/i)).toHaveValue("high"));
    expect(screen.getByRole("status")).toHaveTextContent(/effort reset to high for claude opus/i);
    expect(screen.getByRole("option", { name: "future-depth" })).toBeInTheDocument();
  });

  test("uses contextual effort and permission help for the selected values", async () => {
    render(<Harness initial={{ model: "claude-opus", effort: "future-depth" }} />);

    expect(screen.getByText("Provider-advertised reasoning level.")).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText(/^effort$/i), "high");
    expect(screen.getByText("Deeper reasoning for difficult, multi-step work.")).toBeInTheDocument();

    expect(screen.getByText(/ask before tool use when claude requires approval/i)).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText(/permission mode/i), "acceptEdits");
    expect(screen.getByText(/accept file edits automatically while retaining other prompts/i)).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText(/permission mode/i), "plan");
    expect(screen.getByText(/inspect and plan before making changes/i)).toBeInTheDocument();
  });

  test("keeps uncommon and dangerous controls in one Advanced disclosure and reveals existing danger", () => {
    const collapsed = render(<Harness />);
    const advanced = screen.getByText("Advanced").closest("details");
    expect(advanced).not.toBeNull();
    expect(advanced).not.toHaveAttribute("open");
    expect(within(advanced!).getByRole("checkbox", { name: /use a custom claude model/i })).toBeInTheDocument();
    expect(within(advanced!).getByText(/additional directories/i)).toBeInTheDocument();
    expect(within(advanced!).getByRole("checkbox", { name: /dangerously skip permissions/i })).toBeInTheDocument();
    collapsed.unmount();

    render(<Harness initial={{ dangerouslySkip: true }} />);
    expect(screen.getByText("Advanced").closest("details")).toHaveAttribute("open");
  });

  test("cannot close Advanced while dangerously skipping permissions is enabled", async () => {
    render(<Harness initial={{ dangerouslySkip: true }} />);
    const summary = screen.getByText("Advanced");
    const advanced = summary.closest("details");

    await userEvent.click(summary);

    expect(advanced).toHaveAttribute("open");
    expect(screen.getByRole("checkbox", { name: /dangerously skip permissions/i })).toBeVisible();
  });

  test("degrades to Provider default and retry without a primary free-text model box", async () => {
    const retry = vi.fn();
    render(<Harness catalog={[]} metadataState="unavailable" retry={retry} />);

    const picker = screen.getByRole("combobox", { name: /^claude model$/i });
    expect(picker).toHaveValue("");
    expect(within(picker).getByRole("option", { name: /provider default/i })).toBeInTheDocument();
    expect(within(picker).queryByRole("option", { name: /custom model/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: /custom claude model/i })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /retry claude models/i }));
    expect(retry).toHaveBeenCalledTimes(1);
  });
});
