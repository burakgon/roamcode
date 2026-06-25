import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";
import { WebSocket } from "ws";
import { SessionManager, createServer } from "../src/index.js";
import type { ServerRuntimeConfig, CreateServerResult, ServerFrame } from "../src/index.js";

const MOCK = fileURLToPath(new URL("./helpers/mock-claude-interactive.mjs", import.meta.url));
const TOKEN = "test-token";

function configFor(): ServerRuntimeConfig {
  return {
    port: 0,
    bindAddress: "127.0.0.1",
    accessToken: TOKEN,
    fsRoot: process.cwd(),
    maxUploadBytes: 26214400,
    claude: { claudeBin: process.execPath },
  };
}

function managerFor(mode: string, config: ServerRuntimeConfig) {
  return new SessionManager(config.claude, {
    spawnPrefixArgs: [MOCK],
    baseEnv: { ...process.env, MOCK_MODE: mode },
    startTimeoutMs: 5000,
  });
}

let current: CreateServerResult | undefined;
afterEach(async () => {
  if (current) await current.app.close();
  current = undefined;
});

async function listen(result: CreateServerResult): Promise<string> {
  const address = await result.app.listen({ port: 0, host: "127.0.0.1" });
  return address.replace(/^http/, "ws");
}

async function createSession(result: CreateServerResult): Promise<string> {
  const created = await result.app.inject({
    method: "POST",
    url: "/sessions",
    headers: { authorization: `Bearer ${TOKEN}` },
    payload: { cwd: process.cwd() },
  });
  return created.json().session.id;
}

test("WS: a client `rewind` (code) frame reaches the process and yields a rewound frame", async () => {
  const config = configFor();
  current = createServer(config, managerFor("simple", config));
  const base = await listen(current);
  const id = await createSession(current);

  await new Promise<void>((resolve, reject) => {
    let sent = false;
    const q = `?token=${encodeURIComponent(TOKEN)}`;
    const ws = new WebSocket(`${base}/sessions/${id}/ws${q}`);
    ws.on("open", () => {
      sent = true;
      ws.send(JSON.stringify({ type: "rewind", checkpointId: "uuid-cp", mode: "code" }));
    });
    ws.on("message", (data: Buffer) => {
      const frame = JSON.parse(data.toString()) as ServerFrame;
      if (frame.kind === "rewound") {
        try {
          expect(sent).toBe(true);
          expect(frame.payload).toMatchObject({ checkpointId: "uuid-cp", mode: "code", ok: true });
        } catch (err) {
          ws.close();
          reject(err as Error);
          return;
        }
        ws.close();
        resolve();
      }
    });
    ws.on("error", reject);
    setTimeout(() => reject(new Error("no rewound frame over ws")), 8000);
  });
});

test("WS: a `rewind` frame with an invalid mode is ignored (no crash, no rewound frame)", async () => {
  const config = configFor();
  current = createServer(config, managerFor("simple", config));
  const base = await listen(current);
  const id = await createSession(current);

  await new Promise<void>((resolve, reject) => {
    const q = `?token=${encodeURIComponent(TOKEN)}`;
    const ws = new WebSocket(`${base}/sessions/${id}/ws${q}`);
    let sawRewound = false;
    ws.on("open", () => {
      // Invalid mode + missing checkpointId — both must be ignored.
      ws.send(JSON.stringify({ type: "rewind", checkpointId: "x", mode: "bogus" }));
      ws.send(JSON.stringify({ type: "rewind", mode: "code" }));
      // Prove the server survived: a normal user turn still completes.
      setTimeout(() => ws.send(JSON.stringify({ type: "user", content: "still alive?" })), 150);
    });
    ws.on("message", (data: Buffer) => {
      const frame = JSON.parse(data.toString()) as ServerFrame;
      if (frame.kind === "rewound") sawRewound = true;
      if (frame.kind === "result") {
        try {
          expect(sawRewound).toBe(false);
        } catch (err) {
          ws.close();
          reject(err as Error);
          return;
        }
        ws.close();
        resolve();
      }
    });
    ws.on("error", reject);
    setTimeout(() => reject(new Error("server did not survive a bad rewind frame")), 8000);
  });
});
