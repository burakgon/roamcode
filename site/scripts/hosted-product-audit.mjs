// Real-browser acceptance for the same-origin hosted account shell.
//
// The audit serves the production site build with a deterministic, non-secret API fixture, then
// captures the core product flow in system Chrome and Safari. It never contacts the developer's
// installed RoamCode service and never uses the default RoamCode port or data directories.
//
// Run from any checkout; the harness creates a fresh production build before opening a browser:
//   pnpm --dir site test:hosted-ui
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, devices } from "playwright";

const repositoryDirectory = fileURLToPath(new URL("../..", import.meta.url));
const siteDirectory = fileURLToPath(new URL("..", import.meta.url));
const siteBuildDirectory = join(siteDirectory, "dist");
const outputDirectory = resolve(process.env.ROAMCODE_HOSTED_AUDIT_OUTPUT ?? "/tmp/roamcode-hosted-product-audit");
const host = "127.0.0.1";
const requestedPort = Number.parseInt(process.env.ROAMCODE_HOSTED_AUDIT_PORT ?? "0", 10);
const systemChrome = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
const requestedBrowsers = new Set(
  (process.env.ROAMCODE_HOSTED_AUDIT_BROWSERS ?? (process.platform === "darwin" ? "chrome,safari" : "chrome"))
    .split(",")
    .map((browser) => browser.trim().toLowerCase())
    .filter(Boolean),
);
const unknownBrowsers = [...requestedBrowsers].filter((browser) => browser !== "chrome" && browser !== "safari");
if (requestedBrowsers.size === 0 || unknownBrowsers.length > 0) {
  throw new Error(
    `ROAMCODE_HOSTED_AUDIT_BROWSERS must contain chrome and/or safari, received: ${[...requestedBrowsers].join(", ")}`,
  );
}
const safariRequired = requestedBrowsers.has("safari") && process.env.ROAMCODE_SAFARI_REQUIRED !== "false";

const ORGANIZATION_ID = "10000000-0000-4000-8000-000000000001";
const PERSONAL_ID = "10000000-0000-4000-8000-000000000002";
const USER_ID = "10000000-0000-4000-8000-000000000003";
const HOST_STUDIO = "10000000-0000-4000-8000-000000000004";
const HOST_BUILD = "10000000-0000-4000-8000-000000000005";
const AUDIT_TIME = Date.parse("2026-07-18T10:00:00.000Z");

function assertSafePort(port, variable) {
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`${variable} must be an integer between 0 and 65535`);
  }
  if (port === 4_280) {
    throw new Error(`${variable} must not use RoamCode's live-service port`);
  }
}

function buildHostedSite() {
  const result = spawnSync(process.execPath, [join(siteDirectory, "scripts", "build.mjs")], {
    cwd: repositoryDirectory,
    env: { ...process.env, NODE_ENV: "production" },
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`hosted production build failed with status ${result.status ?? "unknown"}`);
}

function resetEvidenceDirectory() {
  mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });
  for (const entry of readdirSync(outputDirectory)) {
    if (entry === "audit.json" || /^(?:chrome|safari)-.+\.png$/u.test(entry)) {
      rmSync(join(outputDirectory, entry), { force: true });
    }
  }
}

async function availableLoopbackPort() {
  const probe = createNetServer();
  await new Promise((resolveListen, rejectListen) => {
    probe.once("error", rejectListen);
    probe.listen(0, host, resolveListen);
  });
  const address = probe.address();
  await new Promise((resolveClose) => probe.close(resolveClose));
  if (!address || typeof address === "string") throw new Error("could not reserve an isolated Safari driver port");
  return address.port;
}

assertSafePort(requestedPort, "ROAMCODE_HOSTED_AUDIT_PORT");
buildHostedSite();
resetEvidenceDirectory();

const findings = [];
const screenshots = [];
const stepContracts = new Map(
  [
    ["01-sessions-desktop", "/terminal/sessions", "Sessions — RoamCode", "Sessions", "sessions"],
    ["02-automations-desktop", "/terminal/automations", "Automations — RoamCode", "Automations", "automations"],
    ["03-agents-desktop", "/app/agents", "Agents — RoamCode", "Agents", "agents"],
    ["04-people-desktop", "/app/people", "People & Access — RoamCode", "People & Access", "people"],
    ["05-account-desktop", "/app/account", "Account — RoamCode", "Account", "account"],
    ["06-sessions-mobile", "/terminal/sessions", "Sessions — RoamCode", "Sessions", null],
    ["07-agents-mobile", "/app/agents", "Agents — RoamCode", "Agents", "agents"],
    ["08-sign-in-desktop", "/app", "Sign in — RoamCode", "Welcome back", null],
    ["09-sign-up-desktop", "/app", "Create account — RoamCode", "Create your RoamCode account", null],
    ["10-sessions-desktop", "/terminal/sessions", "Sessions — RoamCode", "Sessions", "sessions"],
    ["11-automations-desktop", "/terminal/automations", "Automations — RoamCode", "Automations", "automations"],
    ["12-agents-desktop", "/app/agents", "Agents — RoamCode", "Agents", "agents"],
    ["13-people-desktop", "/app/people", "People & Access — RoamCode", "People & Access", "people"],
    ["14-account-desktop", "/app/account", "Account — RoamCode", "Account", "account"],
    ["15-sessions-narrow", "/terminal/sessions", "Sessions — RoamCode", "Sessions", null],
    [
      "16-organization-desktop",
      "/app/organization",
      "Organization settings — RoamCode",
      "Organization settings",
      "organization",
    ],
    ["17-organization-mobile", "/app/organization", "Organization settings — RoamCode", "Organization settings", null],
  ].map(([step, pathname, title, heading, activeRoute]) => [step, { pathname, title, heading, activeRoute }]),
);

