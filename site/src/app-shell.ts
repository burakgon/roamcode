import "./app-shell.css";
import {
  ChevronRight,
  CircleAlert,
  CircleCheck,
  CircleX,
  Cpu,
  Mail,
  SquareTerminal,
  Workflow,
  X,
  createIcons,
} from "lucide";
import {
  CLOSED_PRODUCT_LAUNCH_CAPABILITIES,
  fetchProductLaunchCapabilities,
  type ProductLaunchCapabilities,
} from "./product-capabilities";

type ProductRoute = "sessions" | "automations" | "agents" | "account" | "people" | "activate" | "invite" | "reset";
type AuthMode = "sign-in" | "sign-up" | "reset-request";
type CloudIconName =
  | "chevron-right"
  | "circle-alert"
  | "circle-check"
  | "circle-x"
  | "cpu"
  | "mail"
  | "square-terminal"
  | "workflow"
  | "x";

const CLOUD_ICONS = {
  ChevronRight,
  CircleAlert,
  CircleCheck,
  CircleX,
  Cpu,
  Mail,
  SquareTerminal,
  Workflow,
  X,
};

function cloudIcon(name: CloudIconName): string {
  return `<i data-lucide="${name}" aria-hidden="true"></i>`;
}

function hydrateCloudIcons(root: Element | Document | DocumentFragment): void {
  createIcons({
    root,
    icons: CLOUD_ICONS,
    attrs: { "stroke-width": 1.8 },
  });
}

interface AccountUser {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  image?: string | null;
}

interface AccountSession {
  user: AccountUser;
  session: { id: string; expiresAt?: string };
}

interface AuthProviders {
  email_password: boolean;
  passkey: boolean;
  github: boolean;
  google: boolean;
  mode?: "local_dev" | "self_hosted";
}

interface CloudContext {
  id: string;
  kind: "personal" | "organization";
  slug: string;
  name: string;
  plan: "free" | "enterprise";
  role: "owner" | "admin" | "member" | "viewer";
}

interface AccountBootstrap {
  user: Pick<AccountUser, "id" | "name" | "email">;
  contexts: CloudContext[];
}

interface OrganizationCreation {
  organization: {
    id: string;
    kind: "organization";
    slug: string;
    name: string;
    plan: "free" | "enterprise";
  };
}

interface Member {
  organizationId: string;
  userId: string;
  role: "owner" | "admin" | "member" | "viewer";
  status: "active" | "suspended";
  name: string;
  email: string;
  joinedAt: string;
}

interface OrganizationInvite {
  id: string;
  organizationId: string;
  email: string;
  role: "owner" | "admin" | "member" | "viewer";
  status: "pending" | "accepted" | "revoked" | "expired";
  expiresAt: string;
  createdAt: string;
}

interface OrganizationInviteCreation {
  invite?: OrganizationInvite;
  invite_url?: string;
}

interface OrganizationGrant {
  id: string;
  organizationId: string;
  principalUserId: string;
  hostId: string | null;
  workspaceId: string | null;
  permission: "view" | "use" | "manage";
  expiresAt: string | null;
  createdAt: string;
}

interface OrganizationAccessRequest {
  id: string;
  organizationId: string;
  requesterUserId: string;
  hostId: string | null;
  workspaceId: string | null;
  permission: "view" | "use" | "manage";
  reason: string;
  status: "pending" | "approved" | "denied" | "cancelled";
  reviewedBy: string | null;
  reviewNote: string | null;
  createdAt: string;
  reviewedAt: string | null;
}

interface OrganizationHostAccess {
  hostId: string;
  effectivePermission: "use" | "manage" | null;
  grantExpiresAt: string | null;
  latestRequest: null | Pick<
    OrganizationAccessRequest,
    "id" | "permission" | "status" | "reason" | "reviewNote" | "createdAt" | "reviewedAt"
  >;
}

interface CloudHost {
  id: string;
  organizationId: string;
  name: string;
  slug: string;
  status: "provisioning" | "offline" | "online" | "revoked" | "failed";
  tokenVersion: number;
  provisioningSagaId: string;
  agentVersion: string | null;
  lastSeenAt: string | null;
  createdAt: string;
  heartbeatState?: "ready" | "draining" | null;
  capabilities?: string[];
}

interface HostStatus {
  host: CloudHost;
  relay: null | {
    status: { hostOnline: boolean; activeDevices: number };
    route: { id: string; label: string; deviceCount: number };
    connection: { path: "/v1/connect"; protocolVersion: 1 };
  };
}

interface CloudDevice {
  id: string;
  organizationId: string;
  organizationName: string;
  name: string;
  platform: string;
  clientId: string;
  scopes: string[];
  lastSeenAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

interface ManagedHostDevice {
  id: string;
  organizationId: string;
  organizationName: string;
  hostId: string;
  hostName: string;
  actorId: string;
  label: string;
  pairedBy: string;
  pairedAt: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
}

interface LegalDocument {
  id: string;
  documentType: "terms" | "privacy" | "aup" | "dpa";
  version: string;
  publicUrl: string;
  effectiveAt: string;
}

interface DeviceInspection {
  client: { id: string; name: string };
  device: { name: string; platform: string };
  scopes: string[];
  expires_at: string;
  warning: string;
}

interface CloudApiErrorBody {
  error?: unknown;
  error_description?: unknown;
  code?: unknown;
  message?: unknown;
}

class CloudApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = "CloudApiError";
  }
}

class CloudApi {
  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    let response: Response;
    try {
      response = await fetch(path, {
        ...init,
        credentials: "include",
        headers: {
          accept: "application/json",
          ...(init.body === undefined ? {} : { "content-type": "application/json" }),
          ...Object.fromEntries(new Headers(init.headers)),
        },
      });
    } catch {
      throw new CloudApiError(0, "network_error", "RoamCode Cloud could not be reached. Check your connection.");
    }
    if (response.status === 204) return undefined as T;
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = undefined;
    }
    if (!response.ok) {
      const error = (body ?? {}) as CloudApiErrorBody;
      const code =
        typeof error.error === "string" ? error.error : typeof error.code === "string" ? error.code : undefined;
      const message =
        typeof error.error_description === "string"
          ? error.error_description
          : typeof error.message === "string"
            ? error.message
            : `Request failed (${response.status})`;
      throw new CloudApiError(response.status, code, message);
    }
    if (body === undefined) {
      throw new CloudApiError(response.status, "invalid_response", "The account service returned an invalid response.");
    }
    return body as T;
  }

  get<T>(path: string, init: RequestInit = {}): Promise<T> {
    return this.request<T>(path, init);
  }

  post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>(path, { method: "POST", body: JSON.stringify(body) });
  }

  patch<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>(path, { method: "PATCH", body: JSON.stringify(body) });
  }

  delete<T>(path: string): Promise<T> {
    return this.request<T>(path, { method: "DELETE" });
  }
}

const api = new CloudApi();
const CONTEXT_KEY = "roamcode.cloud.context.v1";
const INVITE_KEY = "roamcode.cloud.pending-invite.v1";
const RESET_KEY = "roamcode.cloud.pending-password-reset.v1";
const NODE_COMMANDS = {
  login: "roamcode cloud login",
  connect: 'roamcode cloud connect --label "Workstation"',
} as const;

export function isAccountShellPath(pathname: string): boolean {
  const normalized = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  return new Set([
    "/app",
    "/app/sessions",
    "/app/automations",
    "/app/agents",
    "/app/account",
    "/app/people",
    "/app/reset-password",
    "/activate",
    "/device",
    "/invite",
  ]).has(normalized);
}

function routeFromPath(pathname: string): ProductRoute {
  const normalized = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  if (normalized === "/activate" || normalized === "/device") return "activate";
  if (normalized === "/invite") return "invite";
  if (normalized === "/app/agents") return "agents";
  if (normalized === "/app/automations") return "automations";
  if (normalized === "/app/account") return "account";
  if (normalized === "/app/people") return "people";
  if (normalized === "/app/reset-password") return "reset";
  return "sessions";
}

function routePath(route: ProductRoute): string {
  if (route === "activate") return "/activate";
  if (route === "invite") return "/invite";
  if (route === "reset") return "/app/reset-password";
  return `/app/${route}`;
}

export function accountAuthReturnUrl(route: ProductRoute, activationCode: string, origin: string): string {
  const path =
    route === "activate" || route === "invite"
      ? routePath(route)
      : route === "sessions" || route === "reset"
        ? "/app"
        : routePath(route);
  const url = new URL(path, origin);
  // External identity redirects reload the page. Preserve the public user code so the
  // verification_uri_complete journey remains one click without ever exposing the device secret.
  if (route === "activate" && activationCode) url.searchParams.set("user_code", activationCode);
  return url.toString();
}

function consumeRequestedAuthMode(): AuthMode {
  const params = new URLSearchParams(location.search);
  const mode: AuthMode = params.get("mode") === "sign-up" ? "sign-up" : "sign-in";
  if (!params.has("mode")) return mode;
  params.delete("mode");
  const query = params.toString();
  history.replaceState(history.state, "", `${location.pathname}${query ? `?${query}` : ""}${location.hash}`);
  return mode;
}

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function displayDate(value: string | null | undefined): string {
  if (!value) return "Never";
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "Unknown";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return (parts[0]?.[0] ?? "R") + (parts.length > 1 ? (parts.at(-1)?.[0] ?? "") : "");
}

function organizationSlug(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replaceAll("ı", "i")
    .replaceAll("ş", "s")
    .replaceAll("ğ", "g")
    .replaceAll("ç", "c")
    .replaceAll("ö", "o")
    .replaceAll("ü", "u")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63)
    .replace(/-+$/g, "");
}

function safeStorage(storage: Storage, action: "get" | "set" | "remove", key: string, value?: string): string | null {
  try {
    if (action === "get") return storage.getItem(key);
    if (action === "set" && value !== undefined) storage.setItem(key, value);
    if (action === "remove") storage.removeItem(key);
  } catch {
    // The account shell remains usable in private/locked-down browser modes.
  }
  return null;
}

function base64UrlToBytes(value: string): ArrayBuffer {
  const binary = atob(
    value
      .replaceAll("-", "+")
      .replaceAll("_", "/")
      .padEnd(Math.ceil(value.length / 4) * 4, "="),
  );
  return Uint8Array.from(binary, (character) => character.charCodeAt(0)).buffer;
}

function bytesToBase64Url(value: ArrayBuffer): string {
  const bytes = new Uint8Array(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function publicKeyRequestOptions(value: unknown): PublicKeyCredentialRequestOptions {
  const envelope = value as { publicKey?: Record<string, unknown> } & Record<string, unknown>;
  const source = (envelope.publicKey ?? envelope) as Record<string, unknown>;
  return {
    ...(source as unknown as PublicKeyCredentialRequestOptions),
    challenge: base64UrlToBytes(String(source.challenge ?? "")),
    ...(Array.isArray(source.allowCredentials)
      ? {
          allowCredentials: source.allowCredentials.map((credential) => {
            const record = credential as PublicKeyCredentialDescriptor & { id: string };
            return { ...record, id: base64UrlToBytes(record.id) };
          }),
        }
      : {}),
  };
}

function publicKeyCreationOptions(value: unknown): PublicKeyCredentialCreationOptions {
  const envelope = value as { publicKey?: Record<string, unknown> } & Record<string, unknown>;
  const source = (envelope.publicKey ?? envelope) as Record<string, unknown>;
  const user = source.user as { id: string } & Record<string, unknown>;
  return {
    ...(source as unknown as PublicKeyCredentialCreationOptions),
    challenge: base64UrlToBytes(String(source.challenge ?? "")),
    user: { ...(user as unknown as PublicKeyCredentialUserEntity), id: base64UrlToBytes(user.id) },
    ...(Array.isArray(source.excludeCredentials)
      ? {
          excludeCredentials: source.excludeCredentials.map((credential) => {
            const record = credential as PublicKeyCredentialDescriptor & { id: string };
            return { ...record, id: base64UrlToBytes(record.id) };
          }),
        }
      : {}),
  };
}

function serializeCredential(credential: PublicKeyCredential): Record<string, unknown> {
  const response = credential.response;
  const base = {
    id: credential.id,
    rawId: bytesToBase64Url(credential.rawId),
    type: credential.type,
    clientExtensionResults: credential.getClientExtensionResults(),
    authenticatorAttachment: credential.authenticatorAttachment,
  };
  if (response instanceof AuthenticatorAssertionResponse) {
    return {
      ...base,
      response: {
        clientDataJSON: bytesToBase64Url(response.clientDataJSON),
        authenticatorData: bytesToBase64Url(response.authenticatorData),
        signature: bytesToBase64Url(response.signature),
        userHandle: response.userHandle ? bytesToBase64Url(response.userHandle) : null,
      },
    };
  }
  const registration = response as AuthenticatorAttestationResponse;
  return {
    ...base,
    response: {
      clientDataJSON: bytesToBase64Url(registration.clientDataJSON),
      attestationObject: bytesToBase64Url(registration.attestationObject),
      transports: registration.getTransports?.() ?? [],
    },
  };
}

function browserSupportsPasskeys(): boolean {
  return (
    typeof PublicKeyCredential !== "undefined" &&
    typeof navigator.credentials?.get === "function" &&
    typeof navigator.credentials?.create === "function"
  );
}

function readAuthProviders(value: unknown): AuthProviders | undefined {
  if (!value || typeof value !== "object") return;
  const provider = value as Record<string, unknown>;
  if (
    typeof provider.email_password !== "boolean" ||
    typeof provider.passkey !== "boolean" ||
    typeof provider.github !== "boolean" ||
    typeof provider.google !== "boolean"
  ) {
    return;
  }
  const mode = provider.mode;
  return {
    email_password: provider.email_password,
    passkey: provider.passkey,
    github: provider.github,
    google: provider.google,
    ...(mode === "local_dev" || mode === "self_hosted" ? { mode } : {}),
  };
}

function readSameOriginInviteUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 4096) return;
  try {
    const url = new URL(value, location.origin);
    if (url.origin !== location.origin || url.pathname !== "/invite" || !url.searchParams.has("token")) return;
    return url.toString();
  } catch {
    return;
  }
}

function safeDocumentUrl(value: string): string | undefined {
  try {
    const url = new URL(value, location.origin);
    if (url.protocol === "https:" || (url.protocol === "http:" && url.origin === location.origin)) {
      return url.toString();
    }
  } catch {
    // Invalid control-plane data is rendered as unavailable instead of becoming a navigation target.
  }
  return;
}

class AccountShell {
  private readonly root: HTMLElement;
  private route = routeFromPath(location.pathname);
  private authMode: AuthMode;
  private providers: AuthProviders = {
    email_password: false,
    passkey: false,
    github: false,
    google: false,
    mode: "local_dev",
  };
  private providerCapabilitiesLoaded = false;
  private productLaunch: ProductLaunchCapabilities = CLOSED_PRODUCT_LAUNCH_CAPABILITIES;
  private session?: AccountSession;
  private contexts: CloudContext[] = [];
  private context?: CloudContext;
  private membership?: Member;
  private members: Member[] = [];
  private membersState: "idle" | "loading" | "ready" | "error" = "idle";
  private membersError?: string;
  private invites: OrganizationInvite[] = [];
  private invitesState: "idle" | "loading" | "ready" | "error" = "idle";
  private invitesError?: string;
  private grants: OrganizationGrant[] = [];
  private grantsState: "idle" | "loading" | "ready" | "error" = "idle";
  private grantsError?: string;
  private accessRequests: OrganizationAccessRequest[] = [];
  private accessRequestsState: "idle" | "loading" | "ready" | "error" = "idle";
  private accessRequestsError?: string;
  private hosts: CloudHost[] = [];
  private hostStatuses = new Map<string, HostStatus>();
  private hostAccess = new Map<string, OrganizationHostAccess>();
  private hostAccessState: "idle" | "loading" | "ready" | "error" = "idle";
  private hostAccessError?: string;
  private hostInventoryState: "idle" | "loading" | "ready" | "error" = "idle";
  private hostInventoryError?: string;
  private cloudDevices: CloudDevice[] = [];
  private cloudDevicesState: "idle" | "loading" | "ready" | "error" = "idle";
  private cloudDevicesError?: string;
  private pendingDeviceRevocationId?: string;
  private managedHostDevices: ManagedHostDevice[] = [];
  private managedHostDevicesState: "idle" | "loading" | "ready" | "error" = "idle";
  private managedHostDevicesError?: string;
  private pendingManagedHostDeviceRevocationId?: string;
  private pendingMemberRemovalId?: string;
  private pendingInviteRevocationId?: string;
  private oneTimeInviteUrl?: string;
  private pendingGrantRevocationId?: string;
  private legalDocuments: LegalDocument[] = [];
  private activationCode = new URLSearchParams(location.search).get("user_code")?.trim().toUpperCase() ?? "";
  private deviceInspection?: DeviceInspection;
  private activationComplete?: "approved" | "denied";
  private inviteToken?: string;
  private resetToken?: string;
  private inviteComplete = false;
  private pendingVerificationEmail?: string;
  private busy?: string;
  private error?: string;
  private notice?: string;
  private booted = false;
  private contextLoaded = false;
  private contextLoadGeneration = 0;
  private contextLoadController?: AbortController;
  private peopleLoadGeneration = 0;
  private peopleLoadController?: AbortController;
  private accountLoadGeneration = 0;
  private organizationDialogOpen = false;
  private organizationDraft = { name: "", slug: "" };
  private organizationSlugEdited = false;

