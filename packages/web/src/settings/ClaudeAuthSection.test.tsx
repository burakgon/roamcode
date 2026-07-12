import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ClaudeAuthSection } from "./ClaudeAuthSection";
import type { ApiClient } from "../api/client";

function mockApi(over: Partial<ApiClient>): ApiClient {
  return over as ApiClient;
}

describe("ClaudeAuthSection", () => {
  it("keeps sign-in available with a retryable scoped error when account status fails", async () => {
    const getAuthStatus = vi
      .fn()
      .mockRejectedValueOnce(new Error("raw status frame"))
      .mockResolvedValueOnce({ available: true, loggedIn: false });
    render(<ClaudeAuthSection api={mockApi({ getAuthStatus })} />);

    expect(await screen.findByRole("alert")).toHaveTextContent(/claude account status is unavailable/i);
    expect(screen.getByRole("button", { name: /sign in/i })).toBeEnabled();
    await userEvent.click(screen.getByRole("button", { name: /retry claude account status/i }));
    expect(await screen.findByText("Not signed in.")).toBeVisible();
    expect(screen.queryByText(/raw status/i)).not.toBeInTheDocument();
  });

  it("renders nothing when the feature is unavailable on the server", async () => {
    const getAuthStatus = vi.fn().mockResolvedValue({ available: false });
    const { container } = render(<ClaudeAuthSection api={mockApi({ getAuthStatus })} />);
    await waitFor(() => expect(getAuthStatus).toHaveBeenCalled());
    expect(container.querySelector(".rc-auth")).toBeNull();
  });

  it("shows the signed-in account", async () => {
    const getAuthStatus = vi
      .fn()
      .mockResolvedValue({ available: true, loggedIn: true, email: "a@b.com", subscriptionType: "max" });
    render(<ClaudeAuthSection api={mockApi({ getAuthStatus })} />);
    expect(await screen.findByText(/signed in as a@b\.com · max/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /re-authenticate/i })).toBeInTheDocument();
  });

  it("drives the full sign-in flow: start → show URL + code field → submit → signed in", async () => {
    const getAuthStatus = vi
      .fn()
      .mockResolvedValueOnce({ available: true, loggedIn: false }) // initial
      .mockResolvedValue({ available: true, loggedIn: true, email: "a@b.com" }); // after sign-in
    const startAuthLogin = vi
      .fn()
      .mockResolvedValue({ loginId: "L1", url: "https://claude.com/cai/oauth/authorize?code=true" });
    const submitAuthCode = vi.fn().mockResolvedValue({ ok: true });
    render(<ClaudeAuthSection api={mockApi({ getAuthStatus, startAuthLogin, submitAuthCode })} />);

    await userEvent.click(await screen.findByRole("button", { name: /sign in/i }));

    // The authorize URL is offered as a link, and a code field appears.
    const link = await screen.findByRole("link", { name: /open the claude sign-in page/i });
    expect(link).toHaveAttribute("href", "https://claude.com/cai/oauth/authorize?code=true");
    const input = screen.getByLabelText(/authorization code/i);
    await userEvent.type(input, "PASTED-CODE");
    await userEvent.click(screen.getByRole("button", { name: /submit code/i }));

    expect(submitAuthCode).toHaveBeenCalledWith("L1", "PASTED-CODE");
    expect(await screen.findByText(/signed in ✓/i)).toBeInTheDocument();
  });

  it("surfaces a safe failed sign-in message without raw service detail", async () => {
    const getAuthStatus = vi.fn().mockResolvedValue({ available: true, loggedIn: false });
    const startAuthLogin = vi.fn().mockResolvedValue({ loginId: "L1", url: "https://claude.com/cai/oauth/authorize" });
    const submitAuthCode = vi
      .fn()
      .mockResolvedValue({ ok: false, message: "raw app-server token=/private/credential" });
    render(<ClaudeAuthSection api={mockApi({ getAuthStatus, startAuthLogin, submitAuthCode })} />);

    await userEvent.click(await screen.findByRole("button", { name: /sign in/i }));
    await userEvent.type(await screen.findByLabelText(/authorization code/i), "BAD");
    await userEvent.click(screen.getByRole("button", { name: /submit code/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/claude sign-in failed.*check the code/i);
    expect(screen.queryByText(/raw app-server|private|credential/i)).not.toBeInTheDocument();
  });

  it("does not expose a raw start failure", async () => {
    render(
      <ClaudeAuthSection
        api={mockApi({
          getAuthStatus: vi.fn().mockResolvedValue({ available: true, loggedIn: false }),
          startAuthLogin: vi.fn().mockRejectedValue(new Error("raw oauth frame with secret")),
        })}
      />,
    );
    await userEvent.click(await screen.findByRole("button", { name: /sign in/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/couldn't start claude sign-in/i);
    expect(screen.queryByText(/raw oauth|secret/i)).not.toBeInTheDocument();
  });

  it("rejects an unsafe authorization URL", async () => {
    render(
      <ClaudeAuthSection
        api={mockApi({
          getAuthStatus: vi.fn().mockResolvedValue({ available: true, loggedIn: false }),
          startAuthLogin: vi.fn().mockResolvedValue({ loginId: "L1", url: "http://internal/secret" }),
        })}
      />,
    );
    await userEvent.click(await screen.findByRole("button", { name: /sign in/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/couldn't start claude sign-in/i);
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.queryByText(/internal|secret/i)).not.toBeInTheDocument();
  });
});
