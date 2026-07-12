import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { NewSessionWizard } from "./NewSessionWizard";
import type { ApiClient, CreateSessionResponse } from "../api/client";
import type { CodexModel, ProviderSummaries } from "../providers/types";
import type { SessionMeta } from "../types/server";

const providers: ProviderSummaries = {
  claude: { terminalAvailable: true, metadataAvailable: true },
  codex: { terminalAvailable: true, metadataAvailable: true },
};

const codexModels: CodexModel[] = [
  {
    value: "gpt-known",
    id: "gpt-known",
    displayName: "GPT Known",
    description: "Known model",
    isDefault: true,
    supportedReasoningEfforts: ["low", "high"],
    defaultReasoningEffort: "high",
  },
];

function session(provider: "claude" | "codex" = "claude") {
  return {
    id: "s-new",
    provider,
    cwd: "/work",
    dangerouslySkip: false,
    status: "running" as const,
    createdAt: 1,
  };
}

function makeApi(response?: Awaited<ReturnType<ApiClient["createSession"]>>) {
  return {
    listDir: vi.fn(),
    mkdir: vi.fn(),
    searchDirs: vi.fn(),
    createSession: vi.fn(async () => response ?? { session: session() }),
  } as unknown as Pick<ApiClient, "listDir" | "mkdir" | "searchDirs" | "createSession">;
}

function renderWizard(options?: {
  api?: ReturnType<typeof makeApi>;
  onCreated?: ReturnType<typeof vi.fn>;
  onClose?: () => void;
  providerSummaries?: ProviderSummaries;
  codexModels?: CodexModel[];
}) {
  const api = options?.api ?? makeApi();
  const onCreated = options?.onCreated ?? vi.fn();
  const result = render(
    <NewSessionWizard
      api={api}
      recents={[]}
      initialCwd="/work"
      providerSummaries={options?.providerSummaries ?? providers}
      codexModels={options?.codexModels ?? codexModels}
      codexProfiles={["personal", "work.secure"]}
      onCreated={onCreated as (created: SessionMeta) => void}
      onClose={options?.onClose ?? vi.fn()}
    />,
  );
  return { ...result, api, onCreated };
}

beforeEach(() => localStorage.clear());

