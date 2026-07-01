import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createServer, TerminalManager, openSessionStore } from "../src/index.js";
import type { ServerRuntimeConfig, CreateServerResult } from "../src/index.js";

const TOKEN = "test-token";
const auth = { authorization: `Bearer ${TOKEN}` };

let root: string;
let current: CreateServerResult | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "rc-files-"));
  mkdirSync(join(root, "sub"));
  writeFileSync(join(root, "readme.md"), "# hi");
});

afterEach(async () => {
  if (current) await current.app.close();
  current = undefined;
  rmSync(root, { recursive: true, force: true });
});

/** A fake pty spawn so terminal sessions don't touch real tmux/node-pty. */
function fakePtySpawn(): (file: string, args: string[]) => EventEmitter {
  return () => {
    const ee = new EventEmitter() as EventEmitter & {
      write(d: string): void;
      resize(c: number, r: number): void;
      kill(): void;
      onData(cb: (d: string) => void): void;
      onExit(cb: (e: { exitCode: number }) => void): void;
    };
    ee.write = () => {};
    ee.resize = () => {};
    ee.kill = () => {};
    ee.onData = (cb) => void ee.on("data", cb);
    ee.onExit = (cb) => void ee.on("exit", cb);
    return ee;
  };
}

function makeServer(maxUploadBytes = 26214400): CreateServerResult {
  const config: ServerRuntimeConfig = {
    port: 0,
    bindAddress: "127.0.0.1",
    accessToken: TOKEN,
    fsRoot: root,
    dataDir: join(root, ".data"), // within fsRoot → terminal uploads land here, not in a project cwd
    maxUploadBytes,
    claude: { claudeBin: process.execPath },
  };
  const store = openSessionStore({ dbPath: ":memory:" });
  const terminalManager = new TerminalManager({
    store,
    claudeBin: config.claude.claudeBin,
    now: () => Date.now(),
    ptySpawn: fakePtySpawn() as never,
    runTmux: () => {},
  });
  return createServer(config, { store, terminalAvailable: true, terminalManager });
}

/** Create a terminal session via REST and return its id. */
async function createSession(result: CreateServerResult): Promise<string> {
  const created = await result.app.inject({
    method: "POST",
    url: "/sessions",
    headers: auth,
    payload: { cwd: root },
  });
  expect(created.statusCode).toBe(201);
  return created.json().session.id as string;
}

/** Collect the control frames pushed to a terminal session over its WS (attach uses pushControl). */
function collectControl(result: CreateServerResult, id: string): { frames: unknown[]; stop: () => void } {
  const frames: unknown[] = [];
  const sub = result.terminalManager.attach(id, {
    onData: () => {},
    onControl: (json) => frames.push(JSON.parse(json)),
  });
  return { frames, stop: () => sub?.unsubscribe() };
}

test("GET /fs/list returns the listing rooted at fsRoot", async () => {
  current = makeServer();
  const res = await current.app.inject({ method: "GET", url: "/fs/list", headers: auth });
  expect(res.statusCode).toBe(200);
  const names = res.json().entries.map((e: { name: string }) => e.name);
  expect(names).toEqual(["sub", "readme.md"]); // dir first, then file
});

test("GET /fs/list rejects path traversal with 403", async () => {
  current = makeServer();
  const res = await current.app.inject({ method: "GET", url: "/fs/list?path=../..", headers: auth });
  expect(res.statusCode).toBe(403);
});

test("GET /fs/download returns 403 outside root and 404 for a missing in-root file", async () => {
  current = makeServer();
  const outside = await current.app.inject({ method: "GET", url: "/fs/download?path=../../etc/hosts", headers: auth });
  expect(outside.statusCode).toBe(403);
  const missing = await current.app.inject({
    method: "GET",
    url: `/fs/download?path=${encodeURIComponent(join(root, "nope.txt"))}`,
    headers: auth,
  });
  expect(missing.statusCode).toBe(404);
});

