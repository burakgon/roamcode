import { isAbsolute } from "node:path";
import { z, type ZodType } from "zod";
import {
  captureLaunchConfigFingerprint,
  listSecureProfileNames,
  resolveSecureCodexHome,
  sameLaunchConfigFingerprint,
} from "./codex-profile-security.js";
import { ProviderError, type CodexProfileLaunchProof } from "./types.js";
import { isCodexProfileClientLifecycle, type CodexProfileClientLifecycle } from "./codex-profile-client.js";
import type { ReadCodexThreadInventory } from "./codex-thread-resolver.js";

export const CODEX_METADATA_ERROR_CODE = "CODEX_METADATA_UNAVAILABLE" as const;
export const CODEX_MODEL_CATALOG_ERROR_CODE = "CODEX_MODEL_CATALOG_UNAVAILABLE" as const;
export const OSS_PROVIDER_DEFERRED = "OSS_PROVIDER_DEFERRED" as const;

const DEFAULT_MODEL_CACHE_TTL_MS = 60_000;
const DEFAULT_CAPABILITY_CACHE_TTL_MS = 60_000;
const DEFAULT_CAPABILITY_TIMEOUT_MS = 15_000;
const DEFAULT_LOGIN_TTL_MS = 10 * 60_000;
const DEFAULT_MAX_MODEL_PAGES = 20;
const DEFAULT_MAX_MODEL_ITEMS = 500;
const MODEL_PAGE_SIZE = 100;
const MAX_PROFILE_NAME = 128;
const MAX_LOGIN_ID = 256;
const MAX_USER_CODE = 256;
const MAX_URL = 2_048;
const MAX_CURSOR = 2_048;

export interface CodexMetadataRpc {
  request<T>(method: string, params: unknown, schema: ZodType<T>): Promise<T>;
  onNotification(listener: (notification: { method: string; params?: unknown }) => void): () => void;
  start?(): Promise<void>;
  stop?(): Promise<void>;
}

export interface CodexAccount {
  readonly authenticated: boolean;
  readonly authMethod: "none" | "apiKey" | "chatgpt";
  readonly plan?: string;
}

export interface CodexModel {
  readonly value: string;
  readonly id: string;
  readonly displayName: string;
  readonly description: string;
  readonly isDefault: boolean;
  readonly supportedReasoningEfforts: string[];
  readonly defaultReasoningEffort: string;
}

export interface CodexUsageBar {
  readonly id: string;
  readonly label: string;
  readonly percent: number;
  readonly resetsAt?: number;
  readonly windowDurationMs?: number;
}

export interface CodexUsage {
  readonly bars: CodexUsageBar[];
  readonly credits?: {
    readonly hasCredits: boolean;
    readonly unlimited: boolean;
    readonly balance?: string;
    readonly resetCreditsAvailable?: number;
  };
  readonly fetchedAt: number;
}

export type CodexLoginCompletion =
  | { readonly status: "completed" }
  | { readonly status: "failed" }
  | { readonly status: "canceled" }
  | { readonly status: "expired" };

export type CodexLoginStatus = CodexLoginCompletion | { readonly status: "pending" } | { readonly status: "notFound" };

export interface CodexDeviceLogin {
  readonly loginId: string;
  readonly userCode: string;
  readonly verificationUrl: string;
  readonly expiresAt: number;
  readonly completion: Promise<CodexLoginCompletion>;
}

export interface CodexMetadataServiceOptions {
  readonly now?: () => number;
  readonly loginTtlMs?: number;
  readonly modelCacheTtlMs?: number;
  readonly capabilityCacheTtlMs?: number;
  readonly capabilityTimeoutMs?: number;
  readonly maxModelPages?: number;
  readonly maxModelItems?: number;
  readonly codexHome?: string;
  readonly profileClient?: CodexProfileClientLifecycle;
}

export class CodexMetadataServiceError extends Error {
  readonly code = CODEX_METADATA_ERROR_CODE;

