import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const requireFromRuntime = createRequire("/app/roamcode-public-wss-smoke.cjs");
const WebSocket = requireFromRuntime("ws");

const relayDomain = process.env.ROAMCODE_RELAY_DOMAIN ?? "";
const appDomain = process.env.ROAMCODE_APP_DOMAIN ?? "";
const relayInternalOrigin = process.env.ROAMCODE_RELAY_INTERNAL_ORIGIN ?? "";
const rootTokenFile = process.env.ROAMCODE_RELAY_ROOT_TOKEN_FILE ?? "";
const domainPattern = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;
function isPrivateRelayOrigin(value) {
  try {
    const url = new URL(value);
    const octets = url.hostname.split(".").map(Number);
    const privateAddress =
      octets.length === 4 &&
      octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255) &&
      (octets[0] === 10 ||
        (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
        (octets[0] === 192 && octets[1] === 168));
    return (
      url.protocol === "http:" &&
      url.port === "4281" &&
      url.pathname === "/" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      privateAddress
    );
  } catch {
    return false;
  }
}
if (
  !domainPattern.test(relayDomain) ||
  !domainPattern.test(appDomain) ||
  !isPrivateRelayOrigin(relayInternalOrigin) ||
  !rootTokenFile
) {
  throw new Error("public WebSocket smoke configuration is invalid");
}

const rootToken = readFileSync(rootTokenFile, "utf8").trim();
if (!/^rrp_[A-Za-z0-9_-]{43}$/.test(rootToken)) throw new Error("relay root capability is invalid");

const relayOrigin = `https://${relayDomain}`;
const relaySocketUrl = `wss://${relayDomain}/v1/connect`;

function relayCredentialHash(credential) {
  return `sha256:${createHash("sha256")
    .update("roamcode-relay-credential-v1\0")
    .update(credential)
    .digest("base64url")}`;
}

function relayAccountCredentialMaterial(credential) {
  const digest = (label) => createHash("sha256").update(label).update("\0").update(credential).digest("base64url");
  return {
    credentialHash: `sha256:${digest("roamcode-relay-account-credential-v1")}`,
    credentialLookup: `lookup:${digest("roamcode-relay-account-lookup-v1")}`,
  };
}

async function relayRequest(origin, path, method, credential, body) {
  const response = await fetch(`${origin}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${credential}`,
      accept: "application/json",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const chunks = [];
  let total = 0;
  if (response.body) {
    const reader = response.body.getReader();
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        if (!next.value) continue;
        total += next.value.byteLength;
        if (total > 64 * 1024) {
          await reader.cancel();
          throw new Error("relay response was oversized");
        }
        chunks.push(Buffer.from(next.value));
      }
    } finally {
      reader.releaseLock();
    }
  }
  const text = Buffer.concat(chunks, total).toString("utf8");
  if (!response.ok) throw new Error(`relay request failed with ${response.status}`);
  return text ? JSON.parse(text) : undefined;
}

function nextMessage(socket, predicate) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error("relay message timed out")), 10_000);
    const onMessage = (raw) => {
      try {
        const value = JSON.parse(raw.toString());
        if (predicate(value)) finish(undefined, value);
      } catch {
        /* Ignore unrelated malformed input; the timeout remains authoritative. */
      }
    };
    const onClose = () => finish(new Error("relay socket closed early"));
    const onError = () => finish(new Error("relay socket failed"));
    const finish = (error, value) => {
      clearTimeout(timer);
      socket.off("message", onMessage);
      socket.off("close", onClose);
      socket.off("error", onError);
      if (error) reject(error);
      else resolve(value);
    };
    socket.on("message", onMessage);
    socket.once("close", onClose);
    socket.once("error", onError);
  });
}