function json(response, status = 200) {
  return {
    status,
    headers: { "cache-control": "no-store", "content-type": "application/json; charset=utf-8" },
    body: Buffer.from(`${JSON.stringify(response)}\n`),
  };
}

const user = {
  id: USER_ID,
  name: "Ada Lovelace",
  email: "ada@example.test",
  emailVerified: true,
};

const contexts = [
  {
    id: ORGANIZATION_ID,
    kind: "organization",
    slug: "analytical-engineering",
    name: "Analytical Engineering",
    plan: "enterprise",
    role: "owner",
  },
  { id: PERSONAL_ID, kind: "personal", slug: "personal-ada", name: "Personal", plan: "free", role: "owner" },
];

const hosts = [
  {
    id: HOST_STUDIO,
    organizationId: ORGANIZATION_ID,
    name: "Studio Mac",
    slug: "studio-mac",
    status: "online",
    tokenVersion: 3,
    provisioningSagaId: "10000000-0000-4000-8000-000000000010",
    agentVersion: "1.2.0",
    lastSeenAt: "2026-07-18T09:42:00.000Z",
    createdAt: "2026-07-12T08:00:00.000Z",
    heartbeatState: "ready",
    capabilities: ["terminal.v1", "relay.v1", "managed-device-enrollment.v1"],
    revision: 1,
  },
  {
    id: HOST_BUILD,
    organizationId: ORGANIZATION_ID,
    name: "Build Runner",
    slug: "build-runner",
    status: "offline",
    tokenVersion: 2,
    provisioningSagaId: "10000000-0000-4000-8000-000000000011",
    agentVersion: "1.2.0",
    lastSeenAt: "2026-07-18T07:15:00.000Z",
    createdAt: "2026-07-10T08:00:00.000Z",
    heartbeatState: "draining",
    capabilities: ["terminal.v1", "relay.v1", "managed-device-enrollment.v1"],
    revision: 1,
  },
];

const members = [
  {
    organizationId: ORGANIZATION_ID,
    userId: USER_ID,
    role: "owner",
    status: "active",
    name: "Ada Lovelace",
    email: "ada@example.test",
    joinedAt: "2026-07-10T08:00:00.000Z",
  },
  {
    organizationId: ORGANIZATION_ID,
    userId: "10000000-0000-4000-8000-000000000020",
    role: "member",
    status: "active",
    name: "Lin Chen",
    email: "lin@example.test",
    joinedAt: "2026-07-12T08:00:00.000Z",
  },
  {
    organizationId: ORGANIZATION_ID,
    userId: "10000000-0000-4000-8000-000000000021",
    role: "viewer",
    status: "active",
    name: "Noor Khan",
    email: "noor@example.test",
    joinedAt: "2026-07-13T08:00:00.000Z",
  },
];

function productCapabilities() {
  return {
    v: 1,
    launch: { account: true, managedTerminal: true },
    capabilities: ["account.v1", "managed-device-enrollment.v1"],
    requiredNodeCapabilities: ["terminal.v1", "relay.v1", "managed-device-enrollment.v1"],
  };
}

function isAuthFixture(request) {
  return /(?:^|;\s*)rc-audit-mode=auth(?:;|$)/u.test(request.headers.cookie ?? "");
}

