import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { UpdateProgressBanner } from "./UpdateProgressBanner";

describe("UpdateProgressBanner", () => {
  it("keeps hidden background progress visible and opens the detail sheet", async () => {
    const onOpen = vi.fn();
    render(
      <UpdateProgressBanner
        status={{ state: "installing", target: "1.1.0" }}
        target="1.1.0"
        connection="connected"
        onOpen={onOpen}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent(/updating to v1\.1\.0.*installing/i);
    await userEvent.click(screen.getByRole("button", { name: /view progress/i }));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("describes a restart disconnect as reconnecting", () => {
    render(<UpdateProgressBanner target="1.1.0" connection="reconnecting" onOpen={vi.fn()} />);
    expect(screen.getByRole("status")).toHaveTextContent(/server restarting.*reconnecting/i);
  });
});