  constructor(message = "Codex metadata is unavailable") {
    super(message);
    this.name = "CodexMetadataServiceError";
  }
}

export class CodexModelCatalogError extends Error {
  readonly code = CODEX_MODEL_CATALOG_ERROR_CODE;

  constructor() {
    super("Codex model catalog is unavailable");
    this.name = "CodexModelCatalogError";
  }
}

export class CodexProfileCapabilityError extends Error {
  readonly code = OSS_PROVIDER_DEFERRED;

  constructor() {
    super("This Codex profile uses a provider that is not supported yet");
    this.name = "CodexProfileCapabilityError";
  }
}

const BoundedToken = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(value));
const ProfileToken = z
  .string()
  .min(1)
  .max(MAX_PROFILE_NAME)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
const CwdToken = z
  .string()
  .min(1)
  .max(4_096)
  .refine((value) => isAbsolute(value) && !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(value));

const AccountResponseSchema = z.object({
  account: z
    .union([
      z.object({ type: z.literal("apiKey") }),
      z.object({ type: z.literal("chatgpt"), email: z.string().nullable(), planType: z.string().min(1).max(128) }),
      z.object({ type: z.literal("amazonBedrock") }),
    ])
    .nullable(),
  requiresOpenaiAuth: z.boolean(),
});

const DeviceLoginResponseSchema = z.object({
  type: z.literal("chatgptDeviceCode"),
  loginId: z
    .string()
    .min(1)
    .max(MAX_LOGIN_ID)
    .refine((value) => !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(value)),
  userCode: z
    .string()
    .min(1)
    .max(MAX_USER_CODE)
    .refine((value) => !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(value)),
  verificationUrl: z
    .string()
    .url()
    .max(MAX_URL)
    .refine((value) => new URL(value).protocol === "https:"),
});

const LoginCompletedSchema = z.object({
  loginId: z.string().min(1).max(MAX_LOGIN_ID).nullable().optional(),
  success: z.boolean(),
  error: z.string().nullable().optional(),
});

const CancelLoginResponseSchema = z.object({ status: z.enum(["canceled", "notFound"]) });

const ReasoningOptionSchema = z.object({
  reasoningEffort: BoundedToken,
  description: z.string().max(4_096),
});

const ModelSchema = z.object({
  id: BoundedToken,
  model: BoundedToken,
  displayName: z.string().min(1).max(512),
  description: z.string().max(8_192),
  hidden: z.boolean(),
  isDefault: z.boolean(),
  supportedReasoningEfforts: z.array(ReasoningOptionSchema).min(1).max(32),
  defaultReasoningEffort: BoundedToken,
});

const ModelListResponseSchema = z.object({
  data: z.array(ModelSchema).max(DEFAULT_MAX_MODEL_ITEMS),
  nextCursor: z.string().min(1).max(MAX_CURSOR).nullable().optional(),
});

const RateLimitWindowSchema = z.object({
  usedPercent: z.number().int().safe(),
  resetsAt: z.number().int().safe().nonnegative().nullable().optional(),
  windowDurationMins: z.number().int().safe().nonnegative().nullable().optional(),
});

const CreditsSchema = z.object({
  hasCredits: z.boolean(),
  unlimited: z.boolean(),
  balance: z.string().max(256).nullable().optional(),
});

const RateLimitSnapshotSchema = z.object({
  limitId: z.string().min(1).max(256).nullable().optional(),
  limitName: z.string().min(1).max(256).nullable().optional(),
  primary: RateLimitWindowSchema.nullable().optional(),
  secondary: RateLimitWindowSchema.nullable().optional(),
  credits: CreditsSchema.nullable().optional(),
});

const RateLimitsResponseSchema = z.object({
  rateLimits: RateLimitSnapshotSchema,
  rateLimitsByLimitId: z.record(z.string().min(1).max(256), RateLimitSnapshotSchema).nullable().optional(),
  rateLimitResetCredits: z
    .object({
      availableCount: z.number().int().safe().nonnegative(),
      credits: z.array(z.unknown()).nullable().optional(),
    })
    .nullable()
    .optional(),
});

