import { codexMcpTokenPathFor, type AttachSpawnOptions } from "../config.js";
import { isAbsolute } from "node:path";
import {
  classifyCodexPane,
  createCodexOscParser,
  parseCodexOscNotifications,
  parseCodexRuntimeMetadata,
} from "./codex-activity.js";
import { assertExactCodexResumeArgs } from "./codex-thread-resolver.js";
import { cleanupProviderArtifacts, writeProviderArtifact0600 } from "./provider-artifacts.js";
import {
  ProviderError,
  type AgentProvider,
  type CodexProfileLaunchProof,
  type CodexSessionOptions,
  type ProviderProcessContext,
  type ProviderAvailability,
} from "./types.js";

export interface CreateCodexProviderOptions {
  codexBin: string;
  env?: NodeJS.ProcessEnv;
  attach?: AttachSpawnOptions;
  getAttach?: () => AttachSpawnOptions | undefined;
  probe?: () => Promise<ProviderAvailability>;
  /** Task 7 supplies the effective-provider capability check; this adapter never reads profile files. */
  validateProfile?(profile: string, cwd: string): CodexProfileLaunchProof | Promise<CodexProfileLaunchProof>;
}

type CodexAttachContext = Pick<AttachSpawnOptions, "baseUrl" | "token" | "mcpScriptPath">;

function configArg(key: string, value: string | readonly string[]): string[] {
  return ["-c", `${key}=${JSON.stringify(value)}`];
}

function validResumeId(id: string | undefined): id is string {
  return (
    id !== undefined &&
    id.trim().length > 0 &&
    id.length <= 2048 &&
    !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(id) &&
    !id.trimStart().startsWith("-")
  );
}

function usableAttach(attach: AttachSpawnOptions | undefined): attach is AttachSpawnOptions {
  return Boolean(
    attach?.baseUrl &&
    attach.token &&
    Buffer.byteLength(attach.token, "utf8") <= 4096 &&
    !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(attach.token) &&
    attach.mcpScriptPath &&
    attach.dataDir,
  );
}

function profileUnavailable(): ProviderError {
  return new ProviderError("OSS_PROVIDER_DEFERRED", "Codex profile capability proof is unavailable");
}

export function buildCodexArgs(context: ProviderProcessContext, attach?: CodexAttachContext): string[] {
  if (context.options.provider !== "codex") {
    throw new ProviderError("INVALID_PROVIDER_OPTIONS", "Codex provider received non-Codex options");
  }
  if (context.intent === "fresh" && context.providerSessionId !== undefined) {
    throw new ProviderError("INVALID_PROVIDER_OPTIONS", "Fresh Codex launch cannot include a resume identity");
  }

  const options: CodexSessionOptions = context.options;
  const args: string[] = [];
  let resumeId: string | undefined;
  if (context.intent === "resume") {
    resumeId = context.providerSessionId;
    if (!validResumeId(resumeId)) {
      throw new ProviderError("RESUME_IDENTITY_UNAVAILABLE", "Codex resume requires an exact safe session id");
    }
    args.push("resume");
  }
  if (options.model) args.push("--model", options.model);
  if (options.profile) args.push("--profile", options.profile);
  if (options.dangerouslyBypassApprovalsAndSandbox) {
    args.push("--dangerously-bypass-approvals-and-sandbox");
  } else {
    if (options.sandbox) args.push("--sandbox", options.sandbox);
    if (options.approvalPolicy) args.push("--ask-for-approval", options.approvalPolicy);
  }
  if (options.webSearch) args.push("--search");
  for (const dir of options.addDirs ?? []) args.push("--add-dir", dir);
  if (options.reasoningEffort) args.push(...configArg("model_reasoning_effort", options.reasoningEffort));

  if (attach) {
    args.push(...configArg("mcp_servers.roamcode.command", process.execPath));
    args.push(...configArg("mcp_servers.roamcode.args", [attach.mcpScriptPath]));
    args.push(...configArg("mcp_servers.roamcode.env_vars", ["RC_BASE_URL", "RC_SESSION_ID", "RC_TOKEN_FILE"]));
  }
  args.push(...configArg("tui.notifications", ["agent-turn-complete", "approval-requested", "plan-mode-prompt"]));
  args.push(...configArg("tui.notification_method", "osc9"));
  args.push(...configArg("tui.notification_condition", "always"));
  // Keep the conversation in tmux's ordinary pane history. With tmux mouse mode enabled, wheel/trackpad
  // and mobile scroll can read that history in place instead of opening Codex's separate transcript UI.
  args.push("--no-alt-screen");
  if (resumeId) args.push("--", resumeId);
  if (context.intent === "resume") assertExactCodexResumeArgs(args);
  return args;
}

