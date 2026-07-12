import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../api/client";
import { CodexAuthSection } from "./CodexAuthSection";

function api(overrides: Partial<ApiClient>): ApiClient {
  return overrides as ApiClient;
}

describe("CodexAuthSection", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn(async () => undefined) },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps sign-in available with a retryable scoped error when account status fails", async () => {
    const getProviderAuthStatus = vi
      .fn()
      .mockRejectedValueOnce(new Error("raw status frame"))
      .mockResolvedValueOnce({ available: true, authenticated: false });
    render(
      <CodexAuthSection
        api={api({
          getProviderAuthStatus,
          startProviderLogin: vi.fn(),
          cancelProviderLogin: vi.fn(),
        })}
      />,
    );

    expect(await screen.findByText(/codex account status is unavailable/i)).toBeVisible();
    expect(screen.getByRole("button", { name: /sign in to codex/i })).toBeEnabled();
    await userEvent.click(screen.getByRole("button", { name: /retry codex account status/i }));
    expect(await screen.findByText("Not signed in.")).toBeVisible();
    expect(screen.queryByText(/raw status/i)).not.toBeInTheDocument();
  });

  it("shows a secure device link and copyable code without accepting a secret", async () => {
    const startProviderLogin = vi.fn().mockResolvedValue({
      loginId: "login-1",
      userCode: "ABCD-EFGH",
      verificationUrl: "https://auth.example.test/device",
      expiresAt: Date.now() + 60_000,
    });
    render(
      <CodexAuthSection
        api={api({
          getProviderAuthStatus: vi.fn().mockResolvedValue({ available: true, authenticated: false }),
          startProviderLogin,
          cancelProviderLogin: vi.fn().mockResolvedValue({ status: "canceled" }),
        })}
      />,
    );

    await userEvent.click(await screen.findByRole("button", { name: /sign in to codex/i }));
    expect(await screen.findByText("ABCD-EFGH")).toBeVisible();
    const link = screen.getByRole("link", { name: /open codex verification/i });
    expect(link).toHaveAttribute("href", "https://auth.example.test/device");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(screen.queryByLabelText(/api key|secret|token/i)).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /copy device code/i }));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("ABCD-EFGH");
    expect(screen.getByRole("status")).toHaveTextContent(/copied/i);
  });

  it("completes only from the exact login, then refreshes the account", async () => {
    const getProviderAuthStatus = vi
      .fn()
      .mockResolvedValueOnce({ available: true, authenticated: false })
      .mockResolvedValueOnce({ available: true, authenticated: true, authMethod: "chatgpt", plan: "plus" });
    render(
      <CodexAuthSection
        api={api({
          getProviderAuthStatus,
          getProviderLoginStatus: vi.fn().mockResolvedValue({ status: "completed" }),
          startProviderLogin: vi.fn().mockResolvedValue({
            loginId: "login-1",
            userCode: "ABCD",
            verificationUrl: "https://auth.example.test/device",
            expiresAt: Date.now() + 60_000,
          }),
          cancelProviderLogin: vi.fn().mockResolvedValue({ status: "canceled" }),
        })}
      />,
    );
    await userEvent.click(await screen.findByRole("button", { name: /sign in to codex/i }));

    await act(async () => vi.advanceTimersByTimeAsync(2_000));
    expect(await screen.findByText(/signed in.*chatgpt.*plus/i)).toBeVisible();
    expect(getProviderAuthStatus).toHaveBeenCalledTimes(2);
    expect(screen.queryByText("ABCD")).not.toBeInTheDocument();
  });

  it("ignores an initial account response that becomes stale during login", async () => {
    let resolveInitial!: (status: { available: true; authenticated: false }) => void;
    const getProviderAuthStatus = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveInitial = resolve;
          }),
      )
      .mockResolvedValueOnce({ available: true, authenticated: true, authMethod: "chatgpt", plan: "plus" });
    render(
      <CodexAuthSection
        api={api({
          getProviderAuthStatus,
          getProviderLoginStatus: vi.fn().mockResolvedValue({ status: "completed" }),
          startProviderLogin: vi.fn().mockResolvedValue({
            loginId: "login-stale",
            userCode: "STALE",
            verificationUrl: "https://auth.example.test/device",
            expiresAt: Date.now() + 60_000,
          }),
          cancelProviderLogin: vi.fn().mockResolvedValue({ status: "canceled" }),
        })}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /sign in to codex/i }));
    await screen.findByText("STALE");
    await act(async () => vi.advanceTimersByTimeAsync(2_000));
    expect(await screen.findByText(/signed in.*chatgpt.*plus/i)).toBeVisible();

    await act(async () => resolveInitial({ available: true, authenticated: false }));
    expect(screen.getByText(/signed in.*chatgpt.*plus/i)).toBeVisible();
  });

  it("expires and cancels an abandoned login", async () => {
    const cancelProviderLogin = vi.fn().mockResolvedValue({ status: "canceled" });
    render(
      <CodexAuthSection
        api={api({
          getProviderAuthStatus: vi.fn().mockResolvedValue({ available: true, authenticated: false }),
          startProviderLogin: vi.fn().mockResolvedValue({
            loginId: "login-expired",
            userCode: "EXPIRE",
            verificationUrl: "https://auth.example.test/device",
            expiresAt: Date.now() + 1_000,
          }),
          cancelProviderLogin,
        })}
      />,
    );
    await userEvent.click(await screen.findByRole("button", { name: /sign in to codex/i }));
    await act(async () => vi.advanceTimersByTime(1_100));

    expect(await screen.findByRole("alert")).toHaveTextContent(/expired/i);
    expect(cancelProviderLogin).toHaveBeenCalledWith("codex", "login-expired");
  });

  it("does not complete re-authentication from an already-authenticated account or cancel at 60 seconds", async () => {
    let loginStatus: "pending" | "completed" = "pending";
    const cancelProviderLogin = vi.fn().mockResolvedValue({ status: "canceled" });
    const getProviderAuthStatus = vi
      .fn()
      .mockResolvedValue({ available: true, authenticated: true, authMethod: "chatgpt", plan: "plus" });
    render(
      <CodexAuthSection
        api={api({
          getProviderAuthStatus,
          getProviderLoginStatus: vi.fn(async () => ({ status: loginStatus })),
          startProviderLogin: vi.fn().mockResolvedValue({
            loginId: "login-reauth",
            userCode: "REAUTH",
            verificationUrl: "https://auth.example.test/device",
            expiresAt: Date.now() + 10 * 60_000,
          }),
          cancelProviderLogin,
        })}
      />,
    );
    await userEvent.click(await screen.findByRole("button", { name: /re-authenticate codex/i }));
    expect(await screen.findByText("REAUTH")).toBeVisible();

    await act(async () => vi.advanceTimersByTimeAsync(61_000));
    expect(screen.getByText("REAUTH")).toBeVisible();
    expect(cancelProviderLogin).not.toHaveBeenCalled();
    expect(getProviderAuthStatus).toHaveBeenCalledTimes(1);

    loginStatus = "completed";
    await act(async () => vi.advanceTimersByTimeAsync(2_000));
    expect(await screen.findByText(/signed in.*chatgpt.*plus/i)).toBeVisible();
    expect(screen.queryByText("REAUTH")).not.toBeInTheDocument();
    expect(getProviderAuthStatus).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["failed", /failed/i],
    ["canceled", /canceled/i],
    ["expired", /expired/i],
    ["notFound", /no longer available/i],
  ] as const)("handles an exact-login %s outcome", async (status, message) => {
    render(
      <CodexAuthSection
        api={api({
          getProviderAuthStatus: vi.fn().mockResolvedValue({ available: true, authenticated: false }),
          getProviderLoginStatus: vi.fn().mockResolvedValue({ status }),
          startProviderLogin: vi.fn().mockResolvedValue({
            loginId: `login-${status}`,
            userCode: "TERMINAL",
            verificationUrl: "https://auth.example.test/device",
            expiresAt: Date.now() + 60_000,
          }),
          cancelProviderLogin: vi.fn().mockResolvedValue({ status: "canceled" }),
        })}
      />,
    );
    await userEvent.click(await screen.findByRole("button", { name: /sign in to codex/i }));
    await act(async () => vi.advanceTimersByTimeAsync(2_000));
    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    expect(screen.queryByText("TERMINAL")).not.toBeInTheDocument();
  });

  it("ignores an exact-login completion that resolves after user cancellation", async () => {
    let resolveStatus!: (status: { status: "completed" }) => void;
    const cancelProviderLogin = vi.fn().mockResolvedValue({ status: "canceled" });
    render(
      <CodexAuthSection
        api={api({
          getProviderAuthStatus: vi.fn().mockResolvedValue({ available: true, authenticated: false }),
          getProviderLoginStatus: vi.fn(
            () =>
              new Promise<{ status: "completed" }>((resolve) => {
                resolveStatus = resolve;
              }),
          ),
          startProviderLogin: vi.fn().mockResolvedValue({
            loginId: "login-stale-status",
            userCode: "STALE-STATUS",
            verificationUrl: "https://auth.example.test/device",
            expiresAt: Date.now() + 60_000,
          }),
          cancelProviderLogin,
        })}
      />,
    );
    await userEvent.click(await screen.findByRole("button", { name: /sign in to codex/i }));
    await act(async () => vi.advanceTimersByTimeAsync(1_500));
    await userEvent.click(screen.getByRole("button", { name: /cancel codex sign-in/i }));
    await act(async () => resolveStatus({ status: "completed" }));

    expect(screen.getByRole("button", { name: /sign in to codex/i })).toBeVisible();
    expect(screen.queryByText(/^Signed in/i)).not.toBeInTheDocument();
    expect(cancelProviderLogin).toHaveBeenCalledWith("codex", "login-stale-status");
  });

  it("cancels on unmount and ignores stale work", async () => {
    const cancelProviderLogin = vi.fn().mockResolvedValue({ status: "canceled" });
    const { unmount } = render(
      <CodexAuthSection
        api={api({
          getProviderAuthStatus: vi.fn().mockResolvedValue({ available: true, authenticated: false }),
          startProviderLogin: vi.fn().mockResolvedValue({
            loginId: "login-unmount",
            userCode: "UNMOUNT",
            verificationUrl: "https://auth.example.test/device",
            expiresAt: Date.now() + 60_000,
          }),
          cancelProviderLogin,
        })}
      />,
    );
    await userEvent.click(await screen.findByRole("button", { name: /sign in to codex/i }));
    await screen.findByText("UNMOUNT");
    unmount();
    await waitFor(() => expect(cancelProviderLogin).toHaveBeenCalledWith("codex", "login-unmount"));
  });

  it("rejects a non-HTTPS verification URL without exposing it", async () => {
    render(
      <CodexAuthSection
        api={api({
          getProviderAuthStatus: vi.fn().mockResolvedValue({ available: true, authenticated: false }),
          startProviderLogin: vi.fn().mockResolvedValue({
            loginId: "login-bad",
            userCode: "BAD",
            verificationUrl: "http://raw-internal.example/secret",
            expiresAt: Date.now() + 60_000,
          }),
          cancelProviderLogin: vi.fn().mockResolvedValue({ status: "canceled" }),
        })}
      />,
    );
    await userEvent.click(await screen.findByRole("button", { name: /sign in to codex/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/could not start codex sign-in/i);
    expect(screen.queryByText(/raw-internal|secret/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("rejects an unreasonably distant expiry before scheduling timers", async () => {
    const cancelProviderLogin = vi.fn().mockResolvedValue({ status: "canceled" });
    render(
      <CodexAuthSection
        api={api({
          getProviderAuthStatus: vi.fn().mockResolvedValue({ available: true, authenticated: false }),
          startProviderLogin: vi.fn().mockResolvedValue({
            loginId: "login-future",
            userCode: "FUTURE",
            verificationUrl: "https://auth.example.test/device",
            expiresAt: Date.now() + 24 * 60 * 60_000,
          }),
          cancelProviderLogin,
        })}
      />,
    );
    await userEvent.click(await screen.findByRole("button", { name: /sign in to codex/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/could not start codex sign-in/i);
    expect(cancelProviderLogin).toHaveBeenCalledWith("codex", "login-future");
  });

  it("retries a transient exact-status failure without hiding the code or leaking the error", async () => {
    const getProviderLoginStatus = vi
      .fn()
      .mockRejectedValueOnce(new Error("raw protocol frame"))
      .mockResolvedValueOnce({ status: "completed" });
    render(
      <CodexAuthSection
        api={api({
          getProviderAuthStatus: vi
            .fn()
            .mockResolvedValueOnce({ available: true, authenticated: false })
            .mockResolvedValueOnce({ available: true, authenticated: true, authMethod: "chatgpt" }),
          getProviderLoginStatus,
          startProviderLogin: vi.fn().mockResolvedValue({
            loginId: "login-retry",
            userCode: "RETRY",
            verificationUrl: "https://auth.example.test/device",
            expiresAt: Date.now() + 60_000,
          }),
          cancelProviderLogin: vi.fn().mockResolvedValue({ status: "canceled" }),
        })}
      />,
    );
    await userEvent.click(await screen.findByRole("button", { name: /sign in to codex/i }));
    await act(async () => vi.advanceTimersByTimeAsync(1_600));
    expect(screen.getByText("RETRY")).toBeVisible();
    expect(screen.queryByText(/raw protocol/i)).not.toBeInTheDocument();
    await act(async () => vi.advanceTimersByTimeAsync(1_600));
    expect(await screen.findByText(/signed in.*chatgpt/i)).toBeVisible();
  });
});
