import { afterEach, expect, test, vi } from "vitest";
import { createTerminalSocket } from "./terminal-socket";

class FakeWS {
  static instances: FakeWS[] = [];
  static get last(): FakeWS {
    return FakeWS.instances[FakeWS.instances.length - 1]!;
  }
  OPEN = 1;
  readyState = 0;
  binaryType = "";
  sent: string[] = [];
  onmessage?: (e: { data: ArrayBuffer | string }) => void;
  onopen?: () => void;
  onclose?: (e: { code: number; reason?: string }) => void;
  onerror?: () => void;
  constructor(public url: string) {
    FakeWS.instances.push(this);
  }
  send(d: string) {
    this.sent.push(d);
  }
  close() {
    /* caller close — real onclose arrives later; tests fire drop() to simulate it */
  }
  open() {
    this.readyState = this.OPEN;
    this.onopen?.();
  }
  drop(code: number, reason?: string) {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
}

afterEach(() => {
  vi.useRealTimers();
  FakeWS.instances = [];
});

test("decodes binary output and encodes input and resize actions", () => {
  vi.stubGlobal("WebSocket", FakeWS as never);
  const got: Uint8Array[] = [];
  const sock = createTerminalSocket({ url: "wss://x/sessions/a/terminal?token=t", onData: (b) => got.push(b) });
  FakeWS.last.open();
  FakeWS.last.onmessage?.({ data: new TextEncoder().encode("hi").buffer });
  expect(new TextDecoder().decode(got[0])).toBe("hi");

  sock.sendInput("x");
  sock.sendResize(80, 24);
  expect(FakeWS.last.sent.map((frame) => JSON.parse(frame))).toEqual([
    { t: "v", v: true },
    { t: "i", d: "x" },
    { t: "r", c: 80, r: 24 },
  ]);
});

test("reports foreground visibility on open, backgrounding, and reconnect", () => {
  vi.stubGlobal("WebSocket", FakeWS as never);
  let visible = false;
  const sock = createTerminalSocket({ url: "u", onData: () => {}, isVisible: () => visible });
  FakeWS.last.open();
  expect(JSON.parse(FakeWS.last.sent[0]!)).toEqual({ t: "v", v: false });

  visible = true;
  sock.setVisibility?.(true);
  expect(JSON.parse(FakeWS.last.sent.at(-1)!)).toEqual({ t: "v", v: true });
  sock.reconnect();
  FakeWS.last.open();
  expect(JSON.parse(FakeWS.last.sent[0]!)).toEqual({ t: "v", v: true });
});

test("routes text control frames and ignores a superseded socket", () => {
  vi.stubGlobal("WebSocket", FakeWS as never);
  const controls: string[] = [];
  const sock = createTerminalSocket({ url: "u", onData: () => {}, onControl: (json) => controls.push(json) });
  const first = FakeWS.last;
  first.open();
  first.onmessage?.({ data: '{"t":"attach","path":"/tmp/a"}' });
  expect(controls).toHaveLength(1);

  sock.reconnect();
  const second = FakeWS.last;
  second.open();
  first.onmessage?.({ data: '{"t":"attach","path":"/tmp/stale"}' });
  second.onmessage?.({ data: '{"t":"attach","path":"/tmp/b"}' });
  expect(controls).toEqual(['{"t":"attach","path":"/tmp/a"}', '{"t":"attach","path":"/tmp/b"}']);
});

test("auto-reconnects on a transient drop (backoff), re-opening the socket", () => {
  vi.useFakeTimers();
  vi.stubGlobal("WebSocket", FakeWS as never);
  const status: string[] = [];
  createTerminalSocket({ url: "u", onData: () => {}, onStatus: (s) => status.push(s) });
  FakeWS.last.open();
  expect(status).toEqual(["open"]);
  FakeWS.last.drop(1006); // abnormal/transient close
  expect(status).toContain("reconnecting");
  expect(FakeWS.instances.length).toBe(1); // hasn't retried yet (waiting on backoff)
  vi.advanceTimersByTime(1000);
  expect(FakeWS.instances.length).toBe(2); // reconnected
});

test("does NOT reconnect on a fatal close code (4410 ended / 4404 not-found)", () => {
  for (const code of [4410, 4404]) {
    FakeWS.instances = [];
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeWS as never);
    const status: string[] = [];
    createTerminalSocket({ url: "u", onData: () => {}, onStatus: (s) => status.push(s) });
    FakeWS.last.open();
    FakeWS.last.drop(code);
    expect(status).toContain("ended");
    expect(status).not.toContain("reconnecting");
    vi.advanceTimersByTime(60000);
    expect(FakeWS.instances.length).toBe(1); // never retried
    vi.useRealTimers();
  }
});