describe("NewSessionWizard provider choice", () => {
  test("requires a fresh provider choice for every wizard instance, including a prefilled folder", async () => {
    const first = renderWizard();
    expect(screen.getByRole("button", { name: /start session/i })).toBeDisabled();
    expect(screen.getByRole("radio", { name: /claude code/i })).not.toBeChecked();
    expect(screen.getByRole("radio", { name: /codex/i })).not.toBeChecked();
    await userEvent.click(screen.getByRole("radio", { name: /codex/i }));
    expect(screen.getByRole("button", { name: /start session/i })).toBeEnabled();
    first.unmount();

    renderWizard();
    expect(screen.getByRole("radio", { name: /codex/i })).not.toBeChecked();
    expect(screen.getByRole("button", { name: /start session/i })).toBeDisabled();
  });

  test("provider switching discards provider-specific in-memory option state", async () => {
    renderWizard();
    await userEvent.click(screen.getByRole("radio", { name: /claude code/i }));
    await userEvent.type(screen.getByLabelText(/claude model/i), "claude-custom");
    await userEvent.click(screen.getByRole("radio", { name: /codex/i }));
    await userEvent.type(screen.getByLabelText(/codex model/i), "vendor/gpt-next:preview");
    await userEvent.click(screen.getByRole("radio", { name: /claude code/i }));
    expect(screen.getByLabelText(/claude model/i)).toHaveValue("");
  });

  test("preserves Claude controls, naming, recents, and exact nested serialization", async () => {
    const { api, onCreated } = renderWizard();
    await userEvent.click(screen.getByRole("radio", { name: /claude code/i }));
    await userEvent.selectOptions(screen.getByLabelText(/effort/i), "high");
    await userEvent.type(screen.getByLabelText(/claude model/i), "opus-custom");
    await userEvent.selectOptions(screen.getByLabelText(/permission mode/i), "plan");
    await userEvent.type(screen.getByLabelText(/additional directory path/i), "/extra");
    await userEvent.click(screen.getByRole("button", { name: /add directory/i }));
    await userEvent.type(screen.getByLabelText(/session name/i), "Named session");
    await userEvent.click(screen.getByRole("button", { name: /start session/i }));

    expect(api.createSession).toHaveBeenCalledWith({
      provider: "claude",
      cwd: "/work",
      options: { effort: "high", model: "opus-custom", permissionMode: "plan", addDirs: ["/extra"] },
      mode: "terminal",
    });
    expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ id: "s-new" }));
    expect(JSON.parse(localStorage.getItem("rc-session-names")!)).toEqual({ "s-new": "Named session" });
    expect(JSON.parse(localStorage.getItem("roamcode.recents")!)).toEqual(["/work"]);
  });

  test("serializes bounded custom Codex options and excludes safety fields after dangerous confirmation", async () => {
    const api = makeApi({ session: session("codex") });
    renderWizard({ api });
    await userEvent.click(screen.getByRole("radio", { name: /codex/i }));
    await userEvent.type(screen.getByLabelText(/codex model/i), "vendor/gpt-next:preview");
    await userEvent.selectOptions(screen.getByLabelText(/reasoning effort/i), "xhigh");
    await userEvent.selectOptions(screen.getByLabelText(/profile/i), "work.secure");
    await userEvent.click(screen.getByRole("checkbox", { name: /web search/i }));
    await userEvent.type(screen.getByLabelText(/additional directory path/i), "/extra");
    await userEvent.click(screen.getByRole("button", { name: /add directory/i }));
    await userEvent.click(screen.getByRole("checkbox", { name: /bypass approvals and sandbox/i }));
    await userEvent.click(screen.getByRole("button", { name: /yes, enable bypass/i }));
    await userEvent.click(screen.getByRole("button", { name: /start session/i }));

    expect(api.createSession).toHaveBeenCalledWith({
      provider: "codex",
      cwd: "/work",
      options: {
        model: "vendor/gpt-next:preview",
        reasoningEffort: "xhigh",
        profile: "work.secure",
        webSearch: true,
        addDirs: ["/extra"],
        dangerouslyBypassApprovalsAndSandbox: true,
      },
      mode: "terminal",
    });
  });

  test("omits reasoning when a known Codex model has only future effort tokens", async () => {
    const api = makeApi({ session: session("codex") });
    const futureModel: CodexModel = {
      ...codexModels[0]!,
      value: "gpt-future",
      id: "gpt-future",
      supportedReasoningEfforts: ["future-ultra"],
      defaultReasoningEffort: "future-ultra",
    };
    renderWizard({ api, codexModels: [futureModel] });
    await userEvent.click(screen.getByRole("radio", { name: /codex/i }));
    await userEvent.type(screen.getByLabelText(/codex model/i), "gpt-future");
    await waitFor(() => expect(screen.getByLabelText(/reasoning effort/i)).toHaveValue(""));
    await userEvent.click(screen.getByRole("button", { name: /start session/i }));

    expect(api.createSession).toHaveBeenCalledWith({
      provider: "codex",
      cwd: "/work",
      options: { model: "gpt-future", sandbox: "workspace-write", approvalPolicy: "on-request" },
      mode: "terminal",
    });
  });

  test("keeps a successful session pending while presenting non-fatal create warnings", async () => {
    const api = makeApi({
      session: session("codex"),
      warnings: [{ code: "PROVIDER_METADATA_UNAVAILABLE", message: "Codex catalog unavailable" }],
    });
    const onCreated = vi.fn();
    const onClose = vi.fn();
    renderWizard({ api, onCreated, onClose });
    await userEvent.click(screen.getByRole("radio", { name: /codex/i }));
    await userEvent.click(screen.getByRole("button", { name: /start session/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/codex catalog unavailable/i);
    expect(onCreated).not.toHaveBeenCalled();
    expect(api.createSession).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("radio", { name: /claude code/i })).toBeDisabled();
    expect(screen.queryByRole("button", { name: /start session/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /cancel/i })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("radio", { name: /claude code/i }));
    await userEvent.keyboard("{Escape}");
    expect(onClose).not.toHaveBeenCalled();
    expect(api.createSession).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole("button", { name: /open session/i }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ id: "s-new" })));
    expect(api.createSession).toHaveBeenCalledTimes(1);
  });

  test("disables mutable wizard controls while session creation is in flight", async () => {
    let resolveCreate!: (result: Awaited<ReturnType<ApiClient["createSession"]>>) => void;
    const api = makeApi();
    const onClose = vi.fn();
    api.createSession = vi.fn(
      () =>
        new Promise<CreateSessionResponse>((resolve) => {
          resolveCreate = resolve;
        }),
    );
    renderWizard({ api, onClose });
    await userEvent.click(screen.getByRole("radio", { name: /codex/i }));
    await userEvent.click(screen.getByRole("button", { name: /start session/i }));

    expect(screen.getByRole("radio", { name: /codex/i })).toBeDisabled();
    expect(screen.getByLabelText(/session name/i)).toBeDisabled();
    expect(screen.getByRole("button", { name: /change directory/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /cancel/i })).toBeDisabled();
    await userEvent.keyboard("{Escape}");
    expect(onClose).not.toHaveBeenCalled();

    resolveCreate({ session: session("codex") });
    await waitFor(() => expect(api.createSession).toHaveBeenCalledTimes(1));
  });
});
