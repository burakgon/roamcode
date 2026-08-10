import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { IDEMPOTENCY_TTL_MS, openIdempotencyStore } from "../src/idempotency-store.js";

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("idempotency store", () => {
  it("persists retry responses in the existing control database", async () => {
    const directory = await mkdtemp(join(tmpdir(), "roamcode-idempotency-"));
    temporary.push(directory);
    const dbPath = join(directory, "control.db");
    const first = openIdempotencyStore({ dbPath });
    first.put({
      actorId: "device-1",
      key: "create-workspace-1",
      fingerprint: "fingerprint",
      statusCode: 201,
      body: "{}",
      createdAt: 10,
      expiresAt: 10 + IDEMPOTENCY_TTL_MS,
    });
    first.close();

    const reopened = openIdempotencyStore({ dbPath });
    expect(reopened.get("device-1", "create-workspace-1", 11)?.statusCode).toBe(201);
    expect(reopened.get("device-1", "create-workspace-1", 10 + IDEMPOTENCY_TTL_MS)).toBeUndefined();
    reopened.close();
  });
});