  constructor() {
    this.authMode = consumeRequestedAuthMode();
    document.documentElement.classList.add("rc-account-mode");
    document.body.replaceChildren();
    this.root = document.createElement("div");
    this.root.id = "account-shell";
    document.body.append(this.root);
    this.captureInviteToken();
    this.captureResetToken();
    this.root.addEventListener("click", (event) => void this.onClick(event));
    this.root.addEventListener("submit", (event) => void this.onSubmit(event));
    this.root.addEventListener("change", (event) => void this.onChange(event));
    this.root.addEventListener("input", (event) => this.onInput(event));
    window.addEventListener("popstate", () => void this.onPopState());
    window.addEventListener("online", () => this.render());
    window.addEventListener("offline", () => this.render());
  }

  async start(): Promise<void> {
    this.render();
    await this.bootstrap();
  }

  private captureInviteToken(): void {
    if (this.route !== "invite") return;
    const params = new URLSearchParams(location.search);
    const token = params.get("token");
    if (token) {
      this.inviteToken = token;
      safeStorage(sessionStorage, "set", INVITE_KEY, token);
      params.delete("token");
      const query = params.toString();
      history.replaceState(history.state, "", `${location.pathname}${query ? `?${query}` : ""}${location.hash}`);
      return;
    }
    this.inviteToken = safeStorage(sessionStorage, "get", INVITE_KEY) ?? undefined;
  }

  private captureResetToken(): void {
    if (this.route !== "reset") return;
    const params = new URLSearchParams(location.search);
    const token = params.get("token");
    if (token) {
      this.resetToken = token;
      safeStorage(sessionStorage, "set", RESET_KEY, token);
      params.delete("token");
      const query = params.toString();
      history.replaceState(history.state, "", `${location.pathname}${query ? `?${query}` : ""}${location.hash}`);
      return;
    }
    this.resetToken = safeStorage(sessionStorage, "get", RESET_KEY) ?? undefined;
  }

  private async bootstrap(): Promise<void> {
    this.busy = "bootstrap";
    this.error = undefined;
    this.render();
    try {
      const [providerResult, productLaunchResult, sessionResult] = await Promise.allSettled([
        api.get<AuthProviders>("/api/v1/meta/providers"),
        fetchProductLaunchCapabilities(),
        api.get<AccountSession | null>("/api/auth/get-session"),
      ]);
      if (sessionResult.status === "rejected") throw sessionResult.reason;
      this.session = sessionResult.value ?? undefined;
      this.productLaunch =
        productLaunchResult.status === "fulfilled" ? productLaunchResult.value : CLOSED_PRODUCT_LAUNCH_CAPABILITIES;
      if (!this.productLaunch.account && this.authMode === "sign-up") this.authMode = "sign-in";
      const providerCapabilities =
        providerResult.status === "fulfilled" ? readAuthProviders(providerResult.value) : undefined;
      if (providerCapabilities) {
        this.providers = providerCapabilities;
        this.providerCapabilitiesLoaded = true;
      } else if (!this.session) {
        throw providerResult.status === "rejected"
          ? providerResult.reason
          : new Error("The account service returned invalid sign-in capabilities.");
      }
      if (this.session && this.productLaunch.account) await this.loadAccountBootstrap();
      this.booted = true;
      this.busy = undefined;
      this.render();
      if (this.session && this.productLaunch.account && this.route === "activate" && this.activationCode)
        await this.inspectActivation();
      if (this.session && this.productLaunch.account && this.route === "account") await this.loadAccountData();
      if (this.session && this.productLaunch.account && this.route === "people") await this.loadPeopleData();
    } catch (caught) {
      this.booted = true;
      this.busy = undefined;
      this.error = this.message(caught, "The account shell could not be loaded.");
      this.render();
    }
  }

  private async loadAccountBootstrap(preferredContextId?: string): Promise<void> {
    if (!this.productLaunch.account) return;
    const response = await api.post<AccountBootstrap>("/api/v1/account/bootstrap", {});
    if (!response.user || !Array.isArray(response.contexts)) {
      throw new Error("The account service returned an invalid bootstrap response.");
    }
    if (this.session) this.session = { ...this.session, user: { ...this.session.user, ...response.user } };
    this.contexts = response.contexts;
    const queryContext = new URLSearchParams(location.search).get("context");
    const remembered = safeStorage(localStorage, "get", CONTEXT_KEY);
    const selected = preferredContextId ?? queryContext ?? remembered;
    this.context = this.contexts.find((candidate) => candidate.id === selected) ?? this.contexts[0];
    if (this.context) {
      safeStorage(localStorage, "set", CONTEXT_KEY, this.context.id);
      await this.loadContext(this.context.id);
    } else {
      this.contextLoaded = true;
    }
  }

  private async loadContext(organizationId: string): Promise<void> {
    if (!this.productLaunch.account) return;
    const generation = ++this.contextLoadGeneration;
    this.contextLoadController?.abort();
    this.peopleLoadGeneration += 1;
    this.peopleLoadController?.abort();
    const controller = new AbortController();
    this.contextLoadController = controller;
    const selectedContext = this.contexts.find((candidate) => candidate.id === organizationId);
    const shouldLoadMembers =
      selectedContext?.kind === "organization" &&
      (selectedContext.role === "owner" || selectedContext.role === "admin");
    this.contextLoaded = false;
    this.hosts = [];
    this.members = [];
    this.membersState = shouldLoadMembers ? "loading" : "idle";
    this.membersError = undefined;
    this.membership = undefined;
    this.invites = [];
    this.invitesState = "idle";
    this.invitesError = undefined;
    this.grants = [];
    this.grantsState = "idle";
    this.grantsError = undefined;
    this.accessRequests = [];
    this.accessRequestsState = "idle";
    this.accessRequestsError = undefined;
    this.pendingMemberRemovalId = undefined;
    this.pendingInviteRevocationId = undefined;
    this.oneTimeInviteUrl = undefined;
    this.pendingGrantRevocationId = undefined;
    this.hostStatuses.clear();
    this.hostAccess.clear();
    const shouldLoadManagedAccess = selectedContext?.kind === "organization" && this.productLaunch.managedTerminal;
    this.hostAccessState = shouldLoadManagedAccess ? "loading" : "ready";
    this.hostAccessError = undefined;
    this.hostInventoryState = "loading";
    this.hostInventoryError = undefined;
    this.error = undefined;
    this.render();
    const [hostsResult, membersResult, accessResult] = await Promise.allSettled([
      api.get<{ hosts: CloudHost[] }>(`/api/v1/orgs/${encodeURIComponent(organizationId)}/hosts`, {
        signal: controller.signal,
      }),
      shouldLoadMembers
        ? api.get<{ members: Member[] }>(`/api/v1/orgs/${encodeURIComponent(organizationId)}/members`, {
            signal: controller.signal,
          })
        : Promise.resolve(undefined),
      shouldLoadManagedAccess
        ? api.get<{ access: OrganizationHostAccess[] }>(`/api/v1/orgs/${encodeURIComponent(organizationId)}/access`, {
            signal: controller.signal,
          })
        : Promise.resolve(undefined),
    ]);
    if (generation !== this.contextLoadGeneration || controller.signal.aborted || this.context?.id !== organizationId)
      return;
    const hosts = hostsResult.status === "fulfilled" ? hostsResult.value.hosts : [];
    const members = membersResult.status === "fulfilled" && membersResult.value ? membersResult.value.members : [];
    const membership = members.find((member) => member.userId === this.session?.user.id);
    const hostError =
      hostsResult.status === "rejected"
        ? this.message(hostsResult.reason, "Node inventory could not be loaded.")
        : undefined;
    const statuses = await Promise.allSettled(
      hosts.map((host) =>
        api.get<HostStatus>(`/api/v1/hosts/${encodeURIComponent(host.id)}/status`, {
          signal: controller.signal,
        }),
      ),
    );
    if (generation !== this.contextLoadGeneration || controller.signal.aborted || this.context?.id !== organizationId)
      return;
    const hostStatuses = new Map<string, HostStatus>();
    statuses.forEach((result, index) => {
      const host = hosts[index];
      if (host && result.status === "fulfilled") hostStatuses.set(host.id, result.value);
    });
    this.hosts = hosts;
    this.members = members;
    this.membersState = !shouldLoadMembers ? "idle" : membersResult.status === "fulfilled" ? "ready" : "error";
    this.membersError =
      shouldLoadMembers && membersResult.status === "rejected"
        ? this.message(membersResult.reason, "Member roster could not be loaded.")
        : undefined;
    this.membership = membership;
    this.hostStatuses = hostStatuses;
    this.hostAccess = new Map(
      accessResult.status === "fulfilled" && accessResult.value
        ? accessResult.value.access.map((access) => [access.hostId, access])
        : [],
    );
    this.hostAccessState = !shouldLoadManagedAccess ? "ready" : accessResult.status === "fulfilled" ? "ready" : "error";
    this.hostAccessError =
      shouldLoadManagedAccess && accessResult.status === "rejected"
        ? this.message(accessResult.reason, "Your Node access could not be loaded.")
        : undefined;
    this.hostInventoryState = hostError ? "error" : "ready";
    this.hostInventoryError = hostError;
    this.contextLoaded = true;
    this.render();
  }

  private async loadAccountData(): Promise<void> {
    if (!this.session || !this.productLaunch.account) return;
    const generation = ++this.accountLoadGeneration;
    this.cloudDevicesState = "loading";
    this.cloudDevicesError = undefined;
    this.managedHostDevicesState = this.productLaunch.managedTerminal ? "loading" : "ready";
    this.managedHostDevicesError = undefined;
    this.render();
    const loadCliDevices = api
      .get<{ devices: CloudDevice[] }>("/api/v1/auth/devices")
      .then((response) => {
        if (generation !== this.accountLoadGeneration) return;
        this.cloudDevices = response.devices;
        this.cloudDevicesState = "ready";
        if (
          this.pendingDeviceRevocationId &&
          !this.cloudDevices.some((device) => device.id === this.pendingDeviceRevocationId && !device.revokedAt)
        ) {
          this.pendingDeviceRevocationId = undefined;
        }
        this.render();
      })
      .catch((caught: unknown) => {
        if (generation !== this.accountLoadGeneration) return;
        this.cloudDevicesState = "error";
        this.cloudDevicesError = this.message(caught, "Cloud device status could not be loaded.");
        this.render();
      });
    const loadManagedHostDevices = this.productLaunch.managedTerminal
      ? api
          .get<{ devices: ManagedHostDevice[] }>("/api/v1/account/host-devices")
          .then((response) => {
            if (generation !== this.accountLoadGeneration) return;
            this.managedHostDevices = response.devices;
            this.managedHostDevicesState = "ready";
            if (
              this.pendingManagedHostDeviceRevocationId &&
              !this.managedHostDevices.some(
                (device) => device.id === this.pendingManagedHostDeviceRevocationId && !device.revokedAt,
              )
            ) {
              this.pendingManagedHostDeviceRevocationId = undefined;
            }
            this.render();
          })
          .catch((caught: unknown) => {
            if (generation !== this.accountLoadGeneration) return;
            this.managedHostDevicesState = "error";
            this.managedHostDevicesError = this.message(caught, "Managed browser access could not be loaded.");
            this.render();
          })
      : Promise.resolve();
    const loadDocuments = api
      .get<{ documents: LegalDocument[] }>("/api/v1/legal/documents")
      .then((response) => {
        if (generation !== this.accountLoadGeneration) return;
        this.legalDocuments = response.documents;
        this.render();
      })
      .catch(() => {
        // Public legal routes remain available even if account metadata is temporarily unavailable.
      });
    await Promise.all([loadCliDevices, loadManagedHostDevices, loadDocuments]);
  }

  private async reloadManagedHostDevices(): Promise<void> {
    if (!this.session || !this.productLaunch.managedTerminal) return;
    const generation = this.accountLoadGeneration;
    this.managedHostDevicesState = "loading";
    this.managedHostDevicesError = undefined;
    this.render();
    try {
      const response = await api.get<{ devices: ManagedHostDevice[] }>("/api/v1/account/host-devices");
      if (generation !== this.accountLoadGeneration) return;
      this.managedHostDevices = response.devices;
      this.managedHostDevicesState = "ready";
      if (
        this.pendingManagedHostDeviceRevocationId &&
        !this.managedHostDevices.some(
          (device) => device.id === this.pendingManagedHostDeviceRevocationId && !device.revokedAt,
        )
      ) {
        this.pendingManagedHostDeviceRevocationId = undefined;
      }
    } catch (caught) {
      if (generation !== this.accountLoadGeneration) return;
      this.managedHostDevicesState = "error";
      this.managedHostDevicesError = this.message(caught, "Managed browser access could not be loaded.");
    }
    this.render();
  }

  private async loadPeopleData(): Promise<void> {
    const context = this.context;
    if (!context || !this.canManagePeople()) return;
    const organizationId = context.id;
    const generation = ++this.peopleLoadGeneration;
    this.peopleLoadController?.abort();
    const controller = new AbortController();
    this.peopleLoadController = controller;
    this.invitesState = "loading";
    this.invitesError = undefined;
    this.grantsState = "loading";
    this.grantsError = undefined;
    this.accessRequestsState = "loading";
    this.accessRequestsError = undefined;
    this.render();
    const [invitesResult, grantsResult, accessRequestsResult] = await Promise.allSettled([
      api.get<{ invites: OrganizationInvite[] }>(`/api/v1/orgs/${encodeURIComponent(organizationId)}/invites`, {
        signal: controller.signal,
      }),
      api.get<{ grants: OrganizationGrant[] }>(`/api/v1/orgs/${encodeURIComponent(organizationId)}/grants`, {
        signal: controller.signal,
      }),
      api.get<{ access_requests: OrganizationAccessRequest[] }>(
        `/api/v1/orgs/${encodeURIComponent(organizationId)}/access-requests`,
        { signal: controller.signal },
      ),
    ]);
    if (generation !== this.peopleLoadGeneration || controller.signal.aborted || this.context?.id !== organizationId)
      return;
    if (invitesResult.status === "fulfilled") {
      this.invites = invitesResult.value.invites;
      this.invitesState = "ready";
    } else {
      this.invitesState = "error";
      this.invitesError = this.message(invitesResult.reason, "Invitations could not be loaded.");
    }
    if (grantsResult.status === "fulfilled") {
      this.grants = grantsResult.value.grants;
      this.grantsState = "ready";
    } else {
      this.grantsState = "error";
      this.grantsError = this.message(grantsResult.reason, "Node grants could not be loaded.");
    }
    if (accessRequestsResult.status === "fulfilled") {
      this.accessRequests = accessRequestsResult.value.access_requests;
      this.accessRequestsState = "ready";
    } else {
      this.accessRequestsState = "error";
      this.accessRequestsError = this.message(accessRequestsResult.reason, "Access requests could not be loaded.");
    }
    this.render();
  }

  private async refreshPeopleData(): Promise<void> {
    const context = this.context;
    if (!context || !this.canManagePeople()) return;
    await this.loadContext(context.id);
    if (this.route === "people") await this.loadPeopleData();
  }

  private isContextAdmin(): boolean {
    const role = this.membership?.role ?? this.context?.role;
    return role === "owner" || role === "admin";
  }

  private canManagePeople(): boolean {
    return this.context?.kind === "organization" && this.isContextAdmin();
  }

  private message(caught: unknown, fallback: string): string {
    return caught instanceof Error && caught.message ? caught.message : fallback;
  }

  private clearFeedback(): void {
    this.error = undefined;
    this.notice = undefined;
  }

  private render(): void {
    const offline = navigator.onLine === false;
    const feedback = `${offline ? `<div class="rc-cloud-banner rc-cloud-banner--offline" role="status">Offline — account data may be stale.</div>` : ""}${
      this.error
        ? `<div class="rc-cloud-toast rc-cloud-toast--error" role="alert"><span>${escapeHtml(this.error)}</span><button type="button" data-action="dismiss-feedback" aria-label="Dismiss">${cloudIcon("x")}</button></div>`
        : this.notice
          ? `<div class="rc-cloud-toast" role="status"><span>${escapeHtml(this.notice)}</span><button type="button" data-action="dismiss-feedback" aria-label="Dismiss">${cloudIcon("x")}</button></div>`
          : ""
    }`;
    this.root.innerHTML = `<div class="rc-account-app">${feedback}${this.renderContent()}</div>`;
    hydrateCloudIcons(this.root);
    document.title = `${this.pageTitle()} — RoamCode`;
    if (this.organizationDialogOpen) {
      const dialog = this.root.querySelector<HTMLDialogElement>("#organization-dialog");
      if (dialog) {
        try {
          if (!dialog.open) dialog.showModal();
        } catch {
          dialog.setAttribute("open", "");
        }
        dialog.addEventListener("cancel", (event) => {
          event.preventDefault();
          if (this.busy === "create-organization") return;
          this.organizationDialogOpen = false;
          this.render();
        });
        queueMicrotask(() => dialog.querySelector<HTMLInputElement>('input[name="name"]')?.focus());
      }
    }
  }

