import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  createLoopbackRelayHttpOpener,
  createServer,
  openDeviceStore,
  type RelayHttpOpenRequest,
  type ServerRuntimeConfig,
} from "../src/index.js";
import { generateBrowserRelayIdentity } from "../../web/src/relay/crypto.js";

const TOKEN = `rcd_${"d".repeat(43)}`;
const apps: Array<{ close(): Promise<unknown> }> = [];
const dirs: string[] = [];

afterEach(async () => {
  while (apps.length > 0) await apps.pop()!.close();
  while (dirs.length > 0) await rm(dirs.pop()!, { recursive: true, force: true });
});

function config(root: string): ServerRuntimeConfig {
  return {
    port: 0,
    bindAddress: "127.0.0.1",
    accessToken: "host-token",
    fsRoot: root,
    dataDir: root,
    maxUploadBytes: 2 * 1024 * 1024,
    allowedOrigins: [],
    rateLimitRpm: 0,
    rateLimitBurst: 120,
    maxSessions: 25,
    codexBin: process.execPath,
    claude: { claudeBin: process.execPath },
  };
}

describe("relay HTTP loopback bridge", () => {
  test("streams multipart upload and file download through normal relay auth and route hooks", async () => {
    const root = await mkdtemp(join(tmpdir(), "roamcode-relay-http-"));
    dirs.push(root);
    const identity = await generateBrowserRelayIdentity();
    const devices = openDeviceStore({
      dbPath: ":memory:",
      generateSecret: () => `rcp_${"p".repeat(43)}`,
      generateToken: () => TOKEN,
      generateId: () => "relay-device",
    });
    const pairing = devices.issuePairing(1, ["relay"]);
    devices.claimPairing(pairing.secret, "Relay browser", 2, identity.publicKey);
    const server = createServer(config(root), { deviceStore: devices, terminalAvailable: false });
    apps.push(server.app);
    const baseUrl = await server.app.listen({ host: "127.0.0.1", port: 0 });
    const open = createLoopbackRelayHttpOpener({
      baseUrl: () => baseUrl,
      headers: server.relayLoopbackHeaders,
    });

    const run = async (request: RelayHttpOpenRequest, body?: Uint8Array) => {
      let resolve!: (value: { status: number; headers: Record<string, string>; body: Buffer }) => void;
      let reject!: (error: Error) => void;
      const done = new Promise<{ status: number; headers: Record<string, string>; body: Buffer }>((yes, no) => {
        resolve = yes;
        reject = no;
      });
      let head: { status: number; headers: Record<string, string> } | undefined;
      const chunks: Buffer[] = [];
      const bridge = await open(TOKEN, request, {
        onResponse(response) {
          head = response;
        },
        onData(data) {
          chunks.push(Buffer.from(data));
        },
        onEnd() {
          if (!head) throw new Error("response head missing");
          resolve({ ...head, body: Buffer.concat(chunks) });
        },
        onError: reject,
      });
      if (body) {
        for (let offset = 0; offset < body.byteLength; offset += 32 * 1024) {
          await bridge.write(body.subarray(offset, Math.min(body.byteLength, offset + 32 * 1024)));
        }
      }
      bridge.end();
      return done;
    };

    const bytes = new Uint8Array(700_000).fill(0x6b);
    const form = new FormData();
    form.append("file", new File([bytes], "relay.bin", { type: "application/octet-stream" }));
    const browserRequest = new Request("https://host.invalid/fs/upload", { method: "POST", body: form });
    const upload = await run(
      {
        streamId: "upload-1",
        method: "POST",
        path: `/fs/upload?dir=${encodeURIComponent(root)}`,
        headers: { "content-type": browserRequest.headers.get("content-type")! },
      },
      new Uint8Array(await browserRequest.arrayBuffer()),
    );
    expect(upload.status).toBe(201);
    expect(JSON.parse(upload.body.toString("utf8"))).toEqual({ path: join(root, "relay.bin") });
    await expect(readFile(join(root, "relay.bin"))).resolves.toEqual(Buffer.from(bytes));

    const download = await run({
      streamId: "download-1",
      method: "GET",
      path: `/fs/download?path=${encodeURIComponent(join(root, "relay.bin"))}`,
      headers: {},
    });
    expect(download.status).toBe(200);
    expect(download.headers["content-type"]).toBe("application/octet-stream");
    expect(download.body).toEqual(Buffer.from(bytes));
  });
});
