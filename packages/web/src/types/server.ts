// Client-side mirror of the Plan 3 server contract (packages/server/src/replay-buffer.ts,
// session-hub.ts, fs-service.ts, claude-process.ts and @remote-coder/protocol). Kept as a
// standalone type module so the browser bundle never imports the Node server package.

export type ServerFrameKind = "event" | "permission" | "question" | "result" | "diagnostic" | "exit";

export interface ServerFrame {
  seq: number;
  kind: ServerFrameKind;
  payload: unknown;
}

export interface SessionMeta {
  id: string;
  cwd: string;
  model?: string;
  effort?: string;
  dangerouslySkip: boolean;
  status: "running" | "errored" | "stopped";
  createdAt: number;
}

export interface DirEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  isGitRepo: boolean;
  gitBranch?: string;
}

export interface DirListing {
  path: string;
  parent?: string;
  entries: DirEntry[];
}

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } };

export interface PermissionPayload {
  requestId: string;
  kind: "hook_callback" | "can_use_tool";
  toolName?: string;
  toolInput?: unknown;
  toolUseId?: string;
}

export interface QuestionOption {
  label: string;
  description?: string;
}

export interface QuestionSpec {
  question: string;
  header?: string;
  multiSelect: boolean;
  options: QuestionOption[];
}

export interface QuestionPayload {
  requestId: string;
  toolUseId?: string;
  toolInput: unknown;
  questions: QuestionSpec[];
}

export interface ResultPayload {
  type: "result";
  subtype?: string;
  isError?: boolean;
  result?: string;
  sessionId?: string;
  totalCostUsd?: number;
  permissionDenials?: unknown[];
  raw: unknown;
}

export interface DiagnosticPayload {
  source: "stderr" | "parser";
  message: string;
}

export type OutboundFrame =
  | {
      type: "user";
      content?: string;
      blocks?: ContentBlock[];
      text?: string;
      images?: { mediaType: string; dataBase64: string }[];
    }
  | { type: "permission"; requestId: string; decision: "allow" | "deny"; reason?: string }
  | { type: "answer"; requestId: string; toolInput: unknown; answers: Record<string, string | string[]> }
  | { type: "settings"; model?: string; maxThinkingTokens?: number; effort?: string; permissionMode?: string };