  private renderContent(): string {
    if (!this.booted || this.busy === "bootstrap") return this.renderBoot();
    if (this.route === "reset") return this.renderResetPassword();
    if (!this.session) return this.renderAuth();
    if (!this.session.user.emailVerified && this.providers.mode !== "self_hosted")
      return this.renderEmailVerification();
    if (!this.productLaunch.account) return this.renderHostedProductUnavailable();
    if (this.route === "invite") return this.renderInvite();
    if (this.contexts.length === 0) return this.renderContextRecovery();
    if (this.route === "activate") return this.renderDeviceActivation();
    return this.renderProductShell();
  }

  private renderBoot(): string {
    return `<main class="rc-cloud-centered" aria-busy="true"><div class="rc-cloud-loader" aria-hidden="true"></div><p>Opening your RoamCode control plane…</p></main>`;
  }

  private renderHostedProductUnavailable(): string {
    return `<main class="rc-cloud-centered"><a class="rc-cloud-brand" href="/" aria-label="RoamCode home"><span>${cloudIcon("chevron-right")}</span> roamcode<small>.ai</small></a><section class="rc-cloud-focus-card" aria-labelledby="hosted-product-title"><div class="rc-cloud-kicker">Hosted product status</div><h1 id="hosted-product-title">Hosted product unavailable</h1><p>This control plane has not advertised a compatible RoamCode account product. Your existing identity session remains available, but Organizations, Nodes, and managed terminal enrollment stay closed.</p><div class="rc-cloud-warning" role="status">Nothing has been inferred from older or unknown API responses. Try again after the account service and site are on compatible versions.</div><div class="rc-cloud-consent-actions"><button class="rc-cloud-button" type="button" data-action="retry-bootstrap" ${this.busy ? "disabled" : ""}>Check again</button><button class="rc-cloud-button rc-cloud-button--primary" type="button" data-action="sign-out" ${this.busy ? "disabled" : ""}>${this.busy === "sign-out" ? "Signing out…" : "Sign out"}</button></div><div class="rc-cloud-focus-footer"><span>${escapeHtml(this.session?.user.email)}</span><a class="rc-cloud-link-button" href="/">Use self-hosted RoamCode</a></div></section></main>`;
  }

  private authReturnUrl(): string {
    return accountAuthReturnUrl(this.route, this.activationCode, location.origin);
  }

  private renderAuth(): string {
    const accountCreationEnabled = this.productLaunch.account;
    const authMode = !accountCreationEnabled && this.authMode === "sign-up" ? "sign-in" : this.authMode;
    const passkeyAvailable = this.providers.passkey && browserSupportsPasskeys();
    const externalAccountCreation = accountCreationEnabled && authMode === "sign-up" && !this.providers.email_password;
    const anyProvider =
      this.providers.email_password || this.providers.github || this.providers.google || passkeyAvailable;
    const contextualTitle =
      this.route === "activate"
        ? "Sign in to approve this device"
        : this.route === "invite"
          ? "Sign in to accept your invitation"
          : externalAccountCreation
            ? "Continue to RoamCode"
            : authMode === "sign-up"
              ? "Create your RoamCode account"
              : authMode === "reset-request"
                ? "Reset your password"
                : "Welcome back";
    const contextualCopy =
      this.route === "activate"
        ? "Your CLI is waiting. Sign in, inspect the exact scopes, then approve or deny it."
        : this.route === "invite"
          ? "Your invitation stays in this tab while you authenticate."
          : !accountCreationEnabled
            ? "Existing identity and account-recovery routes remain available. Hosted Organizations, Nodes, and enrollment are not enabled by this control plane."
            : externalAccountCreation
              ? "Choose one of the sign-in methods configured by this installation."
              : "One account for your organizations and Nodes. Source code and terminal output stay off the account service.";
    const selfHostedRecovery = this.providers.mode === "self_hosted";
    const emailForm = !this.providerCapabilitiesLoaded
      ? `<div class="rc-cloud-state-card"><span class="rc-cloud-state-icon">${cloudIcon("circle-alert")}</span><strong>Account service unavailable</strong><p>RoamCode could not verify which sign-in methods are enabled.</p><button type="button" class="rc-cloud-button" data-action="retry-bootstrap">Try again</button></div>`
      : !this.providers.email_password
        ? ""
        : authMode === "reset-request"
          ? `<form class="rc-cloud-form" data-form="reset-request"><label>Email<input name="email" type="email" autocomplete="email" required /></label>${selfHostedRecovery ? `<div class="rc-cloud-warning" role="note">This self-hosted installation writes recovery messages to an operator-only file outbox. Ask your operator to deliver the link after you submit this request.</div>` : ""}<button class="rc-cloud-button rc-cloud-button--primary" type="submit" ${this.busy ? "disabled" : ""}>${this.busy === "reset-request" ? "Requesting…" : "Request recovery link"}</button></form>`
          : `<form class="rc-cloud-form" data-form="auth" data-mode="${authMode}">
            ${authMode === "sign-up" ? `<label>Name<input name="name" autocomplete="name" maxlength="120" required /></label>` : ""}
            <label>Email<input name="email" type="email" autocomplete="email" required /></label>
            <label>Password<input name="password" type="password" autocomplete="${authMode === "sign-up" ? "new-password" : "current-password"}" minlength="12" maxlength="128" required /></label>
            <button class="rc-cloud-button rc-cloud-button--primary" type="submit" ${this.busy ? "disabled" : ""}>${this.busy === "auth" ? "Working…" : authMode === "sign-up" ? "Create account" : "Sign in"}</button>
          </form>`;
    return `<main class="rc-cloud-auth-layout">
      <a class="rc-cloud-brand" href="/" aria-label="RoamCode home"><span>${cloudIcon("chevron-right")}</span> roamcode<small>.ai</small></a>
      <section class="rc-cloud-auth-card" aria-labelledby="auth-title">
        <div class="rc-cloud-kicker">Account control plane</div>
        <h1 id="auth-title">${contextualTitle}</h1><p>${contextualCopy}</p>
        ${!accountCreationEnabled ? `<div class="rc-cloud-warning" role="status">Hosted product unavailable — sign in only if you already have an account.</div>` : ""}
        ${this.pendingVerificationEmail ? this.renderPendingVerification() : emailForm}
        ${
          !this.providers.email_password
            ? ""
            : authMode === "reset-request"
              ? `<button class="rc-cloud-link-button" type="button" data-action="auth-mode" data-mode="sign-in">Back to sign in</button>`
              : accountCreationEnabled
                ? `<div class="rc-cloud-auth-switch"><button type="button" data-action="auth-mode" data-mode="sign-in" aria-pressed="${authMode === "sign-in"}">Sign in</button><button type="button" data-action="auth-mode" data-mode="sign-up" aria-pressed="${authMode === "sign-up"}">Create account</button></div>`
                : ""
        }
        ${
          this.providers.email_password && authMode === "sign-in"
            ? `<button class="rc-cloud-link-button" type="button" data-action="auth-mode" data-mode="reset-request">Forgot password?</button>`
            : ""
        }
        ${
          authMode !== "reset-request" &&
          (this.providers.github || this.providers.google || (authMode === "sign-in" && passkeyAvailable))
            ? `<div class="rc-cloud-divider"><span>${this.providers.email_password ? "or continue with" : "continue with"}</span></div><div class="rc-cloud-provider-grid">
                ${this.providers.github ? `<button type="button" class="rc-cloud-button" data-action="social" data-provider="github" ${this.busy ? "disabled" : ""}>GitHub</button>` : ""}
                ${this.providers.google ? `<button type="button" class="rc-cloud-button" data-action="social" data-provider="google" ${this.busy ? "disabled" : ""}>Google</button>` : ""}
                ${authMode === "sign-in" && passkeyAvailable ? `<button type="button" class="rc-cloud-button" data-action="passkey-sign-in" ${this.busy ? "disabled" : ""}>${this.busy === "passkey" ? "Checking…" : "Passkey"}</button>` : ""}
              </div>`
            : ""
        }
        ${this.providerCapabilitiesLoaded && !anyProvider ? `<div class="rc-cloud-warning">No account sign-in method is enabled on this deployment.</div>` : ""}
        <p class="rc-cloud-fineprint">Account cookies are HttpOnly. Provider credentials, repositories, and terminal plaintext stay on your Nodes.</p>
      </section>
      <div class="rc-cloud-auth-aside" aria-hidden="true"><div class="rc-cloud-orbit"><i></i><i></i><i></i><span>3 Nodes<br/>1 control plane</span></div></div>
    </main>`;
  }

  private renderPendingVerification(): string {
    return `<div class="rc-cloud-state-card"><span class="rc-cloud-state-icon">${cloudIcon("mail")}</span><strong>Check your inbox</strong><p>We sent a verification link to <b>${escapeHtml(this.pendingVerificationEmail)}</b>.</p><button type="button" class="rc-cloud-button" data-action="resend-verification" ${this.busy ? "disabled" : ""}>${this.busy === "resend" ? "Sending…" : "Send again"}</button><button type="button" class="rc-cloud-link-button" data-action="clear-verification">Use another email</button></div>`;
  }

  private renderEmailVerification(): string {
    this.pendingVerificationEmail ??= this.session?.user.email;
    return `<main class="rc-cloud-centered"><a class="rc-cloud-brand" href="/"><span>${cloudIcon("chevron-right")}</span> roamcode<small>.ai</small></a><section class="rc-cloud-focus-card"><div class="rc-cloud-kicker">Account activation</div><h1>Verify your email</h1><p>Your account exists, but cloud access stays locked until the address is verified.</p>${this.renderPendingVerification()}<button class="rc-cloud-link-button" type="button" data-action="sign-out">Sign out</button></section></main>`;
  }

  private renderContextRecovery(): string {
    return `<main class="rc-cloud-centered"><a class="rc-cloud-brand" href="/"><span>${cloudIcon("chevron-right")}</span> roamcode<small>.ai</small></a><section class="rc-cloud-focus-card"><div class="rc-cloud-kicker">Account context</div><h1>Your Personal context is not ready</h1><p>RoamCode normally creates it automatically. No placeholder organization or Node has been created in the browser.</p><button class="rc-cloud-button rc-cloud-button--primary" type="button" data-action="retry-bootstrap" ${this.busy ? "disabled" : ""}>Try account bootstrap again</button><button class="rc-cloud-link-button" type="button" data-action="sign-out">Sign out</button></section></main>`;
  }

  private renderDeviceActivation(): string {
    const requiresHostAdministration = this.deviceInspection?.scopes.includes("hosts:write") === true;
    const eligibleContexts = requiresHostAdministration
      ? this.contexts.filter((context) => context.role === "owner" || context.role === "admin")
      : this.contexts;
    const contexts = eligibleContexts
      .map(
        (context) =>
          `<option value="${escapeHtml(context.id)}" ${context.id === this.context?.id ? "selected" : ""}>${escapeHtml(context.name)} · ${context.kind === "personal" ? "Personal" : "Organization"}</option>`,
      )
      .join("");
    const approvalControls =
      eligibleContexts.length > 0
        ? `<label>Authorize for<select class="rc-cloud-select" id="activation-organization" aria-label="Authorize for">${contexts}</select></label>
          <div class="rc-cloud-consent-actions"><button class="rc-cloud-button" type="button" data-action="deny-device" ${this.busy ? "disabled" : ""}>Deny</button><button class="rc-cloud-button rc-cloud-button--primary" type="button" data-action="approve-device" ${this.busy ? "disabled" : ""}>${this.busy === "approve-device" ? "Approving…" : "Approve CLI"}</button></div>`
        : `<div class="rc-cloud-warning">This CLI needs permission to manage Nodes. Choose a context where you are an owner or admin, or ask an Organization admin to connect the Node.</div>
          <div class="rc-cloud-consent-actions"><button class="rc-cloud-button" type="button" data-action="deny-device" ${this.busy ? "disabled" : ""}>Deny</button><a class="rc-cloud-button rc-cloud-button--primary" href="/app/account">Open account settings</a></div>`;
    const inspection = this.deviceInspection
      ? `<div class="rc-cloud-consent">
          <div class="rc-cloud-consent-head"><span class="rc-cloud-node-mark">CLI</span><div><strong>${escapeHtml(this.deviceInspection.client.name)}</strong><span>${escapeHtml(this.deviceInspection.device.name)} · ${escapeHtml(this.deviceInspection.device.platform)}</span></div></div>
          <div class="rc-cloud-warning">${escapeHtml(this.deviceInspection.warning)}</div>
          <dl><div><dt>Requested scopes</dt><dd>${this.deviceInspection.scopes.map((scope) => `<code>${escapeHtml(scope)}</code>`).join(" ")}</dd></div><div><dt>Expires</dt><dd>${escapeHtml(displayDate(this.deviceInspection.expires_at))}</dd></div></dl>
          ${approvalControls}
        </div>`
      : `<form class="rc-cloud-form rc-cloud-code-form" data-form="inspect-device"><label>Device code<input name="user_code" value="${escapeHtml(this.activationCode)}" autocomplete="one-time-code" inputmode="text" minlength="8" maxlength="12" placeholder="ABCD-EFGH" required /></label><button class="rc-cloud-button rc-cloud-button--primary" type="submit" ${this.busy ? "disabled" : ""}>${this.busy === "inspect-device" ? "Checking…" : "Continue"}</button></form>`;
    return `<main class="rc-cloud-centered"><a class="rc-cloud-brand" href="/"><span>${cloudIcon("chevron-right")}</span> roamcode<small>.ai</small></a><section class="rc-cloud-focus-card"><div class="rc-cloud-kicker">CLI activation</div><h1>${this.activationComplete ? "Device flow complete" : "Approve a CLI"}</h1>${
      this.activationComplete
        ? `<div class="rc-cloud-state-card"><span class="rc-cloud-state-icon">${cloudIcon(this.activationComplete === "approved" ? "circle-check" : "circle-x")}</span><strong>${this.activationComplete === "approved" ? "Approved" : "Denied"}</strong><p>You can close this tab and return to the terminal.</p><a class="rc-cloud-button" href="/app">Open RoamCode</a></div>`
        : `<p>Review the exact client and scopes. A code is never approved silently.</p>${inspection}`
    }<div class="rc-cloud-focus-footer"><span>${escapeHtml(this.session?.user.email)}</span><button class="rc-cloud-link-button" type="button" data-action="sign-out">Sign out</button></div></section></main>`;
  }

  private renderInvite(): string {
    if (this.inviteComplete) {
      return `<main class="rc-cloud-centered"><section class="rc-cloud-focus-card"><div class="rc-cloud-state-card"><span class="rc-cloud-state-icon">${cloudIcon("circle-check")}</span><strong>Invitation accepted</strong><p>Your new organization is now available in the context selector.</p><a class="rc-cloud-button rc-cloud-button--primary" href="/app">Open RoamCode</a></div></section></main>`;
    }
    return `<main class="rc-cloud-centered"><a class="rc-cloud-brand" href="/"><span>${cloudIcon("chevron-right")}</span> roamcode<small>.ai</small></a><section class="rc-cloud-focus-card"><div class="rc-cloud-kicker">Organization invitation</div><h1>Join this RoamCode context</h1><p>The invitation is accepted only after you confirm with the signed-in account <b>${escapeHtml(this.session?.user.email)}</b>.</p>${
      this.inviteToken
        ? `<button type="button" class="rc-cloud-button rc-cloud-button--primary" data-action="accept-invite" ${this.busy ? "disabled" : ""}>${this.busy === "accept-invite" ? "Accepting…" : "Accept invitation"}</button>`
        : `<div class="rc-cloud-warning">This invitation link is missing or has already been cleared.</div>`
    }<button class="rc-cloud-link-button" type="button" data-action="sign-out">Use another account</button></section></main>`;
  }

