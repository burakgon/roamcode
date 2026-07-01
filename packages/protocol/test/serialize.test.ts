import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import {
  buildImageBlock,
  serializeInitialize,
  serializeHookPermissionResponse,
  serializeCanUseToolResponse,
  classifyPermissionRequest,
  serializeRewindFiles,
  parseLine,
  type ControlRequestEvent,
} from "../src/index.js";

test("buildImageBlock embeds a base64 image", () => {
  expect(buildImageBlock("image/png", "QUJD")).toEqual({
    type: "image",
    source: { type: "base64", media_type: "image/png", data: "QUJD" },
  });
});

test("serializeInitialize registers a PreToolUse hook", () => {
  const obj = JSON.parse(serializeInitialize({ requestId: "init-1", hookCallbackId: "hook_0" }));
  expect(obj.type).toBe("control_request");
  expect(obj.request_id).toBe("init-1");
  expect(obj.request.subtype).toBe("initialize");
  expect(obj.request.hooks.PreToolUse[0].hookCallbackIds).toContain("hook_0");
});

test("serializeHookPermissionResponse(allow) matches the captured accepted envelope", () => {
  const obj = JSON.parse(serializeHookPermissionResponse("r1", "allow", "ok"));
  expect(obj).toEqual({
    type: "control_response",
    response: {
      subtype: "success",
      request_id: "r1",
      response: {
        async: false,
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "allow",
          permissionDecisionReason: "ok",
        },
      },
    },
  });
});

test("serializeCanUseToolResponse(deny) carries the message at response.response", () => {
  const obj = JSON.parse(serializeCanUseToolResponse("r2", { behavior: "deny", message: "no" }));
  expect(obj.response.request_id).toBe("r2");
  expect(obj.response.response).toEqual({ behavior: "deny", message: "no" });
});

test("classifyPermissionRequest extracts tool info from a hook_callback", () => {
  const ev = parseLine(
    JSON.stringify({
      type: "control_request",
      request_id: "r",
      request: {
        subtype: "hook_callback",
        input: { tool_name: "Write", tool_input: { file_path: "/a" }, tool_use_id: "t1" },
      },
    }),
  ) as ControlRequestEvent;
  expect(classifyPermissionRequest(ev)).toEqual({
    kind: "hook_callback",
    toolName: "Write",
    toolInput: { file_path: "/a" },
    toolUseId: "t1",
  });
});

test("golden: an allow response built from the captured hook_callback matches the captured accepted control_response", () => {
  const path = fileURLToPath(new URL("../fixtures/permission-turn.jsonl", import.meta.url));
  const events = readFileSync(path, "utf8")
    .split("\n")
    .map(parseLine)
    .filter((e) => e !== null);
  const req = events.find(
    (e) => e!.type === "control_request" && (e as ControlRequestEvent).subtype === "hook_callback",
  ) as ControlRequestEvent;
  const accepted = events.find((e) => e!.type === "control_response" && (e!.raw as { _dir?: string })._dir === "out");
  expect(req).toBeTruthy();
  expect(accepted).toBeTruthy();
  const built = JSON.parse(serializeHookPermissionResponse(req.requestId, "allow", "x"));
  const acc = accepted!.raw as { response: { response: { hookSpecificOutput: { permissionDecision: string } } } };
  expect(built.response.request_id).toBe((accepted as { requestId?: string }).requestId);
  expect(built.response.response.hookSpecificOutput.permissionDecision).toBe(
    acc.response.response.hookSpecificOutput.permissionDecision,
  );
});

test("serializeCanUseToolResponse(allow) carries the allow payload at response.response", () => {
  const obj = JSON.parse(serializeCanUseToolResponse("r3", { behavior: "allow", updatedInput: { a: 1 } }));
  expect(obj.type).toBe("control_response");
  expect(obj.response.request_id).toBe("r3");
  expect(obj.response.response).toEqual({ behavior: "allow", updatedInput: { a: 1 } });
});

test("classifyPermissionRequest extracts tool info from a can_use_tool request", () => {
  const ev = parseLine(
    JSON.stringify({
      type: "control_request",
      request_id: "r",
      request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "ls" }, tool_use_id: "t9" },
    }),
  ) as ControlRequestEvent;
  expect(classifyPermissionRequest(ev)).toEqual({
    kind: "can_use_tool",
    toolName: "Bash",
    toolInput: { command: "ls" },
    toolUseId: "t9",
  });
});

test("classifyPermissionRequest returns null for a non-permission control request", () => {
  const ev = parseLine(
    JSON.stringify({ type: "control_request", request_id: "r", request: { subtype: "mcp_message" } }),
  ) as ControlRequestEvent;
  expect(classifyPermissionRequest(ev)).toBeNull();
});

test("serializeInitialize with no args uses an init- prefix and registers hook_0", () => {
  const obj = JSON.parse(serializeInitialize());
  expect(typeof obj.request_id).toBe("string");
  expect((obj.request_id as string).startsWith("init-")).toBe(true);
  expect(obj.request.subtype).toBe("initialize");
  expect(obj.request.hooks.PreToolUse[0].hookCallbackIds).toContain("hook_0");
});

test("serializeHookPermissionResponse(deny) defaults the reason to an empty string", () => {
  const obj = JSON.parse(serializeHookPermissionResponse("r4", "deny"));
  expect(obj.response.response.hookSpecificOutput.permissionDecision).toBe("deny");
  expect(obj.response.response.hookSpecificOutput.permissionDecisionReason).toBe("");
});

test("serializeRewindFiles builds the rewind_files control_request (matches the SDK shape)", () => {
  const line = serializeRewindFiles("48cc3094-0c06-478c-b08c-367995fbfbad");
  expect(line).not.toContain("\n");
  const obj = JSON.parse(line);
  expect(obj.type).toBe("control_request");
  expect(typeof obj.request_id).toBe("string");
  expect(obj.request).toEqual({
    subtype: "rewind_files",
    user_message_id: "48cc3094-0c06-478c-b08c-367995fbfbad",
    dry_run: false,
  });
});

test("serializeRewindFiles honors dryRun and a supplied request id", () => {
  const obj = JSON.parse(serializeRewindFiles("uuid-1", { dryRun: true, requestId: "rw-1" }));
  expect(obj.request_id).toBe("rw-1");
  expect(obj.request.dry_run).toBe(true);
  expect(obj.request.user_message_id).toBe("uuid-1");
});