test("GET /fs/download streams a file with an attachment header", async () => {
  current = makeServer();
  const res = await current.app.inject({
    method: "GET",
    url: `/fs/download?path=${encodeURIComponent(join(root, "readme.md"))}`,
    headers: auth,
  });
  expect(res.statusCode).toBe(200);
  expect(res.headers["content-disposition"]).toContain('filename="readme.md"');
  expect(res.body).toBe("# hi");
});

test("GET /fs/download escapes a filename with quotes/control chars (no header break)", async () => {
  current = makeServer();
  // A filename with a literal double-quote would break out of the quoted-string in the
  // Content-Disposition header if interpolated raw. Such a name is legal on disk.
  const trickyName = 'a"b.txt';
  writeFileSync(join(root, trickyName), "data");
  const res = await current.app.inject({
    method: "GET",
    url: `/fs/download?path=${encodeURIComponent(join(root, trickyName))}`,
    headers: auth,
  });
  expect(res.statusCode).toBe(200);
  const cd = res.headers["content-disposition"] as string;
  // The raw quote must NOT appear unescaped in the ASCII fallback (it is replaced with `_`),
  // and the full name is carried losslessly via the RFC 5987 filename*= form.
  expect(cd).toContain('filename="a_b.txt"');
  expect(cd).toContain("filename*=UTF-8''a%22b.txt");
  // No CR/LF smuggled into the header value.
  expect(cd).not.toContain("\n");
  expect(cd).not.toContain("\r");
});

test("POST /fs/upload writes a file under the target dir", async () => {
  current = makeServer();
  const boundary = "----rcboundary";
  const body =
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="note.txt"\r\n` +
    `Content-Type: text/plain\r\n\r\n` +
    `uploaded-content\r\n` +
    `--${boundary}--\r\n`;
  const res = await current.app.inject({
    method: "POST",
    url: `/fs/upload?dir=${encodeURIComponent(join(root, "sub"))}`,
    headers: { ...auth, "content-type": `multipart/form-data; boundary=${boundary}` },
    payload: body,
  });
  expect(res.statusCode).toBe(201);
  expect(res.json().path).toBe(join(root, "sub", "note.txt"));

  // confirm it is downloadable
  const back = await current.app.inject({
    method: "GET",
    url: `/fs/download?path=${encodeURIComponent(join(root, "sub", "note.txt"))}`,
    headers: auth,
  });
  expect(back.body).toBe("uploaded-content");
});

test("POST /sessions/:id/upload saves in the data dir (outside the session cwd), never <cwd>/shared_files", async () => {
  current = makeServer();
  const cwd = join(root, "sub"); // the "project" the terminal was opened in
  const id = "term-upload-1";
  current.terminalManager.create({ id, cwd }); // register a terminal session (no tmux spawn needed)

  const boundary = "----rcboundary";
  const body =
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="pic.png"\r\n` +
    `Content-Type: image/png\r\n\r\n` +
    `PIXELS\r\n` +
    `--${boundary}--\r\n`;
  const res = await current.app.inject({
    method: "POST",
    url: `/sessions/${id}/upload`,
    headers: { ...auth, "content-type": `multipart/form-data; boundary=${boundary}` },
    payload: body,
  });
  expect(res.statusCode).toBe(201);
  const savedPath = res.json().path as string;

  // The whole fix: the upload is NOT written into the project tree (which would dirty git / block the
  // updater), but under the app data dir, keyed by session id.
  expect(savedPath).toBe(join(root, ".data", "terminal-shared", id, "pic.png"));
  expect(savedPath.startsWith(cwd)).toBe(false);
  const { existsSync } = await import("node:fs");
  expect(existsSync(join(cwd, "shared_files"))).toBe(false);

  // Round-trips through the fsRoot-confined /fs/download (so the Files panel can still fetch it).
  const back = await current.app.inject({
    method: "GET",
    url: `/fs/download?path=${encodeURIComponent(savedPath)}`,
    headers: auth,
  });
  expect(back.statusCode).toBe(200);
  expect(back.body).toBe("PIXELS");
});

