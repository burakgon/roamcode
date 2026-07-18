import { existsSync, readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const siteDirectory = fileURLToPath(new URL("..", import.meta.url));
const repositoryDirectory = fileURLToPath(new URL("../..", import.meta.url));
const webDirectory = fileURLToPath(new URL("../../packages/web", import.meta.url));
const outputDirectory = fileURLToPath(new URL("../dist", import.meta.url));
const terminalDirectory = fileURLToPath(new URL("../dist/terminal", import.meta.url));
const productionDeployHold = fileURLToPath(new URL("../.production-deploy-hold", import.meta.url));
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const buildArguments = process.argv.slice(2);
const deploymentTarget =
  buildArguments.length === 0 ? "production" : buildArguments[0] === "--target=staging" ? "staging" : undefined;
if (!deploymentTarget || buildArguments.length > 1) {
  console.error("Usage: node scripts/build.mjs [--target=staging]");
  process.exit(64);
}
const productionEnvironment = {
  ...process.env,
  NODE_ENV: "production",
};
delete productionEnvironment.VITEST;
delete productionEnvironment.VITEST_WORKER_ID;
const hostedWebEnvironment = {
  ...productionEnvironment,
  ROAMCODE_WEB_BASE: "/terminal/",
  VITE_APP_PATH_PREFIX: "/terminal",
};

// Cross-surface releases deliberately push the reviewed source before the account service and
// stable Node are exposed. Cloudflare injects these variables only into Workers Builds, so GitHub
// CI and preview-branch uploads remain usable while production promotion fails closed.
if (
  deploymentTarget === "production" &&
  process.env.WORKERS_CI === "1" &&
  process.env.WORKERS_CI_BRANCH === "main" &&
  existsSync(productionDeployHold)
) {
  console.error(
    "Production Workers Build is held until the account service, stable Node, and hosted smoke gates pass.",
  );
  process.exit(78);
}

function run(arguments_, options = {}) {
  const result = spawnSync(pnpm, arguments_, {
    cwd: repositoryDirectory,
    env: productionEnvironment,
    stdio: "inherit",
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function assertHostedBundle() {
  const terminalIndex = `${terminalDirectory}/index.html`;
  const terminalManifest = `${terminalDirectory}/manifest.webmanifest`;
  const terminalServiceWorker = `${terminalDirectory}/sw.js`;
  const siteIndex = `${outputDirectory}/index.html`;
  for (const artifact of [siteIndex, terminalIndex, terminalManifest, terminalServiceWorker]) {
    if (!existsSync(artifact)) throw new Error(`Hosted build is missing ${artifact}`);
  }
  const index = readFileSync(terminalIndex, "utf8");
  if (!index.includes("/terminal/assets/") || !index.includes("/terminal/manifest.webmanifest")) {
    throw new Error("Hosted terminal bundle does not use the /terminal/ asset base");
  }
  const manifest = JSON.parse(readFileSync(terminalManifest, "utf8"));
  if (manifest.scope !== "/terminal/" || manifest.start_url !== "/terminal/sessions") {
    throw new Error("Hosted terminal manifest does not use the /terminal navigation scope");
  }
}

rmSync(outputDirectory, { recursive: true, force: true });

// Cloudflare installs site/ as an isolated workspace. Hydrate only the locked web workspace so a
// clean deployment never relies on repository-level node_modules left behind by another build.
run(["install", "--filter", "@roamcode.ai/web...", "--frozen-lockfile"]);

// Type-check and build the real application first. Raw Node traffic remains owned by its browser relay
// transport; this step only publishes the same PWA shell under a same-origin static path.
run(["--dir", webDirectory, "exec", "tsc", "--noEmit"], { env: hostedWebEnvironment });
run(["--dir", webDirectory, "exec", "vite", "build", "--outDir", terminalDirectory, "--emptyOutDir"], {
  env: hostedWebEnvironment,
});

// site/vite.config.ts intentionally keeps emptyOutDir=false so this second build cannot erase the PWA.
run(["--dir", siteDirectory, "exec", "vite", "build"]);
assertHostedBundle();
