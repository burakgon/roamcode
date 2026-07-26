import { execFile } from "node:child_process";
import { promisify } from "node:util";

export interface PaneProcess {
  sessionName: string;
  panePid: number;
}

export interface ProcessSnapshotEntry {
  pid: number;
  ppid: number;
  pgid: number;
  tpgid: number;
  command: string;
  argv: string[];
}

export interface ForegroundProcessSnapshot {
  panes: PaneProcess[];
  processes: ProcessSnapshotEntry[];
}

export interface AgentProcessDescriptor {
  provider: string;
  aliases: readonly string[];
}

export interface DetectedForegroundAgent {
  provider: string;
  pid: number;
}

const execFileAsync = promisify(execFile);
const GENERIC_RUNTIMES = new Set([
  "node",
  "nodejs",
  "bun",
  "deno",
  "python",
  "python3",
  "sh",
  "bash",
  "zsh",
  "fish",
  "dash",
  "npm",
  "npx",
  "pnpm",
  "pnpx",
  "yarn",
  "bunx",
]);
const SHELLS = new Set(["sh", "bash", "zsh", "fish", "dash"]);
const PACKAGE_RUNNERS = new Set(["npm", "npx", "pnpm", "pnpx", "yarn", "bunx"]);
const SCRIPT_RUNTIMES = new Set(["node", "nodejs", "bun", "deno", "python", "python3"]);

function basename(value: string): string {
  const normalized = value.replaceAll("\\", "/");
  return normalized.slice(normalized.lastIndexOf("/") + 1);
}

function normalizedCommand(value: string): string {
  return basename(value)
    .toLowerCase()
    .replace(/\.exe$/u, "");
}

/**
 * `ps args` is display text rather than a lossless argv transport. This tokenizer is intentionally
 * conservative: it recognizes ordinary quoted executable paths but never evaluates substitutions,
 * escapes, environment assignments, or shell operators.
 */
export function splitDisplayedCommandLine(value: string): string[] {
  const result: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;
  for (const character of value) {
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = undefined;
      else current += character;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (/\s/u.test(character)) {
      if (current) {
        result.push(current);
        current = "";
      }
      continue;
    }
    current += character;
  }
  if (escaped) current += "\\";
  if (current) result.push(current);
  return result;
}

export function parsePaneProcesses(value: string): PaneProcess[] {
  const panes: PaneProcess[] = [];
  for (const line of value.split("\n")) {
    if (!line) continue;
    const tab = line.indexOf("\t");
    if (tab <= 0) continue;
    const sessionName = line.slice(0, tab);
    const panePid = Number(line.slice(tab + 1));
    if (!Number.isSafeInteger(panePid) || panePid <= 0) continue;
    panes.push({ sessionName, panePid });
  }
  return panes;
}

export function parseProcessSnapshot(value: string): ProcessSnapshotEntry[] {
  const processes: ProcessSnapshotEntry[] = [];
  for (const line of value.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(-?\d+)\s+(-?\d+)\s+(\S+)(?:\s+(.*))?$/u.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    const pgid = Number(match[3]);
    const tpgid = Number(match[4]);
    if (![pid, ppid, pgid, tpgid].every(Number.isSafeInteger) || pid <= 0 || ppid < 0) continue;
    const command = match[5]!;
    const argv = splitDisplayedCommandLine(match[6] ?? command);
    processes.push({ pid, ppid, pgid, tpgid, command, argv });
  }
  return processes;
}

function aliasProvider(token: string | undefined, aliases: ReadonlyMap<string, string>): string | undefined {
  if (!token) return undefined;
  return aliases.get(normalizedCommand(token));
}

function firstCommandToken(value: string): string | undefined {
  const tokens = splitDisplayedCommandLine(value);
  while (tokens[0] && /^[A-Za-z_][A-Za-z0-9_]*=.*/u.test(tokens[0])) tokens.shift();
  return tokens[0];
}