function apiFixture(request, url) {
  const authFixture = isAuthFixture(request);
  if (url.pathname === "/api/v1/meta/product-capabilities") return json(productCapabilities());
  if (url.pathname === "/api/v1/meta/providers") {
    return json({
      email_password: true,
      passkey: false,
      github: true,
      google: true,
      mode: "self_hosted",
    });
  }
  if (url.pathname === "/api/auth/get-session") {
    return json(authFixture ? null : { session: { id: "audit-session" }, user });
  }
  if (url.pathname === "/api/v1/account/bootstrap" && request.method === "POST") {
    return json({ user: { id: user.id, name: user.name, email: user.email }, contexts });
  }
  if (url.pathname === `/api/v1/orgs/${ORGANIZATION_ID}/hosts`) return json({ hosts });
  if (url.pathname === `/api/v1/orgs/${ORGANIZATION_ID}/members`) return json({ members });
  if (url.pathname === `/api/v1/orgs/${ORGANIZATION_ID}/access`) {
    return json({
      access: hosts.map((hostItem) => ({
        hostId: hostItem.id,
        effectivePermission: "manage",
        grantExpiresAt: null,
        latestRequest: null,
      })),
    });
  }
  if (url.pathname === `/api/v1/orgs/${PERSONAL_ID}/hosts`) return json({ hosts: [] });
  if (url.pathname === `/api/v1/orgs/${ORGANIZATION_ID}`) {
    return json({
      organization: {
        id: ORGANIZATION_ID,
        kind: "organization",
        slug: "analytical-engineering",
        name: "Analytical Engineering",
        plan: "enterprise",
        revision: 1,
        createdAt: "2026-07-10T08:00:00.000Z",
      },
    });
  }
  if (url.pathname === `/api/v1/orgs/${ORGANIZATION_ID}/entitlements`) {
    return json({
      entitlements: {
        organizationId: ORGANIZATION_ID,
        maxMembers: 50,
        maxHosts: 20,
        maxDevicesPerHost: 10,
        auditRetentionDays: 365,
        source: "enterprise",
        validUntil: null,
      },
    });
  }
  if (url.pathname === `/api/v1/hosts/${HOST_STUDIO}/status`) {
    return json({
      host: hosts[0],
      relay: {
        status: { hostOnline: true, activeDevices: 2 },
        route: { id: "audit-route-studio", label: "Studio Mac", deviceCount: 2 },
        connection: { path: "/v1/connect", protocolVersion: 1 },
      },
    });
  }
  if (url.pathname === `/api/v1/hosts/${HOST_BUILD}/status`) {
    return json({ host: hosts[1], relay: null });
  }
  if (url.pathname === `/api/v1/orgs/${ORGANIZATION_ID}/invites`) {
    return json({
      invites: [
        {
          id: "10000000-0000-4000-8000-000000000030",
          organizationId: ORGANIZATION_ID,
          email: "grace@example.test",
          role: "member",
          status: "pending",
          expiresAt: "2026-07-25T09:00:00.000Z",
          createdAt: "2026-07-18T09:00:00.000Z",
        },
      ],
    });
  }
  if (url.pathname === `/api/v1/orgs/${ORGANIZATION_ID}/grants`) {
    return json({
      grants: [
        {
          id: "10000000-0000-4000-8000-000000000031",
          organizationId: ORGANIZATION_ID,
          principalUserId: members[1].userId,
          hostId: HOST_STUDIO,
          workspaceId: null,
          permission: "use",
          expiresAt: null,
          createdAt: "2026-07-18T09:00:00.000Z",
        },
      ],
    });
  }
  if (url.pathname === `/api/v1/orgs/${ORGANIZATION_ID}/access-requests`) {
    return json({
      access_requests: [
        {
          id: "10000000-0000-4000-8000-000000000032",
          organizationId: ORGANIZATION_ID,
          requesterUserId: members[2].userId,
          hostId: HOST_STUDIO,
          workspaceId: null,
          permission: "use",
          reason: "Review the release candidate from the hosted terminal.",
          status: "pending",
          reviewedBy: null,
          reviewNote: null,
          createdAt: "2026-07-18T08:50:00.000Z",
          reviewedAt: null,
        },
      ],
    });
  }
  if (url.pathname === "/api/v1/auth/devices") {
    return json({
      devices: [
        {
          id: "10000000-0000-4000-8000-000000000040",
          organizationId: ORGANIZATION_ID,
          organizationName: "Analytical Engineering",
          name: "Ada's MacBook",
          platform: "macOS",
          clientId: "roamcode-cli",
          scopes: ["identity", "organizations", "hosts"],
          lastSeenAt: "2026-07-18T09:40:00.000Z",
          revokedAt: null,
          createdAt: "2026-07-15T08:00:00.000Z",
        },
      ],
    });
  }
  if (url.pathname === "/api/v1/account/host-devices") {
    return json({
      devices: [
        {
          id: "10000000-0000-4000-8000-000000000041",
          organizationId: ORGANIZATION_ID,
          organizationName: "Analytical Engineering",
          hostId: HOST_STUDIO,
          hostName: "Studio Mac",
          actorId: USER_ID,
          label: "Chrome on MacBook",
          pairedBy: USER_ID,
          pairedAt: "2026-07-17T08:00:00.000Z",
          lastSeenAt: "2026-07-18T09:41:00.000Z",
          revokedAt: null,
        },
      ],
    });
  }
  if (url.pathname === "/api/v1/legal/documents") {
    return json({
      documents: [
        { id: "terms", documentType: "terms", version: "1.0", publicUrl: "/legal/terms", effectiveAt: "2026-07-01" },
        {
          id: "privacy",
          documentType: "privacy",
          version: "1.0",
          publicUrl: "/legal/privacy",
          effectiveAt: "2026-07-01",
        },
      ],
    });
  }
  return json({ error: "not_found" }, 404);
}

