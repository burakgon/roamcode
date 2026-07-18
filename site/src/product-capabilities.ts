export const PRODUCT_CAPABILITIES_ENDPOINT = "/api/v1/meta/product-capabilities";

export const REQUIRED_MANAGED_NODE_CAPABILITIES = ["terminal.v1", "relay.v1", "managed-device-enrollment.v1"] as const;

export interface ProductLaunchCapabilities {
  readonly v: 1 | null;
  readonly account: boolean;
  readonly managedTerminal: boolean;
}

export const CLOSED_PRODUCT_LAUNCH_CAPABILITIES: ProductLaunchCapabilities = Object.freeze({
  v: null,
  account: false,
  managedTerminal: false,
});

function isUniqueStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((item) => typeof item === "string" && item.length > 0) &&
    new Set(value).size === value.length
  );
}

function hasExactManagedNodeCapabilities(value: string[]): boolean {
  return (
    value.length === REQUIRED_MANAGED_NODE_CAPABILITIES.length &&
    REQUIRED_MANAGED_NODE_CAPABILITIES.every((capability) => value.includes(capability))
  );
}

/**
 * Converts the public control-plane document into the only launch decisions the site may use.
 * Unknown, older, newer, partial, and malformed documents deliberately resolve to closed gates.
 */
export function readProductLaunchCapabilities(value: unknown): ProductLaunchCapabilities {
  if (!value || typeof value !== "object") return CLOSED_PRODUCT_LAUNCH_CAPABILITIES;
  const document = value as Record<string, unknown>;
  const launch = document.launch;
  if (
    document.v !== 1 ||
    !launch ||
    typeof launch !== "object" ||
    typeof (launch as Record<string, unknown>).account !== "boolean" ||
    typeof (launch as Record<string, unknown>).managedTerminal !== "boolean" ||
    !isUniqueStringArray(document.capabilities) ||
    !isUniqueStringArray(document.requiredNodeCapabilities)
  ) {
    return CLOSED_PRODUCT_LAUNCH_CAPABILITIES;
  }

  const launchRecord = launch as { account: boolean; managedTerminal: boolean };
  const account = launchRecord.account && document.capabilities.includes("account.v1");
  const managedTerminal =
    account &&
    launchRecord.managedTerminal &&
    document.capabilities.includes("managed-device-enrollment.v1") &&
    hasExactManagedNodeCapabilities(document.requiredNodeCapabilities);

  return Object.freeze({ v: 1, account, managedTerminal });
}

export async function fetchProductLaunchCapabilities(
  fetcher: typeof fetch = fetch,
): Promise<ProductLaunchCapabilities> {
  try {
    const response = await fetcher(PRODUCT_CAPABILITIES_ENDPOINT, {
      cache: "no-store",
      credentials: "omit",
      headers: { accept: "application/json" },
    });
    if (!response.ok) return CLOSED_PRODUCT_LAUNCH_CAPABILITIES;
    return readProductLaunchCapabilities(await response.json());
  } catch {
    return CLOSED_PRODUCT_LAUNCH_CAPABILITIES;
  }
}

/** Keeps static marketing CTAs closed until the current control plane proves account launch compatibility. */
export async function revealHostedAccountEntries(
  root: ParentNode = document,
  fetcher: typeof fetch = fetch,
): Promise<ProductLaunchCapabilities> {
  const entries = Array.from(root.querySelectorAll<HTMLElement>("[data-hosted-account-entry]"));
  for (const entry of entries) entry.hidden = true;
  const capabilities = await fetchProductLaunchCapabilities(fetcher);
  if (capabilities.account) {
    for (const entry of entries) entry.hidden = false;
  }
  return capabilities;
}
