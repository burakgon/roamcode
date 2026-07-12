import { useState } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test, vi } from "vitest";
import { ProviderPicker } from "./ProviderPicker";
import { CodexSessionOptions, type CodexOptionDraft } from "./CodexSessionOptions";
import type { CodexModel, ProviderSummaries } from "./types";

const providers: ProviderSummaries = {
  claude: { terminalAvailable: false, metadataAvailable: false },
  codex: { terminalAvailable: true, metadataAvailable: false },
};

const models: CodexModel[] = [
  {
    value: "gpt-known",
    id: "gpt-known",
    displayName: "GPT Known",
    description: "Known model",
    isDefault: true,
    supportedReasoningEfforts: ["low", "high"],
    defaultReasoningEffort: "high",
  },
];

describe("provider-native option controls", () => {
  test("renders normalized provider auth state without changing terminal selectability", () => {
    render(
      <ProviderPicker
        providers={{
          claude: { terminalAvailable: true, metadataAvailable: true },
          codex: { terminalAvailable: true, metadataAvailable: false },
        }}
        value={undefined}
        onChange={vi.fn()}
        authStates={{ claude: "signed-out", codex: "signed-in" }}
      />,
    );

    expect(screen.getByText(/claude cli on the host/i)).toHaveTextContent(/signed out/i);
    expect(screen.getByText(/^signed in$/i)).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /claude code/i })).toBeEnabled();
    expect(screen.getByRole("radio", { name: /codex/i })).toBeEnabled();
  });

  test("shows auth checking and terminal repair guidance with a real retry action", async () => {
    const retry = vi.fn();
    render(
      <ProviderPicker
        providers={providers}
        value={undefined}
        onChange={vi.fn()}
        authStates={{ claude: "checking", codex: "unavailable" }}
        onRetryAvailability={retry}
      />,
    );

    expect(screen.getByText(/checking sign-in/i)).toBeInTheDocument();
    expect(screen.getByText(/codex sign-in status unavailable/i)).toBeInTheDocument();
    expect(screen.getByText(/install or repair the claude cli on the host/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /retry provider availability/i }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  test("offers retry when auth status alone is unavailable", () => {
    render(
      <ProviderPicker
        providers={{
          claude: { terminalAvailable: true, metadataAvailable: true },
          codex: { terminalAvailable: true, metadataAvailable: true },
        }}
        value={undefined}
        onChange={vi.fn()}
        authStates={{ claude: "unavailable", codex: "signed-in" }}
        onRetryAvailability={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: /retry provider availability/i })).toBeInTheDocument();
  });

  test("uses the existing error color token", () => {
    render(<ProviderPicker providers={providers} value={undefined} onChange={vi.fn()} availabilityState="error" />);
    const css = [...document.querySelectorAll("style")].map((style) => style.textContent).join("\n");
    expect(css).toContain("var(--err)");
    expect(css).not.toContain("var(--danger)");
  });

  test("distinguishes availability checking from a confirmed unavailable terminal", () => {
    render(<ProviderPicker providers={{}} value={undefined} onChange={vi.fn()} availabilityState="loading" />);

    expect(screen.getAllByText(/checking availability/i)).toHaveLength(2);
    expect(screen.queryByText(/terminal unavailable/i)).not.toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /claude code/i })).toBeDisabled();
    expect(screen.getByRole("radio", { name: /codex/i })).toBeDisabled();
  });

  test("uses radio semantics, disables only a terminal-unavailable provider, and exposes metadata degradation", async () => {
    const onChange = vi.fn();
    render(<ProviderPicker providers={providers} value={undefined} onChange={onChange} />);

    expect(screen.getByRole("radiogroup", { name: /coding agent/i })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /claude code/i })).toBeDisabled();
    const codex = screen.getByRole("radio", { name: /codex/i });
    expect(codex).toBeEnabled();
    expect(screen.getByText(/metadata unavailable.*custom/i)).toBeInTheDocument();
    await userEvent.click(codex);
    expect(onChange).toHaveBeenCalledWith("codex");
  });

  test("known Codex models constrain reasoning and reset stale effort to the advertised default", async () => {
    function Harness() {
      const [value, setValue] = useState<CodexOptionDraft>({
        model: "custom-before",
        reasoningEffort: "xhigh",
        sandbox: "workspace-write",
        approvalPolicy: "on-request",
        profile: "",
        webSearch: false,
        addDirs: [],
        dangerouslyBypassApprovalsAndSandbox: false,
      });
      return <CodexSessionOptions value={value} onChange={setValue} models={models} profiles={[]} metadataAvailable />;
    }
    render(<Harness />);

    const model = screen.getByRole("combobox", { name: /^codex model$/i });
    await userEvent.selectOptions(model, "gpt-known");
    expect(screen.getByLabelText(/reasoning effort/i)).toHaveValue("high");
    expect(screen.getByRole("option", { name: "Low" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Extra high" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("option", { name: /provider default/i })).toHaveLength(2);
    expect(screen.getByRole("status")).toHaveTextContent(/reset.*high/i);
  });

  test("constrains a known Codex model restored with a stale reasoning default", async () => {
    function Harness() {
      const [value, setValue] = useState<CodexOptionDraft>({
        model: "gpt-known",
        reasoningEffort: "xhigh",
        sandbox: "workspace-write",
        approvalPolicy: "on-request",
        profile: "",
        webSearch: false,
        addDirs: [],
        dangerouslyBypassApprovalsAndSandbox: false,
      });
      return <CodexSessionOptions value={value} onChange={setValue} models={models} profiles={[]} metadataAvailable />;
    }
    render(<Harness />);

    await waitFor(() => expect(screen.getByLabelText(/reasoning effort/i)).toHaveValue("high"));
    expect(screen.getByRole("status")).toHaveTextContent(/reset.*high/i);
  });

  test("keeps mixed future reasoning tokens and uses the advertised default", async () => {
    const mixedModel: CodexModel = {
      ...models[0]!,
      value: "gpt-mixed",
      id: "gpt-mixed",
      supportedReasoningEfforts: ["future-ultra", "low", "high"],
      defaultReasoningEffort: "future-ultra",
    };
    function Harness() {
      const [value, setValue] = useState<CodexOptionDraft>({
        model: "gpt-mixed",
        reasoningEffort: "xhigh",
        sandbox: "workspace-write",
        approvalPolicy: "on-request",
        profile: "",
        webSearch: false,
        addDirs: [],
        dangerouslyBypassApprovalsAndSandbox: false,
      });
      return (
        <CodexSessionOptions value={value} onChange={setValue} models={[mixedModel]} profiles={[]} metadataAvailable />
      );
    }
    render(<Harness />);

    await waitFor(() => expect(screen.getByLabelText(/reasoning effort/i)).toHaveValue("future-ultra"));
    expect(screen.getByRole("option", { name: /future-ultra/ })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Low" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "High" })).toBeInTheDocument();
  });

  test("renders a future-only advertised reasoning effort with safe fallback copy", async () => {
    const futureModel: CodexModel = {
      ...models[0]!,
      value: "gpt-future",
      id: "gpt-future",
      supportedReasoningEfforts: ["future-ultra"],
      defaultReasoningEffort: "future-ultra",
    };
    function Harness() {
      const [value, setValue] = useState<CodexOptionDraft>({
        model: "gpt-future",
        reasoningEffort: "high",
        sandbox: "workspace-write",
        approvalPolicy: "on-request",
        profile: "",
        webSearch: false,
        addDirs: [],
        dangerouslyBypassApprovalsAndSandbox: false,
      });
      return (
        <CodexSessionOptions value={value} onChange={setValue} models={[futureModel]} profiles={[]} metadataAvailable />
      );
    }
    render(<Harness />);

    await waitFor(() => expect(screen.getByLabelText(/reasoning effort/i)).toHaveValue("future-ultra"));
    expect(screen.getByRole("option", { name: /future-ultra/ })).toBeInTheDocument();
    expect(screen.getByText(/provider-advertised reasoning level/i)).toBeInTheDocument();
  });

  test("preserves provider default when switching a future-only known model to a custom model", async () => {
    const futureModel: CodexModel = {
      ...models[0]!,
      value: "gpt-future",
      id: "gpt-future",
      supportedReasoningEfforts: ["future-ultra"],
      defaultReasoningEffort: "future-ultra",
    };
    function Harness() {
      const [value, setValue] = useState<CodexOptionDraft>({
        model: "gpt-future",
        reasoningEffort: "high",
        sandbox: "workspace-write",
        approvalPolicy: "on-request",
        profile: "",
        webSearch: false,
        addDirs: [],
        dangerouslyBypassApprovalsAndSandbox: false,
      });
      return (
        <CodexSessionOptions value={value} onChange={setValue} models={[futureModel]} profiles={[]} metadataAvailable />
      );
    }
    render(<Harness />);
    await waitFor(() => expect(screen.getByLabelText(/reasoning effort/i)).toHaveValue("future-ultra"));

    await userEvent.click(screen.getByText("Advanced"));
    await userEvent.click(screen.getByRole("checkbox", { name: /use a custom codex model/i }));
    await userEvent.type(screen.getByRole("textbox", { name: /custom codex model/i }), "vendor/custom-next");
    expect(screen.getByLabelText(/reasoning effort/i)).toHaveValue("");
    expect(screen.getAllByRole("option", { name: /provider default/i })).toHaveLength(2);
    expect(screen.getByRole("option", { name: "Extra high" })).toBeInTheDocument();
  });

  test("dangerous Codex bypass requires confirmation and makes ordinary safety controls unavailable", async () => {
    function Harness() {
      const [value, setValue] = useState<CodexOptionDraft>({
        model: "",
        reasoningEffort: "medium",
        sandbox: "workspace-write",
        approvalPolicy: "on-request",
        profile: "",
        webSearch: false,
        addDirs: [],
        dangerouslyBypassApprovalsAndSandbox: false,
      });
      return (
        <CodexSessionOptions value={value} onChange={setValue} models={[]} profiles={[]} metadataAvailable={false} />
      );
    }
    render(<Harness />);

    await userEvent.click(screen.getByRole("checkbox", { name: /bypass approvals and sandbox/i }));
    expect(screen.getByRole("alert")).toHaveTextContent(/without approval or sandbox protection/i);
    await userEvent.click(screen.getByRole("button", { name: /yes, enable bypass/i }));
    expect(screen.getByRole("combobox", { name: "Sandbox" })).toBeDisabled();
    expect(screen.getByRole("combobox", { name: "Approval policy" })).toBeDisabled();
  });
});
