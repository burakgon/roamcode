import { fileURLToPath } from "node:url";
import { expect, test, vi } from "vitest";
import { SessionManager, SessionHub } from "../src/index.js";
import type { ServerFrame } from "../src/index.js";

const MOCK = fileURLToPath(new URL("./helpers/mock-claude-interactive.mjs", import.meta.url));

function hubFor(mode: string) {
  const manager = new SessionManager(
    { claudeBin: process.execPath },
    { spawnPrefixArgs: [MOCK], baseEnv: { ...process.env, MOCK_MODE: mode }, startTimeoutMs: 5000 },
  );
  return { hub: new SessionHub(manager), manager };
}

function waitForFrame(hub: SessionHub, id: string, pred: (f: ServerFrame) => boolean): Promise<ServerFrame> {
  return new Promise((resolve) => {
    const sub = hub.subscribe(id, (f) => {
      if (pred(f)) {
        sub.unsubscribe();
        resolve(f);
      }
    });
  });
}

test("rewind code: live rewind_files on the running process, success + a rewound frame", async () => {
  const { hub, manager } = hubFor("simple");
  const meta = await hub.createSession({ cwd: process.cwd() });
  const proc = manager.getSession(meta.id)!.process;
  const spy = vi.spyOn(proc, "rewindFiles");

  const rewoundPromise = waitForFrame(hub, meta.id, (f) => f.kind === "rewound");
  const result = await hub.rewind(meta.id, "uuid-cp", "code");

  expect(result.ok).toBe(true);
  expect(result.canRewind).toBe(true);
  expect(spy).toHaveBeenCalledWith("uuid-cp", {});

  const frame = await rewoundPromise;
  expect(frame.payload).toMatchObject({ checkpointId: "uuid-cp", mode: "code", ok: true });
  // code mode does NOT respawn the process.
  expect(manager.getSession(meta.id)).toBeDefined();

  hub.stopSession(meta.id);
});

test("rewind conversation: stops the live process and resumes it truncated at the checkpoint", async () => {
  const { hub, manager } = hubFor("simple");
  const meta = await hub.createSession({ cwd: process.cwd() });
  const resumeSpy = vi.spyOn(manager, "resumeSession");

  const rewoundPromise = waitForFrame(hub, meta.id, (f) => f.kind === "rewound");
  const result = await hub.rewind(meta.id, "uuid-cp", "conversation");

  expect(result.ok).toBe(true);
  // It resumed with --resume-session-at <uuid> but NOT --rewind-files (conversation-only).
  expect(resumeSpy).toHaveBeenCalledTimes(1);
  expect(resumeSpy.mock.calls[0]![1]).toMatchObject({ resumeSessionAt: "uuid-cp" });
  expect(resumeSpy.mock.calls[0]![1].rewindFilesAt).toBeUndefined();

  const frame = await rewoundPromise;
  expect(frame.payload).toMatchObject({ checkpointId: "uuid-cp", mode: "conversation", ok: true });
  // The session is live again (resumed) and not flagged errored.
  expect(hub.getSession(meta.id)?.status).toBe("running");

  hub.stopSession(meta.id);
});

test("rewind both: resumes with BOTH --resume-session-at and --rewind-files for the checkpoint", async () => {
  const { hub, manager } = hubFor("simple");
  const meta = await hub.createSession({ cwd: process.cwd() });
  const resumeSpy = vi.spyOn(manager, "resumeSession");

  const result = await hub.rewind(meta.id, "uuid-cp", "both");
  expect(result.ok).toBe(true);
  expect(resumeSpy.mock.calls[0]![1]).toMatchObject({ resumeSessionAt: "uuid-cp", rewindFilesAt: "uuid-cp" });

  hub.stopSession(meta.id);
});

test("rewind code on a disabled-checkpointing CLI resolves ok:false and still emits a rewound frame", async () => {
  const { hub } = hubFor("rewind-disabled");
  const meta = await hub.createSession({ cwd: process.cwd() });

  const rewoundPromise = waitForFrame(hub, meta.id, (f) => f.kind === "rewound");
  const result = await hub.rewind(meta.id, "uuid-cp", "code");
  expect(result.ok).toBe(false);
  expect(result.error).toBe("File rewinding is not enabled.");

  const frame = await rewoundPromise;
  expect(frame.payload).toMatchObject({ checkpointId: "uuid-cp", mode: "code", ok: false });

  hub.stopSession(meta.id);
});

test("rewind throws for an unknown session id (consistent with other hub ops)", async () => {
  const { hub } = hubFor("simple");
  await expect(hub.rewind("nope", "uuid", "code")).rejects.toThrow(/unknown session/);
});
