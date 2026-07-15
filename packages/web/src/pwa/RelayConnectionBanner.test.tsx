import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { RelayConnectionBanner } from "./RelayConnectionBanner";

describe("RelayConnectionBanner", () => {
  it("stays out of the way while the encrypted path is online", () => {
    const { container } = render(<RelayConnectionBanner status="online" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("distinguishes a relay interruption from browser offline state", () => {
    render(<RelayConnectionBanner status="reconnecting" />);
    expect(screen.getByRole("status")).toHaveTextContent(/sessions keep running.*reconnecting/i);
  });

  it("announces a security stop and offers an explicit retry", async () => {
    const onReconnect = vi.fn();
    render(<RelayConnectionBanner status="error" onReconnect={onReconnect} />);
    expect(screen.getByRole("alert")).toHaveTextContent(/identity verification failed/i);
    await userEvent.click(screen.getByRole("button", { name: /reconnect/i }));
    expect(onReconnect).toHaveBeenCalledOnce();
  });
});