const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json",
  ".woff2": "font/woff2",
};

function readAuditAsset(filePath) {
  const source = readFileSync(filePath);
  if (extname(filePath) !== ".html") return source;
  const clock = `<script>globalThis.Date=class extends Date{constructor(...args){super(...(args.length?args:[${AUDIT_TIME}]))}static now(){return ${AUDIT_TIME}}};</script>`;
  return Buffer.from(source.toString("utf8").replace("<head>", `<head>${clock}`));
}

function terminalWorkbenchFixture(destination) {
  const automation = destination === "automations";
  const title = automation ? "Automations" : "Sessions";
  const rows = automation
    ? `<article class="row active"><span class="status violet"></span><div><b>Release readiness</b><small>Schedule · weekdays at 09:00</small></div><em>Ready</em></article>
       <article class="row"><span class="status"></span><div><b>Dependency review</b><small>Webhook · repository signal</small></div><em>Idle</em></article>`
    : `<article class="row active"><span class="status"></span><div><b>Release candidate</b><small>Codex · remote-coder</small></div><em>Live</em></article>
       <article class="row"><span class="status muted"></span><div><b>Cloud migration</b><small>Claude Code · roamcode-cloud</small></div><em>2h</em></article>`;
  const detail = automation
    ? `<div class="terminal-head"><span>Release readiness</span><small>Next run · Mon 09:00</small></div><div class="automation"><span>TRIGGER</span><b>Weekdays at 09:00 · Europe/Istanbul</b><span>RUNS ON</span><b>Studio Mac · /remote-coder</b><span>ACTION</span><b>Open an inspectable Codex session</b></div>`
    : `<div class="terminal-head"><span>Release candidate</span><small>Codex · connected</small></div><pre><i>~/remote-coder</i> <b>main</b>\n\n› Review the release candidate and run the complete verification suite.\n\n✓ Typecheck, unit tests, and production build passed.\n<span>█</span></pre>`;
  return Buffer.from(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} — RoamCode</title><style>
    *{box-sizing:border-box}html,body{height:100%;margin:0;background:#08080b;color:#f4f2f7;font:13px Inter,ui-sans-serif,system-ui,sans-serif}body{display:grid;grid-template-columns:280px minmax(0,1fr);overflow:hidden}.rail{min-width:0;display:flex;flex-direction:column;border-right:1px solid #25242c;background:#0d0d11}.context{display:grid;gap:3px;margin:14px 14px 8px;padding:10px 12px;border:1px solid #292832;border-radius:10px;color:#f4f2f7;text-decoration:none}.context span{color:#777381;font:9px ui-monospace,monospace;letter-spacing:.12em;text-transform:uppercase}.context b{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.primary{padding:0 14px 12px;border-bottom:1px solid #25242c}.primary ul{display:grid;gap:3px;margin:0;padding:0;list-style:none}.primary a{min-height:38px;display:flex;align-items:center;padding:0 11px;border:1px solid transparent;border-radius:8px;color:#8d8998;text-decoration:none}.primary a[aria-current=page]{border-color:#373442;background:#18171e;color:#fff}.work{min-height:0;flex:1;overflow:auto;padding:14px}.work h1{margin:0 0 12px;color:#8d8998;font:600 10px ui-monospace,monospace;letter-spacing:.14em;text-transform:uppercase}.row{display:grid;grid-template-columns:auto 1fr auto;gap:10px;align-items:center;margin:8px 0;padding:12px;border:1px solid transparent;border-radius:10px;color:#aaa6b3}.row.active{border-color:#373442;background:#18171e;color:#fff}.row div{display:grid;gap:4px}.row small,.row em{color:#777381;font-size:10px;font-style:normal}.status{width:7px;height:7px;border-radius:50%;background:#72e3ac;box-shadow:0 0 12px #72e3ac88}.status.violet{background:#a897ff;box-shadow:0 0 12px #a897ff88}.status.muted{background:#55515e;box-shadow:none}.pane{min-width:0;padding:10px}.terminal{height:100%;border:1px solid #292832;border-radius:10px;background:#0b0b0e;overflow:hidden}.terminal-head{height:46px;display:flex;align-items:center;justify-content:space-between;padding:0 16px;border-bottom:1px solid #24232b;background:#111116}.terminal-head span{font-weight:650}.terminal-head small{color:#72e3ac}pre{margin:0;padding:24px;color:#bcb8c5;font:12px/1.8 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap}pre i{color:#6fc8ff;font-style:normal}pre b{color:#a897ff}pre span{color:#ff815f}.automation{display:grid;grid-template-columns:100px 1fr;gap:18px;padding:26px}.automation span{color:#777381;font-size:10px;letter-spacing:.12em}.automation b{font-weight:550}.mobile-head{display:none}@media(max-width:720px){body{display:flex;flex-direction:column}.rail{display:none}.mobile-head{min-height:58px;display:flex;align-items:center;gap:12px;padding:0 14px;border-bottom:1px solid #25242c;background:#0d0d11}.mobile-head b{font:700 13px ui-monospace,monospace}.mobile-head h1{margin:0;font-size:13px}.mobile-head span{margin-left:auto;color:#72e3ac;font-size:10px}.pane{flex:1;min-height:0;padding:0}.terminal{border:0;border-radius:0}.terminal-head{height:48px}pre{padding:20px 16px}.automation{grid-template-columns:74px 1fr;padding:20px 16px}}
  </style></head><body><header class="mobile-head"><b>rc</b><h1>${title}</h1><span>Studio Mac</span></header><aside class="rail"><a class="context" href="/app/account" aria-label="Open account for Analytical Engineering"><span>Organization</span><b>Analytical Engineering</b></a><nav class="primary" aria-label="Primary"><ul><li><a href="/terminal/sessions" data-route="sessions" ${automation ? "" : 'aria-current="page"'}>Sessions</a></li><li><a href="/terminal/automations" data-route="automations" ${automation ? 'aria-current="page"' : ""}>Automations</a></li><li><a href="/app/agents" data-route="agents">Agents</a></li></ul></nav><section class="work"><h1>${title}</h1>${rows}</section></aside><main class="pane"><section class="terminal" aria-label="${title} on connected Node">${detail}</section></main></body></html>`);
}

function staticFixture(url) {
  const requested = decodeURIComponent(url.pathname);
  if (requested === "/terminal/sessions" || requested === "/terminal/automations") {
    // The cryptographic browser-to-Node path is covered by protocol integration tests. This hosted
    // shell audit holds that external boundary connected so screenshots stay deterministic and can
    // verify the same-origin workbench composition without a developer service or live credentials.
    return {
      status: 200,
      headers: { "cache-control": "no-store", "content-type": "text/html; charset=utf-8" },
      body: terminalWorkbenchFixture(requested.endsWith("automations") ? "automations" : "sessions"),
    };
  }
  const requestedFile = requested === "/" ? "index.html" : requested.replace(/^\/+/, "");
  let filePath = resolve(siteBuildDirectory, requestedFile);
  const relativePath = relative(siteBuildDirectory, filePath);
  if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
    return { status: 403, headers: { "content-type": "text/plain" }, body: Buffer.from("Forbidden\n") };
  }
  try {
    return {
      status: 200,
      headers: {
        "cache-control": "no-store",
        "content-type": contentTypes[extname(filePath)] ?? "application/octet-stream",
      },
      body: readAuditAsset(filePath),
    };
  } catch {
    filePath =
      requested === "/terminal" || requested.startsWith("/terminal/")
        ? join(siteBuildDirectory, "terminal", "index.html")
        : join(siteBuildDirectory, "index.html");
    return {
      status: 200,
      headers: { "cache-control": "no-store", "content-type": contentTypes[".html"] },
      body: readAuditAsset(filePath),
    };
  }
}

const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", `http://${host}`);
  const fixture = url.pathname.startsWith("/api/") ? apiFixture(request, url) : staticFixture(url);
  response.writeHead(fixture.status, fixture.headers);
  response.end(fixture.body);
});

