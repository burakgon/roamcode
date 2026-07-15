import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { normalizePeerBaseUrl, openPeerStore, PeerRevisionConflictError } from "../src/peer-store.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function dbPath(): string {
  const directory = mkdtempSync(join(tmpdir(), "roamcode-peers-"));
  dirs.push(directory);
  return join(directory, "peers.db");
}

function input() {
  return {
    label: "Build host",
    baseUrl: "https://build.example.test",
    credential: `rcd_${"c".repeat(43)}`,
    remoteHostId: "host-build",
    remoteVersion: "1.2.3",
    actions: ["read", "wait"] as const,
    allowedWorkspaceIds: ["workspace-1"],
  };
}

describe("peer store", () => {
  test("persists scoped peer connections without exposing credentials through inventory", () => {
    const path = dbPath();
    const store = openPeerStore({ dbPath: path, generatePeerId: () => "peer-1" });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const created = store.create({ ...input(), actions: [...input().actions] }, 10);
    expect(created).toMatchObject({
      id: "peer-1",
      label: "Build host",
      remoteHostId: "host-build",
      actions: ["read", "wait"],
      allowedWorkspaceIds: ["workspace-1"],
      revision: 1,
    });
    expect(JSON.stringify(created)).not.toContain("credential");
    expect(JSON.stringify(created)).not.toContain("build.example.test");
    expect(store.connection(created.id)).toMatchObject({
      baseUrl: "https://build.example.test",
      credential: `rcd_${"c".repeat(43)}`,
    });
    store.close();

    const reopened = openPeerStore({ dbPath: path });
    expect(reopened.list()).toEqual([created]);
    expect(reopened.connection(created.id)?.credential).toBe(`rcd_${"c".repeat(43)}`);
    reopened.close();
  });

  test("uses deterministic revisions and validates action dependencies", () => {
    const store = openPeerStore({ dbPath: ":memory:", generatePeerId: () => "peer-1" });
    const created = store.create({ ...input(), actions: [...input().actions] }, 10);
    const updated = store.update(created.id, { actions: ["read", "wait", "send"], status: "suspended" }, 1, 11);
    expect(updated).toMatchObject({ actions: ["read", "wait", "send"], status: "suspended", revision: 2 });
    expect(() => store.update(created.id, { label: "stale" }, 1, 12)).toThrow(PeerRevisionConflictError);
    expect(() => store.update(created.id, { actions: ["send"] }, 2, 12)).toThrow(/require read/);
    store.close();
  });

  test("denies every remote workspace until an administrator selects a scope", () => {
    const store = openPeerStore({ dbPath: ":memory:", generatePeerId: () => "peer-1" });
    const scoped = input();
    const created = store.create({
      label: scoped.label,
      baseUrl: scoped.baseUrl,
      credential: scoped.credential,
      remoteHostId: scoped.remoteHostId,
      remoteVersion: scoped.remoteVersion,
    });
    expect(created).toMatchObject({ actions: ["read", "wait"], allowedWorkspaceIds: [] });
    store.close();
  });

  test("accepts HTTPS and loopback HTTP origins but rejects credential-bearing or routed URLs", () => {
    expect(normalizePeerBaseUrl("https://host.example.test")).toBe("https://host.example.test");
    expect(normalizePeerBaseUrl("http://127.0.0.1:4280")).toBe("http://127.0.0.1:4280");
    for (const value of [
      "http://host.example.test",
      "https://user:pass@host.example.test",
      "https://host.example.test/path",
      "https://host.example.test/?token=secret",
    ]) {
      expect(() => normalizePeerBaseUrl(value)).toThrow();
    }
  });

  test("rejects duplicate origins and remote host identities", () => {
    const store = openPeerStore({
      dbPath: ":memory:",
      generatePeerId: (() => {
        let id = 0;
        return () => `peer-${++id}`;
      })(),
    });
    store.create({ ...input(), actions: [...input().actions] });
    expect(() => store.create({ ...input(), label: "Duplicate", actions: [...input().actions] })).toThrow(
      /already exists/,
    );
    expect(() =>
      store.create({
        ...input(),
        label: "Same host",
        baseUrl: "https://other.example.test",
        actions: [...input().actions],
      }),
    ).toThrow(/already exists/);
    store.close();
  });
});