const ConfigReadResponseSchema = z.object({
  config: z.object({ model_provider: z.string().min(1).max(256).nullable().optional() }),
  origins: z.record(z.string(), z.unknown()),
});

interface ActiveLogin {
  readonly view: CodexDeviceLogin;
  readonly settle: (completion: CodexLoginCompletion) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  cancelPromise?: Promise<{ status: "canceled" | "notFound" }>;
  settled: boolean;
}

interface EarlyLoginCompletion {
  readonly completion: CodexLoginCompletion;
  readonly generation: number;
  readonly at: number;
}

interface LoginOutcome {
  readonly completion: CodexLoginCompletion;
  readonly at: number;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function cloneModels(models: readonly CodexModel[]): CodexModel[] {
  return models.map((model) => ({ ...model, supportedReasoningEfforts: [...model.supportedReasoningEfforts] }));
}

function metadataUnavailable(): CodexMetadataServiceError {
  return new CodexMetadataServiceError();
}

function catalogUnavailable(): CodexModelCatalogError {
  return new CodexModelCatalogError();
}

function safeMilliseconds(value: number, multiplier: number): number | undefined {
  const result = value * multiplier;
  return Number.isSafeInteger(result) ? result : undefined;
}

export class CodexMetadataService {
  private readonly now: () => number;
  private readonly loginTtlMs: number;
  private readonly modelCacheTtlMs: number;
  private readonly capabilityCacheTtlMs: number;
  private readonly capabilityTimeoutMs: number;
  private readonly maxModelPages: number;
  private readonly maxModelItems: number;
  private readonly codexHome?: string;
  private readonly profileClient?: CodexProfileClientLifecycle;
  private readonly activeLogins = new Map<string, ActiveLogin>();
  private readonly earlyLoginCompletions = new Map<string, EarlyLoginCompletion>();
  private readonly retiredLoginIds = new Map<string, number>();
  private readonly loginOutcomes = new Map<string, LoginOutcome>();
  private activeStartGeneration?: number;
  private nextStartGeneration = 1;
  private startingLogin?: Promise<CodexDeviceLogin>;
  private modelCache?: { at: number; models: readonly CodexModel[] };
  private modelRequest?: Promise<readonly CodexModel[]>;
  private lastUsageDiagnostic?: { code: typeof CODEX_METADATA_ERROR_CODE; message: string };
  private lastCapabilityDiagnostic?: { code: typeof CODEX_METADATA_ERROR_CODE; message: string };
  private capabilityCache?: { at: number; cwd: string; available: boolean };
  private capabilityRequest?: { cwd: string; request: Promise<boolean> };
  private readonly unsubscribeNotification: () => void;
  private disposed = false;

  constructor(
    private readonly rpc: CodexMetadataRpc,
    options: CodexMetadataServiceOptions = {},
  ) {
    this.now = options.now ?? (() => Date.now());
    this.loginTtlMs = positiveInteger(options.loginTtlMs, DEFAULT_LOGIN_TTL_MS);
    this.modelCacheTtlMs = positiveInteger(options.modelCacheTtlMs, DEFAULT_MODEL_CACHE_TTL_MS);
    this.capabilityCacheTtlMs = positiveInteger(options.capabilityCacheTtlMs, DEFAULT_CAPABILITY_CACHE_TTL_MS);
    this.capabilityTimeoutMs = positiveInteger(options.capabilityTimeoutMs, DEFAULT_CAPABILITY_TIMEOUT_MS);
    this.maxModelPages = positiveInteger(options.maxModelPages, DEFAULT_MAX_MODEL_PAGES);
    this.maxModelItems = positiveInteger(options.maxModelItems, DEFAULT_MAX_MODEL_ITEMS);
    this.codexHome = options.codexHome;
    this.profileClient = options.profileClient;
    this.unsubscribeNotification = this.rpc.onNotification((notification) => this.onNotification(notification));
  }

