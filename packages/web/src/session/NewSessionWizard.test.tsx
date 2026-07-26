import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { ApiError, type ApiClient, type CreateSessionBody, type CreateSessionResponse } from "../api/client";
import type { SessionMeta } from "../types/server";
import { NewSessionWizard } from "./NewSessionWizard";

function shellSession(overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id: "terminal-1",
    launch: { kind: "shell" },
    cwd: "/workspace",
    dangerouslySkip: false,
    status: "running",
    createdAt: 1,
    mode: "terminal",
    ...overrides,
  };
}

function makeApi(response: CreateSessionResponse = { session: shellSession() }) {
  return {
    listDir: vi.fn(),
    mkdir: vi.fn(),
    searchDirs: vi.fn(),
    createSession: vi.fn(async () => response),
  } as Pick<ApiClient, "listDir" | "mkdir" | "searchDirs" | "createSession">;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function renderWizard(options?: {
  api?: ReturnType<typeof makeApi>;
  createSession?: (body: CreateSessionBody) => Promise<CreateSessionResponse>;
  onCreated?: (session: SessionMeta) => void;
  onClose?: () => void;
}) {
  const api = options?.api ?? makeApi();
  const onCreated = options?.onCreated ?? vi.fn();
  const onClose = options?.onClose ?? vi.fn();
  const view = render(
    <NewSessionWizard
      api={api}
      recents={[]}
      initialCwd="/workspace"
      createSession={options?.createSession}
      onCreated={onCreated}
      onClose={onClose}
    />,
  );
  return { ...view, api, onCreated, onClose };
}

beforeEach(() => {
  localStorage.clear();
  document.body.style.overflow = "";
});

describe("NewSessionWizard terminal-first flow", () => {
  test("opens an ordinary shell without provider, model, auth, or permission controls", () => {
    renderWizard();

    expect(screen.getByRole("dialog", { name: "New terminal" })).toBeVisible();
    expect(screen.getByText("Open a shell, then start any tool you want.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Open terminal" })).toBeEnabled();
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
    expect(screen.queryByText(/claude|codex|model|sign-in|permission/i)).not.toBeInTheDocument();
  });

  test("creates only a terminal session, remembers its label and directory, then selects it", async () => {
    const { api, onCreated } = renderWizard();

    await userEvent.type(screen.getByRole("textbox", { name: "terminal name" }), "  API work  ");
    await userEvent.click(screen.getByRole("button", { name: "Open terminal" }));

    await waitFor(() =>
      expect(api.createSession).toHaveBeenCalledWith({
        cwd: "/workspace",
        mode: "terminal",
      }),
    );
    expect(onCreated).toHaveBeenCalledWith(shellSession());
    expect(JSON.parse(localStorage.getItem("rc-session-names") ?? "{}")).toEqual({
      "terminal-1": "API work",
    });
    expect(JSON.parse(localStorage.getItem("roamcode.recents") ?? "[]")).toEqual(["/workspace"]);
  });

  test("uses an explicit remote-node transport without adding provider options", async () => {
    const createSession = vi.fn(async () => ({
      session: shellSession({ id: "remote-terminal" }),
    }));
    const { api, onCreated } = renderWizard({ createSession });

    await userEvent.click(screen.getByRole("button", { name: "Open terminal" }));

    expect(createSession).toHaveBeenCalledWith({ cwd: "/workspace", mode: "terminal" });
    expect(api.createSession).not.toHaveBeenCalled();
    expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ id: "remote-terminal" }));
  });

  test("shows creation failures and leaves the draft retryable", async () => {
    const api = makeApi();
    api.createSession = vi.fn(async () => {
      throw new ApiError(503, "Terminal unavailable", "TERMINAL_UNAVAILABLE");
    });
    renderWizard({ api });

    await userEvent.type(screen.getByRole("textbox", { name: "terminal name" }), "Keep me");
    await userEvent.click(screen.getByRole("button", { name: "Open terminal" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Terminal unavailable");
    expect(screen.getByRole("textbox", { name: "terminal name" })).toHaveValue("Keep me");
    expect(screen.getByRole("button", { name: "Open terminal" })).toBeEnabled();
    expect(localStorage.getItem("roamcode.recents")).toBeNull();
  });

  test("prevents duplicate actions while the terminal is opening", async () => {
    const pending = deferred<CreateSessionResponse>();
    const api = makeApi();
    api.createSession = vi.fn(() => pending.promise);
    const { onClose } = renderWizard({ api });

    await userEvent.click(screen.getByRole("button", { name: "Open terminal" }));

    expect(screen.getByRole("button", { name: "Opening…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Change directory" })).toBeDisabled();
    expect(screen.getByRole("textbox", { name: "terminal name" })).toBeDisabled();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();

    pending.resolve({ session: shellSession() });
    await waitFor(() => expect(api.createSession).toHaveBeenCalledTimes(1));
  });

  test("locks page scrolling and supports Escape or backdrop dismissal when idle", () => {
    document.body.style.overflow = "auto";
    const first = renderWizard();
    expect(document.body.style.overflow).toBe("hidden");

    fireEvent.keyDown(window, { key: "Escape" });
    expect(first.onClose).toHaveBeenCalledTimes(1);
    first.unmount();
    expect(document.body.style.overflow).toBe("auto");

    const second = renderWizard();
    fireEvent.click(screen.getByRole("dialog", { name: "New terminal" }));
    expect(second.onClose).toHaveBeenCalledTimes(1);
  });
});
