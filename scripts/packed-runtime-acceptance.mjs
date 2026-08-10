#!/usr/bin/env node

import { appendFile, chmod, readFile, writeFile } from "node:fs/promises";

const PREFIX = "[packed-acceptance]";
const MODE = process.env.RC_ACCEPTANCE_MODE ?? "exercise";
const BASE_URL = requiredUrl("RC_ACCEPTANCE_BASE_URL");
const MASTER_TOKEN = required("RC_ACCEPTANCE_MASTER_TOKEN");
const WORKSPACE_DIR = required("RC_ACCEPTANCE_WORKSPACE");
const STATE_PATH = required("RC_ACCEPTANCE_STATE");
const PROVIDER_STATE_PATH = process.env.RC_ACCEPTANCE_PROVIDER_STATE;
const OPEN_SOCKETS = new Set();
const REQUEST_TIMEOUT_MS = boundedInteger(process.env.RC_ACCEPTANCE_REQUEST_TIMEOUT_MS, 10_000, 1_000, 60_000);
const POLL_TIMEOUT_MS = boundedInteger(process.env.RC_ACCEPTANCE_POLL_TIMEOUT_MS, 15_000, 1_000, 120_000);

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function requiredUrl(name) {
  const url = new URL(required(name));
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${name} must use http or https`);
  }
  url.username = "";
  url.password = "";
  url.hash = "";
  return url;
}

function boundedInteger(raw, fallback, min, max) {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error("invalid acceptance timeout");
  return value;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function bearer(token) {
  return { authorization: `Bearer ${token}` };
}

async function request(path, options = {}) {
  const method = options.method ?? "GET";
  const expected = options.expected ?? [200];
  const headers = new Headers(options.token ? bearer(options.token) : undefined);
  if (options.body !== undefined) headers.set("content-type", "application/json");
  if (options.idempotencyKey) headers.set("idempotency-key", options.idempotencyKey);
  let response;
  try {
    response = await fetch(new URL(path, BASE_URL), {
      method,
      headers,
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      signal: AbortSignal.timeout(options.timeoutMs ?? REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    const reason = error instanceof Error && error.name === "TimeoutError" ? "timed out" : "failed";
    throw new Error(`${method} ${path} ${reason}`);
  }
  const text = await response.text();
  let body;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  if (!expected.includes(response.status)) {
    throw new Error(`${method} ${path} returned ${response.status}`);
  }
  return { status: response.status, headers: response.headers, body };
}

async function poll(label, check) {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`${label} did not become ready${lastError ? " after a transient request failure" : ""}`);
}

function stage(name) {
  process.stdout.write(`${PREFIX} ${name}: ok\n`);
}

async function assertShellAndDiagnostics(token) {
  const health = await request("/health");
  assert(isObject(health.body) && health.body.ok === true, "health payload is invalid");

  const shell = await request("/");
  assert(typeof shell.body === "string" && /<!doctype html>/i.test(shell.body), "web shell is unavailable");

  const capabilities = await request("/api/v1/capabilities", { token });
  assert(isObject(capabilities.body), "capabilities payload is invalid");
  assert(capabilities.body.apiVersion === "v1", "stable API version is missing");
  assert(isObject(capabilities.body.features), "capability flags are missing");
  for (const feature of [
    "workspaces",
    "agents",
    "resumableEvents",
    "sharedLayout",
    "idempotentMutations",
    "devicePairing",
    "inputLeases",
    "multiObserver",
    "presence",
  ]) {
    assert(capabilities.body.features[feature] === true, `${feature} capability is unavailable`);
  }
  for (const removed of ["attention", "teamAuthorization", "enterprisePolicy", "fleetInventory", "peerFederation"]) {
    assert(!(removed in capabilities.body.features), `${removed} capability should not be published`);
  }

  const diagnostics = await request("/diag", { token });
  assert(isObject(diagnostics.body), "diagnostics payload is invalid");
  assert(diagnostics.body.storeMode === "sqlite", "session storage is not durable SQLite");
  assert(typeof diagnostics.body.runningVersion === "string", "running version is missing");
  assert(isObject(diagnostics.body.providers), "provider diagnostics are missing");
  assert(
    isObject(diagnostics.body.providers.codex) && diagnostics.body.providers.codex.terminalAvailable === true,
    "Codex terminal provider is unavailable",
  );
}

async function issueDevice() {
  const pairing = await request("/pairing/start", {
    method: "POST",
    token: MASTER_TOKEN,
    body: {},
    expected: [201],
  });
  assert(isObject(pairing.body) && typeof pairing.body.secret === "string", "pairing credential is missing");

  const claimed = await request("/pairing/claim", {
    method: "POST",
    body: { secret: pairing.body.secret, name: "Packed acceptance device" },
    expected: [201],
  });
  assert(isObject(claimed.body) && typeof claimed.body.token === "string", "device credential is missing");
  assert(isObject(claimed.body.device) && typeof claimed.body.device.id === "string", "paired device is missing");

  await request("/pairing/claim", {
    method: "POST",
    body: { secret: pairing.body.secret, name: "Replay attempt" },
    expected: [410],
  });
  return { token: claimed.body.token, id: claimed.body.device.id };
}

async function createWorkspace(token) {
  const body = { cwd: WORKSPACE_DIR, label: "Packed runtime acceptance", kind: "directory" };
  const first = await request("/api/v1/workspaces", {
    method: "POST",
    token,
    body,
    idempotencyKey: "packed-workspace-once",
    expected: [201],
  });
  assert(isObject(first.body) && isObject(first.body.workspace), "workspace response is invalid");
  assert(typeof first.body.workspace.id === "string", "workspace id is missing");

  const replay = await request("/api/v1/workspaces", {
    method: "POST",
    token,
    body,
    idempotencyKey: "packed-workspace-once",
    expected: [201],
  });
  assert(replay.headers.get("idempotency-replayed") === "true", "workspace mutation did not replay safely");
  assert(isObject(replay.body) && replay.body.workspace?.id === first.body.workspace.id, "workspace replay diverged");
  return first.body.workspace.id;
}

async function createSession(token) {
  const body = { cwd: WORKSPACE_DIR };
  const first = await request("/api/v1/sessions", {
    method: "POST",
    token,
    body,
    idempotencyKey: "packed-session-once",
    expected: [201],
  });
  assert(isObject(first.body) && isObject(first.body.session), "session response is invalid");
  assert(typeof first.body.session.id === "string", "session id is missing");
  assert(first.body.session.launch?.kind === "shell", "manual Session did not launch a user-controlled shell");
  assert(first.body.session.agent === undefined, "manual Session invented an agent before the user launched one");
  assert(first.body.session.agentId === undefined, "manual Session invented an Agent record before observation");
  assert(first.body.session.provider === undefined, "manual Session retained a managed provider");

  const replay = await request("/api/v1/sessions", {
    method: "POST",
    token,
    body,
    idempotencyKey: "packed-session-once",
    expected: [201],
  });
  assert(replay.headers.get("idempotency-replayed") === "true", "session mutation did not replay safely");
  assert(isObject(replay.body) && replay.body.session?.id === first.body.session.id, "session replay diverged");
  return { id: first.body.session.id };
}

async function loadProductSurface(token) {
  const context = await request("/api/v2/context", { token });
  assert(isObject(context.body) && isObject(context.body.context), "product context is invalid");
  assert(context.body.context.kind === "personal", "product context must be personal");

  const nodes = await request("/api/v2/nodes", { token });
  assert(isObject(nodes.body) && Array.isArray(nodes.body.nodes), "Node inventory is invalid");
  assert(nodes.body.nodes.length === 1, "packed runtime must project exactly one local Node");
  const node = nodes.body.nodes[0];
  assert(isObject(node) && typeof node.id === "string", "local Node identity is missing");
  assert(node.status === "online", "local Node is not online");

  // The first provider inventory can perform cold executable and account probes. Keep the normal
  // request budget strict while allowing this one bounded release-acceptance probe to warm up.
  const runtimes = await request(`/api/v2/nodes/${encodeURIComponent(node.id)}/runtimes`, {
    token,
    timeoutMs: Math.max(REQUEST_TIMEOUT_MS, 30_000),
  });
  assert(isObject(runtimes.body) && Array.isArray(runtimes.body.runtimes), "runtime inventory is invalid");
  const runtime = runtimes.body.runtimes.find(
    (candidate) =>
      isObject(candidate) &&
      candidate.provider === "codex" &&
      candidate.availability === "available" &&
      Array.isArray(candidate.capabilities) &&
      candidate.capabilities.includes("launch") &&
      candidate.capabilities.includes("task-bootstrap"),
  );
  assert(isObject(runtime) && typeof runtime.id === "string", "launch-capable Codex runtime is missing");
  return { context: context.body.context, node, runtime };
}

async function createAndRunAutomation(token, nodeId, agentRuntimeId) {
  const definition = {
    name: "Packed repository health",
    nodeId,
    agentRuntimeId,
    cwd: WORKSPACE_DIR,
    instruction: "Report packed automation readiness.",
    runtimeOptions: { sandbox: "workspace-write", approvalPolicy: "on-request" },
    trigger: { type: "manual" },
  };
  const created = await request("/api/v2/automations", {
    method: "POST",
    token,
    body: definition,
    idempotencyKey: "packed-automation-create-once",
    expected: [201],
  });
  assert(isObject(created.body) && isObject(created.body.automation), "automation response is invalid");
  assert(typeof created.body.automation.id === "string", "automation identity is missing");
  assert(created.body.automation.nodeId === nodeId, "automation changed its selected Node");
  assert(created.body.automation.agentRuntimeId === agentRuntimeId, "automation changed its selected runtime");

  const replayedCreate = await request("/api/v2/automations", {
    method: "POST",
    token,
    body: definition,
    idempotencyKey: "packed-automation-create-once",
    expected: [201],
  });
  assert(replayedCreate.headers.get("idempotency-replayed") === "true", "automation creation did not replay safely");
  assert(
    isObject(replayedCreate.body) && replayedCreate.body.automation?.id === created.body.automation.id,
    "automation creation replay diverged",
  );

  const path = `/api/v2/automations/${encodeURIComponent(created.body.automation.id)}/runs`;
  const run = await request(path, {
    method: "POST",
    token,
    body: {},
    idempotencyKey: "packed-automation-run-once",
    expected: [201],
    // A real automation launch waits for the provider TUI's idle composer before submitting the
    // task. That readiness contract is bounded to 15 seconds, so the generic 10-second request
    // budget would abort a healthy cold launch before the server can return its durable Run.
    timeoutMs: Math.max(REQUEST_TIMEOUT_MS, 30_000),
  });
  assert(isObject(run.body) && isObject(run.body.run) && isObject(run.body.session), "automation Run is invalid");
  assert(typeof run.body.run.id === "string", "automation Run identity is missing");
  assert(typeof run.body.session.id === "string", "automation Session identity is missing");
  assert(run.body.run.sessionId === run.body.session.id, "automation Run is not bound to its real Session");
  assert(run.body.session.nodeId === nodeId, "automation Session changed Node");
  assert(run.body.session.agentRuntimeId === agentRuntimeId, "automation Session changed runtime");

  const replayedRun = await request(path, {
    method: "POST",
    token,
    body: {},
    idempotencyKey: "packed-automation-run-once",
    expected: [201],
  });
  assert(replayedRun.headers.get("idempotency-replayed") === "true", "automation Run did not replay safely");
  assert(
    isObject(replayedRun.body) &&
      replayedRun.body.run?.id === run.body.run.id &&
      replayedRun.body.session?.id === run.body.session.id,
    "automation Run replay created a second Session",
  );

  const history = await request(path, { token });
  assert(isObject(history.body) && Array.isArray(history.body.runs), "automation Run history is invalid");
  assert(history.body.runs.length === 1, "automation replay duplicated immutable Run history");
  return {
    automationId: created.body.automation.id,
    runId: run.body.run.id,
    sessionId: run.body.session.id,
  };
}

async function openTerminal(token, sessionId) {
  const ticket = await request("/ws-ticket", { method: "POST", token });
  assert(isObject(ticket.body) && typeof ticket.body.ticket === "string", "terminal ticket is missing");
  const wsUrl = new URL(`/sessions/${encodeURIComponent(sessionId)}/terminal`, BASE_URL);
  wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
  wsUrl.searchParams.set("ticket", ticket.body.ticket);
  wsUrl.searchParams.set("cols", "100");
  wsUrl.searchParams.set("rows", "30");
  wsUrl.searchParams.set("respawn", "fresh");

  const socket = new WebSocket(wsUrl);
  OPEN_SOCKETS.add(socket);
  const output = [];
  const controls = [];
  socket.addEventListener("message", (event) => {
    if (typeof event.data === "string") {
      try {
        controls.push(JSON.parse(event.data));
      } catch {
        // Terminal output is binary by contract; ignore unknown text frames.
      }
      return;
    }
    if (event.data instanceof ArrayBuffer) output.push(Buffer.from(event.data).toString("utf8"));
    else if (ArrayBuffer.isView(event.data)) {
      output.push(Buffer.from(event.data.buffer, event.data.byteOffset, event.data.byteLength).toString("utf8"));
    } else if (typeof Blob !== "undefined" && event.data instanceof Blob) {
      void event.data.arrayBuffer().then((buffer) => output.push(Buffer.from(buffer).toString("utf8")));
    }
  });

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("terminal WebSocket did not open")), POLL_TIMEOUT_MS);
    socket.addEventListener(
      "open",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
    socket.addEventListener(
      "error",
      () => {
        clearTimeout(timer);
        reject(new Error("terminal WebSocket failed"));
      },
      { once: true },
    );
  });

  const text = () => output.join("");
  await poll("terminal input ownership", () =>
    controls.some((frame) => isObject(frame) && frame.t === "input-lease" && frame.writable === true),
  );
  return { socket, text };
}

async function closeTerminal(socket) {
  if (socket.readyState === WebSocket.CLOSED) {
    OPEN_SOCKETS.delete(socket);
    return;
  }
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 2_000);
    socket.addEventListener(
      "close",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
    socket.close();
  });
  OPEN_SOCKETS.delete(socket);
}

async function commandEvents(token) {
  const response = await request("/api/v1/events?after=0&limit=1000", { token });
  assert(isObject(response.body) && Array.isArray(response.body.events), "event journal is unavailable");
  return response.body.events;
}

async function needsSignalEvent(token, sessionId, eventType, kind, resourceId) {
  const events = await commandEvents(token);
  return events.find(
    (event) =>
      isObject(event) &&
      event.type === eventType &&
      (!resourceId || event.resourceId === resourceId) &&
      isObject(event.payload) &&
      event.payload.sessionId === sessionId &&
      (!kind || event.payload.kind === kind),
  );
}

async function observedAgentFor(token, sessionId, provider) {
  const response = await request("/api/v1/sessions", { token });
  assert(isObject(response.body) && Array.isArray(response.body.sessions), "session inventory is invalid");
  const session = response.body.sessions.find((candidate) => isObject(candidate) && candidate.id === sessionId);
  if (
    !isObject(session) ||
    session.launch?.kind !== "shell" ||
    session.agent?.provider !== provider ||
    session.agent?.source !== "process" ||
    typeof session.agentId !== "string"
  ) {
    return undefined;
  }
  return { agentId: session.agentId, session };
}

async function providerLaunchCount(sessionId) {
  if (!PROVIDER_STATE_PATH) return undefined;
  const raw = await readFile(PROVIDER_STATE_PATH, "utf8");
  return raw
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    })
    .filter((event) => isObject(event) && event.kind === "launch" && event.sessionId === sessionId).length;
}

async function sendProviderControl(sessionId, action) {
  if (!PROVIDER_STATE_PATH) throw new Error("RC_ACCEPTANCE_PROVIDER_STATE is required for provider signals");
  await appendFile(PROVIDER_STATE_PATH, `${JSON.stringify({ kind: "control", target: sessionId, action })}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

async function exercise() {
  await assertShellAndDiagnostics(MASTER_TOKEN);
  stage("packed web, API, providers, and SQLite diagnostics");

  const device = await issueDevice();
  await assertShellAndDiagnostics(device.token);
  stage("single-use device pairing and revocable authentication");

  const product = await loadProductSurface(device.token);
  stage("personal Node and Agent runtime projection");

  const workspaceId = await createWorkspace(device.token);
  const session = await createSession(device.token);
  stage("idempotent workspace and user-controlled shell creation");

  const terminal = await openTerminal(device.token, session.id);
  assert(/^[A-Za-z0-9-]+$/.test(session.id), "session identity is not safe for the acceptance shell command");
  terminal.socket.send(JSON.stringify({ t: "i", d: `env RC_SESSION_ID=${session.id} "$CODEX_BIN"\r` }));
  await poll("user-started fake Codex terminal", () => terminal.text().includes(`FAKE_CODEX_TUI:${session.id}`));
  const observed = await poll("foreground Codex observation", () =>
    observedAgentFor(device.token, session.id, "codex"),
  );
  session.agentId = observed.agentId;
  stage("user-started foreground agent observation");

  terminal.socket.send(JSON.stringify({ t: "i", d: "packed-terminal-input-proof" }));
  await poll("native terminal input", () => terminal.text().includes("CODEX_ECHO:packed-terminal-input-proof"));
  await sendProviderControl(session.id, "approval");
  const blocked = await poll("blocked needs signal", () =>
    needsSignalEvent(device.token, session.id, "attention.created", "blocked"),
  );
  assert(isObject(blocked) && typeof blocked.resourceId === "string", "blocked signal id is missing");
  await sendProviderControl(session.id, "complete");
  await poll("blocked needs signal resolution", () =>
    needsSignalEvent(device.token, session.id, "attention.resolved", undefined, blocked.resourceId),
  );
  await closeTerminal(terminal.socket);
  stage("native terminal stream and internal decision signal");

  const clientId = "packed-acceptance";
  const lease = await poll("released terminal ownership", async () => {
    const response = await request(`/api/v1/sessions/${encodeURIComponent(session.id)}/input-lease`, {
      method: "POST",
      token: device.token,
      body: { action: "acquire", clientId },
      expected: [200, 201, 409],
    });
    return response.status === 409 ? undefined : response.body;
  });
  assert(isObject(lease) && typeof lease.leaseId === "string", "input lease id is missing");
  await request(`/api/v1/sessions/${encodeURIComponent(session.id)}/input`, {
    method: "POST",
    token: device.token,
    body: { data: "packed-http-input-proof", clientId, leaseId: lease.leaseId },
    expected: [202],
  });
  await sendProviderControl(session.id, "complete");
  const done = await poll("completion needs signal", () =>
    needsSignalEvent(device.token, session.id, "attention.created", "done"),
  );
  assert(isObject(done) && typeof done.resourceId === "string", "completion signal id is missing");
  await request(`/api/v1/sessions/${encodeURIComponent(session.id)}/input-lease`, {
    method: "POST",
    token: device.token,
    body: { action: "release", clientId, leaseId: lease.leaseId },
  });
  const viewed = await openTerminal(device.token, session.id);
  await poll("completion needs signal resolution", () =>
    needsSignalEvent(device.token, session.id, "attention.resolved", undefined, done.resourceId),
  );
  await closeTerminal(viewed.socket);
  stage("single-writer HTTP input and detached completion signal");

  const events = await commandEvents(device.token);
  assert(
    events.some((event) => isObject(event) && event.type === "attention.created"),
    "needs-signal event is missing",
  );
  assert(
    events.some((event) => isObject(event) && event.type === "session.input_sent"),
    "input event is missing",
  );

  const launches = await providerLaunchCount(session.id);
  if (launches !== undefined) assert(launches === 1, "provider launched an unexpected number of times");
  const automation = await createAndRunAutomation(device.token, product.node.id, product.runtime.id);
  const automationLaunches = await providerLaunchCount(automation.sessionId);
  if (automationLaunches !== undefined) {
    assert(automationLaunches === 1, "automation replay launched its provider more than once");
  }
  stage("idempotent Automation Run backed by one real Session");
  await writeFile(
    STATE_PATH,
    `${JSON.stringify({
      deviceToken: device.token,
      deviceId: device.id,
      workspaceId,
      sessionId: session.id,
      agentId: session.agentId,
      blockedSignalId: blocked.resourceId,
      doneSignalId: done.resourceId,
      nodeId: product.node.id,
      agentRuntimeId: product.runtime.id,
      automationId: automation.automationId,
      automationRunId: automation.runId,
      automationSessionId: automation.sessionId,
    })}\n`,
    { mode: 0o600 },
  );
  await chmod(STATE_PATH, 0o600);
  stage("durable acceptance state checkpoint");
}

async function verifyRestart() {
  const raw = await readFile(STATE_PATH, "utf8");
  const saved = JSON.parse(raw);
  assert(isObject(saved), "acceptance state is invalid");
  for (const field of [
    "deviceToken",
    "deviceId",
    "workspaceId",
    "sessionId",
    "agentId",
    "blockedSignalId",
    "doneSignalId",
    "nodeId",
    "agentRuntimeId",
    "automationId",
    "automationRunId",
    "automationSessionId",
  ]) {
    assert(typeof saved[field] === "string", `acceptance state is missing ${field}`);
  }

  await assertShellAndDiagnostics(saved.deviceToken);
  const devices = await request("/devices", { token: saved.deviceToken });
  assert(isObject(devices.body) && Array.isArray(devices.body.devices), "device inventory is invalid");
  assert(
    devices.body.devices.some((device) => isObject(device) && device.id === saved.deviceId),
    "paired device did not persist",
  );

  const workspaces = await request("/api/v1/workspaces?includeArchived=1", { token: saved.deviceToken });
  assert(isObject(workspaces.body) && Array.isArray(workspaces.body.workspaces), "workspace inventory is invalid");
  assert(
    workspaces.body.workspaces.some((workspace) => isObject(workspace) && workspace.id === saved.workspaceId),
    "workspace did not persist",
  );

  const sessions = await request("/api/v1/sessions", { token: saved.deviceToken });
  assert(isObject(sessions.body) && Array.isArray(sessions.body.sessions), "session inventory is invalid");
  assert(
    sessions.body.sessions.some((session) => isObject(session) && session.id === saved.sessionId),
    "session did not persist",
  );

  const agent = await poll("observed agent restart recovery", async () => {
    const agents = await request("/api/v1/agents", { token: saved.deviceToken });
    assert(isObject(agents.body) && Array.isArray(agents.body.agents), "agent inventory is invalid");
    return agents.body.agents.find((candidate) => isObject(candidate) && candidate.id === saved.agentId);
  });
  assert(isObject(agent) && agent.sessionId === saved.sessionId, "observed agent did not recover after restart");

  const events = await commandEvents(saved.deviceToken);
  for (const signalId of [saved.blockedSignalId, saved.doneSignalId]) {
    assert(
      events.some((event) => isObject(event) && event.type === "attention.created" && event.resourceId === signalId),
      "needs-signal creation did not persist",
    );
    assert(
      events.some((event) => isObject(event) && event.type === "attention.resolved" && event.resourceId === signalId),
      "needs-signal resolution did not persist",
    );
  }
  stage("device, workspace, observed agent, and needs-signal restart durability");

  const product = await loadProductSurface(saved.deviceToken);
  assert(product.node.id === saved.nodeId, "Node identity changed across restart");
  assert(product.runtime.id === saved.agentRuntimeId, "Agent runtime identity changed across restart");
  const automations = await request("/api/v2/automations", { token: saved.deviceToken });
  assert(isObject(automations.body) && Array.isArray(automations.body.automations), "automation inventory is invalid");
  assert(
    automations.body.automations.some((automation) => isObject(automation) && automation.id === saved.automationId),
    "automation definition did not persist",
  );
  const runHistory = await request(`/api/v2/automations/${encodeURIComponent(saved.automationId)}/runs`, {
    token: saved.deviceToken,
  });
  assert(isObject(runHistory.body) && Array.isArray(runHistory.body.runs), "automation Run history is unavailable");
  assert(
    runHistory.body.runs.some(
      (run) => isObject(run) && run.id === saved.automationRunId && run.sessionId === saved.automationSessionId,
    ),
    "automation Run lost its durable Session link",
  );
  const nodeSessions = await request(`/api/v2/nodes/${encodeURIComponent(saved.nodeId)}/sessions`, {
    token: saved.deviceToken,
  });
  assert(isObject(nodeSessions.body) && Array.isArray(nodeSessions.body.sessions), "Node Session inventory is invalid");
  assert(
    nodeSessions.body.sessions.some((session) => isObject(session) && session.id === saved.automationSessionId),
    "automation Session did not survive restart",
  );
  const automationLaunches = await providerLaunchCount(saved.automationSessionId);
  if (automationLaunches !== undefined) {
    assert(automationLaunches === 1, "restart duplicated the automation provider process");
  }
  stage("Node, Automation, Run, and Session restart durability");

  const launchesBefore = await providerLaunchCount(saved.sessionId);
  if (launchesBefore !== undefined) assert(launchesBefore === 1, "server restart duplicated the provider process");
  const terminal = await openTerminal(saved.deviceToken, saved.sessionId);
  terminal.socket.send(JSON.stringify({ t: "i", d: "packed-reconnect-proof" }));
  await poll("reconnected terminal output", () => terminal.text().includes("CODEX_ECHO:packed-reconnect-proof"));
  await closeTerminal(terminal.socket);
  const launchesAfter = await providerLaunchCount(saved.sessionId);
  if (launchesAfter !== undefined) assert(launchesAfter === 1, "terminal reconnect duplicated the provider process");
  stage("tmux adoption and duplicate-free terminal reconnect");
}

try {
  if (MODE === "exercise") await exercise();
  else if (MODE === "verify-restart") await verifyRestart();
  else throw new Error("RC_ACCEPTANCE_MODE must be exercise or verify-restart");
  process.stdout.write(`${PREFIX} ${MODE}: complete\n`);
} catch (error) {
  await Promise.all([...OPEN_SOCKETS].map((socket) => closeTerminal(socket)));
  const message = error instanceof Error ? error.message : "unknown acceptance failure";
  process.stderr.write(`${PREFIX} failed: ${message}\n`);
  process.exitCode = 1;
}
