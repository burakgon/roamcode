import { describe, expect, test } from "vitest";
import { parseRelayRpcRequest, relayRpcResponse, RELAY_RPC_MAX_BODY_BYTES } from "../src/relay-rpc.js";

describe("relay RPC boundary", () => {
  test("accepts bounded API requests and canonical binary bodies", () => {
    const body = Buffer.from('{"label":"Studio"}');
    expect(
      parseRelayRpcRequest({
        id: "request-1",
        method: "POST",
        path: "/api/v1/workspaces?include=active",
        headers: { "content-type": "application/json", "idempotency-key": "once-1" },
        body: body.toString("base64url"),
      }),
    ).toEqual({
      id: "request-1",
      method: "POST",
      path: "/api/v1/workspaces?include=active",
      headers: { "content-type": "application/json", "idempotency-key": "once-1" },
      body,
    });
  });

  test("rejects credential smuggling, absolute paths, malformed base64, and oversized bodies", () => {
    const base = { id: "request-1", method: "POST", path: "/api/v1/workspaces" };
    expect(() => parseRelayRpcRequest({ ...base, headers: { authorization: "Bearer stolen" } })).toThrow("headers");
    expect(() => parseRelayRpcRequest({ ...base, path: "//metadata.internal/latest" })).toThrow("path");
    expect(() => parseRelayRpcRequest({ ...base, path: "/safe\\..\\escape" })).toThrow("path");
    expect(() => parseRelayRpcRequest({ ...base, body: "not+canonical" })).toThrow("body");
    expect(() =>
      parseRelayRpcRequest({ ...base, body: Buffer.alloc(RELAY_RPC_MAX_BODY_BYTES + 1).toString("base64url") }),
    ).toThrow("body");
    expect(() => parseRelayRpcRequest({ ...base, method: "GET", body: "YQ" })).toThrow("body");
  });

  test("returns only browser-safe response metadata and keeps bytes opaque", () => {
    const response = relayRpcResponse({
      id: "request-2",
      status: 206,
      headers: {
        "content-type": "application/octet-stream",
        "content-range": "bytes 0-3/4",
        "set-cookie": "secret=value",
        authorization: "never",
      },
      body: Buffer.from([0, 1, 2, 3]),
    });
    expect(response).toEqual({
      id: "request-2",
      status: 206,
      headers: { "content-type": "application/octet-stream", "content-range": "bytes 0-3/4" },
      body: "AAECAw",
    });
  });
});