function providerFromWrappedArgv(
  process: ProcessSnapshotEntry,
  aliases: ReadonlyMap<string, string>,
): string | undefined {
  const effective = normalizedCommand(process.argv[0] ?? process.command);
  if (!GENERIC_RUNTIMES.has(effective)) return aliasProvider(process.argv[0] ?? process.command, aliases);

  if (SCRIPT_RUNTIMES.has(effective)) {
    const skipValueFor = new Set(["-e", "--eval", "-p", "--print", "-c", "-m"]);
    for (let index = 1; index < process.argv.length; index += 1) {
      const token = process.argv[index]!;
      if (skipValueFor.has(token)) return undefined;
      if (token.startsWith("-")) continue;
      const direct = aliasProvider(token, aliases);
      if (direct) return direct;
      const pathParts = token.replaceAll("\\", "/").split("/");
      for (let part = pathParts.length - 1; part >= 0; part -= 1) {
        const candidate = aliasProvider(pathParts[part], aliases);
        if (candidate) return candidate;
        if (pathParts[part] === "node_modules") break;
      }
      return undefined;
    }
    return undefined;
  }

  if (PACKAGE_RUNNERS.has(effective)) {
    const directRunner = effective === "npx" || effective === "pnpx" || effective === "bunx";
    let acceptedVerb = directRunner;
    for (let index = 1; index < process.argv.length; index += 1) {
      const token = process.argv[index]!;
      if (token.startsWith("-")) continue;
      if (!acceptedVerb) {
        if (!["exec", "x", "dlx"].includes(token)) return undefined;
        acceptedVerb = true;
        continue;
      }
      return aliasProvider(token, aliases);
    }
    return undefined;
  }

  if (SHELLS.has(effective)) {
    const commandIndex = process.argv.findIndex((token, index) => index > 0 && (token === "-c" || token === "-lc"));
    if (commandIndex < 0) return undefined;
    return aliasProvider(firstCommandToken(process.argv[commandIndex + 1] ?? ""), aliases);
  }

  return undefined;
}

function isDescendantOf(
  process: ProcessSnapshotEntry,
  ancestorPid: number,
  byPid: ReadonlyMap<number, ProcessSnapshotEntry>,
): boolean {
  let current: ProcessSnapshotEntry | undefined = process;
  const visited = new Set<number>();
  for (let depth = 0; current && depth < 64; depth += 1) {
    if (current.pid === ancestorPid) return true;
    if (visited.has(current.pid) || current.ppid <= 0 || current.ppid === current.pid) return false;
    visited.add(current.pid);
    current = byPid.get(current.ppid);
  }
  return false;
}

export function identifyForegroundAgent(
  panePid: number,
  processes: readonly ProcessSnapshotEntry[],
  descriptors: readonly AgentProcessDescriptor[],
): DetectedForegroundAgent | undefined {
  const aliases = new Map<string, string>();
  for (const descriptor of descriptors) {
    for (const alias of descriptor.aliases) {
      const normalized = normalizedCommand(alias);
      if (normalized && !aliases.has(normalized)) aliases.set(normalized, descriptor.provider);
    }
  }
  const byPid = new Map(processes.map((process) => [process.pid, process]));
  const pane = byPid.get(panePid);
  if (!pane) return undefined;
  const foregroundGroup = pane.tpgid > 0 ? pane.tpgid : pane.pgid;
  const candidates = processes
    .filter((process) => process.pgid === foregroundGroup && isDescendantOf(process, panePid, byPid))
    .sort((left, right) => Number(right.pid === foregroundGroup) - Number(left.pid === foregroundGroup));
  for (const process of candidates) {
    const provider =
      aliasProvider(process.command, aliases) ??
      aliasProvider(process.argv[0], aliases) ??
      providerFromWrappedArgv(process, aliases);
    if (provider) return { provider, pid: process.pid };
  }
  return undefined;
}

export async function captureForegroundProcessSnapshot(options: {
  tmuxSocket: string;
  tmuxBin?: string;
  timeoutMs?: number;
}): Promise<ForegroundProcessSnapshot | undefined> {
  const timeout = options.timeoutMs ?? 1_500;
  try {
    const [tmuxResult, psResult] = await Promise.all([
      execFileAsync(
        options.tmuxBin ?? "tmux",
        ["-L", options.tmuxSocket, "list-panes", "-a", "-F", "#{session_name}\t#{pane_pid}"],
        { encoding: "utf8", timeout, maxBuffer: 512 * 1024 },
      ),
      execFileAsync("ps", ["-axo", "pid=,ppid=,pgid=,tpgid=,comm=,args="], {
        encoding: "utf8",
        timeout,
        maxBuffer: 4 * 1024 * 1024,
      }),
    ]);
    return {
      panes: parsePaneProcesses(tmuxResult.stdout),
      processes: parseProcessSnapshot(psResult.stdout),
    };
  } catch {
    return undefined;
  }
}
