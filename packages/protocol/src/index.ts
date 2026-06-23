export const PROTOCOL_PACKAGE = "@remote-coder/protocol";
export * from "./types.js";
export { parseLine, ProtocolParseError } from "./parse.js";
export {
  buildImageBlock, serializeUserMessage, serializeInitialize,
  serializeHookPermissionResponse, serializeCanUseToolResponse, classifyPermissionRequest,
} from "./serialize.js";
export { replayFixture, type ReplayOptions } from "./mock-claude.js";
