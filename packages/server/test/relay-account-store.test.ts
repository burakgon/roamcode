import { describe, expect, test } from "vitest";
import {
  generateRelayAccountCredential,
  openRelayAccountStore,
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

    test("suspension is immediate and deletion is terminal", () => {
      const accounts = store();
      const credential = generateRelayAccountCredential();
      const account = accounts.createAccount({ label: "Studio", credential }, 1);
      const suspended = accounts.updateAccount(account.id, { status: "suspended" }, 1, 2)!;
      expect(accounts.authenticate(credential)).toBeUndefined();
      const deleted = accounts.updateAccount(account.id, { status: "deleted" }, suspended.revision, 3)!;
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
      expect(() => accounts.createAccount({ label: "Good", credential: "short" })).toThrow("credential");
      expect(() =>
        accounts.createAccount({ label: "Good", credential: generateRelayAccountCredential(), maxRoutes: 0 }),
      ).toThrow("route limit");
      accounts.close();
    });
  });
}
