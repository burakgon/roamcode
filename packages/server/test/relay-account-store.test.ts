import { describe, expect, test } from "vitest";
import {
  generateRelayAccountCredential,
  openRelayAccountStore,
  relayAccountCredentialHash,
  relayAccountCredentialLookup,
  RelayAccountRevisionConflictError,
} from "../src/relay-account-store.js";

for (const mode of ["memory", "sqlite"] as const) {
  describe(`relay account store (${mode})`, () => {
    function store() {
      return openRelayAccountStore({
        dbPath: ":memory:",
        generateAccountId: () => "rra_account1234567890",
        ...(mode === "memory"
          ? {
              loadDatabase: () => {
                throw new Error("native unavailable");
              },
            }
          : {}),
      });
    }

    test("stores only a hash and applies plan quotas", () => {
      const accounts = store();
      const credential = generateRelayAccountCredential();
      const account = accounts.createAccount({ label: "Acme engineering", credential, plan: "team" }, 10);
      expect(account).toMatchObject({
        id: "rra_account1234567890",
        label: "Acme engineering",
        status: "active",
        plan: "team",
        maxRoutes: 25,
        maxDevicesPerRoute: 64,
        revision: 1,
      });
      expect(JSON.stringify(account)).not.toContain(credential);
      expect(account).not.toHaveProperty("credentialHash");
      expect(account).not.toHaveProperty("credentialLookup");
      expect(accounts.authenticate(credential)).toEqual(account);
      expect(accounts.authenticate(generateRelayAccountCredential())).toBeUndefined();
      accounts.close();
    });

    test("rotation invalidates the previous credential and is revision guarded", () => {
      const accounts = store();
      const first = generateRelayAccountCredential();
      const next = generateRelayAccountCredential();
      const account = accounts.createAccount({ label: "Studio", credential: first }, 1);
      const rotated = accounts.rotateCredential(account.id, next, account.revision, 2)!;
      expect(rotated.revision).toBe(2);
      expect(accounts.authenticate(first)).toBeUndefined();
      expect(accounts.authenticate(next)?.id).toBe(account.id);
      expect(() => accounts.updateAccount(account.id, { label: "Stale" }, 1, 3)).toThrow(
        RelayAccountRevisionConflictError,
      );
      accounts.close();
    });

    test("accepts locally generated credential material without receiving the capability", () => {
      const accounts = store();
      const first = generateRelayAccountCredential();
      const created = accounts.createAccount(
        {
          label: "Local credential",
          credentialHash: relayAccountCredentialHash(first),
          credentialLookup: relayAccountCredentialLookup(first),
        },
        1,
      );
      expect(accounts.authenticate(first)?.id).toBe(created.id);

      const next = generateRelayAccountCredential();
      const rotated = accounts.rotateCredential(
        created.id,
        {
          credentialHash: relayAccountCredentialHash(next),
          credentialLookup: relayAccountCredentialLookup(next),
        },
        created.revision,
        2,
      )!;
      expect(rotated.revision).toBe(2);
      expect(accounts.authenticate(first)).toBeUndefined();
      expect(accounts.authenticate(next)?.id).toBe(created.id);
      accounts.close();
    });

    test("supports stable control-plane ids and constant-time material matching", () => {
      const accounts = store();
      const credential = generateRelayAccountCredential();
      const material = {
        credentialHash: relayAccountCredentialHash(credential),
        credentialLookup: relayAccountCredentialLookup(credential),
      };
      const created = accounts.createAccount({
        id: "rra_controlplane000001",
        label: "Control plane account",
        ...material,
      });

      expect(created.id).toBe("rra_controlplane000001");
      expect(accounts.credentialMatches(created.id, material)).toBe(true);
      expect(
        accounts.credentialMatches(created.id, {
          credentialHash: relayAccountCredentialHash(generateRelayAccountCredential()),
          credentialLookup: material.credentialLookup,
        }),
      ).toBe(false);
      expect(accounts.credentialMatches("rra_missingaccount0001", material)).toBe(false);
      accounts.close();
    });

    test("suspension is immediate and deletion is terminal", () => {
      const accounts = store();
      const credential = generateRelayAccountCredential();
      const account = accounts.createAccount({ label: "Studio", credential }, 1);
      const suspended = accounts.updateAccount(account.id, { status: "suspended" }, 1, 2)!;
      expect(accounts.authenticate(credential)).toBeUndefined();
      expect(accounts.verifyCredential(credential)).toEqual(suspended);
      const deleted = accounts.updateAccount(account.id, { status: "deleted" }, suspended.revision, 3)!;
      expect(accounts.verifyCredential(credential)).toBeUndefined();
      expect(accounts.listAccounts()).toEqual([]);
      expect(accounts.listAccounts({ includeDeleted: true })).toEqual([deleted]);
      expect(() => accounts.updateAccount(account.id, { status: "active" }, deleted.revision, 4)).toThrow("immutable");
      accounts.close();
    });

    test("rejects unsafe labels, credentials, and limits", () => {
      const accounts = store();
      expect(() =>
        accounts.createAccount({ label: "bad\0label", credential: generateRelayAccountCredential() }),
      ).toThrow("label");
      expect(() =>
        accounts.createAccount({ label: "Acme\u202Etxt.exe", credential: generateRelayAccountCredential() }),
      ).toThrow("label");
      expect(() => accounts.createAccount({ label: "Good", credential: "short" })).toThrow("credential");
      expect(() =>
        accounts.createAccount({
          label: "Good",
          credentialHash: "not-a-hash",
          credentialLookup: `lookup:${"a".repeat(43)}`,
        }),
      ).toThrow("hash");
      expect(() =>
        accounts.createAccount({ label: "Good", credential: generateRelayAccountCredential(), maxRoutes: 0 }),
      ).toThrow("route limit");
      accounts.close();
    });
  });
}
