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
  onclose?: (e: { code: number }) => void;
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
  drop(code: number) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
}

afterEach(() => {
  vi.useRealTimers();
  FakeWS.instances = [];
});

test("decodes binary output and encodes input, resize, and lease actions", () => {
  vi.stubGlobal("WebSocket", FakeWS as never);
  const got: Uint8Array[] = [];
  const sock = createTerminalSocket({ url: "wss://x/sessions/a/terminal?token=t", onData: (b) => got.push(b) });
  FakeWS.last.open();
  FakeWS.last.onmessage?.({ data: new TextEncoder().encode("hi").buffer });
  expect(new TextDecoder().decode(got[0])).toBe("hi");

  sock.sendInput("x");
  sock.sendResize(80, 24);
  sock.requestInputLease?.("takeover", true);
  expect(JSON.parse(FakeWS.last.sent[0]!)).toEqual({ t: "i", d: "x" });
  expect(JSON.parse(FakeWS.last.sent[1]!)).toEqual({ t: "r", c: 80, r: 24 });
  expect(JSON.parse(FakeWS.last.sent[2]!)).toEqual({ t: "lease", action: "takeover", confirm: true });
});

test("routes text control frames and ignores a superseded socket", () => {
  vi.stubGlobal("WebSocket", FakeWS as never);
  const controls: string[] = [];
  const sock = createTerminalSocket({ url: "u", onData: () => {}, onControl: (json) => controls.push(json) });
  const first = FakeWS.last;
  first.open();
  first.onmessage?.({ data: '{"t":"input-lease","writable":true}' });
  expect(controls).toHaveLength(1);

  sock.reconnect();
  const second = FakeWS.last;
  second.open();
  first.onmessage?.({ data: '{"t":"input-lease","writable":false}' });
  second.onmessage?.({ data: '{"t":"input-lease","writable":true}' });
  expect(controls).toEqual(['{"t":"input-lease","writable":true}', '{"t":"input-lease","writable":true}']);
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
