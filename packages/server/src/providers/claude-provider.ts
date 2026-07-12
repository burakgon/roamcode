import {
  buildHooksSettingsDocument,
  buildMcpConfigDocument,
  hookAuthFileContent,
  hookAuthPathFor,
  hooksSettingsPathFor,
  mcpConfigPathFor,
  type AttachSpawnOptions,
} from "../config.js";
import { classifyPaneStatus } from "../pane-status.js";
import { cleanupProviderArtifacts, writeProviderArtifact0600 } from "./provider-artifacts.js";
import { ProviderError, type AgentProvider, type ClaudeSessionOptions } from "./types.js";
import type { ProviderAvailability } from "./types.js";

export interface CreateClaudeProviderOptions {
  claudeBin: string;
  env?: NodeJS.ProcessEnv;
  attach?: AttachSpawnOptions;
  getAttach?: () => AttachSpawnOptions | undefined;
  probe?: () => Promise<ProviderAvailability>;
}

type OwnedValueArity = "one" | "optional" | "variadic";

const OWNED_VALUE_FLAGS = new Map<string, OwnedValueArity>([
  ["--resume", "optional"],
  ["--session-id", "one"],
  ["--model", "one"],
  ["--effort", "one"],
  ["--permission-mode", "one"],
  ["--add-dir", "variadic"],
  ["--mcp-config", "variadic"],
  ["--settings", "one"],
]);

const OWNED_BOOLEAN_FLAGS = ["--continue", "--dangerously-skip-permissions"] as const;

function invalidLegacyArg(message: string): ProviderError {
  return new ProviderError("INVALID_PROVIDER_OPTIONS", `Invalid provider options: ${message}`);
}

function requireLegacyValue(args: readonly string[], index: number, flag: string): number {
  const value = args[index + 1];
  if (value === undefined || value.startsWith("-")) throw invalidLegacyArg(`${flag} requires a value`);
  return index + 1;
}

function sanitizeLegacyArgs(legacyArgs: readonly string[]): string[] {
  const preserved: string[] = [];

  for (let index = 0; index < legacyArgs.length; index += 1) {
    const arg = legacyArgs[index]!;
    if (arg === "--") {
      preserved.push(...legacyArgs.slice(index));
      break;
    }

    if (arg === "-c") continue;
    if (arg.startsWith("-c")) {
      throw invalidLegacyArg("-c has an ambiguous attached value");
    }

    if (arg === "-r") {
      const value = legacyArgs[index + 1];
      if (value !== undefined && !value.startsWith("-")) index += 1;
      continue;
    }
    if (arg.startsWith("-r")) {
      if (arg === "-r=" || arg.length === 2) throw invalidLegacyArg("-r has an ambiguous empty value");
      continue;
    }

    let handled = false;
    for (const flag of OWNED_BOOLEAN_FLAGS) {
      if (arg === flag) {
        handled = true;
        break;
      }
      if (arg.startsWith(`${flag}=`)) {
        if (arg.length === flag.length + 1) throw invalidLegacyArg(`${flag} has an ambiguous empty value`);
        handled = true;
        break;
      }
    }
    if (handled) continue;

    for (const [flag, arity] of OWNED_VALUE_FLAGS) {
      if (arg.startsWith(`${flag}=`)) {
        if (arg.length === flag.length + 1) {
          const detail = arity === "optional" ? "has an ambiguous empty value" : "requires a value";
          throw invalidLegacyArg(`${flag} ${detail}`);
        }
        handled = true;
        break;
      }
      if (arg !== flag) continue;

      handled = true;
      if (arity === "optional") {
        const value = legacyArgs[index + 1];
        if (value !== undefined && !value.startsWith("-")) index += 1;
      } else {
        index = requireLegacyValue(legacyArgs, index, flag);
        if (arity === "variadic") {
          while (legacyArgs[index + 1] !== undefined && !legacyArgs[index + 1]!.startsWith("-")) index += 1;
        }
      }
      break;
    }
    if (!handled) preserved.push(arg);
  }

  return preserved;
}

function insertBeforeSeparator(args: string[], ownedArgs: readonly string[]): void {
  const separatorIndex = args.indexOf("--");
  args.splice(separatorIndex === -1 ? args.length : separatorIndex, 0, ...ownedArgs);
}

function claudeArgs(options: ClaudeSessionOptions): string[] {
  const args: string[] = [];
  if (options.model) args.push("--model", options.model);
  if (options.effort) args.push("--effort", options.effort);
  if (options.dangerouslySkip) args.push("--dangerously-skip-permissions");
  else if (options.permissionMode) args.push("--permission-mode", options.permissionMode);
  for (const dir of options.addDirs ?? []) args.push("--add-dir", dir);

  // Legacy arguments exist only for rollback-readable Claude rows. Provider-owned model, safety, session,
  // and attachment flags are rebuilt from typed options so historical argv cannot override adapter policy.
  args.push(...sanitizeLegacyArgs(options.legacyArgs ?? []));
  return args;
}

export function createClaudeProvider(options: CreateClaudeProviderOptions): AgentProvider {
  return {
    id: "claude",
    displayName: "Claude Code",
    resumeIdentity: "optional",
    probe: options.probe ?? (() => Promise.resolve({ terminalAvailable: true, metadataAvailable: true })),
    buildProcess: async (context) => {
      if (context.options.provider !== "claude") {
        throw new ProviderError("INVALID_PROVIDER_OPTIONS", "Claude provider received non-Claude options");
      }

      const args = claudeArgs(context.options);
      const ownedPaths: string[] = [];
      const attach = context.attach ?? options.getAttach?.() ?? options.attach;
      if (attach) {
        try {
          const mcpPath = mcpConfigPathFor(attach.dataDir, context.roamSessionId);
          if (
            writeProviderArtifact0600(
              mcpPath,
              JSON.stringify(buildMcpConfigDocument(context.roamSessionId, attach)),
              context,
              ownedPaths,
            )
          ) {
            insertBeforeSeparator(args, ["--mcp-config", mcpPath]);
          }

          const authPath = hookAuthPathFor(attach.dataDir, context.roamSessionId);
          const settingsPath = hooksSettingsPathFor(attach.dataDir, context.roamSessionId);
          if (writeProviderArtifact0600(authPath, hookAuthFileContent(attach.token), context, ownedPaths)) {
            if (
              writeProviderArtifact0600(
                settingsPath,
                JSON.stringify(buildHooksSettingsDocument(context.roamSessionId, attach, authPath)),
                context,
                ownedPaths,
              )
            ) {
              insertBeforeSeparator(args, ["--settings", settingsPath]);
            } else {
              cleanupProviderArtifacts([authPath]);
            }
          }
        } catch (error) {
          cleanupProviderArtifacts(ownedPaths);
          throw error;
        }
      }

      if (context.intent === "resume") insertBeforeSeparator(args, ["--continue"]);

      const env = { ...(options.env ?? process.env) };
      delete env.ANTHROPIC_API_KEY;
      return {
        executable: options.claudeBin,
        args,
        env,
        cleanupPaths: ownedPaths,
      };
    },
    runtimeSignals: () => [],
    classifyPane: classifyPaneStatus,
    cleanup: cleanupProviderArtifacts,
  };
}
