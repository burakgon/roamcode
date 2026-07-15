import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { NewSessionWizard } from "./NewSessionWizard";
import { ApiError, type ApiClient, type CreateSessionResponse } from "../api/client";
import type { CodexModel, ProviderSummaries } from "../providers/types";
import type { ModelInfo, SessionMeta } from "../types/server";
import type { SessionDefaults } from "../settings/defaults";

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

const claudeModels: ModelInfo[] = [
  {
    value: "claude-default",
    displayName: "Claude Default",
    isDefault: true,
    supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
  },
];

const defaults = { effort: "medium", dangerouslySkip: false } as const;

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
  models?: ModelInfo[];
  claudeMetadataState?: "loading" | "ready" | "unavailable";
  codexMetadataState?: "loading" | "ready" | "unavailable";
  onRetryProviderAvailability?: () => void;
  defaults?: SessionDefaults;
}) {
  const api = options?.api ?? makeApi();
  const onCreated = options?.onCreated ?? vi.fn();
  const result = render(
    <NewSessionWizard
      api={api}
      defaults={options?.defaults ?? defaults}
      recents={[]}
      initialCwd="/work"
      providerSummaries={options?.providerSummaries ?? providers}
      models={options?.models ?? claudeModels}
      codexModels={options?.codexModels ?? codexModels}
      claudeMetadataState={options?.claudeMetadataState}
      codexMetadataState={options?.codexMetadataState}
      codexProfiles={["personal", "work.secure"]}
      onRetryProviderAvailability={options?.onRetryProviderAvailability}
      onCreated={onCreated as (created: SessionMeta) => void}
      onClose={options?.onClose ?? vi.fn()}
    />,
  );
  return { ...result, api, onCreated };
}

function modelTrigger(provider: "Claude" | "Codex") {
  return screen.getByRole("button", { name: `${provider} model` });
}

async function selectModel(provider: "Claude" | "Codex", value: string) {
  await userEvent.click(modelTrigger(provider));
  const dialog = screen.getByRole("dialog", { name: /choose a model/i });
  const option = Array.from(dialog.querySelectorAll<HTMLButtonElement>("[data-model-value]")).find(
    (candidate) => candidate.dataset.modelValue === value,
  );
  expect(option).toBeDefined();
  await userEvent.click(option!);
}

function expectModel(provider: "Claude" | "Codex", value: string) {
  expect(modelTrigger(provider)).toHaveAttribute("data-model-value", value);
}

beforeEach(() => localStorage.clear());