  get diagnostics(): {
    readonly usage?: { readonly code: typeof CODEX_METADATA_ERROR_CODE; readonly message: string };
    readonly capabilities?: { readonly code: typeof CODEX_METADATA_ERROR_CODE; readonly message: string };
  } {
    return {
      ...(this.lastUsageDiagnostic ? { usage: { ...this.lastUsageDiagnostic } } : {}),
      ...(this.lastCapabilityDiagnostic ? { capabilities: { ...this.lastCapabilityDiagnostic } } : {}),
    };
  }

  async probeCapabilities(cwd: string, readThreadInventory: ReadCodexThreadInventory): Promise<boolean> {
    if (this.disposed || !CwdToken.safeParse(cwd).success || typeof readThreadInventory !== "function") return false;
    const now = this.now();
    if (this.capabilityCache?.cwd === cwd && now - this.capabilityCache.at < this.capabilityCacheTtlMs) {
      return this.capabilityCache.available;
    }
    if (this.capabilityRequest?.cwd === cwd) return this.capabilityRequest.request;

    const request = this.loadCapabilities(cwd, readThreadInventory);
    this.capabilityRequest = { cwd, request };
    try {
      const available = await request;
      this.capabilityCache = { at: this.now(), cwd, available };
      return available;
    } finally {
      if (this.capabilityRequest?.request === request) this.capabilityRequest = undefined;
    }
  }

