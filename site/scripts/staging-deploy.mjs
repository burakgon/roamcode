import { spawnSync } from "node:child_process";
import { lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const siteDirectory = fileURLToPath(new URL("..", import.meta.url));
const repositoryDirectory = fileURLToPath(new URL("../..", import.meta.url));
const stagingConfigFilename = "wrangler.staging.jsonc";
const stagingConfigPath = join(siteDirectory, stagingConfigFilename);
const stagingOrigin = "https://staging.roamcode.ai";
const capabilityPath = "/api/v1/meta/product-capabilities";
const wranglerPath = join(siteDirectory, "node_modules", "wrangler", "bin", "wrangler.js");

export const REQUIRED_STAGING_SECRETS = Object.freeze([
  "CONTROL_PLANE_ORIGIN",
  "CONTROL_PLANE_EDGE_AUTH_KEY_ID",
  "CONTROL_PLANE_EDGE_AUTH_SECRET",
]);

const REQUIRED_MANAGED_NODE_CAPABILITIES = Object.freeze(["terminal.v1", "relay.v1", "managed-device-enrollment.v1"]);

const EXPECTED_CONFIG_KEYS = Object.freeze([
  "$schema",
  "assets",
  "compatibility_date",
  "main",
  "name",
  "observability",
  "preview_urls",
  "routes",
  "rules",
  "secrets",
  "workers_dev",
]);

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sameStrings(actual, expected) {
  return (
    Array.isArray(actual) &&
    actual.length === expected.length &&
    actual.every((value) => typeof value === "string") &&
    [...actual].sort().every((value, index) => value === [...expected].sort()[index])
  );
}

/**
 * Keeps staging structurally independent from the default production Worker. Any new binding or
 * route must be reviewed here instead of arriving through Wrangler environment inheritance.
 */
export function assertStagingConfig(config) {
  invariant(isRecord(config), "Staging Wrangler configuration must be an object");
  invariant(
    sameStrings(Object.keys(config), EXPECTED_CONFIG_KEYS),
    "Staging Wrangler configuration contains an unreviewed or missing top-level field",
  );
  invariant(config.name === "roamcode-site-staging", "Staging must use its dedicated Worker name");
  invariant(config.main === "worker/index.ts", "Staging must use the reviewed site Worker entry point");
  invariant(config.compatibility_date === "2026-07-01", "Staging compatibility date drifted from production");
  invariant(config.workers_dev === false, "Staging must not expose a workers.dev route");
  invariant(config.preview_urls === false, "Staging must not expose version preview URLs");
  invariant(
    Array.isArray(config.routes) &&
      config.routes.length === 1 &&
      isRecord(config.routes[0]) &&
      config.routes[0].pattern === "staging.roamcode.ai" &&
      config.routes[0].custom_domain === true &&
      Object.keys(config.routes[0]).length === 2,
    "Staging must route only the staging.roamcode.ai Custom Domain",
  );
  invariant(
    isRecord(config.assets) &&
      config.assets.directory === "./dist" &&
      config.assets.binding === "ASSETS" &&
      config.assets.run_worker_first === true &&
      Object.keys(config.assets).length === 3,
    "Staging must use only the reviewed ASSETS binding",
  );
  invariant(
    Array.isArray(config.rules) &&
      config.rules.length === 1 &&
      isRecord(config.rules[0]) &&
      config.rules[0].type === "Text" &&
      config.rules[0].fallthrough === true &&
      sameStrings(config.rules[0].globs, ["**/*.md"]),
    "Staging module rules drifted from production",
  );
  invariant(
    isRecord(config.observability) && config.observability.enabled === true,
    "Staging observability must remain enabled",
  );
  invariant(
    isRecord(config.secrets) &&
      Object.keys(config.secrets).length === 1 &&
      sameStrings(config.secrets.required, REQUIRED_STAGING_SECRETS),
    "Staging must require its control-plane origin, key id, and HMAC secret",
  );
}

/** Returns only missing secret names. Secret values are never accepted or inspected here. */
export function missingRequiredSecrets(secrets) {
  invariant(Array.isArray(secrets), "Wrangler secret inventory must be a JSON array");
  const names = new Set();
  for (const secret of secrets) {
    if (typeof secret === "string") {
      names.add(secret);
      continue;
    }
    invariant(isRecord(secret) && typeof secret.name === "string", "Wrangler returned an invalid secret inventory");
    names.add(secret.name);
  }
  return REQUIRED_STAGING_SECRETS.filter((name) => !names.has(name));
}

function uniqueStringArray(value) {
  return (
    Array.isArray(value) &&
    value.every((item) => typeof item === "string" && item.length > 0) &&
    new Set(value).size === value.length
  );
}

/** Validates the public launch authority after deployment without requiring either launch gate to be open. */
export function validateCapabilityDocument(value) {
  invariant(isRecord(value), "Staging capability response must be an object");
  invariant(value.v === 1, "Staging capability response must use contract v1");
  invariant(isRecord(value.launch), "Staging capability response must include launch gates");
  invariant(
    typeof value.launch.account === "boolean" && typeof value.launch.managedTerminal === "boolean",
    "Staging capability launch gates must be booleans",
  );
  invariant(uniqueStringArray(value.capabilities), "Staging product capabilities must be unique strings");
  invariant(
    uniqueStringArray(value.requiredNodeCapabilities),
    "Staging required Node capabilities must be unique strings",
  );

  const account = value.launch.account;
  const managedTerminal = value.launch.managedTerminal;
  invariant(!account || value.capabilities.includes("account.v1"), "Account launch requires account.v1");
  invariant(!managedTerminal || account, "Managed terminal launch requires account launch");
  invariant(
    !managedTerminal || value.capabilities.includes("managed-device-enrollment.v1"),
    "Managed terminal launch requires managed-device-enrollment.v1",
  );
  invariant(
    !managedTerminal || sameStrings(value.requiredNodeCapabilities, REQUIRED_MANAGED_NODE_CAPABILITIES),
    "Managed terminal launch requires the exact reviewed Node capability set",
  );
  return Object.freeze({ account, managedTerminal });
}

/** Normal deploys omit a secrets file so Wrangler inherits every existing `secrets.required` binding. */
export function stagingDeployArguments(secretsFile) {
  const arguments_ = ["deploy", "--config", stagingConfigFilename, "--strict", "--autoconfig=false"];
  if (secretsFile) arguments_.push("--secrets-file", secretsFile);
  return arguments_;
}

function stagingConfig() {
  const config = JSON.parse(readFileSync(stagingConfigPath, "utf8"));
  assertStagingConfig(config);
  return config;
}

function runNode(arguments_, options = {}) {
  const { label = "Command", ...spawnOptions } = options;
  const result = spawnSync(process.execPath, arguments_, {
    cwd: siteDirectory,
    env: { ...process.env, NODE_ENV: "production" },
    stdio: "inherit",
    ...spawnOptions,
  });
  if (result.error) throw result.error;
  invariant(result.status === 0, `${label} failed with status ${result.status ?? "unknown"}`);
  return result;
}

function runWrangler(arguments_, options = {}) {
  return runNode([wranglerPath, ...arguments_], options);
}

function assertWranglerCliContract() {
  const deployHelp = runWrangler(["deploy", "--help"], {
    encoding: "utf8",
    label: "Wrangler deploy help check",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const deployOptions = `${deployHelp.stdout}\n${deployHelp.stderr}`;
  for (const option of ["--dry-run", "--strict", "--autoconfig"]) {
    invariant(deployOptions.includes(option), `Pinned Wrangler no longer supports ${option}`);
  }

  const secretHelp = runWrangler(["secret", "list", "--help"], {
    encoding: "utf8",
    label: "Wrangler secret-list help check",
    stdio: ["ignore", "pipe", "pipe"],
  });
  invariant(
    `${secretHelp.stdout}\n${secretHelp.stderr}`.includes("--format"),
    "Pinned Wrangler lacks JSON secret lists",
  );
}

function buildStaging() {
  runNode([join(siteDirectory, "scripts", "build.mjs"), "--target=staging"], { label: "Staging build" });
}

function dryRunStaging(secretsFile) {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "roamcode-site-staging-dry-run-"));
  try {
    const arguments_ = [
      "deploy",
      "--config",
      stagingConfigFilename,
      "--dry-run",
      "--outdir",
      join(temporaryDirectory, "bundle"),
      "--autoconfig=false",
    ];
    if (secretsFile) arguments_.push("--secrets-file", secretsFile);
    runWrangler(arguments_, { label: "Staging Wrangler dry-run" });
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function remoteSecretPreflight() {
  const result = runWrangler(["secret", "list", "--config", stagingConfigFilename, "--format=json"], {
    encoding: "utf8",
    label: "Staging secret-name preflight",
    stdio: ["ignore", "pipe", "pipe"],
  });
  let inventory;
  try {
    inventory = JSON.parse(result.stdout);
  } catch {
    throw new Error("Wrangler returned an invalid staging secret inventory");
  }
  const missing = missingRequiredSecrets(inventory);
  invariant(
    missing.length === 0,
    `Staging deploy stopped before upload; missing required secret names: ${missing.join(", ")}`,
  );
}

function checkedBootstrapSecretsFile(rawPath) {
  invariant(typeof rawPath === "string" && isAbsolute(rawPath), "Bootstrap requires an absolute --secrets-file path");
  let path;
  let stats;
  try {
    path = realpathSync(rawPath);
    stats = lstatSync(path);
  } catch {
    throw new Error("Bootstrap secrets file is not a readable regular file");
  }
  invariant(stats.isFile() && stats.size > 0, "Bootstrap secrets file must be a non-empty regular file");
  const repositoryRelativePath = relative(repositoryDirectory, path);
  invariant(
    repositoryRelativePath.startsWith("..") || isAbsolute(repositoryRelativePath),
    "Bootstrap secrets file must live outside the repository",
  );
  if (process.platform !== "win32") {
    invariant((stats.mode & 0o077) === 0, "Bootstrap secrets file permissions must deny group and other access");
  }
  return path;
}

async function smokeStaging() {
  let response;
  try {
    response = await fetch(`${stagingOrigin}${capabilityPath}`, {
      cache: "no-store",
      headers: { accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new Error("Staging capability smoke could not reach the dedicated staging origin");
  }
  invariant(response.status === 200, `Staging capability smoke returned HTTP ${response.status}`);
  invariant(
    (response.headers.get("cache-control") ?? "")
      .split(",")
      .some((directive) => directive.trim().toLowerCase() === "no-store"),
    "Staging capability response must be no-store",
  );
  let document;
  try {
    document = await response.json();
  } catch {
    throw new Error("Staging capability response is not valid JSON");
  }
  return validateCapabilityDocument(document);
}

function parseCommand(arguments_) {
  const [command, ...rest] = arguments_;
  invariant(
    command === "check" || command === "deploy" || command === "bootstrap",
    "Expected check, deploy, or bootstrap",
  );
  if (command !== "bootstrap") {
    invariant(rest.length === 0, `${command} does not accept additional arguments`);
    return { command };
  }
  invariant(
    rest.length === 2 && rest[0] === "--secrets-file",
    "Bootstrap usage: staging-deploy.mjs bootstrap --secrets-file /absolute/path",
  );
  return { command, secretsFile: checkedBootstrapSecretsFile(rest[1]) };
}

async function main() {
  const operation = parseCommand(process.argv.slice(2));
  stagingConfig();
  assertWranglerCliContract();

  if (operation.command === "deploy") remoteSecretPreflight();
  buildStaging();
  dryRunStaging(operation.secretsFile);
  if (operation.command === "check") {
    console.log("Staging config, build, and Wrangler dry-run passed without Cloudflare authentication or mutation.");
    return;
  }

  runWrangler(stagingDeployArguments(operation.secretsFile), { label: "Staging deploy" });
  const launch = await smokeStaging();
  console.log(
    `Staging deploy and capability smoke passed; account=${launch.account ? "open" : "closed"}, managed-terminal=${launch.managedTerminal ? "open" : "closed"}.`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(scriptPath)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "Staging deployment failed");
    process.exitCode = 1;
  });
}