async function connect(hello, origin) {
  const socket = new WebSocket(relaySocketUrl, {
    ...(origin ? { origin } : {}),
    perMessageDeflate: false,
    maxPayload: 2_100_000,
    handshakeTimeout: 15_000,
  });
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  const ready = nextMessage(socket, (value) => value?.t === "ready");
  socket.send(JSON.stringify(hello));
  return { socket, ready: await ready };
}

const routeId = `rrt_smoke_${randomBytes(16).toString("base64url")}`;
const accountId = `rra_smoke_${randomBytes(16).toString("base64url")}`;
const accountPath = `/internal/v1/accounts/${encodeURIComponent(accountId)}`;
let host;
let device;
let failure;
let accountCreated = false;
try {
  const accountCredential = `rrk_${randomBytes(32).toString("base64url")}`;
  const createdAccount = await relayRequest(relayInternalOrigin, accountPath, "PUT", rootToken, {
    label: "Public edge verification",
    plan: "free",
    maxRoutes: 1,
    maxDevicesPerRoute: 1,
    ...relayAccountCredentialMaterial(accountCredential),
  });
  // A successful PUT means this exact random account is ours even if a later response is malformed. Cleanup can
  // therefore purge the transient route without risking an unrelated account.
  accountCreated = true;
  if (
    createdAccount?.account?.id !== accountId ||
    createdAccount?.account?.revision !== 1 ||
    JSON.stringify(createdAccount).includes(accountCredential)
  ) {
    throw new Error("relay account response was invalid");
  }

  const hostCredential = `rrh_${randomBytes(32).toString("base64url")}`;
  const created = await relayRequest(
    relayInternalOrigin,
    `${accountPath}/routes/${encodeURIComponent(routeId)}`,
    "PUT",
    rootToken,
    { label: "Public edge verification", credentialHash: relayCredentialHash(hostCredential) },
  );
  if (created?.route?.id !== routeId) throw new Error("relay route response was invalid");

  const deviceId = `smoke-${randomBytes(8).toString("hex")}`;
  const deviceCredential = `rrd_${randomBytes(32).toString("base64url")}`;
  await relayRequest(
    relayOrigin,
    `/v1/routes/${encodeURIComponent(routeId)}/devices/${encodeURIComponent(deviceId)}`,
    "PUT",
    hostCredential,
    { credentialHash: relayCredentialHash(deviceCredential) },
  );

  const hostConnection = await connect({ v: 1, role: "host", routeId, credential: hostCredential });
  host = hostConnection.socket;
  const peerOpened = nextMessage(host, (value) => value?.t === "peer-open");
  const deviceConnection = await connect(
    { v: 1, role: "device", routeId, deviceId, credential: deviceCredential },
    `https://${appDomain}`,
  );
  device = deviceConnection.socket;
  const peer = await peerOpened;
  if (peer.channelId !== deviceConnection.ready.channelId) throw new Error("relay channel binding was invalid");

  const devicePayload = Buffer.from("device-to-host").toString("base64url");
  const receivedByHost = nextMessage(
    host,
    (value) => value?.t === "frame" && value?.channelId === peer.channelId && value?.payload === devicePayload,
  );
  device.send(JSON.stringify({ t: "frame", payload: devicePayload }));
  await receivedByHost;

  const hostPayload = Buffer.from("host-to-device").toString("base64url");
  const receivedByDevice = nextMessage(device, (value) => value?.t === "frame" && value?.payload === hostPayload);
  host.send(JSON.stringify({ t: "frame", channelId: peer.channelId, payload: hostPayload }));
  await receivedByDevice;
} catch (error) {
  failure = error;
} finally {
  device?.close();
  host?.close();
  if (accountCreated) {
    try {
      await relayRequest(relayInternalOrigin, accountPath, "DELETE", rootToken, { expectedRevision: 1 });
    } catch (error) {
      failure ??= error;
    }
  }
}

if (failure) throw new Error("RoamCode cloud public WebSocket verification failed");
console.log("RoamCode cloud public WebSocket and bidirectional blind-frame verification passed");