  private async loadCapabilities(cwd: string, readThreadInventory: ReadCodexThreadInventory): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const [, , usage, , threads] = await Promise.race([
        Promise.all([
          this.getAccount(),
          this.getModels(),
          this.getUsage(),
          this.rpc.request("config/read", { cwd, includeLayers: false }, ConfigReadResponseSchema),
          readThreadInventory(),
        ]),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(metadataUnavailable()), this.capabilityTimeoutMs);
          (timer as NodeJS.Timeout).unref?.();
        }),
      ]);
      if (usage === null || !Array.isArray(threads)) throw metadataUnavailable();
      this.lastCapabilityDiagnostic = undefined;
      return true;
    } catch {
      this.lastCapabilityDiagnostic = {
        code: CODEX_METADATA_ERROR_CODE,
        message: "Codex metadata capabilities are unavailable",
      };
      return false;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async getAccount(): Promise<CodexAccount> {
    let response: z.infer<typeof AccountResponseSchema>;
    try {
      response = await this.rpc.request("account/read", { refreshToken: false }, AccountResponseSchema);
    } catch {
      throw metadataUnavailable();
    }
    if (response.account?.type === "apiKey") return { authenticated: true, authMethod: "apiKey" };
    if (response.account?.type === "chatgpt") {
      return { authenticated: true, authMethod: "chatgpt", plan: response.account.planType };
    }
    return { authenticated: false, authMethod: "none" };
  }

  startDeviceLogin(): Promise<CodexDeviceLogin> {
    if (this.disposed) return Promise.reject(metadataUnavailable());
    if (this.startingLogin) return this.startingLogin;
    const existing = this.activeLogins.values().next().value as ActiveLogin | undefined;
    if (existing) return Promise.resolve(existing.view);

    const generation = this.nextStartGeneration++;
    this.activeStartGeneration = generation;
    const request = this.rpc
      .request("account/login/start", { type: "chatgptDeviceCode" }, DeviceLoginResponseSchema)
      .then((response) => this.installLogin(response, generation))
      .catch(() => {
        throw metadataUnavailable();
      });
    this.startingLogin = request;
    void request.then(
      () => {
        if (this.startingLogin === request) this.finishStartGeneration(generation);
      },
      () => {
        if (this.startingLogin === request) this.finishStartGeneration(generation);
      },
    );
    return request;
  }

  cancelLogin(loginId: string): Promise<{ status: "canceled" | "notFound" }> {
    if (!DeviceLoginResponseSchema.shape.loginId.safeParse(loginId).success) {
      return Promise.reject(metadataUnavailable());
    }
    const active = this.activeLogins.get(loginId);
    if (!active || active.settled) return Promise.resolve({ status: "notFound" });
    if (active.cancelPromise) return active.cancelPromise;

    const request = this.rpc
      .request("account/login/cancel", { loginId }, CancelLoginResponseSchema)
      .then((response) => {
        if (response.status === "canceled" || response.status === "notFound") {
          this.settleLogin(loginId, { status: "canceled" });
        }
        return response;
      })
      .catch(() => {
        if (active.cancelPromise === request) active.cancelPromise = undefined;
        throw metadataUnavailable();
      });
    active.cancelPromise = request;
    return request;
  }

  getLoginStatus(loginId: string): CodexLoginStatus {
    if (!DeviceLoginResponseSchema.shape.loginId.safeParse(loginId).success) throw metadataUnavailable();
    const active = this.activeLogins.get(loginId);
    if (active && !active.settled) return { status: "pending" };
    this.pruneLoginOutcomes();
    return this.loginOutcomes.get(loginId)?.completion ?? { status: "notFound" };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribeNotification();
    this.earlyLoginCompletions.clear();
    for (const loginId of [...this.activeLogins.keys()]) {
      this.settleLogin(loginId, { status: "canceled" });
      void this.rpc.request("account/login/cancel", { loginId }, CancelLoginResponseSchema).catch(() => {});
    }
  }

  async getModels(force = false): Promise<CodexModel[]> {
    const now = this.now();
    if (!force && this.modelCache && now - this.modelCache.at < this.modelCacheTtlMs) {
      return cloneModels(this.modelCache.models);
    }
    if (this.modelRequest) return cloneModels(await this.modelRequest);

    const request = this.loadModels();
    this.modelRequest = request;
    try {
      const models = await request;
      this.modelCache = { at: this.now(), models: cloneModels(models) };
      return cloneModels(models);
    } finally {
      if (this.modelRequest === request) this.modelRequest = undefined;
    }
  }

  async validateModelSelection(model: string, reasoningEffort?: string): Promise<void> {
    const models = await this.getModels();
    const selected = models.find((candidate) => candidate.value === model);
    // Codex intentionally accepts bounded custom model identifiers not advertised by the current catalog.
    // The parser remains the trust boundary for token shape/length; only a KNOWN model can prove an effort
    // incompatible and be rejected here.
    if (!selected) return;
    if (reasoningEffort !== undefined && !selected.supportedReasoningEfforts.includes(reasoningEffort)) {
      throw new ProviderError("INVALID_PROVIDER_OPTIONS", "Invalid Codex model and reasoning selection");
    }
  }

  async getUsage(): Promise<CodexUsage | null> {
    try {
      const response = await this.rpc.request("account/rateLimits/read", {}, RateLimitsResponseSchema);
      const bars: CodexUsageBar[] = [];
      this.appendSnapshotBars(bars, response.rateLimits);
      const primaryId = response.rateLimits.limitId;
      for (const [id, snapshot] of Object.entries(response.rateLimitsByLimitId ?? {})) {
        if (id === primaryId || snapshot.limitId === primaryId) continue;
        this.appendSnapshotBars(bars, { ...snapshot, limitId: snapshot.limitId ?? id });
      }

      const credits = response.rateLimits.credits;
      const resetCreditsAvailable = response.rateLimitResetCredits?.availableCount;
      const normalizedCredits =
        credits || resetCreditsAvailable !== undefined
          ? {
              hasCredits: credits?.hasCredits ?? false,
              unlimited: credits?.unlimited ?? false,
              ...(credits?.balance ? { balance: credits.balance } : {}),
              ...(resetCreditsAvailable !== undefined ? { resetCreditsAvailable } : {}),
            }
          : undefined;
      this.lastUsageDiagnostic = undefined;
      return {
        bars,
        ...(normalizedCredits ? { credits: normalizedCredits } : {}),
        fetchedAt: this.now(),
      };
    } catch {
      this.lastUsageDiagnostic = {
        code: CODEX_METADATA_ERROR_CODE,
        message: "Codex usage is unavailable",
      };
      return null;
    }
  }

  async listProfiles(): Promise<string[]> {
    try {
      const home = await resolveSecureCodexHome(this.codexHome);
      if (!home) return [];
      return await listSecureProfileNames(home, (profile) => ProfileToken.safeParse(profile).success);
    } catch {
      return [];
    }
  }

  readonly validateProfile = async (profile: string, cwd: string): Promise<CodexProfileLaunchProof> => {
    if (!ProfileToken.safeParse(profile).success || !CwdToken.safeParse(cwd).success) {
      throw new ProviderError("INVALID_PROVIDER_OPTIONS", "Invalid Codex profile selection");
    }
    const codexHome = await resolveSecureCodexHome(this.codexHome);
    const before = codexHome ? await captureLaunchConfigFingerprint(codexHome, profile) : undefined;
    if (!codexHome || !before) {
      throw new ProviderError("INVALID_PROVIDER_OPTIONS", "Invalid Codex profile selection");
    }
    if (!isCodexProfileClientLifecycle(this.profileClient)) throw new CodexProfileCapabilityError();

    const response = await this.readProfileConfig(profile, codexHome, cwd);
    const after = await captureLaunchConfigFingerprint(codexHome, profile);
    if (!sameLaunchConfigFingerprint(before, after) || response.config.model_provider !== "openai") {
      throw new CodexProfileCapabilityError();
    }

    return {
      profile,
      codexHome,
      assertUnchanged: async () => {
        const currentHome = await resolveSecureCodexHome(this.codexHome);
        if (currentHome !== codexHome) throw new CodexProfileCapabilityError();
        const finalResponse = await this.readProfileConfig(profile, codexHome, cwd);
        const current = await captureLaunchConfigFingerprint(codexHome, profile);
        if (!sameLaunchConfigFingerprint(before, current) || finalResponse.config.model_provider !== "openai") {
          throw new CodexProfileCapabilityError();
        }
      },
    };
  };

  private async readProfileConfig(
    profile: string,
    codexHome: string,
    cwd: string,
  ): Promise<z.infer<typeof ConfigReadResponseSchema>> {
    try {
      return await this.profileClient!.readConfig(profile, codexHome, cwd, ConfigReadResponseSchema);
    } catch {
      throw new CodexProfileCapabilityError();
    }
  }

  private installLogin(response: z.infer<typeof DeviceLoginResponseSchema>, generation: number): CodexDeviceLogin {
    if (this.disposed) {
      void this.rpc
        .request("account/login/cancel", { loginId: response.loginId }, CancelLoginResponseSchema)
        .catch(() => {});
      throw metadataUnavailable();
    }
    this.pruneRetiredLoginIds();
    if (this.retiredLoginIds.has(response.loginId)) throw metadataUnavailable();
    const expiresAt = this.now() + this.loginTtlMs;
    let settle!: (completion: CodexLoginCompletion) => void;
    const completion = new Promise<CodexLoginCompletion>((resolve) => {
      settle = resolve;
    });
    const view: CodexDeviceLogin = {
      loginId: response.loginId,
      userCode: response.userCode,
      verificationUrl: response.verificationUrl,
      expiresAt,
      completion,
    };
    const timer = setTimeout(() => this.expireLogin(response.loginId), this.loginTtlMs);
    (timer as NodeJS.Timeout).unref?.();
    const active: ActiveLogin = { view, settle, timer, settled: false };
    this.activeLogins.set(response.loginId, active);
    const early = this.earlyLoginCompletions.get(response.loginId);
    if (early && early.generation === generation && this.now() - early.at <= this.loginTtlMs) {
      this.earlyLoginCompletions.delete(response.loginId);
      this.settleLogin(response.loginId, early.completion);
    }
    return view;
  }

  private onNotification(notification: { method: string; params?: unknown }): void {
    if (notification.method !== "account/login/completed") return;
    const parsed = LoginCompletedSchema.safeParse(notification.params);
    if (!parsed.success || !parsed.data.loginId) return;
    const completion: CodexLoginCompletion = parsed.data.success ? { status: "completed" } : { status: "failed" };
    if (this.activeLogins.has(parsed.data.loginId)) {
      this.settleLogin(parsed.data.loginId, completion);
      return;
    }
    if (this.activeStartGeneration === undefined) return;
    this.pruneEarlyLoginCompletions();
    this.pruneRetiredLoginIds();
    if (this.retiredLoginIds.has(parsed.data.loginId)) return;
    if (this.earlyLoginCompletions.size >= 16) {
      const oldest = this.earlyLoginCompletions.keys().next().value as string | undefined;
      if (oldest) {
        this.earlyLoginCompletions.delete(oldest);
        this.retireLoginId(oldest);
      }
    }
    this.earlyLoginCompletions.set(parsed.data.loginId, {
      completion,
      generation: this.activeStartGeneration,
      at: this.now(),
    });
  }

  private settleLogin(loginId: string, completion: CodexLoginCompletion): void {
    const active = this.activeLogins.get(loginId);
    if (!active || active.settled) return;
    active.settled = true;
    clearTimeout(active.timer);
    this.activeLogins.delete(loginId);
    this.recordLoginOutcome(loginId, completion);
    this.retireLoginId(loginId);
    active.settle(completion);
  }

  private finishStartGeneration(generation: number): void {
    this.startingLogin = undefined;
    if (this.activeStartGeneration === generation) this.activeStartGeneration = undefined;
    for (const [loginId, early] of this.earlyLoginCompletions) {
      if (early.generation !== generation) continue;
      this.earlyLoginCompletions.delete(loginId);
      this.retireLoginId(loginId);
    }
  }

  private retireLoginId(loginId: string): void {
    this.retiredLoginIds.delete(loginId);
    this.retiredLoginIds.set(loginId, this.now());
    this.pruneRetiredLoginIds();
    while (this.retiredLoginIds.size > 64) {
      const oldest = this.retiredLoginIds.keys().next().value as string | undefined;
      if (!oldest) break;
      this.retiredLoginIds.delete(oldest);
    }
  }

  private pruneEarlyLoginCompletions(): void {
    for (const [loginId, early] of this.earlyLoginCompletions) {
      if (this.now() - early.at <= this.loginTtlMs) continue;
      this.earlyLoginCompletions.delete(loginId);
      this.retireLoginId(loginId);
    }
  }

  private pruneRetiredLoginIds(): void {
    const oldestAllowed = this.now() - this.loginTtlMs;
    for (const [loginId, retiredAt] of this.retiredLoginIds) {
      if (retiredAt >= oldestAllowed) continue;
      this.retiredLoginIds.delete(loginId);
    }
  }

  private recordLoginOutcome(loginId: string, completion: CodexLoginCompletion): void {
    this.loginOutcomes.delete(loginId);
    this.loginOutcomes.set(loginId, { completion, at: this.now() });
    this.pruneLoginOutcomes();
    while (this.loginOutcomes.size > 64) {
      const oldest = this.loginOutcomes.keys().next().value as string | undefined;
      if (!oldest) break;
      this.loginOutcomes.delete(oldest);
    }
  }

  private pruneLoginOutcomes(): void {
    const oldestAllowed = this.now() - this.loginTtlMs;
    for (const [loginId, outcome] of this.loginOutcomes) {
      if (outcome.at >= oldestAllowed) continue;
      this.loginOutcomes.delete(loginId);
    }
  }

  private expireLogin(loginId: string): void {
    const active = this.activeLogins.get(loginId);
    if (!active || active.settled) return;
    this.settleLogin(loginId, { status: "expired" });
    void this.rpc.request("account/login/cancel", { loginId }, CancelLoginResponseSchema).catch(() => {
      // Expiry is already fail-closed locally; protocol diagnostics remain redacted by the client.
    });
  }

  private async loadModels(): Promise<readonly CodexModel[]> {
    const seenCursors = new Set<string>();
    const seenModels = new Set<string>();
    const models: CodexModel[] = [];
    let advertisedItems = 0;
    let cursor: string | null = null;
    try {
      for (let page = 0; page < this.maxModelPages; page += 1) {
        const response: z.infer<typeof ModelListResponseSchema> = await this.rpc.request(
          "model/list",
          { cursor, includeHidden: false, limit: MODEL_PAGE_SIZE },
          ModelListResponseSchema,
        );
        advertisedItems += response.data.length;
        if (advertisedItems > this.maxModelItems) throw catalogUnavailable();
        for (const advertised of response.data) {
          const efforts = advertised.supportedReasoningEfforts.map((option) => option.reasoningEffort);
          if (new Set(efforts).size !== efforts.length || !efforts.includes(advertised.defaultReasoningEffort)) {
            throw catalogUnavailable();
          }
          if (advertised.hidden || seenModels.has(advertised.model)) continue;
          seenModels.add(advertised.model);
          models.push({
            value: advertised.model,
            id: advertised.id,
            displayName: advertised.displayName,
            description: advertised.description,
            isDefault: advertised.isDefault,
            supportedReasoningEfforts: efforts,
            defaultReasoningEffort: advertised.defaultReasoningEffort,
          });
        }
        const next: string | null = response.nextCursor ?? null;
        if (next === null) return models;
        if (seenCursors.has(next)) throw catalogUnavailable();
        seenCursors.add(next);
        cursor = next;
      }
    } catch {
      throw catalogUnavailable();
    }
    throw catalogUnavailable();
  }

  private appendSnapshotBars(bars: CodexUsageBar[], snapshot: z.infer<typeof RateLimitSnapshotSchema>): void {
    const windows = [["primary", snapshot.primary] as const, ["secondary", snapshot.secondary] as const].filter(
      (entry): entry is readonly ["primary" | "secondary", z.infer<typeof RateLimitWindowSchema>] => Boolean(entry[1]),
    );
    for (const [kind, window] of windows) {
      const baseId = snapshot.limitId;
      const id = baseId ? `${baseId}:${kind}` : kind;
      const rawBaseLabel = snapshot.limitName ?? snapshot.limitId;
      const baseLabel = rawBaseLabel ? `${rawBaseLabel[0]!.toUpperCase()}${rawBaseLabel.slice(1)}` : undefined;
      const windowLabel = kind === "primary" ? "Primary" : "Secondary";
      const label = baseLabel ? (windows.length === 1 ? baseLabel : `${baseLabel} ${windowLabel}`) : windowLabel;
      const resetsAt =
        window.resetsAt === null || window.resetsAt === undefined
          ? undefined
          : safeMilliseconds(window.resetsAt, 1_000);
      const windowDurationMs =
        window.windowDurationMins === null || window.windowDurationMins === undefined
          ? undefined
          : safeMilliseconds(window.windowDurationMins, 60_000);
      if (
        (window.resetsAt !== null && window.resetsAt !== undefined && resetsAt === undefined) ||
        (window.windowDurationMins !== null &&
          window.windowDurationMins !== undefined &&
          windowDurationMs === undefined)
      ) {
        throw metadataUnavailable();
      }
      bars.push({
        id,
        label,
        percent: Math.max(0, Math.min(100, window.usedPercent)),
        ...(resetsAt !== undefined ? { resetsAt } : {}),
        ...(windowDurationMs !== undefined ? { windowDurationMs } : {}),
      });
    }
  }
}