await new Promise((resolveListen, rejectListen) => {
  server.once("error", rejectListen);
  server.listen(requestedPort, host, resolveListen);
});

const address = server.address();
if (!address || typeof address === "string") throw new Error("hosted audit server did not bind a TCP port");
const origin = `http://${host}:${address.port}`;

function screenshotPath(browser, name) {
  const filename = `${browser}-${name}.png`;
  screenshots.push(filename);
  return join(outputDirectory, filename);
}

function recordRuntimeSignals(page, errors, prefix = "") {
  page.on("pageerror", (error) => errors.push(`${prefix}page: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`${prefix}console: ${message.text()}`);
  });
  page.on("response", (response) => {
    if (response.status() < 400) return;
    const url = new URL(response.url());
    errors.push(`${prefix}response: ${response.status()} ${url.pathname}${url.search}`);
  });
}

function auditExpression() {
  return `(() => {
    const visible = (element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
    };
    const name = (element) => element.getAttribute("aria-label")?.trim() ||
      (element.labels ? Array.from(element.labels).map((label) => label.textContent?.trim()).find(Boolean) : "") ||
      element.textContent?.trim() || element.getAttribute("title")?.trim() || "";
    const controls = Array.from(document.querySelectorAll("button, input, select, textarea, a[href]")).filter(visible);
    const minimumFor = (element) => element.matches("select") || innerWidth <= 560 ? 44 : 24;
    const targetSize = (element) => {
      const rect = element.getBoundingClientRect();
      return {
        name: name(element).slice(0, 80),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        minimum: minimumFor(element),
      };
    };
    const heading = Array.from(document.querySelectorAll("h1")).find(visible);
    const headingRect = heading?.getBoundingClientRect();
    return {
      title: document.title,
      pathname: location.pathname,
      viewport: { width: innerWidth, height: innerHeight },
      scrollY: Math.round(scrollY),
      horizontalOverflow: document.documentElement.scrollWidth > innerWidth + 1,
      unnamedControls: controls.filter((element) => !name(element)).length,
      selectTargets: controls.filter((element) => element.matches("select")).map(targetSize),
      undersizedTargets: controls.map(targetSize).filter((target) =>
        target.width < target.minimum || target.height < target.minimum),
      activeNavigation: Array.from(document.querySelectorAll('[aria-current="page"]')).filter(visible).map((element) => name(element)),
      activeRoutes: Array.from(document.querySelectorAll('[data-route][aria-current="page"]')).filter(visible).map((element) => element.getAttribute("data-route")),
      mainHeading: heading?.textContent?.trim(),
      mainHeadingTop: headingRect ? Math.round(headingRect.top) : null,
      mainHeadingBottom: headingRect ? Math.round(headingRect.bottom) : null,
      iframeCount: document.querySelectorAll("iframe").length,
      bodyText: document.body.innerText.slice(0, 500),
    };
  })()`;
}

function recordEvidence(browser, step, evidence) {
  findings.push({ browser, step, ...evidence });
  const contract = stepContracts.get(step);
  if (!contract) {
    findings.push({ browser, step: `${step}-contract`, contractFailures: ["missing step contract"] });
    return;
  }
  const failures = [];
  if (evidence.pathname !== contract.pathname) failures.push(`pathname ${evidence.pathname} != ${contract.pathname}`);
  if (evidence.title !== contract.title) failures.push(`title ${evidence.title} != ${contract.title}`);
  if (evidence.mainHeading !== contract.heading)
    failures.push(`heading ${evidence.mainHeading ?? "missing"} != ${contract.heading}`);
  const expectedRoutes = contract.activeRoute ? [contract.activeRoute] : [];
  if (JSON.stringify(evidence.activeRoutes) !== JSON.stringify(expectedRoutes)) {
    failures.push(`active routes ${JSON.stringify(evidence.activeRoutes)} != ${JSON.stringify(expectedRoutes)}`);
  }
  if (evidence.iframeCount !== 0) failures.push(`page contains ${evidence.iframeCount} iframe(s)`);
  if (Math.abs(evidence.scrollY) > 1) failures.push(`page retained scroll position ${evidence.scrollY}`);
  if (
    typeof evidence.mainHeadingTop !== "number" ||
    evidence.mainHeadingTop < 0 ||
    evidence.mainHeadingBottom > evidence.viewport.height
  ) {
    failures.push("main heading is outside the initial viewport");
  }
  if (failures.length > 0) findings.push({ browser, step: `${step}-contract`, contractFailures: failures });
}

async function waitForChromePage(page, heading) {
  await page.locator("h1:visible", { hasText: heading }).waitFor({ state: "visible", timeout: 15_000 });
  await page.waitForFunction(
    () =>
      Array.from(document.querySelectorAll("iframe")).every(
        (frame) => frame.contentDocument?.readyState === "complete",
      ),
    undefined,
    { timeout: 15_000 },
  );
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(350);
}

async function captureChrome(page, name, heading) {
  await waitForChromePage(page, heading);
  const evidence = await page.evaluate(auditExpression());
  recordEvidence("chrome", name, evidence);
  await page.screenshot({ path: screenshotPath("chrome", name), fullPage: false });
}

async function runChrome() {
  let browser;
  if (systemChrome) {
    browser = await chromium.launch({ executablePath: systemChrome, headless: true });
  } else {
    try {
      browser = await chromium.launch({ channel: "chrome", headless: true });
    } catch (channelError) {
      try {
        browser = await chromium.launch({ headless: true });
      } catch (managedError) {
        throw new Error(
          `Chrome is unavailable. Install Google Chrome, install Playwright Chromium, or set PLAYWRIGHT_CHROMIUM_EXECUTABLE. Channel error: ${channelError instanceof Error ? channelError.message : "unknown"}. Managed-browser error: ${managedError instanceof Error ? managedError.message : "unknown"}.`,
        );
      }
    }
  }
  try {
    const errors = [];
    const desktopContext = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      deviceScaleFactor: 1,
      colorScheme: "dark",
      reducedMotion: "reduce",
    });
    await desktopContext.addCookies([{ name: "rc-audit-mode", value: "product", domain: host, path: "/" }]);
    const desktop = await desktopContext.newPage();
    recordRuntimeSignals(desktop, errors);
    await desktop.goto(`${origin}/app/sessions`, { waitUntil: "domcontentloaded" });
    await captureChrome(desktop, "01-sessions-desktop", "Sessions");
    for (const [name, route, heading] of [
      ["02-automations-desktop", "automations", "Automations"],
      ["03-agents-desktop", "agents", "Agents"],
      ["04-people-desktop", "people", "People & Access"],
    ]) {
      const target = desktop.locator(`a[data-route="${route}"]:visible`).first();
      await target.waitFor({ state: "visible" });
      await target.click();
      await captureChrome(desktop, name, heading);
    }
    await desktop.locator("a.rc-cloud-account-link:visible").click();
    await captureChrome(desktop, "05-account-desktop", "Account");
    await desktop.locator("a.rc-cloud-context-manage:visible").click();
    await captureChrome(desktop, "16-organization-desktop", "Organization settings");
    await desktopContext.close();

    const mobileContext = await browser.newContext({
      ...devices["iPhone 13 Pro"],
      colorScheme: "dark",
      reducedMotion: "reduce",
    });
    await mobileContext.addCookies([{ name: "rc-audit-mode", value: "product", domain: host, path: "/" }]);
    const mobile = await mobileContext.newPage();
    recordRuntimeSignals(mobile, errors, "mobile ");
    await mobile.goto(`${origin}/app/sessions`, { waitUntil: "domcontentloaded" });
    await captureChrome(mobile, "06-sessions-mobile", "Sessions");
    await mobile.goto(`${origin}/app/agents`, { waitUntil: "domcontentloaded" });
    await captureChrome(mobile, "07-agents-mobile", "Agents");
    await mobile.locator("a.rc-cloud-avatar:visible").click();
    await mobile.locator("a.rc-cloud-context-manage:visible").click();
    await captureChrome(mobile, "17-organization-mobile", "Organization settings");
    await mobileContext.close();

    const authContext = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      colorScheme: "dark",
      reducedMotion: "reduce",
    });
    await authContext.addCookies([{ name: "rc-audit-mode", value: "auth", domain: host, path: "/" }]);
    const auth = await authContext.newPage();
    recordRuntimeSignals(auth, errors, "auth ");
    await auth.goto(`${origin}/app`, { waitUntil: "domcontentloaded" });
    await captureChrome(auth, "08-sign-in-desktop", "Welcome back");
    await auth.getByRole("button", { name: "Create account", exact: true }).click();
    await captureChrome(auth, "09-sign-up-desktop", "Create your RoamCode account");
    await authContext.close();
    if (errors.length > 0) findings.push({ browser: "chrome", step: "runtime-errors", errors });
  } finally {
    await browser.close();
  }
}

async function waitForWebDriver(driverOrigin, timeout = 12_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${driverOrigin}/status`);
      if (response.ok) return;
    } catch {
      // Driver is still starting.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 200));
  }
  throw new Error("Safari WebDriver did not become ready");
}

