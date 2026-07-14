import { describe, expect, it, vi } from "vitest";
import {
  clientRunsBuildVersion,
  respondToServiceWorkerVersionProbe,
  SW_VERSION_PROBE,
  SW_VERSION_REPLY,
} from "./sw-version-handshake";

describe("service-worker version handshake", () => {
  it("lets a current page report its exact bundle version", () => {
    const postMessage = vi.fn();
    expect(
      respondToServiceWorkerVersionProbe(
        { data: { type: SW_VERSION_PROBE }, ports: [{ postMessage } as unknown as MessagePort] },
        "1.0.15",
      ),
    ).toBe(true);
    expect(postMessage).toHaveBeenCalledWith({ type: SW_VERSION_REPLY, version: "1.0.15" });
  });

  it("distinguishes a matching client from an older bundle", async () => {
    const probe = async (replyVersion: string) => {
      let onmessage: ((event: MessageEvent) => void) | null = null;
      const port1 = {
        close: vi.fn(),
        start: vi.fn(),
        get onmessage() {
          return onmessage;
        },
        set onmessage(value) {
          onmessage = value;
        },
      } as unknown as MessagePort;
      const port2 = {} as MessagePort;
      const client = {
        postMessage: () =>
          queueMicrotask(() =>
            onmessage?.({ data: { type: SW_VERSION_REPLY, version: replyVersion } } as MessageEvent),
          ),
      } as unknown as Client;
      return clientRunsBuildVersion(client, "1.0.15", 100, () => ({ port1, port2 }) as MessageChannel);
    };

    await expect(probe("1.0.15")).resolves.toBe(true);
    await expect(probe("1.0.14")).resolves.toBe(false);
  });
});