test("POST /fs/upload rejects a file over the size cap with 413", async () => {
  current = makeServer(8); // 8-byte cap
  const boundary = "----rcboundary";
  const body =
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="big.txt"\r\n` +
    `Content-Type: text/plain\r\n\r\n` +
    `this content is definitely longer than eight bytes\r\n` +
    `--${boundary}--\r\n`;
  const res = await current.app.inject({
    method: "POST",
    url: `/fs/upload?dir=${encodeURIComponent(root)}`,
    headers: { ...auth, "content-type": `multipart/form-data; boundary=${boundary}` },
    payload: body,
  });
  expect(res.statusCode).toBe(413);
});

test("POST /sessions/:id/attach pushes a control frame for a valid in-root image", async () => {
  current = makeServer();
  writeFileSync(join(root, "shot.png"), "img-bytes");
  const id = await createSession(current);

  const { frames, stop } = collectControl(current, id);

  const res = await current.app.inject({
    method: "POST",
    url: `/sessions/${id}/attach`,
    headers: auth,
    payload: { path: join(root, "shot.png"), caption: "here you go", kind: "image" },
  });
  stop();

  expect(res.statusCode).toBe(200);
  const json = res.json();
  expect(json.ok).toBe(true);
  expect(typeof json.id).toBe("string");

  const frame = frames.find((f) => (f as { t?: string }).t === "attach") as
    { id: string; path: string; name: string; caption?: string; isImage: boolean } | undefined;
  expect(frame).toBeDefined();
  expect(frame!.id).toBe(json.id);
  expect(frame!.path).toBe(join(root, "shot.png"));
  expect(frame!.name).toBe("shot.png");
  expect(frame!.isImage).toBe(true);
  expect(frame!.caption).toBe("here you go");
});

test("POST /sessions/:id/attach with kind=file marks a non-image file isImage:false", async () => {
  current = makeServer();
  const id = await createSession(current);
  const { frames, stop } = collectControl(current, id);

  const res = await current.app.inject({
    method: "POST",
    url: `/sessions/${id}/attach`,
    headers: auth,
    payload: { path: join(root, "readme.md"), kind: "file" },
  });
  stop();

  expect(res.statusCode).toBe(200);
  const frame = frames.find((f) => (f as { t?: string }).t === "attach") as
    { isImage: boolean; caption?: string } | undefined;
  expect(frame!.isImage).toBe(false);
  expect(frame!.caption).toBeUndefined();
});

test("POST /sessions/:id/attach returns 403 for a traversal/outside path and pushes NO frame", async () => {
  current = makeServer();
  const id = await createSession(current);
  const { frames, stop } = collectControl(current, id);

  const res = await current.app.inject({
    method: "POST",
    url: `/sessions/${id}/attach`,
    headers: auth,
    payload: { path: "../../etc/hosts" },
  });
  stop();

  expect(res.statusCode).toBe(403);
  expect(frames.some((f) => (f as { t?: string }).t === "attach")).toBe(false);
});

test("POST /sessions/:id/attach returns 404 for a missing in-root file", async () => {
  current = makeServer();
  const id = await createSession(current);
  const res = await current.app.inject({
    method: "POST",
    url: `/sessions/${id}/attach`,
    headers: auth,
    payload: { path: join(root, "nope.txt") },
  });
  expect(res.statusCode).toBe(404);
});

test("POST /sessions/:id/attach returns 404 for an unknown session", async () => {
  current = makeServer();
  const res = await current.app.inject({
    method: "POST",
    url: `/sessions/does-not-exist/attach`,
    headers: auth,
    payload: { path: join(root, "readme.md") },
  });
  expect(res.statusCode).toBe(404);
});

test("POST /sessions/:id/attach is token-gated (401 without auth)", async () => {
  current = makeServer();
  const id = await createSession(current);
  const res = await current.app.inject({
    method: "POST",
    url: `/sessions/${id}/attach`,
    payload: { path: join(root, "readme.md") },
  });
  expect(res.statusCode).toBe(401);
});