async function webdriverRequest(driverOrigin, pathname, method = "GET", body) {
  const response = await fetch(`${driverOrigin}${pathname}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json();
  if (!response.ok || payload.value?.error) {
    throw new Error(payload.value?.message ?? `Safari WebDriver request failed (${response.status})`);
  }
  return payload.value;
}

async function waitForSafariHeading(driverOrigin, sessionId, heading) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const value = await webdriverRequest(driverOrigin, `/session/${sessionId}/execute/sync`, "POST", {
      script:
        "return Array.from(document.querySelectorAll('h1')).some((node) => node.textContent.trim() === arguments[0]);",
      args: [heading],
    });
    if (value) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 350));
      return;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 150));
  }
  throw new Error(`Safari did not render ${heading}`);
}

async function captureSafari(driverOrigin, sessionId, name, heading) {
  await waitForSafariHeading(driverOrigin, sessionId, heading);
  const evidence = await webdriverRequest(driverOrigin, `/session/${sessionId}/execute/sync`, "POST", {
    script: `return ${auditExpression()};`,
    args: [],
  });
  recordEvidence("safari", name, evidence);
  const encoded = await webdriverRequest(driverOrigin, `/session/${sessionId}/screenshot`);
  writeFileSync(screenshotPath("safari", name), Buffer.from(encoded, "base64"), { mode: 0o600 });
}

async function runSafari() {
  if (process.platform !== "darwin") {
    findings.push({ browser: "safari", step: "safari-unavailable", reason: "Safari is available only on macOS." });
    return;
  }
  const configuredPort = Number.parseInt(process.env.ROAMCODE_SAFARI_DRIVER_PORT ?? "0", 10);
  assertSafePort(configuredPort, "ROAMCODE_SAFARI_DRIVER_PORT");
  const safariDriverPort = configuredPort === 0 ? await availableLoopbackPort() : configuredPort;
  const driverOrigin = `http://${host}:${safariDriverPort}`;
  const driver = spawn("safaridriver", ["-p", String(safariDriverPort)], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  let driverError = "";
  let driverSpawnError;
  driver.on("error", (error) => {
    driverSpawnError = error;
  });
  driver.stderr.setEncoding("utf8");
  driver.stderr.on("data", (chunk) => {
    driverError = `${driverError}${chunk}`.slice(-2_000);
  });
  let sessionId;
  try {
    try {
      await waitForWebDriver(driverOrigin);
      if (driverSpawnError) throw driverSpawnError;
      const session = await webdriverRequest(driverOrigin, "/session", "POST", {
        capabilities: { alwaysMatch: { browserName: "safari", pageLoadStrategy: "normal" } },
      });
      sessionId = session.sessionId;
    } catch (error) {
      findings.push({
        browser: "safari",
        step: "safari-unavailable",
        error: error instanceof Error ? error.message : "unknown Safari WebDriver availability error",
        driver: driverError.replaceAll(origin, "[isolated-origin]").slice(0, 500),
      });
      return;
    }
    try {
      await webdriverRequest(driverOrigin, `/session/${sessionId}/window/rect`, "POST", {
        width: 1440,
        height: 1000,
        x: 0,
        y: 0,
      });
      await webdriverRequest(driverOrigin, `/session/${sessionId}/url`, "POST", { url: `${origin}/` });
      await webdriverRequest(driverOrigin, `/session/${sessionId}/cookie`, "POST", {
        cookie: { name: "rc-audit-mode", value: "product", path: "/" },
      });
      for (const [name, path, heading] of [
        ["10-sessions-desktop", "/app/sessions", "Sessions"],
        ["11-automations-desktop", "/app/automations", "Automations"],
        ["12-agents-desktop", "/app/agents", "Agents"],
        ["13-people-desktop", "/app/people", "People & Access"],
        ["14-account-desktop", "/app/account", "Account"],
      ]) {
        await webdriverRequest(driverOrigin, `/session/${sessionId}/url`, "POST", { url: `${origin}${path}` });
        await captureSafari(driverOrigin, sessionId, name, heading);
      }
      await webdriverRequest(driverOrigin, `/session/${sessionId}/window/rect`, "POST", {
        width: 430,
        height: 900,
        x: 0,
        y: 0,
      });
      await webdriverRequest(driverOrigin, `/session/${sessionId}/url`, "POST", { url: `${origin}/app/sessions` });
      await captureSafari(driverOrigin, sessionId, "15-sessions-narrow", "Sessions");
    } catch (error) {
      findings.push({
        browser: "safari",
        step: "safari-failure",
        error: error instanceof Error ? error.message : "unknown Safari browser acceptance error",
        driver: driverError.replaceAll(origin, "[isolated-origin]").slice(0, 500),
      });
    }
  } finally {
    if (sessionId) {
      await webdriverRequest(driverOrigin, `/session/${sessionId}`, "DELETE").catch(() => undefined);
    }
    driver.kill("SIGTERM");
  }
}

let runError;
try {
  if (requestedBrowsers.has("chrome")) await runChrome();
  if (requestedBrowsers.has("safari")) await runSafari();
} catch (error) {
  runError = error;
  findings.push({
    browser: "harness",
    step: "failure",
    error: error instanceof Error ? error.message : "unknown hosted product audit error",
  });
} finally {
  await new Promise((resolveClose) => server.close(resolveClose));
}

const blockingFindings = findings.flatMap((finding) => {
  if (finding.step === "runtime-errors" || finding.step === "failure" || finding.step === "safari-failure")
    return [finding];
  if (finding.step === "safari-unavailable") return safariRequired ? [finding] : [];
  if (finding.contractFailures?.length > 0) return [finding];
  if (finding.horizontalOverflow || finding.unnamedControls > 0 || finding.undersizedTargets?.length > 0)
    return [finding];
  return [];
});

writeFileSync(
  join(outputDirectory, "audit.json"),
  `${JSON.stringify({ origin: "isolated-loopback", screenshots, findings, blockingFindings }, null, 2)}\n`,
  { mode: 0o600 },
);

console.log(`Hosted product audit captured ${screenshots.length} screenshot(s).`);
console.log(`Evidence: ${outputDirectory}`);
if (runError) throw runError;
if (blockingFindings.length > 0) {
  throw new Error(
    `hosted product audit found ${blockingFindings.length} blocking browser, layout, or accessibility issue(s)`,
  );
}
