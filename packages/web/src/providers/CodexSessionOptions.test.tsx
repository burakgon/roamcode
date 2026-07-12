import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, test, vi } from "vitest";
import { CodexSessionOptions, type CodexOptionDraft } from "./CodexSessionOptions";
import type { CodexModel } from "./types";

const models: CodexModel[] = [
  {
    value: "gpt-balanced",
    id: "gpt-balanced",
    displayName: "GPT Balanced",
    description: "Everyday account model.",
    isDefault: true,
    reasoningOptions: [
      { value: "low", description: "Provider low copy.", isDefault: false },
      { value: "medium", description: "Provider medium copy.", isDefault: true },
    ],
    supportedReasoningEfforts: ["low", "medium"],
    defaultReasoningEffort: "medium",
  },
  {
    value: "gpt-deep",
    id: "gpt-deep",
    displayName: "GPT Deep",
    description: "Hard account model.",
    isDefault: false,
    reasoningOptions: [
      { value: "high", description: "Provider high copy.", isDefault: true },
      { value: "future-depth", description: "Provider future-depth copy.", isDefault: false },
    ],
    supportedReasoningEfforts: ["high", "future-depth"],
    defaultReasoningEffort: "high",
  },
];

function Harness({
  initial,
  catalog = models,
  metadataState = "ready",
  retry = vi.fn(),
  customModelIntent = false,
}: {
  initial?: Partial<CodexOptionDraft>;
  catalog?: CodexModel[];
  metadataState?: "loading" | "ready" | "unavailable";
  retry?: () => void;
  customModelIntent?: boolean;
}) {
  const [value, setValue] = useState<CodexOptionDraft>({
    model: "",
    reasoningEffort: "medium",
    sandbox: "workspace-write",
    approvalPolicy: "on-request",
    profile: "",
    webSearch: false,
    addDirs: [],
    dangerouslyBypassApprovalsAndSandbox: false,
    ...initial,
  });
  return (
    <CodexSessionOptions
      value={value}
      onChange={setValue}
      models={catalog}
      profiles={["work"]}
      metadataState={metadataState}
      onRetryMetadata={retry}
      customModelIntent={customModelIntent}
      onCustomModelIntentChange={vi.fn()}
    />
  );
}

describe("CodexSessionOptions", () => {
  test("uses the catalog default for blank model reasoning and resets incompatible effort on change", async () => {
    render(<Harness />);

    expect(screen.getByRole("button", { name: /^codex model$/i })).toHaveTextContent("Codex default");
    expect(screen.getByRole("option", { name: /^Medium/ })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /^codex model$/i }));
    await userEvent.click(screen.getByRole("button", { name: /gpt deep/i }));
    await waitFor(() => expect(screen.getByLabelText(/reasoning effort/i)).toHaveValue("high"));
    expect(screen.getByRole("status")).toHaveTextContent(/reasoning reset to high for gpt deep/i);
    expect(screen.getByRole("option", { name: "future-depth" })).toBeInTheDocument();
  });

  test("uses provider copy for unknown advertised effort and contextual safety help", async () => {
    render(<Harness initial={{ model: "gpt-deep", reasoningEffort: "future-depth" }} />);

    expect(screen.getByText("Provider future-depth copy.")).toBeInTheDocument();
    expect(screen.getByText(/recommended balanced sandbox/i)).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByRole("combobox", { name: /^sandbox$/i }), "read-only");
    expect(screen.getByText(/inspect and plan without file writes/i)).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByRole("combobox", { name: /^sandbox$/i }), "danger-full-access");
    expect(screen.getByText(/remove workspace isolation/i)).toBeInTheDocument();

    expect(screen.getByText(/recommended interactive policy/i)).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText(/approval policy/i), "untrusted");
    expect(screen.getByText(/outside codex's trusted set/i)).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText(/approval policy/i), "never");
    expect(screen.getByText(/selected sandbox still applies/i)).toBeInTheDocument();
  });

  test("keeps profile, web, directories, and danger in one Advanced disclosure and opens saved danger", () => {
    const collapsed = render(<Harness />);
    const advanced = screen.getByText("Advanced").closest("details");
    expect(advanced).not.toBeNull();
    expect(advanced).not.toHaveAttribute("open");
    expect(within(advanced!).getByRole("checkbox", { name: /use a custom codex model/i })).toBeInTheDocument();
    expect(within(advanced!).getByLabelText(/profile/i)).toBeInTheDocument();
    expect(within(advanced!).getByRole("checkbox", { name: /web search/i })).toBeInTheDocument();
    expect(within(advanced!).getByText(/additional directories/i)).toBeInTheDocument();
    expect(within(advanced!).getByRole("checkbox", { name: /bypass approvals and sandbox/i })).toBeInTheDocument();
    collapsed.unmount();

    render(<Harness initial={{ dangerouslyBypassApprovalsAndSandbox: true }} />);
    expect(screen.getByText("Advanced").closest("details")).toHaveAttribute("open");
  });

  test("cannot close Advanced while bypassing approvals and sandbox is enabled", async () => {
    render(<Harness initial={{ dangerouslyBypassApprovalsAndSandbox: true }} />);
    const summary = screen.getByText("Advanced");
    const advanced = summary.closest("details");

    await userEvent.click(summary);

    expect(advanced).toHaveAttribute("open");
    expect(screen.getByRole("checkbox", { name: /bypass approvals and sandbox/i })).toBeVisible();
  });

  test("degrades to Provider default and retry without a primary free-text model box", async () => {
    const retry = vi.fn();
    render(<Harness catalog={[]} metadataState="unavailable" retry={retry} />);

    const picker = screen.getByRole("button", { name: /^codex model$/i });
    expect(picker).toHaveTextContent("Codex default");
    await userEvent.click(picker);
    const dialog = screen.getByRole("dialog", { name: /choose a model/i });
    expect(within(dialog).getByRole("button", { name: /use codex default/i })).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: /custom model/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: /custom codex model/i })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /retry codex models/i }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  test("shows provider-default reasoning while metadata is unusable and restores the preserved draft when ready", () => {
    const view = render(
      <Harness initial={{ model: "gpt-deep", reasoningEffort: "high" }} metadataState="unavailable" />,
    );

    const unavailable = screen.getByLabelText(/reasoning effort/i);
    expect(unavailable).toHaveValue("");
    expect(unavailable).toBeDisabled();
    expect(within(unavailable).getByRole("option", { name: /provider default/i })).toBeInTheDocument();
    expect(within(unavailable).queryByRole("option", { name: /^High/ })).not.toBeInTheDocument();

    view.rerender(<Harness initial={{ model: "gpt-deep", reasoningEffort: "high" }} metadataState="ready" />);

    expect(screen.getByLabelText(/reasoning effort/i)).toHaveValue("high");
    expect(screen.getByRole("option", { name: /^High/ })).toBeInTheDocument();
  });
});
