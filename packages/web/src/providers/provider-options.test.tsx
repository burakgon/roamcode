import { useState } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test } from "vitest";
import { CodexSessionOptions, type CodexOptionDraft } from "./CodexSessionOptions";
import type { CodexModel } from "./types";

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

    await userEvent.click(screen.getByRole("button", { name: /^codex model$/i }));
    await userEvent.click(screen.getByRole("button", { name: /gpt known/i }));
    expect(screen.getByLabelText(/reasoning effort/i)).toHaveValue("high");
    expect(screen.getByRole("option", { name: "Low" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Extra high" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("option", { name: /provider default/i })).toHaveLength(1);
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
    expect(screen.getAllByRole("option", { name: /provider default/i })).toHaveLength(1);
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
