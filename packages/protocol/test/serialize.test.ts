import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import {
  buildImageBlock, serializeUserMessage, serializeInitialize,
  serializeHookPermissionResponse, serializeCanUseToolResponse,
  classifyPermissionRequest, parseLine, type ControlRequestEvent,
} from "../src/index.js";

test("serializeUserMessage wraps a string as a text block (single line)", () => {
  const line = serializeUserMessage("hi");
  expect(line).not.toContain("\n");
  expect(JSON.parse(line)).toEqual({ type: "user", message: { role: "user", content: [{ type: "text", text: "hi" }] } });
});

test("buildImageBlock embeds a base64 image", () => {
  const line = serializeUserMessage([{ type: "text", text: "see:" }, buildImageBlock("image/png", "QUJD")]);
  expect(JSON.parse(line).message.content[1]).toEqual({ type: "image", source: { type: "base64", media_type: "image/png", data: "QUJD" } });
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
    response: { subtype: "success", request_id: "r1", response: { async: false, hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", permissionDecisionReason: "ok" } } },
  });
});

test("serializeCanUseToolResponse(deny) carries the message at response.response", () => {
  const obj = JSON.parse(serializeCanUseToolResponse("r2", { behavior: "deny", message: "no" }));
  expect(obj.response.request_id).toBe("r2");
  expect(obj.response.response).toEqual({ behavior: "deny", message: "no" });
});

test("classifyPermissionRequest extracts tool info from a hook_callback", () => {
  const ev = parseLine(JSON.stringify({ type: "control_request", request_id: "r", request: { subtype: "hook_callback", input: { tool_name: "Write", tool_input: { file_path: "/a" }, tool_use_id: "t1" } } })) as ControlRequestEvent;
  expect(classifyPermissionRequest(ev)).toEqual({ kind: "hook_callback", toolName: "Write", toolInput: { file_path: "/a" }, toolUseId: "t1" });
});

test("golden: an allow response built from the captured hook_callback matches the captured accepted control_response", () => {
  const path = fileURLToPath(new URL("../fixtures/permission-turn.jsonl", import.meta.url));
  const events = readFileSync(path, "utf8").split("\n").map(parseLine).filter((e) => e !== null);
  const req = events.find((e) => e!.type === "control_request" && (e as ControlRequestEvent).subtype === "hook_callback") as ControlRequestEvent;
  const accepted = events.find((e) => e!.type === "control_response" && (e!.raw as { _dir?: string })._dir === "out");
  expect(req).toBeTruthy();
  expect(accepted).toBeTruthy();
  const built = JSON.parse(serializeHookPermissionResponse(req.requestId, "allow", "x"));
  const acc = (accepted!.raw as { response: { response: { hookSpecificOutput: { permissionDecision: string } } } });
  expect(built.response.request_id).toBe((accepted as { requestId?: string }).requestId);
  expect(built.response.response.hookSpecificOutput.permissionDecision).toBe(acc.response.response.hookSpecificOutput.permissionDecision);
});
