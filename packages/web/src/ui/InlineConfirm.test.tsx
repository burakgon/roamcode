import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { InlineConfirm } from "./InlineConfirm";

describe("InlineConfirm", () => {
  it("keeps destructive confirmation inline and lets Escape cancel", async () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <InlineConfirm
        message="Remove this device?"
        confirmLabel="Remove device"
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );

    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("requires an exact typed phrase before enabling the action", async () => {
    const onConfirm = vi.fn();
    render(
      <InlineConfirm
        message="Reset every credential?"
        confirmLabel="Reset access"
        requireText="RESET"
        onConfirm={onConfirm}
        onCancel={() => {}}
      />,
    );

    const confirm = screen.getByRole("button", { name: "Reset access" });
    expect(confirm).toBeDisabled();
    await userEvent.type(screen.getByRole("textbox"), "reset");
    expect(confirm).toBeDisabled();
    await userEvent.clear(screen.getByRole("textbox"));
    await userEvent.type(screen.getByRole("textbox"), "RESET");
    expect(confirm).toBeEnabled();
    await userEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledOnce();
  });
});