export function createCodexProvider(options: CreateCodexProviderOptions): AgentProvider {
  return {
    id: "codex",
    displayName: "Codex",
    resumeIdentity: "required",
    probe: options.probe ?? (() => Promise.resolve({ terminalAvailable: true, metadataAvailable: false })),
    buildProcess: async (context) => {
      if (context.options.provider !== "codex") {
        throw new ProviderError("INVALID_PROVIDER_OPTIONS", "Codex provider received non-Codex options");
      }
      let profileProof: CodexProfileLaunchProof | undefined;
      if (context.options.profile) {
        let validateProfile: CreateCodexProviderOptions["validateProfile"];
        try {
          validateProfile = options.validateProfile;
        } catch {
          throw profileUnavailable();
        }
        if (!validateProfile) throw profileUnavailable();
        try {
          profileProof = await validateProfile(context.options.profile, context.cwd);
        } catch {
          throw profileUnavailable();
        }
        if (
          profileProof.profile !== context.options.profile ||
          !isAbsolute(profileProof.codexHome) ||
          /[\p{Cc}\p{Zl}\p{Zp}]/u.test(profileProof.codexHome) ||
          typeof profileProof.assertUnchanged !== "function"
        ) {
          throw profileUnavailable();
        }
      }
      const env = { ...(options.env ?? process.env) };
      delete env.RC_TOKEN;
      delete env.RC_TOKEN_FILE;
      if (profileProof) env.CODEX_HOME = profileProof.codexHome;
      const preSpawnCheck = profileProof
        ? async () => {
            try {
              await profileProof!.assertUnchanged();
            } catch {
              throw profileUnavailable();
            }
          }
        : undefined;
      const ownedPaths: string[] = [];
      const candidateAttach = context.attach ?? options.getAttach?.() ?? options.attach;
      let attach: AttachSpawnOptions | undefined;
      try {
        if (usableAttach(candidateAttach)) {
          const tokenPath = codexMcpTokenPathFor(candidateAttach.dataDir, context.roamSessionId);
          if (writeProviderArtifact0600(tokenPath, candidateAttach.token, context, ownedPaths)) {
            attach = candidateAttach;
            env.RC_BASE_URL = candidateAttach.baseUrl;
            env.RC_SESSION_ID = context.roamSessionId;
            env.RC_TOKEN_FILE = tokenPath;
          }
        }
        const args = buildCodexArgs(context, attach);
        return {
          executable: options.codexBin,
          args,
          env,
          cleanupPaths: ownedPaths,
          ...(preSpawnCheck ? { preSpawnCheck } : {}),
          integration: attach
            ? {
                attachments: "ready",
                activity: "degraded",
                detail: "Codex activity uses display-text signals with pane fallback",
              }
            : {
                attachments: "degraded",
                activity: "degraded",
                detail:
                  "RoamCode attachment MCP is not configured; Codex activity uses display-text signals with pane fallback",
              },
        };
      } catch (error) {
        cleanupProviderArtifacts(ownedPaths);
        throw error;
      }
    },
    createRuntimeSignalParser: createCodexOscParser,
    runtimeSignals: parseCodexOscNotifications,
    classifyPane: classifyCodexPane,
    runtimeMetadata: parseCodexRuntimeMetadata,
    cleanup: cleanupProviderArtifacts,
  };
}
