import { describe, expect, test } from "vitest";
import {
  EnterprisePolicyRevisionConflictError,
  evaluateEnterprisePolicy,
  openPolicyStore,
  type OpenPolicyStoreOptions,
} from "../src/policy-store.js";

function options(memory: boolean): OpenPolicyStoreOptions {
  return {
    dbPath: ":memory:",
    now: 10,
    ...(memory
      ? {
          loadDatabase: () => {
            throw new Error("memory fixture");
          },
        }
      : {}),
  };
}

describe.each([
  ["memory fallback", true],
  ["sqlite", false],
] as const)("enterprise policy store: %s", (_label, memory) => {
  test("starts non-enforcing and applies revisioned, normalized updates", () => {
    const store = openPolicyStore(options(memory));
    const initial = store.get();
    expect(initial).toMatchObject({
      enforcementEnabled: false,
      allowDangerousProviderModes: false,
      allowFileTransfer: true,
      extensionMode: "allow-integrity",
      allowRelay: true,
      updateMode: "stable-only",
      revision: 1,
    });
    const updated = store.update(
      {
        enforcementEnabled: true,
        allowedHostIds: ["host-b", "host-a", "host-a"],
        allowedWorkspaceIds: ["workspace-a"],
        allowedProviderIds: ["codex"],
        allowFileTransfer: false,
        extensionMode: "signed-only",
        allowRelay: false,
        updateMode: "deny",
      },
      initial.revision,
      20,
    );
    expect(updated).toMatchObject({
      allowedHostIds: ["host-a", "host-b"],
      allowedWorkspaceIds: ["workspace-a"],
      allowedProviderIds: ["codex"],
      revision: 2,
      updatedAt: 20,
    });
    expect(() => store.update({ allowRelay: true }, initial.revision, 30)).toThrow(
      EnterprisePolicyRevisionConflictError,
    );
    expect(store.get()).toEqual(updated);
    store.close();
  });

  test("rejects unknown, malformed, and empty policy writes", () => {
    const store = openPolicyStore(options(memory));
    expect(() => store.update({}, 1)).toThrow(/empty/);
    expect(() => store.update({ allowedProviderIds: ["Bad Provider"] }, 1)).toThrow(/provider/);
    expect(() => store.update({ extensionMode: "anything" as "deny" }, 1)).toThrow(/extension/);
    expect(() => store.update({ unknown: true } as never, 1)).toThrow(/field/);
    store.close();
  });
});

test("policy decisions cover host, workspace, provider, danger, transfer, extensions, relay, and updates", () => {
  const store = openPolicyStore(options(true));
  const policy = store.update(
    {
      enforcementEnabled: true,
      allowedHostIds: ["host-a"],
      allowedWorkspaceIds: ["workspace-a"],
      allowedProviderIds: ["codex"],
      allowDangerousProviderModes: false,
      allowFileTransfer: false,
      extensionMode: "signed-only",
      allowRelay: false,
      updateMode: "stable-only",
    },
    1,
  );
  expect(evaluateEnterprisePolicy(policy, "access", { hostId: "host-b" }).reason).toBe("host-denied");
  expect(evaluateEnterprisePolicy(policy, "access", { hostId: "host-a", workspaceId: "workspace-b" }).reason).toBe(
    "workspace-denied",
  );
  expect(
    evaluateEnterprisePolicy(policy, "session.launch", {
      hostId: "host-a",
      workspaceId: "workspace-a",
      providerId: "claude",
    }).reason,
  ).toBe("provider-denied");
  expect(
    evaluateEnterprisePolicy(policy, "session.launch", {
      hostId: "host-a",
      workspaceId: "workspace-a",
      providerId: "codex",
      dangerousProviderMode: true,
    }).reason,
  ).toBe("dangerous-mode-denied");
  expect(evaluateEnterprisePolicy(policy, "file.transfer", { hostId: "host-a" }).reason).toBe("file-transfer-denied");
  expect(
    evaluateEnterprisePolicy(policy, "extension.mutate", { hostId: "host-a", extensionTrust: "integrity" }).reason,
  ).toBe("extension-signature-required");
  expect(
    evaluateEnterprisePolicy(policy, "extension.mutate", { hostId: "host-a", extensionTrust: "signed" }).allowed,
  ).toBe(true);
  expect(evaluateEnterprisePolicy(policy, "relay.access", { hostId: "host-a" }).reason).toBe("relay-denied");
  expect(evaluateEnterprisePolicy(policy, "update.mutate", { hostId: "host-a", updateChannel: "beta" }).reason).toBe(
    "update-channel-denied",
  );
  expect(evaluateEnterprisePolicy(policy, "update.mutate", { hostId: "host-a", updateChannel: "stable" }).allowed).toBe(
    true,
  );
  store.close();
});
