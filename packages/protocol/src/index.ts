export const PROTOCOL_PACKAGE = "@remote-coder/protocol";
export * from "./types.js";
export { parseLine, parseModelsFromInitResponse, ProtocolParseError } from "./parse.js";
export {
  buildImageBlock,
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
export { encodeProjectDir, parseTranscript, activeBranchIndices } from "./transcript.js";
export type { TranscriptTurn, BranchNode } from "./transcript.js";
