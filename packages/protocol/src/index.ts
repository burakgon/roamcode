export const PROTOCOL_PACKAGE = "@remote-coder/protocol";
export * from "./types.js";
export { parseLine, parseModelsFromInitResponse, ProtocolParseError } from "./parse.js";
export {
  buildImageBlock,
  serializeUserMessage,
  serializeInitialize,
  serializeHookPermissionResponse,
  serializeCanUseToolResponse,
  classifyPermissionRequest,
  classifyQuestionRequest,
  serializeHookQuestionAnswer,
  serializeSetModel,
  serializeSetMaxThinkingTokens,
  serializeSetPermissionMode,
  serializeInterrupt,
  serializeRewindFiles,
} from "./serialize.js";
export type { QuestionSpec, QuestionOption } from "./serialize.js";
export { replayFixture, type ReplayOptions } from "./mock-claude.js";
export { encodeProjectDir, parseTranscript } from "./transcript.js";
export type { TranscriptTurn } from "./transcript.js";
