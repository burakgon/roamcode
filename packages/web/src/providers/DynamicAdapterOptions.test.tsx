import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test, vi } from "vitest";
import { NewSessionWizard } from "../session/NewSessionWizard";
import { adapterDraftErrors, adapterOptionDefaults, DynamicAdapterOptions } from "./DynamicAdapterOptions";
import type { ProviderDescriptor } from "./types";

const schema = {
  type: "object",
  additionalProperties: false,
  required: ["mode"],
  properties: {
    mode: {
      type: "string",
      title: "Execution mode",
      description: "Controls the adapter's native execution strategy.",
      enum: ["safe", "fast"],
      default: "safe",
    },
    retries: { type: "integer", title: "Retries", minimum: 0, maximum: 3, default: 1 },
    trace: { type: "boolean", title: "Trace adapter", default: false },
    labels: { type: "array", title: "Labels", items: { type: "string" }, maxItems: 4 },
  },
} satisfies Record<string, unknown>;

const descriptor: ProviderDescriptor = {
  id: "fixture-agent",
  displayName: "Fixture Agent",
  version: "1.0.0",
  schemaVersion: 1,
  source: "installed",
  enabled: true,
  resumeIdentity: "required",
  optionSchema: schema,
};

describe("manifest-driven adapter options", () => {
  test("hydrates defaults, renders bounded field types, and preserves native JSON values", async () => {
    const user = userEvent.setup();
    const defaults = adapterOptionDefaults(schema);
    expect(defaults).toEqual({ mode: "safe", retries: 1, trace: false });

    function Harness() {
      const [value, setValue] = useState(defaults);
      return (
        <>
          <DynamicAdapterOptions displayName="Fixture Agent" schema={schema} value={value} onChange={setValue} />
          <output data-testid="value">{JSON.stringify(value)}</output>
        </>
      );
    }

    render(<Harness />);
    await user.selectOptions(screen.getByRole("combobox", { name: /Execution mode/ }), "fast");
    await user.clear(screen.getByRole("spinbutton", { name: "Retries" }));
    await user.type(screen.getByRole("spinbutton", { name: "Retries" }), "3");
    await user.click(screen.getByLabelText("Trace adapter"));
    fireEvent.change(screen.getByRole("textbox", { name: /Labels/ }), { target: { value: "backend\nrelease" } });
    expect(JSON.parse(screen.getByTestId("value").textContent ?? "{}") as unknown).toEqual({
      mode: "fast",
      retries: 3,
      trace: true,
      labels: ["backend", "release"],
    });
    expect(adapterDraftErrors(schema, { mode: "", retries: 4 })).toEqual(
      expect.arrayContaining(["Execution mode is required", "Options.retries is above its maximum"]),
    );
  });

  test("starts an installed provider with only its manifest-owned option document", async () => {
    const user = userEvent.setup();
    const createSession = vi.fn(async () => ({
      session: {
        id: "session-1",
        provider: "fixture-agent",
        cwd: "/workspace",
        dangerouslySkip: false,
        status: "running" as const,
        createdAt: 1,
      },
    }));
    const onCreated = vi.fn();
    render(
      <NewSessionWizard
        api={{
          listDir: vi.fn(),
          createSession,
        }}
        defaults={{ effort: "medium", dangerouslySkip: false }}
        recents={[]}
        providerSummaries={{
          claude: { terminalAvailable: true, metadataAvailable: true },
          codex: { terminalAvailable: true, metadataAvailable: true },
          "fixture-agent": { terminalAvailable: true, metadataAvailable: false, version: "1.0.0" },
        }}
        providerCatalog={[
          {
            id: "claude",
            displayName: "Claude Code",
            resumeIdentity: "unsupported",
            source: "built-in",
            enabled: true,
          },
          { id: "codex", displayName: "Codex", resumeIdentity: "required", source: "built-in", enabled: true },
          descriptor,
        ]}
        initialCwd="/workspace"
        onCreated={onCreated}
        onClose={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("radio", { name: /Fixture Agent/ }));
    expect(screen.getByRole("region", { name: "Fixture Agent options" })).toBeVisible();
    await user.selectOptions(screen.getByRole("combobox", { name: /Execution mode/ }), "fast");
    await user.click(screen.getByRole("button", { name: "Start session" }));
    expect(createSession).toHaveBeenCalledWith({
      provider: "fixture-agent",
      cwd: "/workspace",
      options: { mode: "fast", retries: 1, trace: false },
      mode: "terminal",
    });
    expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ provider: "fixture-agent" }), undefined);
  });
});
