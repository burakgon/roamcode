import { beforeEach, describe, expect, test, vi } from "vitest";

import {
  CLOSED_PRODUCT_LAUNCH_CAPABILITIES,
  fetchProductLaunchCapabilities,
  PRODUCT_CAPABILITIES_ENDPOINT,
  readProductLaunchCapabilities,
  revealHostedAccountEntries,
} from "./product-capabilities";

const compatibleDocument = {
  v: 1,
  launch: { account: true, managedTerminal: true },
  capabilities: ["account.v1", "managed-device-enrollment.v1"],
  requiredNodeCapabilities: ["terminal.v1", "relay.v1", "managed-device-enrollment.v1"],
};

describe("hosted product capability contract", () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  test("opens both gates only for the exact compatible v1 contract", () => {
    expect(readProductLaunchCapabilities(compatibleDocument)).toEqual({
      v: 1,
      account: true,
      managedTerminal: true,
    });
    expect(
      readProductLaunchCapabilities({
        ...compatibleDocument,
        requiredNodeCapabilities: ["managed-device-enrollment.v1", "terminal.v1", "relay.v1"],
      }),
    ).toEqual({ v: 1, account: true, managedTerminal: true });
  });

  test.each([
    ["missing document", undefined],
    ["future version", { ...compatibleDocument, v: 2 }],
    ["missing launch object", { ...compatibleDocument, launch: undefined }],
    ["missing account capability", { ...compatibleDocument, capabilities: ["managed-device-enrollment.v1"] }],
    ["disabled account launch", { ...compatibleDocument, launch: { account: false, managedTerminal: true } }],
  ])("keeps the hosted account closed for %s", (_name, document) => {
    expect(readProductLaunchCapabilities(document).account).toBe(false);
  });

  test.each([
    ["disabled launch", { ...compatibleDocument, launch: { account: true, managedTerminal: false } }],
    ["missing product capability", { ...compatibleDocument, capabilities: ["account.v1"] }],
    [
      "missing Node requirement",
      { ...compatibleDocument, requiredNodeCapabilities: ["terminal.v1", "managed-device-enrollment.v1"] },
    ],
    [
      "additional Node requirement",
      {
        ...compatibleDocument,
        requiredNodeCapabilities: ["terminal.v1", "relay.v1", "managed-device-enrollment.v1", "unknown.v1"],
      },
    ],
  ])("keeps managed enrollment closed for %s", (_name, document) => {
    expect(readProductLaunchCapabilities(document)).toMatchObject({ v: 1, account: true, managedTerminal: false });
  });

  test("uses a public no-store request and fails closed on old-control-plane responses", async () => {
    const fetcher = vi.fn(async () => Response.json({ error: "not_found" }, { status: 404 }));
    await expect(fetchProductLaunchCapabilities(fetcher)).resolves.toBe(CLOSED_PRODUCT_LAUNCH_CAPABILITIES);
    expect(fetcher).toHaveBeenCalledWith(PRODUCT_CAPABILITIES_ENDPOINT, {
      cache: "no-store",
      credentials: "omit",
      headers: { accept: "application/json" },
    });

    fetcher.mockRejectedValueOnce(new Error("offline"));
    await expect(fetchProductLaunchCapabilities(fetcher)).resolves.toBe(CLOSED_PRODUCT_LAUNCH_CAPABILITIES);
  });

  test("reveals marketing account creation only after a compatible response", async () => {
    document.body.innerHTML = `<a data-hosted-account-entry href="/app?mode=sign-up">Create account</a>`;
    const entry = document.querySelector<HTMLAnchorElement>("[data-hosted-account-entry]")!;
    let release: ((response: Response) => void) | undefined;
    const fetcher = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    );

    const pending = revealHostedAccountEntries(document, fetcher);
    expect(entry.hidden).toBe(true);
    release?.(Response.json(compatibleDocument));
    await expect(pending).resolves.toMatchObject({ account: true });
    expect(entry.hidden).toBe(false);

    await revealHostedAccountEntries(document, async () => Response.json({ ...compatibleDocument, v: 2 }));
    expect(entry.hidden).toBe(true);
  });
});
