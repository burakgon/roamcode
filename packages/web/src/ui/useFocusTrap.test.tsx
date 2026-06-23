import { useRef, useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { useFocusTrap } from "./useFocusTrap";

/** A minimal dialog driven by the hook, opened from a trigger button. */
function Harness() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref, open);
  return (
    <div>
      <button type="button" onClick={() => setOpen(true)}>
        open
      </button>
      {open && (
        <div ref={ref} role="dialog" aria-modal="true">
          <button type="button">first</button>
          <button type="button">middle</button>
          <button type="button" onClick={() => setOpen(false)}>
            last
          </button>
        </div>
      )}
    </div>
  );
}

describe("useFocusTrap", () => {
  it("focuses the first focusable element on open", async () => {
    render(<Harness />);
    await userEvent.click(screen.getByRole("button", { name: "open" }));
    expect(screen.getByRole("button", { name: "first" })).toHaveFocus();
  });

  it("wraps Tab from the last focusable back to the first", async () => {
    render(<Harness />);
    await userEvent.click(screen.getByRole("button", { name: "open" }));
    // first → middle → last → (wrap) first
    await userEvent.tab();
    expect(screen.getByRole("button", { name: "middle" })).toHaveFocus();
    await userEvent.tab();
    expect(screen.getByRole("button", { name: "last" })).toHaveFocus();
    await userEvent.tab();
    expect(screen.getByRole("button", { name: "first" })).toHaveFocus();
  });

  it("wraps Shift+Tab from the first focusable to the last", async () => {
    render(<Harness />);
    await userEvent.click(screen.getByRole("button", { name: "open" }));
    expect(screen.getByRole("button", { name: "first" })).toHaveFocus();
    await userEvent.tab({ shift: true });
    expect(screen.getByRole("button", { name: "last" })).toHaveFocus();
  });

  it("restores focus to the trigger when the dialog closes", async () => {
    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "open" });
    await userEvent.click(trigger);
    // Close via the dialog's own button; focus must return to the trigger.
    await userEvent.click(screen.getByRole("button", { name: "last" }));
    expect(trigger).toHaveFocus();
  });
});
