import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, within } from "@testing-library/react";
import { RewindSheet } from "./RewindSheet";

afterEach(cleanup);

describe("RewindSheet", () => {
  it("renders a focus-trapped dialog titled 'Rewind to here' with the three modes", () => {
    render(<RewindSheet checkpointId="cp-1" onConfirm={() => {}} onCancel={() => {}} />);
    const dialog = screen.getByRole("dialog", { name: /rewind to here/i });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    // The three modes are each selectable, with one-line explanations.
    expect(screen.getByRole("radio", { name: /code/i })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /conversation/i })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /both/i })).toBeInTheDocument();
  });

  it("warns that Bash-made changes are not tracked and this cannot be undone", () => {
    render(<RewindSheet checkpointId="cp-1" onConfirm={() => {}} onCancel={() => {}} />);
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(/bash/i)).toBeInTheDocument();
    expect(within(dialog).getByText(/can.?t be undone/i)).toBeInTheDocument();
  });

  it("defaults to 'code' mode and confirms with the selected mode", () => {
    const onConfirm = vi.fn();
    render(<RewindSheet checkpointId="cp-1" onConfirm={onConfirm} onCancel={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /^confirm/i }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledWith("code");
  });

  it("confirms with 'conversation' once that mode is chosen", () => {
    const onConfirm = vi.fn();
    render(<RewindSheet checkpointId="cp-1" onConfirm={onConfirm} onCancel={() => {}} />);
    fireEvent.click(screen.getByRole("radio", { name: /conversation/i }));
    fireEvent.click(screen.getByRole("button", { name: /^confirm/i }));
    expect(onConfirm).toHaveBeenCalledWith("conversation");
  });

  it("confirms with 'both' once that mode is chosen", () => {
    const onConfirm = vi.fn();
    render(<RewindSheet checkpointId="cp-1" onConfirm={onConfirm} onCancel={() => {}} />);
    fireEvent.click(screen.getByRole("radio", { name: /both/i }));
    fireEvent.click(screen.getByRole("button", { name: /^confirm/i }));
    expect(onConfirm).toHaveBeenCalledWith("both");
  });

  it("cancels via the Cancel button and via Escape, without confirming", () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    const { rerender } = render(<RewindSheet checkpointId="cp-1" onConfirm={onConfirm} onCancel={onCancel} />);
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();

    rerender(<RewindSheet checkpointId="cp-1" onConfirm={onConfirm} onCancel={onCancel} />);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(2);
  });
});
