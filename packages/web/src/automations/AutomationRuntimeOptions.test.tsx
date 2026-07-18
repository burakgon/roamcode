import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AutomationRuntimeOptions } from "./AutomationRuntimeOptions";

describe("AutomationRuntimeOptions", () => {
  it("does not normalize a saved Claude definition until the user changes a typed control", async () => {
    const onChange = vi.fn();
    render(
      <AutomationRuntimeOptions
        provider="claude"
        displayName="Claude Code"
        value={{
          model: "claude-saved",
          effort: "saved-effort",
          permissionMode: "plan",
          futureOption: "keep-me",
        }}
        onChange={onChange}
        claudeModels={[
          {
            value: "claude-saved",
            displayName: "Claude Saved",
            supportedEffortLevels: ["high"],
            isDefault: true,
          },
        ]}
        claudeMetadataState="ready"
      />,
    );

    expect(await screen.findByText(/draft remains unchanged until you choose another effort/i)).toBeVisible();
    expect(onChange).not.toHaveBeenCalled();

    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Permission mode" }), "acceptEdits");
    expect(onChange).toHaveBeenLastCalledWith({
      model: "claude-saved",
      effort: "saved-effort",
      permissionMode: "acceptEdits",
      futureOption: "keep-me",
    });
  });
});
