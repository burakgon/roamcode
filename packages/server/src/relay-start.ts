import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  type Dirent,
} from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createBlindRelayServer, type BlindRelayServer } from "./relay-broker.js";
import { ensureDataDir, resolveDataDir } from "./data-dir.js";
import { openRelayAccountStore, type RelayAccountStore } from "./relay-account-store.js";
import { openRelayRouteStore } from "./relay-store.js";

/** The minimal OCI bundle imports this module, so its inlined copy must never also run the CLI entrypoint. */
declare const __RELAY_CONTAINER_BUILD__: boolean | undefined;

export interface StartedBlindRelay extends BlindRelayServer {
  url: string;
}

function boundedInteger(value: string | undefined, fallback: number, minimum: number, maximum: number, field: string) {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) throw new Error(`invalid ${field}`);
  return parsed;
}

function relayDataDir(env: NodeJS.ProcessEnv): string {
  const configured = env.ROAMCODE_RELAY_DATA_DIR?.trim();
  return configured ? resolve(configured) : join(resolveDataDir(env), "relay");
}

function relayOrigins(env: NodeJS.ProcessEnv): string[] {
  return (env.ROAMCODE_RELAY_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function privateSecretFile(path: string, field: string): string {
  let descriptor: number | undefined;
  try {
    const before = lstatSync(path);
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.size > 4_096 ||
      (before.mode & 0o077) !== 0 ||
      (typeof process.getuid === "function" && before.uid !== process.getuid())
    ) {
      throw new Error("unsafe secret file");
    }
    descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(descriptor);
    if (
      !opened.isFile() ||
      opened.size > 4_096 ||
      (opened.mode & 0o077) !== 0 ||
      (typeof process.getuid === "function" && opened.uid !== process.getuid()) ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino
    ) {
      throw new Error("unsafe secret file");
    }
    return readFileSync(descriptor, "utf8").trim();
  } catch {
    throw new Error(`${field} could not be read securely`);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function previousRootTokens(env: NodeJS.ProcessEnv): string[] {
  const inline = (env.ROAMCODE_RELAY_PREVIOUS_ROOT_TOKENS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const directory = env.ROAMCODE_RELAY_PREVIOUS_ROOT_TOKEN_DIR?.trim();
  if (inline.length > 0 && directory) {
    throw new Error(
      "ROAMCODE_RELAY_PREVIOUS_ROOT_TOKENS and ROAMCODE_RELAY_PREVIOUS_ROOT_TOKEN_DIR are mutually exclusive",
    );
  }
  if (!directory) return inline;
  let before: ReturnType<typeof lstatSync>;
  let entries: Dirent[];
  try {
    before = lstatSync(directory);
    if (
      !before.isDirectory() ||
      before.isSymbolicLink() ||
      (before.mode & 0o077) !== 0 ||
      (typeof process.getuid === "function" && before.uid !== process.getuid())
    ) {
      throw new Error("unsafe secret directory");
    }
    entries = readdirSync(directory, { withFileTypes: true });
    const after = lstatSync(directory);
    if (
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      (after.mode & 0o077) !== 0 ||
      (typeof process.getuid === "function" && after.uid !== process.getuid()) ||
      entries.some((entry) => !entry.isFile())
    ) {
      throw new Error("unsafe secret directory");
    }
  } catch {
    throw new Error("ROAMCODE_RELAY_PREVIOUS_ROOT_TOKEN_DIR could not be read securely");
  }
  if (entries.length > 3) throw new Error("ROAMCODE_RELAY_PREVIOUS_ROOT_TOKEN_DIR may contain at most three files");
  return entries
    .map((entry) => entry.name)
    .sort()
    .map((name) => privateSecretFile(join(directory, name), "previous relay root capability"));
}

function explicitBoolean(value: string | undefined, field: string): boolean {
  if (value === undefined || value === "" || value === "0" || value === "false") return false;
  if (value === "1" || value === "true") return true;
  throw new Error(`invalid ${field}`);
}

function secretValue(
  env: NodeJS.ProcessEnv,
  directKey: "ROAMCODE_RELAY_ROOT_TOKEN",
  fileKey: "ROAMCODE_RELAY_ROOT_TOKEN_FILE",
): string | undefined {
  const direct = env[directKey]?.trim();
  const file = env[fileKey]?.trim();
  if (direct && file) throw new Error(`${directKey} and ${fileKey} are mutually exclusive`);
  if (direct) return direct;
  if (!file) return undefined;
  return privateSecretFile(file, fileKey);
}

export async function startBlindRelay(env: NodeJS.ProcessEnv = process.env): Promise<StartedBlindRelay> {
  const rootToken = secretValue(env, "ROAMCODE_RELAY_ROOT_TOKEN", "ROAMCODE_RELAY_ROOT_TOKEN_FILE");
  if (!rootToken) throw new Error("ROAMCODE_RELAY_ROOT_TOKEN or ROAMCODE_RELAY_ROOT_TOKEN_FILE is required");
  const previousRoots = previousRootTokens(env);
  const allowedOrigins = relayOrigins(env);
  const allowAnyOrigin = explicitBoolean(env.ROAMCODE_RELAY_ALLOW_ANY_ORIGIN, "relay allow-any-origin flag");
  if (env.NODE_ENV === "production" && allowedOrigins.length === 0 && !allowAnyOrigin) {
    throw new Error(
      "ROAMCODE_RELAY_ALLOWED_ORIGINS is required in production; explicitly set ROAMCODE_RELAY_ALLOW_ANY_ORIGIN=1 only for a reviewed deployment",
    );
  }
  const dataDir = relayDataDir(env);
  ensureDataDir(dataDir);
  const store = openRelayRouteStore({ dbPath: join(dataDir, "routes.db") });
  if (store.mode !== "sqlite") {
    store.close();
    throw new Error("relay requires durable SQLite; rebuild better-sqlite3 before starting");
  }
  const accountsEnabled = explicitBoolean(env.ROAMCODE_RELAY_ACCOUNTS_ENABLED, "relay accounts-enabled flag");
  let accountStore: RelayAccountStore | undefined;
  if (accountsEnabled) {
    accountStore = openRelayAccountStore({ dbPath: join(dataDir, "accounts.db") });
    if (accountStore.mode !== "sqlite") {
      accountStore.close();
      store.close();
      throw new Error("relay accounts require durable SQLite; rebuild better-sqlite3 before starting");
    }
  }
  let relay: BlindRelayServer;
  try {
    relay = createBlindRelayServer({
      rootToken,
      previousRootTokens: previousRoots,
      store,
      ...(accountStore ? { accountStore } : {}),
      allowedOrigins,
      handshakeTimeoutMs: boundedInteger(
        env.ROAMCODE_RELAY_HANDSHAKE_TIMEOUT_MS,
        5_000,
        1_000,
        30_000,
        "relay handshake timeout",
      ),
      idleTimeoutMs: boundedInteger(
        env.ROAMCODE_RELAY_IDLE_TIMEOUT_MS,
        120_000,
        10_000,
        3_600_000,
        "relay idle timeout",
      ),
      maxFrameBytes: boundedInteger(
        env.ROAMCODE_RELAY_MAX_FRAME_BYTES,
        1_500_000,
        1_024,
        16 * 1024 * 1024,
        "relay frame limit",
      ),
      maxQueueBytes: boundedInteger(
        env.ROAMCODE_RELAY_MAX_QUEUE_BYTES,
        4_000_000,
        1_024,
        64 * 1024 * 1024,
        "relay queue limit",
      ),
      maxTotalConnections: boundedInteger(
        env.ROAMCODE_RELAY_MAX_TOTAL_CONNECTIONS,
        1_024,
        1,
        100_000,
        "relay total connection limit",
      ),
      maxConnectionsPerRoute: boundedInteger(
        env.ROAMCODE_RELAY_MAX_CONNECTIONS_PER_ROUTE,
        64,
        1,
        10_000,
        "relay route connection limit",
      ),
      maxBytesPerMinute: boundedInteger(
        env.ROAMCODE_RELAY_MAX_BYTES_PER_MINUTE,
        64 * 1024 * 1024,
        1_024,
        1024 * 1024 * 1024,
        "relay byte rate",
      ),
      maxMessagesPerMinute: boundedInteger(
        env.ROAMCODE_RELAY_MAX_MESSAGES_PER_MINUTE,
        12_000,
        10,
        1_000_000,
        "relay message rate",
      ),
    });
  } catch (error) {
    accountStore?.close();
    store.close();
    throw error;
  }
  relay.app.addHook("onClose", async () => {
    accountStore?.close();
    store.close();
  });
  const host = env.ROAMCODE_RELAY_BIND?.trim() || "127.0.0.1";
  const port = boundedInteger(env.ROAMCODE_RELAY_PORT, 4281, 0, 65_535, "relay port");
  try {
    const url = await relay.app.listen({ host, port });
    return { ...relay, url };
  } catch (error) {
    accountStore?.close();
    store.close();
    throw error;
  }
}

export function isRelayDirectExecution(
  moduleUrl: string,
  argv1: string | undefined,
  embeddedContainerBuild = false,
): boolean {
  if (embeddedContainerBuild) return false;
  if (!argv1) return false;
  try {
    return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(argv1);
  } catch {
    return moduleUrl === pathToFileURL(argv1).href;
  }
}

const embeddedContainerBuild = typeof __RELAY_CONTAINER_BUILD__ === "boolean" && __RELAY_CONTAINER_BUILD__ === true;

if (isRelayDirectExecution(import.meta.url, process.argv[1], embeddedContainerBuild)) {
  void startBlindRelay()
    .then((relay) => {
      process.stdout.write(`RoamCode blind relay is listening at ${relay.url}\n`);
      const shutdown = () => relay.app.close().finally(() => process.exit(0));
      process.once("SIGINT", shutdown);
      process.once("SIGTERM", shutdown);
    })
    .catch((error) => {
      process.stderr.write(`roamcode relay failed to start: ${(error as Error).message}\n`);
      process.exitCode = 1;
    });
}