  private renderResetPassword(): string {
    return `<main class="rc-cloud-centered"><a class="rc-cloud-brand" href="/"><span>${cloudIcon("chevron-right")}</span> roamcode<small>.ai</small></a><section class="rc-cloud-focus-card"><div class="rc-cloud-kicker">Account recovery</div><h1>Choose a new password</h1>${
      this.resetToken
        ? `<form class="rc-cloud-form" data-form="reset-password"><label>New password<input name="password" type="password" autocomplete="new-password" minlength="12" maxlength="128" required /></label><button class="rc-cloud-button rc-cloud-button--primary" type="submit" ${this.busy ? "disabled" : ""}>${this.busy === "reset-password" ? "Updating…" : "Update password"}</button></form>`
        : `<div class="rc-cloud-warning">This recovery link has no token. Request another link from the sign-in screen${this.providers.mode === "self_hosted" ? " and ask the installation operator to retrieve it from the protected file outbox" : ""}.</div>`
    }<a class="rc-cloud-link-button" href="/app">Back to RoamCode</a></section></main>`;
  }

  private renderProductShell(): string {
    const contextOptions = this.contexts
      .map(
        (context) =>
          `<option value="${escapeHtml(context.id)}" ${context.id === this.context?.id ? "selected" : ""}>${escapeHtml(context.name)} — ${context.kind === "personal" ? "Personal" : "Organization"}</option>`,
      )
      .join("");
    const primary = this.renderPrimaryNav("rail");
    return `<div class="rc-cloud-shell">
      <a class="rc-cloud-skip" href="#main-content">Skip to content</a>
      <aside class="rc-cloud-rail">
        <a class="rc-cloud-brand" href="/"><span>${cloudIcon("chevron-right")}</span> roamcode<small>.ai</small></a>
        <div class="rc-cloud-context-group"><label class="rc-cloud-context"><span>${this.context?.kind === "personal" ? "Personal" : this.context?.plan === "enterprise" ? "Enterprise" : "Organization"}</span><select class="rc-cloud-select" id="context-selector" aria-label="Current context">${contextOptions}</select></label><button class="rc-cloud-context-create" type="button" data-action="open-organization-dialog">New organization</button></div>
        ${primary}
        <div class="rc-cloud-rail-spacer"></div>
        ${this.canManagePeople() ? `<a class="rc-cloud-utility-link ${this.route === "people" ? "is-active" : ""}" href="/app/people" data-route="people" ${this.route === "people" ? 'aria-current="page"' : ""}><span>People &amp; Access</span><small>Admin</small></a>` : ""}
        <a class="rc-cloud-account-link ${this.route === "account" ? "is-active" : ""}" href="/app/account" data-route="account" ${this.route === "account" ? 'aria-current="page"' : ""}><span class="rc-cloud-avatar">${escapeHtml(initials(this.session?.user.name ?? "R"))}</span><span><strong>${escapeHtml(this.session?.user.name)}</strong><small>${escapeHtml(this.session?.user.email)}</small></span></a>
      </aside>
      <header class="rc-cloud-mobile-head"><a class="rc-cloud-brand" href="/"><span>${cloudIcon("chevron-right")}</span> rc</a><label><span class="sr-only">Current context</span><select class="rc-cloud-select" id="mobile-context-selector" aria-label="Current context">${contextOptions}</select></label><a class="rc-cloud-avatar" href="/app/account" data-route="account" aria-label="Open account for ${escapeHtml(this.session?.user.name)}" ${this.route === "account" ? 'aria-current="page"' : ""}>${escapeHtml(initials(this.session?.user.name ?? "R"))}</a></header>
      <main class="rc-cloud-main" id="main-content" tabindex="-1">${this.renderProductPage()}</main>
      <div class="rc-cloud-mobile-nav">${this.renderPrimaryNav("bottom")}</div>
      ${this.renderOrganizationDialog()}
    </div>`;
  }

  private renderOrganizationDialog(): string {
    if (!this.organizationDialogOpen) return "";
    return `<dialog class="rc-cloud-dialog" id="organization-dialog" aria-labelledby="organization-dialog-title" aria-describedby="organization-dialog-copy">
      <form class="rc-cloud-dialog-card rc-cloud-form" data-form="create-organization">
        <div class="rc-cloud-dialog-head"><div><span class="rc-cloud-kicker">Shared context</span><h2 id="organization-dialog-title">Create an Organization</h2></div><button type="button" class="rc-cloud-dialog-close" data-action="close-organization-dialog" aria-label="Close organization form">${cloudIcon("x")}</button></div>
        <p id="organization-dialog-copy">Create a shared boundary for people, Nodes, Sessions, and Automations. Your Personal context stays separate.</p>
        <label>Organization name<input name="name" value="${escapeHtml(this.organizationDraft.name)}" autocomplete="organization" maxlength="120" placeholder="Acme Engineering" required /></label>
        <label>Organization slug<input name="slug" value="${escapeHtml(this.organizationDraft.slug)}" ${this.organizationSlugEdited ? 'data-edited="true"' : ""} autocomplete="off" autocapitalize="none" spellcheck="false" minlength="3" maxlength="63" pattern="[a-z0-9][a-z0-9-]{1,61}[a-z0-9]" placeholder="acme-engineering" aria-describedby="organization-slug-help" required /></label>
        <small id="organization-slug-help">Lowercase letters, numbers, and hyphens. You can change the suggested slug before creating.</small>
        <div class="rc-cloud-dialog-actions"><button type="button" class="rc-cloud-button" data-action="close-organization-dialog" ${this.busy ? "disabled" : ""}>Cancel</button><button class="rc-cloud-button rc-cloud-button--primary" type="submit" ${this.busy ? "disabled" : ""}>${this.busy === "create-organization" ? "Creating…" : "Create Organization"}</button></div>
        <p class="rc-cloud-fineprint">The Free plan includes one Organization you own. Invitations to other Organizations remain separate.</p>
      </form>
    </dialog>`;
  }

  private renderPrimaryNav(variant: "rail" | "bottom"): string {
    const items: Array<{ route: ProductRoute; label: string; icon: CloudIconName }> = [
      { route: "sessions", label: "Sessions", icon: "square-terminal" },
      { route: "automations", label: "Automations", icon: "workflow" },
      { route: "agents", label: "Agents", icon: "cpu" },
    ];
    return `<nav class="rc-cloud-primary rc-cloud-primary--${variant}" aria-label="Primary"><ul>${items
      .map(
        (item) =>
          `<li><a href="${routePath(item.route)}" data-route="${item.route}" class="${this.route === item.route ? "is-active" : ""}" ${this.route === item.route ? 'aria-current="page"' : ""}><span aria-hidden="true">${cloudIcon(item.icon)}</span><b>${item.label}</b></a></li>`,
      )
      .join("")}</ul></nav>`;
  }

  private renderProductPage(): string {
    if (!this.contextLoaded)
      return `<div class="rc-cloud-page-loading" role="status"><div class="rc-cloud-loader"></div>Loading ${escapeHtml(this.context?.name)}…</div>`;
    if (this.route === "account") return this.renderAccount();
    if (this.route === "people") return this.renderPeople();
    if (this.hostInventoryState === "error") return this.renderFleetUnavailable();
    if (this.route === "agents") return this.renderAgents();
    if (this.route === "automations")
      return this.renderProductGateway(
        "automations",
        "Automations",
        "Repeatable coding work",
        "Choose the Node that will execute each Run as a real, inspectable Session.",
      );
    return this.renderProductGateway(
      "sessions",
      "Sessions",
      "Live coding work",
      "Choose the Node that owns the repository, then open its real Claude Code or Codex TUI.",
    );
  }

  private pageHeader(eyebrow: string, title: string, copy: string, action = ""): string {
    return `<header class="rc-cloud-page-head"><div><span>${escapeHtml(eyebrow)}</span><h1>${escapeHtml(title)}</h1><p>${escapeHtml(copy)}</p></div>${action}</header>`;
  }

  private renderFleetUnavailable(): string {
    const title = this.route === "automations" ? "Automations" : this.route === "agents" ? "Agents" : "Sessions";
    const eyebrow =
      this.route === "automations"
        ? "Repeatable coding work"
        : this.route === "agents"
          ? "Fleet & runtimes"
          : "Live coding work";
    return `${this.pageHeader(eyebrow, title, "The current context is still selected, but its Node inventory is temporarily unavailable.")}<section class="rc-cloud-locked rc-cloud-locked--compact" role="alert"><div class="rc-cloud-lock-visual" aria-hidden="true"><span></span><i></i></div><div><span class="rc-cloud-status-label">Account service unavailable</span><h2>Node inventory could not be loaded</h2><p>${escapeHtml(this.hostInventoryError ?? "RoamCode could not read the Nodes in this context.")}</p><div class="rc-cloud-locked-actions"><button class="rc-cloud-button rc-cloud-button--primary" type="button" data-action="refresh-context">Try again</button></div></div></section>`;
  }

  private hostIsOnline(host: CloudHost): boolean {
    return host.status === "online" && this.hostStatuses.get(host.id)?.relay?.status.hostOnline === true;
  }

  private hostDisplayState(host: CloudHost): CloudHost["status"] | "unknown" {
    if (!this.hostStatuses.has(host.id)) return "unknown";
    return host.status === "online" && !this.hostIsOnline(host) ? "offline" : host.status;
  }

  private hostSupportsManagedEnrollment(host: CloudHost): boolean {
    return (
      this.productLaunch.managedTerminal &&
      host.heartbeatState === "ready" &&
      host.capabilities?.includes("terminal.v1") === true &&
      host.capabilities?.includes("relay.v1") === true &&
      host.capabilities.includes("managed-device-enrollment.v1")
    );
  }

  private hostGrantIsCurrent(access: OrganizationHostAccess | undefined): boolean {
    if (!access?.effectivePermission) return false;
    return access.grantExpiresAt === null || Date.parse(access.grantExpiresAt) > Date.now();
  }

  private hostAccessCopy(host: CloudHost): string {
    if (!this.productLaunch.managedTerminal) return "Managed terminal unavailable";
    if (!this.hostSupportsManagedEnrollment(host)) return "Node update required";
    if (this.context?.kind !== "organization") return "Personal owner";
    if (this.hostAccessState === "loading" || this.hostAccessState === "idle") return "Checking access";
    if (this.hostAccessState === "error") return "Access unknown";
    const access = this.hostAccess.get(host.id);
    if (this.hostGrantIsCurrent(access)) return `${access?.effectivePermission === "manage" ? "Manage" : "Use"} grant`;
    if (access?.latestRequest?.status === "pending") return "Request pending";
    if (access?.grantExpiresAt && Date.parse(access.grantExpiresAt) <= Date.now()) return "Grant expired";
    if (access?.latestRequest?.status === "denied") return "Request denied";
    return "Access required";
  }

  private renderHostAction(
    host: CloudHost,
    destination: "sessions" | "automations",
    label: string,
    ariaLabel: string,
  ): string {
    if (!this.productLaunch.managedTerminal)
      return `<button class="rc-cloud-button" type="button" disabled>Managed terminal unavailable</button>`;
    const statusKnown = this.hostStatuses.has(host.id);
    if (!this.hostIsOnline(host))
      return `<button class="rc-cloud-button" type="button" disabled>${statusKnown ? "Node offline" : "Status unavailable"}</button>`;
    if (!this.hostSupportsManagedEnrollment(host))
      return `<button class="rc-cloud-button" type="button" disabled>Node update required</button>`;
    if (this.context?.kind !== "organization" || this.hostGrantIsCurrent(this.hostAccess.get(host.id)))
      return `<a class="rc-cloud-button rc-cloud-button--primary" href="${escapeHtml(this.terminalDestination(destination, host.id))}" aria-label="${escapeHtml(ariaLabel)}">${escapeHtml(label)}</a>`;
    if (this.hostAccessState === "loading" || this.hostAccessState === "idle")
      return `<button class="rc-cloud-button" type="button" disabled>Checking access…</button>`;
    if (this.hostAccessState === "error")
      return `<button class="rc-cloud-button" type="button" disabled>Access unknown</button>`;
    const access = this.hostAccess.get(host.id);
    if (access?.latestRequest?.status === "pending")
      return `<button class="rc-cloud-button" type="button" disabled>Request pending</button>`;
    if (this.isContextAdmin()) {
      const query = this.context ? `?context=${encodeURIComponent(this.context.id)}` : "";
      return `<a class="rc-cloud-button" href="/app/people${query}">Manage access</a>`;
    }
    const query = new URLSearchParams({ context: this.context.id, request: host.id });
    const requestLabel = access?.latestRequest?.status === "denied" ? "Request again" : "Request access";
    return `<a class="rc-cloud-button" href="/app/agents?${query.toString()}#node-${escapeHtml(host.id)}">${requestLabel}</a>`;
  }

  private terminalDestination(destination: "sessions" | "automations", hostId: string): string {
    const query = new URLSearchParams({ enroll: hostId });
    if (this.context) query.set("context", this.context.id);
    return `/terminal/${destination}?${query.toString()}`;
  }

  private nodeDetailHref(hostId: string): string {
    const query = new URLSearchParams();
    if (this.context) query.set("context", this.context.id);
    query.set("node", hostId);
    return `/app/agents?${query.toString()}#node-${encodeURIComponent(hostId)}`;
  }

  private renderProductGateway(
    destination: "sessions" | "automations",
    title: string,
    eyebrow: string,
    copy: string,
  ): string {
    const online = this.hosts.filter((host) => this.hostIsOnline(host)).length;
    const noHosts = this.hosts.length === 0;
    if (!noHosts && online > 0) {
      return `${this.pageHeader(eyebrow, title, copy, `<button class="rc-cloud-button" type="button" data-action="refresh-context">Refresh</button>`)}<section class="rc-cloud-node-grid" aria-label="Choose a Node for ${escapeHtml(title)}">${this.hosts
        .map((host) => {
          const available = this.hostIsOnline(host);
          const statusKnown = this.hostStatuses.has(host.id);
          const state = this.hostDisplayState(host);
          const action = this.renderHostAction(host, destination, `Open ${title}`, `Open ${title} on ${host.name}`);
          return `<article class="rc-cloud-node-card"><header><span class="rc-cloud-node-mark">${escapeHtml(initials(host.name))}</span><div><h2>${escapeHtml(host.name)}</h2><p>${escapeHtml(host.slug)}</p></div><span class="rc-cloud-node-state rc-cloud-node-state--${escapeHtml(state)}"><i></i>${escapeHtml(state)}</span></header><dl><div><dt>RoamCode Node service</dt><dd>${escapeHtml(host.agentVersion ?? "Not reported")}</dd></div><div><dt>Last heartbeat</dt><dd>${escapeHtml(displayDate(host.lastSeenAt))}</dd></div><div><dt>Relay route</dt><dd>${available ? "Ready" : statusKnown ? "Unavailable" : "Status unknown"}</dd></div><div><dt>Browser access</dt><dd>${escapeHtml(this.hostAccessCopy(host))}</dd></div></dl><footer><span>${available ? (!this.productLaunch.managedTerminal ? "Managed terminal launch is unavailable on this control plane" : this.hostSupportsManagedEnrollment(host) ? "Terminal data stays end-to-end encrypted" : "Update the Node before managed browser enrollment") : statusKnown ? "This Node must reconnect before it can be opened" : "Refresh before assuming this Node is offline"}</span>${action}</footer></article>`;
        })
        .join(
          "",
        )}</section><div class="rc-cloud-trust-note"><span>Node-scoped access</span><p>RoamCode Cloud selects the Node and issues a revocable browser grant. Session, automation, repository, and terminal data travel only through the end-to-end encrypted Node connection.</p></div>`;
    }
    const statusUnknown = !noHosts && this.hosts.some((host) => !this.hostStatuses.has(host.id));
    const heading = noHosts
      ? "No Nodes in this context"
      : statusUnknown
        ? "Node status is unavailable"
        : "Your Nodes are offline";
    const detail = noHosts
      ? "Register a Node from the RoamCode CLI. It will appear in Agents after its first control-plane heartbeat."
      : statusUnknown
        ? "RoamCode loaded the fleet inventory but could not verify every relay route. Refresh before assuming a Node is offline."
        : "Account inventory is available, but terminal and automation actions remain locked until a Node reconnects.";
    return `${this.pageHeader(eyebrow, title, copy)}<section class="rc-cloud-locked"><div class="rc-cloud-lock-visual" aria-hidden="true"><span></span><i></i></div><div><span class="rc-cloud-status-label">${noHosts ? "Setup required" : statusUnknown ? "Status unknown" : "Fleet offline"}</span><h2>${heading}</h2><p>${detail}</p><div class="rc-cloud-locked-actions"><a class="rc-cloud-button rc-cloud-button--primary" href="/app/agents" data-route="agents">Open Agents</a><button class="rc-cloud-button" type="button" data-action="refresh-context">Refresh fleet</button></div></div></section>${this.renderFleetStrip()}`;
  }

  private renderFleetStrip(): string {
    if (this.hosts.length === 0) return "";
    return `<section class="rc-cloud-fleet-strip" aria-label="Node status">${this.hosts
      .map(
        (host) =>
          `<div><span class="rc-cloud-dot rc-cloud-dot--${escapeHtml(this.hostDisplayState(host))}"></span><strong>${escapeHtml(host.name)}</strong><small>${escapeHtml(this.hostDisplayState(host))}</small></div>`,
      )
      .join("")}</section>`;
  }