describe("NewSessionWizard provider choice", () => {
  test("keeps long Codex settings inside the modal scroll container at 390x480 and restores page lock", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 480 });
    document.body.style.overflow = "auto";
    document.documentElement.scrollTop = 120;
    const { container, unmount } = renderWizard();
    await userEvent.click(screen.getByRole("radio", { name: /codex/i }));
    await userEvent.click(screen.getByText("Advanced"));

    const card = container.querySelector<HTMLElement>(".rc-wizard__card");
    const body = container.querySelector<HTMLElement>(".rc-wizard__body");
    expect(card).not.toBeNull();
    expect(body).not.toBeNull();

    const cardStyle = getComputedStyle(card!);
    const bodyStyle = getComputedStyle(body!);
    expect(cardStyle.display).toBe("flex");
    expect(cardStyle.flexDirection).toBe("column");
    expect(cardStyle.overflow).toBe("hidden");
    expect(cardStyle.maxHeight).toContain("100dvh");
    expect(bodyStyle.flexGrow).toBe("1");
    expect(bodyStyle.minHeight).toBe("0px");
    expect(bodyStyle.overflowY).toBe("auto");
    expect(bodyStyle.getPropertyValue("overscroll-behavior-y")).toBe("contain");
    expect(document.body.style.overflow).toBe("hidden");
    expect(document.documentElement.scrollTop).toBe(120);
    expect(Array.from(container.querySelectorAll("style"), (style) => style.textContent).join("\n")).toMatch(
      /\.rc-wizard__body\s*{[^}]*-webkit-overflow-scrolling:\s*touch;/,
    );
    unmount();
    expect(document.body.style.overflow).toBe("auto");
    expect(document.documentElement.scrollTop).toBe(120);
  });

  test("keeps the draft, refreshes metadata, and explains stale model compatibility", async () => {
    const retry = vi.fn();
    const api = makeApi();
    api.createSession = vi.fn(async () => {
      throw new ApiError(400, "Invalid Codex model or reasoning selection", "INVALID_PROVIDER_OPTIONS");
    });
    renderWizard({ api, onRetryProviderAvailability: retry });
    await userEvent.click(screen.getByRole("radio", { name: /codex/i }));
    await selectModel("Codex", "gpt-known");
    await userEvent.click(screen.getByRole("button", { name: /start session/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/catalog changed.*review.*model.*reasoning/i);
    expectModel("Codex", "gpt-known");
    expect(retry).toHaveBeenCalledTimes(1);
  });

  test("preserves Codex model and reasoning through loading and a successful catalog refresh", async () => {
    const api = makeApi({ session: session("codex") });
    const futureModel: CodexModel = {
      ...codexModels[0]!,
      value: "gpt-future",
      id: "gpt-future",
      displayName: "GPT Future",
      description: "Future account model.",
      reasoningOptions: [{ value: "future-depth", description: "Future depth.", isDefault: true }],
      supportedReasoningEfforts: ["future-depth"],
      defaultReasoningEffort: "future-depth",
    };
    const onCreated = vi.fn();
    function Wizard({ catalog, state }: { catalog: CodexModel[]; state: "loading" | "ready" | "unavailable" }) {
      return (
        <NewSessionWizard
          api={api}
          defaults={defaults}
          recents={[]}
          initialCwd="/work"
          models={claudeModels}
          providerSummaries={providers}
          codexModels={catalog}
          codexProfiles={["work.secure"]}
          codexMetadataState={state}
          onCreated={onCreated}
          onClose={vi.fn()}
        />
      );
    }
    const view = render(<Wizard catalog={[futureModel]} state="ready" />);
    await userEvent.click(screen.getByRole("radio", { name: /codex/i }));
    await selectModel("Codex", "gpt-future");
    expect(screen.getByLabelText(/reasoning effort/i)).toHaveValue("future-depth");

    view.rerender(<Wizard catalog={[]} state="loading" />);
    expectModel("Codex", "gpt-future");
    expect(screen.getByText("Future account model.")).toBeInTheDocument();
    expect(screen.getByLabelText(/reasoning effort/i)).toHaveValue("");
    expect(screen.getByLabelText(/reasoning effort/i)).toBeDisabled();

    view.rerender(
      <Wizard
        catalog={[
          {
            ...futureModel,
            reasoningOptions: [{ value: "high", description: "Refreshed high.", isDefault: true }],
            supportedReasoningEfforts: ["high"],
            defaultReasoningEffort: "high",
          },
        ]}
        state="ready"
      />,
    );
    expectModel("Codex", "gpt-future");
    expect(screen.getByLabelText(/reasoning effort/i)).toHaveValue("future-depth");
    expect(screen.getByRole("option", { name: /future-depth.*review required/i })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /high.*default/i })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(/future-depth.*no longer advertised.*review/i);
    await userEvent.click(screen.getByRole("button", { name: /start session/i }));

    expect(api.createSession).toHaveBeenCalledWith({
      provider: "codex",
      cwd: "/work",
      options: {
        model: "gpt-future",
        reasoningEffort: "future-depth",
        sandbox: "workspace-write",
        approvalPolicy: "on-request",
      },
      mode: "terminal",
    });
  });

  test("preserves Claude model and effort through loading, failure, and changed effort metadata", async () => {
    const api = makeApi();
    const futureModel: ModelInfo = {
      value: "claude-future",
      displayName: "Claude Future",
      description: "Future account model.",
      supportedEffortLevels: ["high", "future-depth"],
      isDefault: false,
    };
    function Wizard({ catalog, state }: { catalog: ModelInfo[]; state: "loading" | "ready" | "unavailable" }) {
      return (
        <NewSessionWizard
          api={api}
          defaults={defaults}
          recents={[]}
          initialCwd="/work"
          models={catalog}
          providerSummaries={providers}
          codexModels={codexModels}
          codexProfiles={[]}
          claudeMetadataState={state}
          onCreated={vi.fn()}
          onClose={vi.fn()}
        />
      );
    }
    const view = render(<Wizard catalog={[...claudeModels, futureModel]} state="ready" />);
    await userEvent.click(screen.getByRole("radio", { name: /claude code/i }));
    await selectModel("Claude", "claude-future");
    await userEvent.selectOptions(screen.getByLabelText(/^effort$/i), "future-depth");

    view.rerender(<Wizard catalog={[]} state="loading" />);
    expectModel("Claude", "claude-future");
    expect(screen.getByLabelText(/^effort$/i)).toHaveValue("");
    expect(screen.getByLabelText(/^effort$/i)).toBeDisabled();

    view.rerender(<Wizard catalog={[]} state="unavailable" />);
    expectModel("Claude", "claude-future");
    expect(screen.getByLabelText(/^effort$/i)).toHaveValue("");
    expect(screen.getByLabelText(/^effort$/i)).toBeDisabled();

    view.rerender(<Wizard catalog={[{ ...futureModel, supportedEffortLevels: ["high"] }]} state="ready" />);
    expectModel("Claude", "claude-future");
    expect(screen.getByLabelText(/^effort$/i)).toHaveValue("future-depth");
    expect(screen.getByRole("option", { name: /future-depth.*review required/i })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "High" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(/future-depth.*no longer advertised.*review/i);
    await userEvent.click(screen.getByRole("button", { name: /start session/i }));

    expect(api.createSession).toHaveBeenCalledWith({
      provider: "claude",
      cwd: "/work",
      options: { model: "claude-future", effort: "future-depth" },
      mode: "terminal",
    });
  });

  test("preserves blank-model Claude effort when the catalog default changes", async () => {
    const api = makeApi();
    const initialDefault: ModelInfo = {
      value: "claude-default-a",
      displayName: "Claude Default A",
      supportedEffortLevels: ["medium", "future-depth"],
      isDefault: true,
    };
    const refreshedDefault: ModelInfo = {
      value: "claude-default-b",
      displayName: "Claude Default B",
      supportedEffortLevels: ["high"],
      isDefault: true,
    };
    function Wizard({ catalog }: { catalog: ModelInfo[] }) {
      return (
        <NewSessionWizard
          api={api}
          defaults={defaults}
          recents={[]}
          initialCwd="/work"
          models={catalog}
          providerSummaries={providers}
          codexModels={codexModels}
          claudeMetadataState="ready"
          onCreated={vi.fn()}
          onClose={vi.fn()}
        />
      );
    }
    const view = render(<Wizard catalog={[initialDefault]} />);
    await userEvent.click(screen.getByRole("radio", { name: /claude code/i }));
    await userEvent.selectOptions(screen.getByLabelText(/^effort$/i), "future-depth");
    expectModel("Claude", "");

    view.rerender(<Wizard catalog={[refreshedDefault]} />);
    expectModel("Claude", "");
    expect(screen.getByLabelText(/^effort$/i)).toHaveValue("future-depth");
    expect(screen.getByRole("option", { name: /future-depth.*review required/i })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "High" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(/claude default b.*review/i);
    await userEvent.click(screen.getByRole("button", { name: /start session/i }));

    expect(api.createSession).toHaveBeenCalledWith({
      provider: "claude",
      cwd: "/work",
      options: { effort: "future-depth" },
      mode: "terminal",
    });
  });

  test("preserves blank-model Codex reasoning when the catalog default changes", async () => {
    const api = makeApi({ session: session("codex") });
    const initialDefault: CodexModel = {
      ...codexModels[0]!,
      value: "gpt-default-a",
      id: "gpt-default-a",
      displayName: "GPT Default A",
      reasoningOptions: [
        { value: "medium", description: "Medium.", isDefault: true },
        { value: "future-depth", description: "Future depth.", isDefault: false },
      ],
      supportedReasoningEfforts: ["medium", "future-depth"],
      defaultReasoningEffort: "medium",
    };
    const refreshedDefault: CodexModel = {
      ...codexModels[0]!,
      value: "gpt-default-b",
      id: "gpt-default-b",
      displayName: "GPT Default B",
      reasoningOptions: [{ value: "high", description: "High.", isDefault: true }],
      supportedReasoningEfforts: ["high"],
      defaultReasoningEffort: "high",
    };
    function Wizard({ catalog }: { catalog: CodexModel[] }) {
      return (
        <NewSessionWizard
          api={api}
          defaults={defaults}
          recents={[]}
          initialCwd="/work"
          models={claudeModels}
          providerSummaries={providers}
          codexModels={catalog}
          codexMetadataState="ready"
          onCreated={vi.fn()}
          onClose={vi.fn()}
        />
      );
    }
    const view = render(<Wizard catalog={[initialDefault]} />);
    await userEvent.click(screen.getByRole("radio", { name: /codex/i }));
    await userEvent.selectOptions(screen.getByLabelText(/reasoning effort/i), "future-depth");
    expectModel("Codex", "");

    view.rerender(<Wizard catalog={[refreshedDefault]} />);
    expectModel("Codex", "");
    expect(screen.getByLabelText(/reasoning effort/i)).toHaveValue("future-depth");
    expect(screen.getByRole("option", { name: /future-depth.*review required/i })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /high.*default/i })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(/gpt default b.*review/i);
    await userEvent.click(screen.getByRole("button", { name: /start session/i }));

    expect(api.createSession).toHaveBeenCalledWith({
      provider: "codex",
      cwd: "/work",
      options: {
        reasoningEffort: "future-depth",
        sandbox: "workspace-write",
        approvalPolicy: "on-request",
      },
      mode: "terminal",
    });
  });

  test("omits Claude effort for the provider-default model when metadata is unavailable", async () => {
    const api = makeApi();
    renderWizard({
      api,
      defaults: { effort: "high", dangerouslySkip: false },
      models: [],
      claudeMetadataState: "unavailable",
    });
    await userEvent.click(screen.getByRole("radio", { name: /claude code/i }));
    const effort = screen.getByLabelText(/^effort$/i);
    expect(effort).toHaveValue("");
    expect(effort).toBeDisabled();
    expect(within(effort).queryByRole("option", { name: "High" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /start session/i }));

    expect(api.createSession).toHaveBeenCalledWith({
      provider: "claude",
      cwd: "/work",
      options: {},
      mode: "terminal",
    });
  });

  test("omits Codex reasoning for the provider-default model when metadata is unavailable", async () => {
    const api = makeApi({ session: session("codex") });
    renderWizard({
      api,
      defaults: { effort: "medium", dangerouslySkip: false, codex: { reasoningEffort: "high" } },
      codexModels: [],
      codexMetadataState: "unavailable",
    });
    await userEvent.click(screen.getByRole("radio", { name: /codex/i }));
    const reasoning = screen.getByLabelText(/reasoning effort/i);
    expect(reasoning).toHaveValue("");
    expect(reasoning).toBeDisabled();
    expect(within(reasoning).queryByRole("option", { name: /^High/ })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /start session/i }));

    expect(api.createSession).toHaveBeenCalledWith({
      provider: "codex",
      cwd: "/work",
      options: { sandbox: "workspace-write", approvalPolicy: "on-request" },
      mode: "terminal",
    });
  });

  test("omits Claude effort for an unverifiable catalog model", async () => {
    const api = makeApi();
    renderWizard({ api, claudeMetadataState: "unavailable" });
    await userEvent.click(screen.getByRole("radio", { name: /claude code/i }));
    await selectModel("Claude", "claude-default");
    expect(screen.getByLabelText(/^effort$/i)).toHaveValue("");
    expect(screen.getByLabelText(/^effort$/i)).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: /start session/i }));

    expect(api.createSession).toHaveBeenCalledWith({
      provider: "claude",
      cwd: "/work",
      options: { model: "claude-default" },
      mode: "terminal",
    });
  });

  test("omits Codex reasoning for an unverifiable catalog model", async () => {
    const api = makeApi({ session: session("codex") });
    renderWizard({ api, codexMetadataState: "unavailable" });
    await userEvent.click(screen.getByRole("radio", { name: /codex/i }));
    await selectModel("Codex", "gpt-known");
    expect(screen.getByLabelText(/reasoning effort/i)).toHaveValue("");
    expect(screen.getByLabelText(/reasoning effort/i)).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: /start session/i }));

    expect(api.createSession).toHaveBeenCalledWith({
      provider: "codex",
      cwd: "/work",
      options: {
        model: "gpt-known",
        sandbox: "workspace-write",
        approvalPolicy: "on-request",
      },
      mode: "terminal",
    });
  });

  test("allows only a baseline Claude effort after explicit custom-model input without metadata", async () => {
    const api = makeApi();
    renderWizard({ api, models: [], claudeMetadataState: "unavailable" });
    await userEvent.click(screen.getByRole("radio", { name: /claude code/i }));
    await userEvent.click(screen.getByText("Advanced"));
    await userEvent.click(screen.getByRole("checkbox", { name: /use a custom claude model/i }));
    await userEvent.type(screen.getByRole("textbox", { name: /custom claude model/i }), "claude-custom");
    await userEvent.selectOptions(screen.getByLabelText(/^effort$/i), "high");
    await userEvent.click(screen.getByRole("button", { name: /start session/i }));

    expect(api.createSession).toHaveBeenCalledWith({
      provider: "claude",
      cwd: "/work",
      options: { model: "claude-custom", effort: "high" },
      mode: "terminal",
    });
  });

  test("allows only baseline Codex reasoning after explicit custom-model input without metadata", async () => {
    const api = makeApi({ session: session("codex") });
    renderWizard({ api, codexModels: [], codexMetadataState: "unavailable" });
    await userEvent.click(screen.getByRole("radio", { name: /codex/i }));
    await userEvent.click(screen.getByText("Advanced"));
    await userEvent.click(screen.getByRole("checkbox", { name: /use a custom codex model/i }));
    await userEvent.type(screen.getByRole("textbox", { name: /custom codex model/i }), "codex-custom");
    await userEvent.selectOptions(screen.getByLabelText(/reasoning effort/i), "xhigh");
    await userEvent.click(screen.getByRole("button", { name: /start session/i }));

    expect(api.createSession).toHaveBeenCalledWith({
      provider: "codex",
      cwd: "/work",
      options: {
        model: "codex-custom",
        reasoningEffort: "xhigh",
        sandbox: "workspace-write",
        approvalPolicy: "on-request",
      },
      mode: "terminal",
    });
  });

  test("omits a saved custom model's non-baseline Claude effort while metadata is loading", async () => {
    const api = makeApi();
    renderWizard({
      api,
      defaults: { effort: "future-depth", model: "saved-custom", dangerouslySkip: false },
      models: [],
      claudeMetadataState: "loading",
    });
    await userEvent.click(screen.getByRole("radio", { name: /claude code/i }));
    expect(screen.getByLabelText(/^effort$/i)).toHaveValue("");
    expect(screen.getByLabelText(/^effort$/i)).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: /start session/i }));

    expect(api.createSession).toHaveBeenCalledWith({
      provider: "claude",
      cwd: "/work",
      options: { model: "saved-custom" },
      mode: "terminal",
    });
  });

  test("omits a saved custom model's non-baseline Codex reasoning while metadata is loading", async () => {
    const api = makeApi({ session: session("codex") });
    renderWizard({
      api,
      defaults: {
        effort: "medium",
        dangerouslySkip: false,
        codex: { model: "saved-custom", reasoningEffort: "future-depth" },
      },
      codexModels: [],
      codexMetadataState: "loading",
    });
    await userEvent.click(screen.getByRole("radio", { name: /codex/i }));
    expect(screen.getByLabelText(/reasoning effort/i)).toHaveValue("");
    expect(screen.getByLabelText(/reasoning effort/i)).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: /start session/i }));

    expect(api.createSession).toHaveBeenCalledWith({
      provider: "codex",
      cwd: "/work",
      options: {
        model: "saved-custom",
        sandbox: "workspace-write",
        approvalPolicy: "on-request",
      },
      mode: "terminal",
    });
  });

  test("preselects the remembered provider for every wizard instance, including a prefilled folder", () => {
    const remembered = { ...defaults, provider: "codex" as const };
    const first = renderWizard({ defaults: remembered });
    expect(screen.getByRole("radio", { name: /claude code/i })).not.toBeChecked();
    expect(screen.getByRole("radio", { name: /codex/i })).toBeChecked();
    expect(screen.getByRole("button", { name: /start session/i })).toBeEnabled();
    first.unmount();

    renderWizard({ defaults: remembered });
    expect(screen.getByRole("radio", { name: /codex/i })).toBeChecked();
    expect(screen.getByRole("button", { name: /start session/i })).toBeEnabled();
  });

  test("captures server choices per mount and a fresh reopen uses the newly remembered launch", () => {
    const firstDefaults: SessionDefaults = {
      provider: "claude",
      effort: "high",
      model: "claude-default",
      permissionMode: "plan",
      dangerouslySkip: false,
      codex: {
        model: "gpt-known",
        reasoningEffort: "low",
        sandbox: "read-only",
        approvalPolicy: "never",
      },
    };
    const first = renderWizard({ defaults: firstDefaults });
    expect(screen.getByRole("radio", { name: /claude code/i })).toBeChecked();
    expect(screen.getByRole("radio", { name: /codex/i })).not.toBeChecked();
    expectModel("Claude", "claude-default");
    expect(screen.getByLabelText(/^effort$/i)).toHaveValue("high");
    expect(screen.getByLabelText(/permission mode/i)).toHaveValue("plan");
    first.unmount();

    const changedDefaults: SessionDefaults = {
      provider: "codex",
      effort: "low",
      dangerouslySkip: false,
      codex: {
        model: "gpt-known",
        reasoningEffort: "high",
        sandbox: "workspace-write",
        approvalPolicy: "on-request",
      },
    };
    renderWizard({ defaults: changedDefaults });
    expect(screen.getByRole("radio", { name: /claude code/i })).not.toBeChecked();
    expect(screen.getByRole("radio", { name: /codex/i })).toBeChecked();
    expectModel("Codex", "gpt-known");
    expect(screen.getByLabelText(/reasoning effort/i)).toHaveValue("high");
    expect(screen.getByLabelText(/^sandbox$/i)).toHaveValue("workspace-write");
    expect(screen.getByLabelText(/approval policy/i)).toHaveValue("on-request");
  });

  test("provider switching discards provider-specific in-memory option state", async () => {
    renderWizard();
    await userEvent.click(screen.getByRole("radio", { name: /claude code/i }));
    await userEvent.click(screen.getByText("Advanced"));
    await userEvent.click(screen.getByRole("checkbox", { name: /use a custom claude model/i }));
    await userEvent.type(screen.getByRole("textbox", { name: /custom claude model/i }), "claude-custom");
    await userEvent.click(screen.getByRole("radio", { name: /codex/i }));
    await userEvent.click(screen.getByText("Advanced"));
    await userEvent.click(screen.getByRole("checkbox", { name: /use a custom codex model/i }));
    await userEvent.type(screen.getByRole("textbox", { name: /custom codex model/i }), "vendor/gpt-next:preview");
    await userEvent.click(screen.getByRole("radio", { name: /claude code/i }));
    expectModel("Claude", "");
  });

  test("preserves Claude controls, naming, recents, and exact nested serialization", async () => {
    const { api, onCreated } = renderWizard();
    await userEvent.click(screen.getByRole("radio", { name: /claude code/i }));
    await userEvent.selectOptions(screen.getByLabelText(/effort/i), "high");
    await userEvent.click(screen.getByText("Advanced"));
    await userEvent.click(screen.getByRole("checkbox", { name: /use a custom claude model/i }));
    await userEvent.type(screen.getByRole("textbox", { name: /custom claude model/i }), "opus-custom");
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
    expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ id: "s-new" }), undefined);
    expect(JSON.parse(localStorage.getItem("rc-session-names")!)).toEqual({ "s-new": "Named session" });
    expect(JSON.parse(localStorage.getItem("roamcode.recents")!)).toEqual(["/work"]);
  });

  test("keeps Claude additional directories available for a one-off session", async () => {
    renderWizard();
    await userEvent.click(screen.getByRole("radio", { name: /claude code/i }));
    await userEvent.click(screen.getByText("Advanced"));

    expect(screen.getByLabelText(/additional directory path/i)).toBeInTheDocument();
    expect(screen.getByText(/additional directories/i)).toBeInTheDocument();
  });

  test("serializes bounded custom Codex options and excludes safety fields after dangerous confirmation", async () => {
    const api = makeApi({ session: session("codex") });
    renderWizard({ api });
    await userEvent.click(screen.getByRole("radio", { name: /codex/i }));
    await userEvent.click(screen.getByText("Advanced"));
    await userEvent.click(screen.getByRole("checkbox", { name: /use a custom codex model/i }));
    await userEvent.type(screen.getByRole("textbox", { name: /custom codex model/i }), "vendor/gpt-next:preview");
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

  test("preserves advertised future reasoning when a known Codex model uses an additive token", async () => {
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
    await selectModel("Codex", "gpt-future");
    await waitFor(() => expect(screen.getByLabelText(/reasoning effort/i)).toHaveValue("future-ultra"));
    await userEvent.click(screen.getByRole("button", { name: /start session/i }));

    expect(api.createSession).toHaveBeenCalledWith({
      provider: "codex",
      cwd: "/work",
      options: {
        model: "gpt-future",
        reasoningEffort: "future-ultra",
        sandbox: "workspace-write",
        approvalPolicy: "on-request",
      },
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
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ id: "s-new" }), undefined));
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