test("caller close() stops any reconnection", () => {
  vi.useFakeTimers();
  vi.stubGlobal("WebSocket", FakeWS as never);
  const sock = createTerminalSocket({ url: "u", onData: () => {} });
  FakeWS.last.open();
  sock.close();
  FakeWS.last.drop(1006); // a late close after the caller already tore down
  vi.advanceTimersByTime(60000);
  expect(FakeWS.instances.length).toBe(1); // no reconnect after an intentional close
});

test("a revoked device stops retrying and says so instead of reconnecting forever", () => {
  vi.stubGlobal("WebSocket", FakeWS as never);
  vi.useFakeTimers();
  const statuses: [string, unknown][] = [];
  createTerminalSocket({
    url: "wss://x/sessions/a/terminal",
    onData: () => {},
    onStatus: (s, detail) => statuses.push([s, detail]),
  });
  FakeWS.last.open();
  const opened = FakeWS.instances.length;

  // 4403 = this device's access was revoked. It used to fall through to the transient branch, so the user
  // watched "Reconnecting…" forever while every attempt was rejected the same way.
  FakeWS.last.drop(4403, "remote access revoked");
  vi.advanceTimersByTime(60_000);

  expect(FakeWS.instances.length).toBe(opened);
  expect(statuses.at(-1)).toEqual(["ended", { cause: "access-revoked" }]);
});

test("carries the server's attach-failure reason instead of a bare 'session gone'", () => {
  vi.stubGlobal("WebSocket", FakeWS as never);
  const statuses: [string, unknown][] = [];
  createTerminalSocket({
    url: "wss://x/sessions/a/terminal",
    onData: () => {},
    onStatus: (s, detail) => statuses.push([s, detail]),
  });
  FakeWS.last.open();
  FakeWS.last.drop(4404, "attach-failed:cwd-missing");

  expect(statuses.at(-1)).toEqual(["ended", { cause: "attach-failed", detail: "cwd-missing" }]);
});

test("a 4404 with no reason is still just a missing session", () => {
  vi.stubGlobal("WebSocket", FakeWS as never);
  const statuses: [string, unknown][] = [];
  createTerminalSocket({
    url: "wss://x/sessions/a/terminal",
    onData: () => {},
    onStatus: (s, detail) => statuses.push([s, detail]),
  });
  FakeWS.last.open();
  FakeWS.last.drop(4404, "terminal session not found");

  expect(statuses.at(-1)).toEqual(["ended", { cause: "session-gone" }]);
});

test("repeated failures stop being described as a blip, without ever giving up", () => {
  vi.stubGlobal("WebSocket", FakeWS as never);
  vi.useFakeTimers();
  const statuses: [string, unknown][] = [];
  createTerminalSocket({
    url: "wss://x/sessions/a/terminal",
    onData: () => {},
    onStatus: (s, detail) => statuses.push([s, detail]),
  });

  // Four transient drops: the first ones read as an ordinary blip...
  for (let i = 0; i < 4; i += 1) {
    FakeWS.last.drop(1006);
    vi.advanceTimersByTime(30_000);
  }
  expect(
    statuses
      .filter(([s]) => s === "reconnecting")
      .slice(0, 4)
      .every(([, d]) => d === undefined),
  ).toBe(true);

  // ...and the next one admits the Node is unreachable. The retry loop continues either way — a phone in a
  // tunnel must still recover on its own.
  FakeWS.last.drop(1006);
  const last = statuses.at(-1) as [string, { cause: string; attempts: number }];
  expect(last[0]).toBe("reconnecting");
  expect(last[1].cause).toBe("unreachable");
  const attempts = FakeWS.instances.length;
  vi.advanceTimersByTime(30_000);
  expect(FakeWS.instances.length).toBeGreaterThan(attempts);
});