  private renderAgents(): string {
    const action = `<button class="rc-cloud-button" type="button" data-action="refresh-context">Refresh</button>`;
    if (this.hosts.length === 0) {
      return `${this.pageHeader("Fleet & runtimes", "Agents", "Nodes first. Each coding-agent runtime belongs to one machine.", action)}<section class="rc-cloud-node-onboarding"><div class="rc-cloud-node-onboarding-head"><span class="rc-cloud-status-label">No Nodes connected</span><h2>Connect the computer that will run your agents</h2><p>Run these commands on that computer. Sign-in opens this same RoamCode origin so you can inspect the account and scopes before approving it.</p></div><ol class="rc-cloud-setup-steps"><li><div><span>1</span><div><strong>Authorize the CLI</strong><small>Choose the Personal or Organization context for this Node.</small></div></div>${this.renderCommand("login")}</li><li><div><span>2</span><div><strong>Register the Node</strong><small>The private relay credential is written only to that machine.</small></div></div>${this.renderCommand("connect")}</li><li><div><span>3</span><div><strong>Wait for the first heartbeat</strong><small>The Node and its real Codex or Claude Code runtimes will appear here.</small></div></div><button class="rc-cloud-button" type="button" data-action="refresh-context">Refresh fleet</button></li></ol></section><div class="rc-cloud-trust-note"><span>What stays local</span><p>Provider logins, repositories, terminal output, and runtime credentials never pass through the account service.</p></div>`;
    }
    return `${this.pageHeader("Fleet & runtimes", "Agents", "Control-plane truth for every Node in the current context.", action)}${this.renderAccessRequestForm()}<div class="rc-cloud-node-grid">${this.hosts
      .map((host) => {
        const status = this.hostStatuses.get(host.id);
        const statusKnown = this.hostStatuses.has(host.id);
        const relayOnline = status?.relay?.status.hostOnline === true;
        const online = this.hostIsOnline(host);
        const state = this.hostDisplayState(host);
        const action = this.renderHostAction(host, "sessions", "Open Node", `Open ${host.name}`);
        const requestedNode = new URLSearchParams(location.search).get("node") === host.id;
        return `<article class="rc-cloud-node-card ${requestedNode ? "is-focused" : ""}" id="node-${escapeHtml(host.id)}" tabindex="-1"><header><span class="rc-cloud-node-mark">${escapeHtml(initials(host.name))}</span><div><h2>${escapeHtml(host.name)}</h2><p>${escapeHtml(host.slug)}</p></div><span class="rc-cloud-node-state rc-cloud-node-state--${escapeHtml(state)}"><i></i>${escapeHtml(state)}</span></header><dl><div><dt>RoamCode Node service</dt><dd>${escapeHtml(host.agentVersion ?? "Not reported")}</dd></div><div><dt>Last heartbeat</dt><dd>${escapeHtml(displayDate(host.lastSeenAt))}</dd></div><div><dt>Relay route</dt><dd>${statusKnown ? (status?.relay ? (relayOnline ? "Online" : "Offline") : "Unavailable") : "Status unknown"}</dd></div><div><dt>Browser access</dt><dd>${escapeHtml(this.hostAccessCopy(host))}</dd></div></dl><footer><span>${online ? (!this.productLaunch.managedTerminal ? "Managed terminal launch is unavailable on this control plane" : this.hostSupportsManagedEnrollment(host) ? "Open the real terminal UI with a Node-scoped browser grant" : "Update this Node to enable managed browser enrollment") : statusKnown ? "This Node must reconnect before it can be opened" : "Refresh before assuming this Node is offline"}</span>${action}</footer></article>`;
      })
      .join(
        "",
      )}</div><div class="rc-cloud-trust-note"><span>End-to-end boundary</span><p>Fleet metadata comes from the account service. Provider logins, repositories, terminal output, and runtime inventory do not.</p></div>`;
  }

  private renderAccessRequestForm(): string {
    const hostId = new URLSearchParams(location.search).get("request");
    const host = this.hosts.find((candidate) => candidate.id === hostId);
    if (!host || !this.context || this.context.kind !== "organization" || this.isContextAdmin()) return "";
    if (!this.productLaunch.managedTerminal)
      return `<section class="rc-cloud-panel rc-cloud-access-request"><div><span class="rc-cloud-status-label">Hosted capability unavailable</span><h2>Managed terminal access is not enabled</h2><p>This control plane did not advertise a compatible managed terminal launch. RoamCode will not submit an access request or try to enroll this browser.</p></div></section>`;
    if (!this.hostSupportsManagedEnrollment(host))
      return `<section class="rc-cloud-panel rc-cloud-access-request"><div><span class="rc-cloud-status-label">Node update required</span><h2>${escapeHtml(host.name)} cannot enroll managed browsers yet</h2><p>Update or reconnect the RoamCode Node service until its heartbeat is ready and reports terminal, relay, and managed-device-enrollment capabilities. Access grants cannot make an older Node enroll a browser.</p></div></section>`;
    if (this.hostAccessState === "idle" || this.hostAccessState === "loading")
      return `<section class="rc-cloud-panel rc-cloud-access-request" role="status" aria-busy="true"><div class="rc-cloud-loader" aria-hidden="true"></div><div><h2>Checking your access to ${escapeHtml(host.name)}…</h2><p>RoamCode is reading your own grant and latest request before offering another action.</p></div></section>`;
    if (this.hostAccessState === "error")
      return `<section class="rc-cloud-panel rc-cloud-access-request" role="alert"><div><span class="rc-cloud-status-label">Access unknown</span><h2>Your Node access could not be loaded</h2><p>${escapeHtml(this.hostAccessError ?? "RoamCode could not read your current grant.")}</p><button class="rc-cloud-button" type="button" data-action="refresh-context">Try again</button></div></section>`;
    const access = this.hostAccess.get(host.id);
    if (this.hostGrantIsCurrent(access))
      return `<section class="rc-cloud-panel rc-cloud-access-request"><div><span class="rc-cloud-status-label">Access granted</span><h2>You can already open ${escapeHtml(host.name)}</h2><p>Your ${escapeHtml(access?.effectivePermission)} grant is active. Use the Node card below to create the encrypted browser connection.</p></div></section>`;
    if (access?.latestRequest?.status === "pending")
      return `<section class="rc-cloud-panel rc-cloud-access-request"><div><span class="rc-cloud-status-label">Request pending</span><h2>An admin is reviewing ${escapeHtml(host.name)}</h2><p>${escapeHtml(access.latestRequest.reason)}</p><small>Requested ${escapeHtml(displayDate(access.latestRequest.createdAt))}. RoamCode will not claim access until an Organization admin approves it.</small></div></section>`;
    const denied = access?.latestRequest?.status === "denied";
    return `<section class="rc-cloud-panel rc-cloud-access-request" aria-labelledby="access-request-title"><div><span class="rc-cloud-status-label">${denied ? "Request denied" : "Access required"}</span><h2 id="access-request-title">${denied ? "Request again" : "Request access"} to ${escapeHtml(host.name)}</h2><p>${denied && access.latestRequest?.reviewNote ? `${escapeHtml(access.latestRequest.reviewNote)} ` : ""}Your Organization admin controls browser access to this Node. Tell them what you need; RoamCode will not claim access until they approve it.</p></div><form class="rc-cloud-form" data-form="request-access"><input type="hidden" name="host_id" value="${escapeHtml(host.id)}" /><label>Permission<select class="rc-cloud-select" aria-label="Permission" name="permission"><option value="use">Use terminal</option><option value="manage">Manage Node</option></select></label><label>Reason<textarea name="reason" minlength="1" maxlength="500" rows="3" placeholder="What will you work on?" required></textarea></label><button class="rc-cloud-button rc-cloud-button--primary" type="submit" ${this.busy ? "disabled" : ""}>${this.busy === "request-access" ? "Sending…" : denied ? "Send new request" : "Send request"}</button></form></section>`;
  }

  private renderCommand(command: keyof typeof NODE_COMMANDS): string {
    return `<div class="rc-cloud-command"><code>${escapeHtml(NODE_COMMANDS[command])}</code><button type="button" data-action="copy-command" data-command="${command}" aria-label="Copy ${command === "login" ? "cloud login" : "cloud connect"} command">Copy</button></div>`;
  }

  private renderAccount(): string {
    const passkey = this.providers.passkey && browserSupportsPasskeys();
    const accountCopy = this.productLaunch.managedTerminal
      ? "Your cloud identity, contexts, CLI sign-ins, and managed browser access."
      : "Your cloud identity, contexts, and CLI sign-ins.";
    const providerBadges = [
      this.providers.email_password ? "Email + password" : undefined,
      this.providers.github ? "GitHub" : undefined,
      this.providers.google ? "Google" : undefined,
      passkey ? "Passkeys" : undefined,
    ].filter(Boolean);
    return `${this.pageHeader("Identity & security", "Account", accountCopy, `<button class="rc-cloud-button" type="button" data-action="sign-out">Sign out</button>`)}<div class="rc-cloud-account-grid"><section class="rc-cloud-panel"><h2>Profile</h2><div class="rc-cloud-profile"><span class="rc-cloud-avatar rc-cloud-avatar--large">${escapeHtml(initials(this.session?.user.name ?? "R"))}</span><div><strong>${escapeHtml(this.session?.user.name)}</strong><span>${escapeHtml(this.session?.user.email)}</span><small>${this.providers.mode === "self_hosted" ? "Self-hosted account" : "Verified account"}</small></div></div><div class="rc-cloud-badges">${providerBadges.map((provider) => `<span>${escapeHtml(provider)}</span>`).join("")}</div>${passkey ? `<button class="rc-cloud-button" type="button" data-action="passkey-register" ${this.busy ? "disabled" : ""}>Add a passkey</button>` : ""}</section><section class="rc-cloud-panel"><div class="rc-cloud-panel-head"><h2>Contexts</h2><button class="rc-cloud-panel-action" type="button" data-action="open-organization-dialog">New Organization</button></div><ul class="rc-cloud-simple-list">${this.contexts.map((context) => `<li><span><strong>${escapeHtml(context.name)}</strong><small>${escapeHtml(context.kind === "personal" ? "Personal" : context.slug)}</small></span><span class="rc-cloud-plan">${escapeHtml(context.plan)}</span></li>`).join("")}</ul>${
      this.canManagePeople()
        ? `<a class="rc-cloud-admin-entry" href="/app/people" data-route="people"><span><strong>People &amp; Access</strong><small>Manage members, invitations, and roles</small></span><b>Open</b></a>`
        : ""
    }</section><section class="rc-cloud-panel rc-cloud-panel--wide"><div><span class="rc-cloud-kicker">CLI authorization</span><h2>CLI sign-ins</h2></div>${this.renderCloudDevices()}</section>${
      this.productLaunch.managedTerminal
        ? `<section class="rc-cloud-panel rc-cloud-panel--wide"><div><span class="rc-cloud-kicker">Node credentials</span><h2>Browser access to Nodes</h2></div><p class="rc-cloud-section-copy">These are browser identities this account enrolled on managed Nodes. Revoking one removes that browser's Node access without signing out your CLI.</p>${this.renderManagedHostDevices()}</section>`
        : ""
    }${
      this.legalDocuments.length > 0
        ? `<section class="rc-cloud-panel rc-cloud-panel--wide"><h2>Legal documents</h2><div class="rc-cloud-document-links">${this.legalDocuments
            .map((document) => {
              const href = safeDocumentUrl(document.publicUrl);
              return href
                ? `<a href="${escapeHtml(href)}" target="_blank" rel="noopener">${escapeHtml(document.documentType.toUpperCase())}<small>v${escapeHtml(document.version)}</small></a>`
                : `<span>${escapeHtml(document.documentType.toUpperCase())}<small>Unavailable</small></span>`;
            })
            .join("")}</div></section>`
        : ""
    }</div>`;
  }

  private renderCloudDevices(): string {
    if (this.cloudDevicesState === "idle" || this.cloudDevicesState === "loading")
      return `<div class="rc-cloud-state-card" role="status" aria-busy="true"><div class="rc-cloud-loader" aria-hidden="true"></div><strong>Loading cloud devices…</strong><p>Checking signed-in CLI sessions.</p></div>`;
    if (this.cloudDevicesState === "error")
      return `<div class="rc-cloud-state-card" role="alert"><span class="rc-cloud-state-icon">${cloudIcon("circle-alert")}</span><strong>Cloud device status is unknown</strong><p>${escapeHtml(this.cloudDevicesError ?? "Cloud device status could not be loaded.")} Existing device sessions may still be active.</p><button class="rc-cloud-button" type="button" data-action="retry-cloud-devices">Try again</button></div>`;
    if (this.cloudDevices.length === 0) return `<p class="rc-cloud-muted">No CLI device sessions are active.</p>`;
    const revocationBusy = this.busy?.startsWith("revoke-device:") === true;
    return `<ul class="rc-cloud-simple-list rc-cloud-device-list">${this.cloudDevices
      .map((device) => {
        const pending = this.pendingDeviceRevocationId === device.id;
        const revoking = this.busy === `revoke-device:${device.id}`;
        const label = `${device.name} on ${device.platform}`;
        const action = device.revokedAt
          ? `<span class="rc-cloud-device-revoked">Revoked ${escapeHtml(displayDate(device.revokedAt))}</span>`
          : pending
            ? `<div class="rc-cloud-revoke-confirm" role="group" aria-label="Confirm revoking ${escapeHtml(label)}"><span>Revoke this CLI session?</span><div><button type="button" data-action="cancel-device-revoke" data-device-id="${escapeHtml(device.id)}" ${revocationBusy ? "disabled" : ""}>Cancel</button><button type="button" class="is-danger" data-action="confirm-device-revoke" data-device-id="${escapeHtml(device.id)}" ${revocationBusy ? "disabled" : ""}>${revoking ? "Revoking…" : "Revoke device"}</button></div></div>`
            : `<button class="rc-cloud-device-revoke" type="button" data-action="prepare-device-revoke" data-device-id="${escapeHtml(device.id)}" ${revocationBusy ? "disabled" : ""}>Revoke</button>`;
        return `<li class="rc-cloud-device-row" ${revoking ? 'aria-busy="true"' : ""}><span><strong>${escapeHtml(device.name)}</strong><small>${escapeHtml(device.platform)} · ${escapeHtml(device.organizationName)}</small></span><div class="rc-cloud-device-side"><small>Last used ${escapeHtml(displayDate(device.lastSeenAt ?? device.createdAt))}</small>${action}</div></li>`;
      })
      .join("")}</ul>`;
  }

  private renderManagedHostDevices(): string {
    if (this.managedHostDevicesState === "idle" || this.managedHostDevicesState === "loading")
      return `<div class="rc-cloud-state-card" role="status" aria-busy="true"><div class="rc-cloud-loader" aria-hidden="true"></div><strong>Loading managed browser access…</strong><p>Checking browser identities paired to your Nodes.</p></div>`;
    if (this.managedHostDevicesState === "error")
      return `<div class="rc-cloud-state-card" role="alert"><span class="rc-cloud-state-icon">${cloudIcon("circle-alert")}</span><strong>Browser access is unknown</strong><p>${escapeHtml(this.managedHostDevicesError ?? "Managed browser access could not be loaded.")} Existing browser credentials may still be active.</p><button class="rc-cloud-button" type="button" data-action="retry-managed-host-devices">Try again</button></div>`;
    if (this.managedHostDevices.length === 0)
      return `<p class="rc-cloud-muted">No managed browsers have been enrolled on your Nodes.</p>`;
    const revocationBusy = this.busy?.startsWith("revoke-host-device:") === true;
    return `<ul class="rc-cloud-simple-list rc-cloud-device-list">${this.managedHostDevices
      .map((device) => {
        const pending = this.pendingManagedHostDeviceRevocationId === device.id;
        const revoking = this.busy === `revoke-host-device:${device.id}`;
        const label = `${device.label} on ${device.hostName}`;
        const action = device.revokedAt
          ? `<span class="rc-cloud-device-revoked">Revoked ${escapeHtml(displayDate(device.revokedAt))}</span>`
          : pending
            ? `<div class="rc-cloud-revoke-confirm" role="group" aria-label="Confirm revoking ${escapeHtml(label)}"><span>Revoke this browser's access to ${escapeHtml(device.hostName)}?</span><div><button type="button" data-action="cancel-managed-host-device-revoke" data-device-id="${escapeHtml(device.id)}" ${revocationBusy ? "disabled" : ""}>Cancel</button><button type="button" class="is-danger" data-action="confirm-managed-host-device-revoke" data-device-id="${escapeHtml(device.id)}" ${revocationBusy ? "disabled" : ""}>${revoking ? "Revoking…" : "Revoke browser"}</button></div></div>`
            : `<button class="rc-cloud-device-revoke" type="button" data-action="prepare-managed-host-device-revoke" data-device-id="${escapeHtml(device.id)}" ${revocationBusy ? "disabled" : ""}>Revoke</button>`;
        return `<li class="rc-cloud-device-row" ${revoking ? 'aria-busy="true"' : ""}><span><strong>${escapeHtml(device.label)}</strong><small>${escapeHtml(device.hostName)} · ${escapeHtml(device.organizationName)}</small></span><div class="rc-cloud-device-side"><small>${device.lastSeenAt ? `Last used ${escapeHtml(displayDate(device.lastSeenAt))}` : `Paired ${escapeHtml(displayDate(device.pairedAt))}`}</small>${action}</div></li>`;
      })
      .join("")}</ul>`;
  }

  private renderPeople(): string {
    if (!this.canManagePeople()) {
      const personal = this.context?.kind === "personal";
      return `${this.pageHeader("Administration", "People & Access", "Membership is an administrative surface, not a daily-work destination.")}<section class="rc-cloud-locked rc-cloud-locked--compact"><div class="rc-cloud-lock-visual" aria-hidden="true"><span></span><i></i></div><div><span class="rc-cloud-status-label">${personal ? "Organization context required" : "Admin only"}</span><h2>${personal ? "Personal contexts do not have a team" : "Organization administration is locked"}</h2><p>${personal ? "Switch to an Organization context to manage members, invitations, and roles." : "An owner or administrator can manage invitations and roles."}</p></div></section>`;
    }
    const pendingInvites = this.invites.filter((invite) => invite.status === "pending");
    const pendingRequests = this.accessRequests.filter((request) => request.status === "pending");
    return `${this.pageHeader("Administration", "People & Access", "Manage Organization membership first, then grant explicit access to the Nodes people actually need.")}<div class="rc-cloud-people-layout">
      <section class="rc-cloud-panel rc-cloud-panel--wide"><div class="rc-cloud-panel-head"><div><span class="rc-cloud-kicker">Organization</span><h2>Members</h2></div><span>${this.membersState === "ready" ? this.members.length : "—"}</span></div>${this.renderMembers()}</section>
      <section class="rc-cloud-panel"><div><span class="rc-cloud-kicker">Membership</span><h2>Invite someone</h2></div><form class="rc-cloud-form" data-form="invite-member"><label>Email<input name="email" type="email" autocomplete="email" required /></label><label>Role<select class="rc-cloud-select" aria-label="Role" name="role"><option value="member">Member</option><option value="viewer">Viewer</option><option value="admin">Admin</option></select></label><button class="rc-cloud-button rc-cloud-button--primary" type="submit" ${this.busy || this.membersState !== "ready" ? "disabled" : ""}>${this.busy === "invite-member" ? "Creating…" : "Create invitation"}</button></form>${this.oneTimeInviteUrl ? `<div class="rc-cloud-state-card" role="status"><strong>Invite link ready</strong><p>Copy it now and send it through a trusted channel. For security, RoamCode will not show or store this one-time link again.</p><button class="rc-cloud-button rc-cloud-button--primary" type="button" data-action="copy-invite-link">Copy invite link</button></div>` : ""}<p class="rc-cloud-fineprint">Membership does not grant terminal access. Add a Node grant separately.</p></section>
      <section class="rc-cloud-panel"><div class="rc-cloud-panel-head"><div><span class="rc-cloud-kicker">Membership</span><h2>Pending invitations</h2></div><span>${this.invitesState === "ready" ? pendingInvites.length : "—"}</span></div>${this.renderInvitations(pendingInvites)}</section>
      <section class="rc-cloud-panel"><div><span class="rc-cloud-kicker">Node access</span><h2>Grant access</h2></div>${this.renderGrantForm()}</section>
      <section class="rc-cloud-panel"><div class="rc-cloud-panel-head"><div><span class="rc-cloud-kicker">Node access</span><h2>Active grants</h2></div><span>${this.grantsState === "ready" ? this.grants.length : "—"}</span></div>${this.renderGrants()}</section>
      <section class="rc-cloud-panel rc-cloud-panel--wide"><div class="rc-cloud-panel-head"><div><span class="rc-cloud-kicker">Review queue</span><h2>Access requests</h2></div><span>${this.accessRequestsState === "ready" ? pendingRequests.length : "—"}</span></div>${this.renderAccessRequests()}</section>
    </div>`;
  }

  private renderMembers(): string {
    if (this.membersState === "error")
      return `<div class="rc-cloud-state-card" role="alert"><span class="rc-cloud-state-icon">${cloudIcon("circle-alert")}</span><strong>Member roster unavailable</strong><p>${escapeHtml(this.membersError ?? "Member roster could not be loaded.")} No empty roster has been assumed.</p><button class="rc-cloud-button" type="button" data-action="retry-people">Try again</button></div>`;
    if (this.membersState === "idle" || this.membersState === "loading")
      return `<div class="rc-cloud-state-card" role="status" aria-busy="true"><div class="rc-cloud-loader" aria-hidden="true"></div><strong>Loading members…</strong></div>`;
    if (this.members.length === 0)
      return `<div class="rc-cloud-state-card" role="status"><strong>No members were returned</strong><p>An Organization must have an owner. Refresh before making access changes.</p><button class="rc-cloud-button" type="button" data-action="retry-people">Refresh roster</button></div>`;
    const mutationBusy = this.busy?.startsWith("member:") === true;
    return `<ul class="rc-cloud-access-list">${this.members
      .map((member) => {
        const owner = member.role === "owner";
        const current = member.userId === this.session?.user.id;
        const pendingRemoval = this.pendingMemberRemovalId === member.userId;
        const rowBusy = this.busy === `member:${member.userId}`;
        const controls = owner
          ? `<span class="rc-cloud-role">Owner · protected</span>`
          : current
            ? `<span class="rc-cloud-role">${escapeHtml(member.role)} · current account</span>`
            : pendingRemoval
              ? `<div class="rc-cloud-revoke-confirm" role="group" aria-label="Confirm removing ${escapeHtml(member.name)}"><span>Remove this member and revoke their access?</span><div><button type="button" data-action="cancel-member-remove" data-user-id="${escapeHtml(member.userId)}" ${mutationBusy ? "disabled" : ""}>Cancel</button><button type="button" class="is-danger" data-action="confirm-member-remove" data-user-id="${escapeHtml(member.userId)}" ${mutationBusy ? "disabled" : ""}>${rowBusy ? "Removing…" : "Remove member"}</button></div></div>`
              : `<div class="rc-cloud-row-controls"><label><span class="sr-only">Role for ${escapeHtml(member.name)}</span><select class="rc-cloud-select" aria-label="Role for ${escapeHtml(member.name)}" data-member-role data-user-id="${escapeHtml(member.userId)}" ${mutationBusy ? "disabled" : ""}><option value="admin" ${member.role === "admin" ? "selected" : ""}>Admin</option><option value="member" ${member.role === "member" ? "selected" : ""}>Member</option><option value="viewer" ${member.role === "viewer" ? "selected" : ""}>Viewer</option></select></label><button type="button" data-action="toggle-member-status" data-user-id="${escapeHtml(member.userId)}" data-status="${member.status === "active" ? "suspended" : "active"}" ${mutationBusy ? "disabled" : ""}>${rowBusy ? "Saving…" : member.status === "active" ? "Suspend" : "Restore"}</button><button type="button" class="is-danger" data-action="prepare-member-remove" data-user-id="${escapeHtml(member.userId)}" ${mutationBusy ? "disabled" : ""}>Remove</button></div>`;
        return `<li ${rowBusy ? 'aria-busy="true"' : ""}><span class="rc-cloud-person"><span class="rc-cloud-avatar">${escapeHtml(initials(member.name))}</span><span><strong>${escapeHtml(member.name)}</strong><small>${escapeHtml(member.email)} · ${escapeHtml(member.status)}</small></span></span>${controls}</li>`;
      })
      .join("")}</ul>`;
  }

  private renderInvitations(pendingInvites: OrganizationInvite[]): string {
    if (this.invitesState === "error")
      return `<div class="rc-cloud-state-card" role="alert"><span class="rc-cloud-state-icon">${cloudIcon("circle-alert")}</span><strong>Invitations unavailable</strong><p>${escapeHtml(this.invitesError ?? "Invitations could not be loaded.")}</p><button class="rc-cloud-button" type="button" data-action="retry-people">Try again</button></div>`;
    if (this.invitesState === "idle" || this.invitesState === "loading")
      return `<div class="rc-cloud-state-card" role="status" aria-busy="true"><div class="rc-cloud-loader" aria-hidden="true"></div><strong>Loading invitations…</strong></div>`;
    if (pendingInvites.length === 0) return `<p class="rc-cloud-muted">No pending invitations.</p>`;
    const mutationBusy = this.busy?.startsWith("invite:") === true;
    return `<ul class="rc-cloud-access-list">${pendingInvites
      .map((invite) => {
        const pending = this.pendingInviteRevocationId === invite.id;
        const rowBusy = this.busy === `invite:${invite.id}`;
        const action = pending
          ? `<div class="rc-cloud-revoke-confirm" role="group" aria-label="Confirm revoking invitation for ${escapeHtml(invite.email)}"><span>Revoke this pending invitation?</span><div><button type="button" data-action="cancel-invite-revoke" data-invite-id="${escapeHtml(invite.id)}" ${mutationBusy ? "disabled" : ""}>Cancel</button><button type="button" class="is-danger" data-action="confirm-invite-revoke" data-invite-id="${escapeHtml(invite.id)}" ${mutationBusy ? "disabled" : ""}>${rowBusy ? "Revoking…" : "Revoke invite"}</button></div></div>`
          : `<button class="rc-cloud-device-revoke" type="button" data-action="prepare-invite-revoke" data-invite-id="${escapeHtml(invite.id)}" ${mutationBusy ? "disabled" : ""}>Revoke</button>`;
        return `<li ${rowBusy ? 'aria-busy="true"' : ""}><span><strong>${escapeHtml(invite.email)}</strong><small>${escapeHtml(invite.role)} · expires ${escapeHtml(displayDate(invite.expiresAt))}</small></span>${action}</li>`;
      })
      .join("")}</ul>`;
  }

  private renderGrantForm(): string {
    if (this.membersState === "error" || this.grantsState === "error" || this.hostInventoryState === "error")
      return `<div class="rc-cloud-state-card" role="alert"><strong>Grant editor unavailable</strong><p>Members, Nodes, and existing grants must all load before RoamCode can safely change access.</p><button class="rc-cloud-button" type="button" data-action="retry-people">Try again</button></div>`;
    if (
      this.membersState !== "ready" ||
      this.grantsState === "idle" ||
      this.grantsState === "loading" ||
      this.hostInventoryState === "loading"
    )
      return `<div class="rc-cloud-state-card" role="status" aria-busy="true"><div class="rc-cloud-loader" aria-hidden="true"></div><strong>Loading grant editor…</strong></div>`;
    const eligibleMembers = this.members.filter((member) => member.status === "active" && member.role !== "owner");
    if (this.hosts.length === 0)
      return `<div class="rc-cloud-state-card"><strong>No Nodes to grant</strong><p>Connect a Node in Agents before assigning terminal access.</p><a class="rc-cloud-button" href="/app/agents" data-route="agents">Open Agents</a></div>`;
    if (eligibleMembers.length === 0)
      return `<div class="rc-cloud-state-card"><strong>No eligible members</strong><p>Invite a member first. Owners already administer every Node.</p></div>`;
    return `<form class="rc-cloud-form" data-form="node-grant"><label>Member<select class="rc-cloud-select" aria-label="Member" name="principal_user_id">${eligibleMembers.map((member) => `<option value="${escapeHtml(member.userId)}">${escapeHtml(member.name)} · ${escapeHtml(member.role)}</option>`).join("")}</select></label><label>Node<select class="rc-cloud-select" aria-label="Node" name="host_id">${this.hosts.map((host) => `<option value="${escapeHtml(host.id)}">${escapeHtml(host.name)}</option>`).join("")}</select></label><label>Permission<select class="rc-cloud-select" aria-label="Permission" name="permission"><option value="use">Use terminal</option><option value="manage">Manage Node</option></select></label><button class="rc-cloud-button rc-cloud-button--primary" type="submit" ${this.busy ? "disabled" : ""}>${this.busy === "grant:create" ? "Saving…" : "Grant or update access"}</button><p class="rc-cloud-fineprint">Use opens terminal sessions. Manage also permits Node administration. View-only is not offered because it cannot open the terminal.</p></form>`;
  }

  private renderGrants(): string {
    if (this.grantsState === "error")
      return `<div class="rc-cloud-state-card" role="alert"><span class="rc-cloud-state-icon">${cloudIcon("circle-alert")}</span><strong>Node grants unavailable</strong><p>${escapeHtml(this.grantsError ?? "Node grants could not be loaded.")} No access state has been assumed.</p><button class="rc-cloud-button" type="button" data-action="retry-people">Try again</button></div>`;
    if (this.grantsState === "idle" || this.grantsState === "loading")
      return `<div class="rc-cloud-state-card" role="status" aria-busy="true"><div class="rc-cloud-loader" aria-hidden="true"></div><strong>Loading grants…</strong></div>`;
    if (this.grants.length === 0) return `<p class="rc-cloud-muted">No explicit Node grants.</p>`;
    const mutationBusy = this.busy?.startsWith("grant:") === true;
    return `<ul class="rc-cloud-access-list">${this.grants
      .map((grant) => {
        const member = this.members.find((candidate) => candidate.userId === grant.principalUserId);
        const host = this.hosts.find((candidate) => candidate.id === grant.hostId);
        const pending = this.pendingGrantRevocationId === grant.id;
        const rowBusy = this.busy === `grant:${grant.id}`;
        const resource = host
          ? `<a href="${escapeHtml(this.nodeDetailHref(host.id))}">${escapeHtml(host.name)}</a>`
          : grant.workspaceId
            ? "Legacy workspace grant"
            : "Unknown Node";
        const permission = grant.permission === "view" ? "View · terminal unavailable" : grant.permission;
        const action = pending
          ? `<div class="rc-cloud-revoke-confirm" role="group" aria-label="Confirm revoking access for ${escapeHtml(member?.name ?? "member")}"><span>Revoke this Node grant?</span><div><button type="button" data-action="cancel-grant-revoke" data-grant-id="${escapeHtml(grant.id)}" ${mutationBusy ? "disabled" : ""}>Cancel</button><button type="button" class="is-danger" data-action="confirm-grant-revoke" data-grant-id="${escapeHtml(grant.id)}" ${mutationBusy ? "disabled" : ""}>${rowBusy ? "Revoking…" : "Revoke grant"}</button></div></div>`
          : `<button class="rc-cloud-device-revoke" type="button" data-action="prepare-grant-revoke" data-grant-id="${escapeHtml(grant.id)}" ${mutationBusy ? "disabled" : ""}>Revoke</button>`;
        return `<li ${rowBusy ? 'aria-busy="true"' : ""}><span><strong>${escapeHtml(member?.name ?? "Unknown member")}</strong><small>${resource} · ${escapeHtml(permission)}${grant.expiresAt ? ` · expires ${escapeHtml(displayDate(grant.expiresAt))}` : ""}</small></span>${action}</li>`;
      })
      .join("")}</ul>`;
  }

  private renderAccessRequests(): string {
    if (this.accessRequestsState === "error")
      return `<div class="rc-cloud-state-card" role="alert"><span class="rc-cloud-state-icon">${cloudIcon("circle-alert")}</span><strong>Access requests unavailable</strong><p>${escapeHtml(this.accessRequestsError ?? "Access requests could not be loaded.")} No review queue has been assumed.</p><button class="rc-cloud-button" type="button" data-action="retry-people">Try again</button></div>`;
    if (this.accessRequestsState === "idle" || this.accessRequestsState === "loading")
      return `<div class="rc-cloud-state-card" role="status" aria-busy="true"><div class="rc-cloud-loader" aria-hidden="true"></div><strong>Loading access requests…</strong></div>`;
    if (this.accessRequests.length === 0) return `<p class="rc-cloud-muted">No access requests.</p>`;
    const requests = [...this.accessRequests].sort((left, right) => {
      if (left.status === "pending" && right.status !== "pending") return -1;
      if (right.status === "pending" && left.status !== "pending") return 1;
      return right.createdAt.localeCompare(left.createdAt);
    });
    const mutationBusy = this.busy?.startsWith("request:") === true;
    return `<ul class="rc-cloud-request-list">${requests
      .map((request) => {
        const member = this.members.find((candidate) => candidate.userId === request.requesterUserId);
        const host = this.hosts.find((candidate) => candidate.id === request.hostId);
        const rowBusy = this.busy === `request:${request.id}`;
        const resource = host
          ? `<a href="${escapeHtml(this.nodeDetailHref(host.id))}">${escapeHtml(host.name)}</a>`
          : request.workspaceId
            ? "Legacy workspace request"
            : "Unknown Node";
        const viewWarning =
          request.permission === "view" && request.status === "pending"
            ? `<p class="rc-cloud-inline-warning">View-only terminal access is not supported yet. Deny this request and ask the member to request Use.</p>`
            : "";
        const actions =
          request.status === "pending"
            ? `<div class="rc-cloud-row-controls">${request.permission === "view" ? "" : `<button type="button" data-action="review-access-request" data-request-id="${escapeHtml(request.id)}" data-status="approved" ${mutationBusy ? "disabled" : ""}>${rowBusy ? "Saving…" : "Approve"}</button>`}<button type="button" class="is-danger" data-action="review-access-request" data-request-id="${escapeHtml(request.id)}" data-status="denied" ${mutationBusy ? "disabled" : ""}>Deny</button></div>`
            : `<span class="rc-cloud-role">${escapeHtml(request.status)}</span>`;
        return `<li ${rowBusy ? 'aria-busy="true"' : ""}><div><div class="rc-cloud-request-head"><strong>${escapeHtml(member?.name ?? "Unknown member")}</strong><span>${resource} · ${escapeHtml(request.permission)}</span></div><p>${escapeHtml(request.reason)}</p>${viewWarning}<small>Requested ${escapeHtml(displayDate(request.createdAt))}${request.reviewNote ? ` · ${escapeHtml(request.reviewNote)}` : ""}</small></div>${actions}</li>`;
      })
      .join("")}</ul>`;
  }

  private pageTitle(): string {
    if (!this.session) {
      if (this.route === "reset") return "Reset password";
      if (this.route === "activate") return "Approve a CLI";
      if (this.route === "invite") return "Accept invitation";
      if (this.authMode === "sign-up" && this.productLaunch.account) return "Create account";
      if (this.authMode === "reset-request") return "Reset password";
      return "Sign in";
    }
    if (!this.session.user.emailVerified && this.providers.mode !== "self_hosted") return "Verify email";
    const titles: Record<ProductRoute, string> = {
      sessions: "Sessions",
      automations: "Automations",
      agents: "Agents",
      account: "Account",
      people: "People & Access",
      activate: "Activate device",
      invite: "Accept invitation",
      reset: "Reset password",
    };
    return titles[this.route];
  }

  private async onClick(event: MouseEvent): Promise<void> {
    const target = (event.target as HTMLElement).closest<HTMLElement>("[data-action], [data-route]");
    if (!target) return;
    const route = target.dataset.route as ProductRoute | undefined;
    if (route) {
      event.preventDefault();
      await this.navigate(route);
      return;
    }
    const action = target.dataset.action;
    if (!action) return;
    event.preventDefault();
    this.clearFeedback();
    if (action === "dismiss-feedback") return this.render();
    if (action === "retry-bootstrap") return this.bootstrap();
    if (action === "auth-mode") {
      const mode = target.dataset.mode;
      if (mode !== "sign-in" && mode !== "sign-up" && mode !== "reset-request") return;
      if (mode === "sign-up" && !this.productLaunch.account) return;
      this.authMode = mode;
      this.pendingVerificationEmail = undefined;
      return this.render();
    }
    if (action === "clear-verification") {
      this.pendingVerificationEmail = undefined;
      return this.render();
    }
    if (action === "open-organization-dialog") {
      this.organizationDraft = { name: "", slug: "" };
      this.organizationSlugEdited = false;
      this.organizationDialogOpen = true;
      return this.render();
    }
    if (action === "close-organization-dialog") {
      if (this.busy === "create-organization") return;
      this.organizationDialogOpen = false;
      return this.render();
    }
    if (action === "copy-command") return this.copyNodeCommand(target.dataset.command);
    if (action === "copy-invite-link") return this.copyOneTimeInviteLink();
    if (action === "prepare-device-revoke") {
      if (this.busy?.startsWith("revoke-device:")) return;
      const deviceId = target.dataset.deviceId;
      if (!deviceId || !this.cloudDevices.some((device) => device.id === deviceId && !device.revokedAt)) return;
      this.pendingDeviceRevocationId = deviceId;
      return this.render();
    }
    if (action === "cancel-device-revoke") {
      if (this.busy?.startsWith("revoke-device:")) return;
      if (target.dataset.deviceId === this.pendingDeviceRevocationId) this.pendingDeviceRevocationId = undefined;
      return this.render();
    }
    if (action === "confirm-device-revoke") return this.revokeCloudDevice(target.dataset.deviceId);
    if (action === "retry-cloud-devices") return this.loadAccountData();
    if (action === "prepare-managed-host-device-revoke") {
      if (this.busy?.startsWith("revoke-host-device:")) return;
      const deviceId = target.dataset.deviceId;
      if (!deviceId || !this.managedHostDevices.some((device) => device.id === deviceId && !device.revokedAt)) return;
      this.pendingManagedHostDeviceRevocationId = deviceId;
      return this.render();
    }
    if (action === "cancel-managed-host-device-revoke") {
      if (this.busy?.startsWith("revoke-host-device:")) return;
      if (target.dataset.deviceId === this.pendingManagedHostDeviceRevocationId)
        this.pendingManagedHostDeviceRevocationId = undefined;
      return this.render();
    }
    if (action === "confirm-managed-host-device-revoke") return this.revokeManagedHostDevice(target.dataset.deviceId);
    if (action === "retry-managed-host-devices") return this.reloadManagedHostDevices();
    if (action === "retry-people") return this.refreshPeopleData();
    if (action === "prepare-member-remove") {
      if (this.busy?.startsWith("member:")) return;
      const userId = target.dataset.userId;
      const member = this.members.find((candidate) => candidate.userId === userId);
      if (!member || member.role === "owner" || member.userId === this.session?.user.id) return;
      this.pendingMemberRemovalId = member.userId;
      return this.render();
    }
    if (action === "cancel-member-remove") {
      if (this.busy?.startsWith("member:")) return;
      if (target.dataset.userId === this.pendingMemberRemovalId) this.pendingMemberRemovalId = undefined;
      return this.render();
    }
    if (action === "confirm-member-remove") return this.removeMember(target.dataset.userId);
    if (action === "toggle-member-status") {
      const status = target.dataset.status;
      if (status !== "active" && status !== "suspended") return;
      return this.updateMember(target.dataset.userId, { status });
    }
    if (action === "prepare-invite-revoke") {
      if (this.busy?.startsWith("invite:")) return;
      const inviteId = target.dataset.inviteId;
      if (!inviteId || !this.invites.some((invite) => invite.id === inviteId && invite.status === "pending")) return;
      this.pendingInviteRevocationId = inviteId;
      return this.render();
    }
    if (action === "cancel-invite-revoke") {
      if (this.busy?.startsWith("invite:")) return;
      if (target.dataset.inviteId === this.pendingInviteRevocationId) this.pendingInviteRevocationId = undefined;
      return this.render();
    }
    if (action === "confirm-invite-revoke") return this.revokeInvite(target.dataset.inviteId);
    if (action === "prepare-grant-revoke") {
      if (this.busy?.startsWith("grant:")) return;
      const grantId = target.dataset.grantId;
      if (!grantId || !this.grants.some((grant) => grant.id === grantId)) return;
      this.pendingGrantRevocationId = grantId;
      return this.render();
    }
    if (action === "cancel-grant-revoke") {
      if (this.busy?.startsWith("grant:")) return;
      if (target.dataset.grantId === this.pendingGrantRevocationId) this.pendingGrantRevocationId = undefined;
      return this.render();
    }
    if (action === "confirm-grant-revoke") return this.revokeGrant(target.dataset.grantId);
    if (action === "review-access-request") {
      const status = target.dataset.status;
      if (status !== "approved" && status !== "denied") return;
      return this.reviewAccessRequest(target.dataset.requestId, status);
    }
    if (action === "social") return this.socialSignIn(target.dataset.provider);
    if (action === "passkey-sign-in") return this.passkeySignIn();
    if (action === "passkey-register") return this.passkeyRegister();
    if (action === "resend-verification") return this.resendVerification();
    if (action === "sign-out") return this.signOut();
    if (action === "refresh-context" && this.context) return this.loadContext(this.context.id);
    if (action === "approve-device") return this.verifyDevice("approve");
    if (action === "deny-device") return this.verifyDevice("deny");
    if (action === "accept-invite") return this.acceptInvite();
  }

  private async onSubmit(event: SubmitEvent): Promise<void> {
    const form = event.target as HTMLFormElement;
    const kind = form.dataset.form;
    if (!kind) return;
    event.preventDefault();
    const data = new FormData(form);
    this.clearFeedback();
    if (kind === "auth") return this.submitAuth(form.dataset.mode as AuthMode, data);
    if (kind === "reset-request") return this.requestPasswordReset(String(data.get("email") ?? ""));
    if (kind === "reset-password") return this.resetPassword(this.resetToken ?? "", String(data.get("password") ?? ""));
    if (kind === "inspect-device") {
      this.activationCode = String(data.get("user_code") ?? "")
        .trim()
        .toUpperCase();
      return this.inspectActivation();
    }
    if (kind === "create-organization")
      return this.createOrganization(String(data.get("name") ?? ""), String(data.get("slug") ?? ""));
    if (kind === "invite-member")
      return this.inviteMember(String(data.get("email") ?? ""), String(data.get("role") ?? "member"));
    if (kind === "node-grant")
      return this.upsertNodeGrant(
        String(data.get("principal_user_id") ?? ""),
        String(data.get("host_id") ?? ""),
        String(data.get("permission") ?? ""),
      );
    if (kind === "request-access")
      return this.requestNodeAccess(
        String(data.get("host_id") ?? ""),
        String(data.get("permission") ?? ""),
        String(data.get("reason") ?? ""),
      );
  }

  private onInput(event: Event): void {
    const input = event.target as HTMLInputElement;
    if (input.form?.dataset.form !== "create-organization") return;
    if (input.name === "name") {
      this.organizationDraft.name = input.value;
      const slug = input.form.elements.namedItem("slug") as HTMLInputElement | null;
      if (slug && slug.dataset.edited !== "true") {
        const suggested = organizationSlug(input.value);
        this.organizationDraft.slug = suggested;
        slug.value = suggested;
      }
      return;
    }
    if (input.name === "slug") {
      const clean = organizationSlug(input.value);
      if (clean !== input.value) input.value = clean;
      input.dataset.edited = "true";
      this.organizationSlugEdited = true;
      this.organizationDraft.slug = clean;
    }
  }

  private async onChange(event: Event): Promise<void> {
    const select = event.target as HTMLSelectElement;
    if (select.matches("select[data-member-role]")) {
      const role = select.value;
      if (role !== "admin" && role !== "member" && role !== "viewer") return;
      await this.updateMember(select.dataset.userId, { role });
      return;
    }
    if (select.id !== "context-selector" && select.id !== "mobile-context-selector") return;
    const context = this.contexts.find((candidate) => candidate.id === select.value);
    if (!context) return;
    this.context = context;
    safeStorage(localStorage, "set", CONTEXT_KEY, context.id);
    const url = new URL(location.href);
    url.searchParams.set("context", context.id);
    history.replaceState(history.state, "", url);
    await this.loadContext(context.id);
  }

  private async onPopState(): Promise<void> {
    this.route = routeFromPath(location.pathname);
    const contextId = new URLSearchParams(location.search).get("context");
    const context = this.contexts.find((candidate) => candidate.id === contextId);
    if (context && context.id !== this.context?.id) {
      this.context = context;
      safeStorage(localStorage, "set", CONTEXT_KEY, context.id);
      await this.loadContext(context.id);
    } else {
      this.render();
    }
    if (this.route === "account") await this.loadAccountData();
    if (this.route === "people") await this.loadPeopleData();
    this.focusProductStart();
  }

  private async navigate(route: ProductRoute): Promise<void> {
    this.route = route;
    if (route !== "account") this.pendingDeviceRevocationId = undefined;
    const url = new URL(routePath(route), location.origin);
    if (this.context && route !== "activate" && route !== "invite") url.searchParams.set("context", this.context.id);
    history.pushState(history.state, "", url);
    this.render();
    if (route === "account") await this.loadAccountData();
    if (route === "people") await this.loadPeopleData();
    this.focusProductStart();
  }

  private focusProductStart(): void {
    if (document.scrollingElement) document.scrollingElement.scrollTop = 0;
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
    document.getElementById("main-content")?.focus({ preventScroll: true });
  }

  private async copyNodeCommand(command: string | undefined): Promise<void> {
    if (command !== "login" && command !== "connect") return;
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard access is unavailable.");
      await navigator.clipboard.writeText(NODE_COMMANDS[command]);
      this.notice = `${command === "login" ? "Cloud login" : "Cloud connect"} command copied.`;
    } catch {
      this.error = "This browser blocked clipboard access. Select and copy the command manually.";
    }
    this.render();
  }

  private async copyOneTimeInviteLink(): Promise<void> {
    const inviteUrl = this.oneTimeInviteUrl;
    if (!inviteUrl) return;
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard access is unavailable.");
      await navigator.clipboard.writeText(inviteUrl);
      this.oneTimeInviteUrl = undefined;
      this.notice = "Invite link copied. RoamCode has removed its in-memory copy.";
    } catch {
      this.error = "This browser blocked clipboard access. Allow clipboard access and try again.";
    }
    this.render();
  }

  private async revokeCloudDevice(deviceId: string | undefined): Promise<void> {
    if (this.busy?.startsWith("revoke-device:")) return;
    const device = this.cloudDevices.find((candidate) => candidate.id === deviceId && !candidate.revokedAt);
    if (!device || this.pendingDeviceRevocationId !== device.id) return;
    this.busy = `revoke-device:${device.id}`;
    this.render();
    try {
      await api.delete<void>(`/api/v1/auth/devices/${encodeURIComponent(device.id)}`);
      this.cloudDevices = this.cloudDevices.filter((candidate) => candidate.id !== device.id);
      this.pendingDeviceRevocationId = undefined;
      await this.loadAccountData();
      this.notice = `${device.name} can no longer access RoamCode Cloud.`;
    } catch (caught) {
      this.error = this.message(caught, "The CLI device could not be revoked.");
    } finally {
      this.busy = undefined;
      this.render();
    }
  }

  private async revokeManagedHostDevice(deviceId: string | undefined): Promise<void> {
    if (!this.productLaunch.managedTerminal) return;
    if (this.busy?.startsWith("revoke-host-device:")) return;
    const device = this.managedHostDevices.find((candidate) => candidate.id === deviceId && !candidate.revokedAt);
    if (!device || this.pendingManagedHostDeviceRevocationId !== device.id) return;
    this.busy = `revoke-host-device:${device.id}`;
    this.render();
    try {
      await api.delete<void>(`/api/v1/account/host-devices/${encodeURIComponent(device.id)}`);
      this.pendingManagedHostDeviceRevocationId = undefined;
      this.notice = `${device.label} can no longer access ${device.hostName}.`;
      await this.reloadManagedHostDevices();
    } catch (caught) {
      this.error = this.message(caught, "The managed browser could not be revoked.");
    } finally {
      this.busy = undefined;
      this.render();
    }
  }

  private async createOrganization(nameInput: string, slugInput: string): Promise<void> {
    const name = nameInput.trim().replace(/\s+/g, " ");
    const slug = organizationSlug(slugInput);
    this.organizationDraft = { name, slug };
    if (!name || !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(slug)) {
      this.error = "Enter an Organization name and a slug with 3–63 lowercase letters, numbers, or hyphens.";
      this.render();
      return;
    }
    this.busy = "create-organization";
    this.render();
    try {
      const created = await api.post<OrganizationCreation>("/api/v1/orgs", { name, slug });
      if (!created.organization?.id) throw new Error("The account service returned an invalid Organization.");
      const contextId = created.organization.id;
      this.organizationDialogOpen = false;
      this.organizationDraft = { name: "", slug: "" };
      this.organizationSlugEdited = false;
      const url = new URL(location.href);
      url.searchParams.set("context", contextId);
      history.replaceState(history.state, "", url);
      await this.loadAccountBootstrap(contextId);
      this.notice = `${created.organization.name} is ready. Connect a Node to start using it.`;
    } catch (caught) {
      this.error = this.message(caught, "The Organization could not be created.");
    } finally {
      this.busy = undefined;
      this.render();
    }
  }

  private async submitAuth(mode: AuthMode, data: FormData): Promise<void> {
    if (mode !== "sign-in" && mode !== "sign-up") return;
    if (mode === "sign-up" && !this.productLaunch.account) return;
    this.busy = "auth";
    this.render();
    const email = String(data.get("email") ?? "")
      .trim()
      .toLowerCase();
    const password = String(data.get("password") ?? "");
    try {
      if (mode === "sign-up") {
        await api.post("/api/auth/sign-up/email", {
          name: String(data.get("name") ?? "").trim(),
          email,
          password,
        });
        this.busy = undefined;
        if (this.providers.mode === "self_hosted") await this.bootstrap();
        else {
          this.pendingVerificationEmail = email;
          this.render();
        }
        return;
      }
      await api.post("/api/auth/sign-in/email", {
        email,
        password,
        rememberMe: true,
        callbackURL: this.authReturnUrl(),
      });
      this.busy = undefined;
      await this.bootstrap();
    } catch (caught) {
      this.busy = undefined;
      this.error = this.message(caught, "Authentication failed.");
      if (this.providers.mode !== "self_hosted" && caught instanceof CloudApiError && /verif/i.test(caught.message))
        this.pendingVerificationEmail = email;
      this.render();
    }
  }

  private async socialSignIn(provider: string | undefined): Promise<void> {
    if (provider !== "github" && provider !== "google") return;
    this.busy = `social:${provider}`;
    this.render();
    try {
      const result = await api.post<{ url?: string; redirect?: boolean }>("/api/auth/sign-in/social", {
        provider,
        callbackURL: this.authReturnUrl(),
        errorCallbackURL: this.authReturnUrl(),
      });
      if (!result.url) throw new Error("The identity provider did not return a trusted sign-in URL.");
      const redirect = new URL(result.url, location.origin);
      if (redirect.protocol !== "https:" && redirect.origin !== location.origin)
        throw new Error("Untrusted sign-in redirect.");
      location.assign(redirect.toString());
    } catch (caught) {
      this.busy = undefined;
      this.error = this.message(caught, `${provider} sign-in could not start.`);
      this.render();
    }
  }

  private async passkeySignIn(): Promise<void> {
    if (!browserSupportsPasskeys()) return;
    this.busy = "passkey";
    this.render();
    try {
      const options = await api.get<unknown>("/api/auth/passkey/generate-authenticate-options");
      const credential = (await navigator.credentials.get({
        publicKey: publicKeyRequestOptions(options),
      })) as PublicKeyCredential | null;
      if (!credential) throw new Error("Passkey sign-in was cancelled.");
      await api.post("/api/auth/passkey/verify-authentication", { response: serializeCredential(credential) });
      this.busy = undefined;
      await this.bootstrap();
    } catch (caught) {
      this.busy = undefined;
      this.error = this.message(caught, "Passkey sign-in failed.");
      this.render();
    }
  }

  private async passkeyRegister(): Promise<void> {
    if (!browserSupportsPasskeys() || !this.session) return;
    this.busy = "passkey-register";
    this.render();
    try {
      const options = await api.get<unknown>(
        "/api/auth/passkey/generate-register-options?authenticatorAttachment=platform&name=RoamCode",
      );
      const credential = (await navigator.credentials.create({
        publicKey: publicKeyCreationOptions(options),
      })) as PublicKeyCredential | null;
      if (!credential) throw new Error("Passkey registration was cancelled.");
      await api.post("/api/auth/passkey/verify-registration", {
        response: serializeCredential(credential),
        name: "RoamCode",
      });
      this.notice = "Passkey added to your account.";
    } catch (caught) {
      this.error = this.message(caught, "Passkey registration failed.");
    } finally {
      this.busy = undefined;
      this.render();
    }
  }

  private async resendVerification(): Promise<void> {
    const email = this.pendingVerificationEmail ?? this.session?.user.email;
    if (!email) return;
    this.busy = "resend";
    this.render();
    try {
      await api.post("/api/auth/send-verification-email", { email, callbackURL: `${location.origin}/app` });
      this.notice = "Verification email queued.";
    } catch (caught) {
      this.error = this.message(caught, "The verification email could not be sent.");
    } finally {
      this.busy = undefined;
      this.render();
    }
  }

  private async requestPasswordReset(email: string): Promise<void> {
    this.busy = "reset-request";
    this.render();
    try {
      await api.post("/api/auth/request-password-reset", {
        email: email.trim().toLowerCase(),
        redirectTo: `${location.origin}/app/reset-password`,
      });
      this.notice =
        this.providers.mode === "self_hosted"
          ? "If that account exists, a recovery link was written to the operator-only file outbox. Ask your operator to deliver it."
          : "If that account exists, a recovery link is on its way.";
    } catch (caught) {
      this.error = this.message(caught, "The reset request could not be sent.");
    } finally {
      this.busy = undefined;
      this.render();
    }
  }

  private async resetPassword(token: string, password: string): Promise<void> {
    this.busy = "reset-password";
    this.render();
    try {
      await api.post("/api/auth/reset-password", { token, newPassword: password });
      safeStorage(sessionStorage, "remove", RESET_KEY);
      this.resetToken = undefined;
      history.replaceState(history.state, "", "/app");
      this.route = "sessions";
      this.notice = "Password updated. Sign in again on devices that were revoked.";
      await this.bootstrap();
    } catch (caught) {
      this.busy = undefined;
      this.error = this.message(caught, "The password could not be reset.");
      this.render();
    }
  }

  private async signOut(): Promise<void> {
    this.busy = "sign-out";
    this.render();
    try {
      await api.post("/api/auth/sign-out", {});
    } catch {
      // Re-reading the server session below remains authoritative even if the response was interrupted.
    }
    this.session = undefined;
    this.contexts = [];
    this.context = undefined;
    this.hosts = [];
    this.members = [];
    this.membersState = "idle";
    this.membersError = undefined;
    this.membership = undefined;
    this.invites = [];
    this.invitesState = "idle";
    this.invitesError = undefined;
    this.grants = [];
    this.grantsState = "idle";
    this.grantsError = undefined;
    this.accessRequests = [];
    this.accessRequestsState = "idle";
    this.accessRequestsError = undefined;
    this.pendingMemberRemovalId = undefined;
    this.pendingInviteRevocationId = undefined;
    this.pendingGrantRevocationId = undefined;
    this.hostStatuses.clear();
    this.hostAccess.clear();
    this.hostAccessState = "idle";
    this.hostAccessError = undefined;
    this.cloudDevices = [];
    this.cloudDevicesState = "idle";
    this.cloudDevicesError = undefined;
    this.pendingDeviceRevocationId = undefined;
    this.managedHostDevices = [];
    this.managedHostDevicesState = "idle";
    this.managedHostDevicesError = undefined;
    this.pendingManagedHostDeviceRevocationId = undefined;
    this.contextLoadController?.abort();
    this.contextLoadGeneration += 1;
    this.peopleLoadController?.abort();
    this.peopleLoadGeneration += 1;
    this.accountLoadGeneration += 1;
    this.contextLoaded = false;
    this.busy = undefined;
    this.render();
  }

  private async inspectActivation(): Promise<void> {
    if (!this.activationCode || !this.session) return;
    this.busy = "inspect-device";
    this.deviceInspection = undefined;
    this.render();
    try {
      this.deviceInspection = await api.post<DeviceInspection>("/api/v1/auth/device/inspect", {
        user_code: this.activationCode,
      });
      const url = new URL("/activate", location.origin);
      url.searchParams.set("user_code", this.activationCode);
      history.replaceState(history.state, "", url);
    } catch (caught) {
      this.error = this.message(caught, "That device code is invalid or expired.");
    } finally {
      this.busy = undefined;
      this.render();
    }
  }

  private async verifyDevice(decision: "approve" | "deny"): Promise<void> {
    if (!this.deviceInspection) return;
    const selectedOrganizationId =
      decision === "approve"
        ? (document.getElementById("activation-organization") as HTMLSelectElement | null)?.value
        : undefined;
    this.busy = decision === "approve" ? "approve-device" : "deny-device";
    this.render();
    try {
      if (decision === "approve") {
        const organizationId = selectedOrganizationId ?? this.context?.id;
        if (!organizationId) throw new Error("Choose an organization for this device.");
        await api.post("/api/v1/auth/device/verify", {
          user_code: this.activationCode,
          organization_id: organizationId,
          decision: "approve",
          client_id: this.deviceInspection.client.id,
          approved_scopes: this.deviceInspection.scopes,
        });
      } else {
        await api.post("/api/v1/auth/device/verify", { user_code: this.activationCode, decision: "deny" });
      }
      this.activationComplete = decision === "approve" ? "approved" : "denied";
      history.replaceState(history.state, "", "/activate");
    } catch (caught) {
      this.error = this.message(caught, "The device decision could not be recorded.");
    } finally {
      this.busy = undefined;
      this.render();
    }
  }

  private async acceptInvite(): Promise<void> {
    if (!this.inviteToken) return;
    this.busy = "accept-invite";
    this.render();
    try {
      await api.post("/api/v1/invites/accept", { token: this.inviteToken });
      safeStorage(sessionStorage, "remove", INVITE_KEY);
      this.inviteToken = undefined;
      this.inviteComplete = true;
      await this.loadAccountBootstrap();
    } catch (caught) {
      this.error = this.message(caught, "The invitation is invalid, expired, or belongs to another email address.");
    } finally {
      this.busy = undefined;
      this.render();
    }
  }

  private async inviteMember(email: string, role: string): Promise<void> {
    if (!this.context || !this.canManagePeople()) return;
    if (role !== "admin" && role !== "member" && role !== "viewer") return;
    this.busy = "invite-member";
    this.oneTimeInviteUrl = undefined;
    this.render();
    try {
      const response = await api.post<OrganizationInviteCreation>(
        `/api/v1/orgs/${encodeURIComponent(this.context.id)}/invites`,
        {
          email: email.trim().toLowerCase(),
          role,
        },
      );
      this.oneTimeInviteUrl = readSameOriginInviteUrl(response.invite_url);
      this.notice = this.oneTimeInviteUrl ? "Invitation created. Copy its one-time link now." : "Invitation created.";
      await this.loadPeopleData();
    } catch (caught) {
      this.error = this.message(caught, "The invitation could not be created.");
    } finally {
      this.busy = undefined;
      this.render();
    }
  }

  private async updateMember(
    userId: string | undefined,
    patch: { role?: "admin" | "member" | "viewer"; status?: "active" | "suspended" },
  ): Promise<void> {
    if (!this.context || !this.canManagePeople() || this.busy?.startsWith("member:")) return;
    const member = this.members.find((candidate) => candidate.userId === userId);
    if (!member || member.role === "owner" || member.userId === this.session?.user.id) return;
    if ((patch.role && patch.role === member.role) || (patch.status && patch.status === member.status)) return;
    this.busy = `member:${member.userId}`;
    this.render();
    try {
      const response = await api.patch<{ member: Member }>(
        `/api/v1/orgs/${encodeURIComponent(this.context.id)}/members/${encodeURIComponent(member.userId)}`,
        patch,
      );
      this.members = this.members.map((candidate) =>
        candidate.userId === response.member.userId ? response.member : candidate,
      );
      this.notice = `${response.member.name}'s Organization access was updated.`;
      await this.loadPeopleData();
    } catch (caught) {
      this.error = this.message(caught, "The member could not be updated.");
    } finally {
      this.busy = undefined;
      this.render();
    }
  }

  private async removeMember(userId: string | undefined): Promise<void> {
    if (!this.context || !this.canManagePeople() || this.busy?.startsWith("member:")) return;
    const member = this.members.find((candidate) => candidate.userId === userId);
    if (
      !member ||
      member.role === "owner" ||
      member.userId === this.session?.user.id ||
      this.pendingMemberRemovalId !== member.userId
    )
      return;
    this.busy = `member:${member.userId}`;
    this.render();
    try {
      await api.delete<void>(
        `/api/v1/orgs/${encodeURIComponent(this.context.id)}/members/${encodeURIComponent(member.userId)}`,
      );
      this.members = this.members.filter((candidate) => candidate.userId !== member.userId);
      this.pendingMemberRemovalId = undefined;
      this.notice = `${member.name} was removed and their Organization access was revoked.`;
      await this.loadPeopleData();
    } catch (caught) {
      this.error = this.message(caught, "The member could not be removed.");
    } finally {
      this.busy = undefined;
      this.render();
    }
  }

  private async revokeInvite(inviteId: string | undefined): Promise<void> {
    if (!this.context || !this.canManagePeople() || this.busy?.startsWith("invite:")) return;
    const invite = this.invites.find((candidate) => candidate.id === inviteId && candidate.status === "pending");
    if (!invite || this.pendingInviteRevocationId !== invite.id) return;
    this.busy = `invite:${invite.id}`;
    this.render();
    try {
      await api.delete<void>(
        `/api/v1/orgs/${encodeURIComponent(this.context.id)}/invites/${encodeURIComponent(invite.id)}`,
      );
      this.invites = this.invites.filter((candidate) => candidate.id !== invite.id);
      this.pendingInviteRevocationId = undefined;
      this.notice = `The invitation for ${invite.email} was revoked.`;
    } catch (caught) {
      this.error = this.message(caught, "The invitation could not be revoked.");
    } finally {
      this.busy = undefined;
      this.render();
    }
  }

  private async upsertNodeGrant(principalUserId: string, hostId: string, permission: string): Promise<void> {
    if (!this.context || !this.canManagePeople() || this.busy) return;
    const member = this.members.find(
      (candidate) =>
        candidate.userId === principalUserId && candidate.status === "active" && candidate.role !== "owner",
    );
    const host = this.hosts.find((candidate) => candidate.id === hostId);
    if (!member || !host || (permission !== "use" && permission !== "manage")) return;
    this.busy = "grant:create";
    this.render();
    try {
      const response = await api.post<{ grant: OrganizationGrant }>(
        `/api/v1/orgs/${encodeURIComponent(this.context.id)}/grants`,
        { principal_user_id: member.userId, host_id: host.id, permission },
      );
      this.grants = [
        response.grant,
        ...this.grants.filter(
          (candidate) =>
            !(
              candidate.principalUserId === response.grant.principalUserId && candidate.hostId === response.grant.hostId
            ),
        ),
      ];
      this.notice = `${member.name} now has ${permission} access to ${host.name}.`;
      await this.loadPeopleData();
    } catch (caught) {
      this.error = this.message(caught, "The Node grant could not be saved.");
    } finally {
      this.busy = undefined;
      this.render();
    }
  }

  private async revokeGrant(grantId: string | undefined): Promise<void> {
    if (!this.context || !this.canManagePeople() || this.busy?.startsWith("grant:")) return;
    const grant = this.grants.find((candidate) => candidate.id === grantId);
    if (!grant || this.pendingGrantRevocationId !== grant.id) return;
    this.busy = `grant:${grant.id}`;
    this.render();
    try {
      await api.delete<void>(
        `/api/v1/orgs/${encodeURIComponent(this.context.id)}/grants/${encodeURIComponent(grant.id)}`,
      );
      this.grants = this.grants.filter((candidate) => candidate.id !== grant.id);
      this.pendingGrantRevocationId = undefined;
      this.notice = "The Node grant was revoked.";
    } catch (caught) {
      this.error = this.message(caught, "The Node grant could not be revoked.");
    } finally {
      this.busy = undefined;
      this.render();
    }
  }

  private async reviewAccessRequest(requestId: string | undefined, status: "approved" | "denied"): Promise<void> {
    if (!this.context || !this.canManagePeople() || this.busy?.startsWith("request:")) return;
    const request = this.accessRequests.find(
      (candidate) => candidate.id === requestId && candidate.status === "pending",
    );
    if (!request || (status === "approved" && request.permission === "view")) return;
    this.busy = `request:${request.id}`;
    this.render();
    try {
      const response = await api.patch<{ access_request: OrganizationAccessRequest }>(
        `/api/v1/orgs/${encodeURIComponent(this.context.id)}/access-requests/${encodeURIComponent(request.id)}`,
        { status },
      );
      this.accessRequests = this.accessRequests.map((candidate) =>
        candidate.id === response.access_request.id ? response.access_request : candidate,
      );
      this.notice = `The access request was ${status}.`;
      await this.loadPeopleData();
    } catch (caught) {
      this.error = this.message(caught, "The access request could not be reviewed.");
    } finally {
      this.busy = undefined;
      this.render();
    }
  }

  private async requestNodeAccess(hostId: string, permission: string, reasonInput: string): Promise<void> {
    if (
      !this.productLaunch.managedTerminal ||
      !this.context ||
      this.context.kind !== "organization" ||
      this.isContextAdmin() ||
      this.busy
    )
      return;
    const host = this.hosts.find((candidate) => candidate.id === hostId);
    const reason = reasonInput.trim().replace(/\s+/g, " ");
    if (!host || (permission !== "use" && permission !== "manage") || reason.length < 1 || reason.length > 500) {
      this.error = "Choose a valid permission and enter a reason of up to 500 characters.";
      this.render();
      return;
    }
    this.busy = "request-access";
    this.render();
    try {
      await api.post<{ access_request: OrganizationAccessRequest }>(
        `/api/v1/orgs/${encodeURIComponent(this.context.id)}/access-requests`,
        { host_id: host.id, permission, reason },
      );
      const url = new URL(location.href);
      url.searchParams.delete("request");
      history.replaceState(history.state, "", url);
      this.notice = `Access request sent for ${host.name}. An Organization admin must approve it before you try again.`;
      await this.loadContext(this.context.id);
    } catch (caught) {
      this.error = this.message(caught, "The access request could not be sent.");
    } finally {
      this.busy = undefined;
      this.render();
    }
  }
}

export function mountAccountShell(): void {
  void new AccountShell().start();
}
