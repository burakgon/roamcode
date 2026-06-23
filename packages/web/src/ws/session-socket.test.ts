import { describe, expect, it, vi } from "vitest";
import { createSessionSocket } from "./session-socket";
import type { ServerFrame } from "../types/server";

// A minimal fake WebSocket that lets the test drive open/message/close.
class FakeWS {
  static instances: FakeWS[] = [];
  url: string;
  readyState = 0; // CONNECTING
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];
  static OPEN = 1;
  OPEN = 1;
  constructor(url: string) {
    this.url = url;
    FakeWS.instances.push(this);
  }
  send(data: string) { this.sent.push(data); }
  close() { this.readyState = 3; this.onclose?.(); }
  _open() { this.readyState = 1; this.onopen?.(); }
  _message(frame: ServerFrame) { this.onmessage?.({ data: JSON.stringify(frame) }); }
}

describe("SessionSocket", () => {
  it("parses frames and reports status", () => {
    FakeWS.instances = [];
    const frames: ServerFrame[] = [];
    const statuses: string[] = [];
    const sock = createSessionSocket({
      url: "ws://x/sessions/a/ws",
      onFrame: (f) => frames.push(f),
      onStatus: (s) => statuses.push(s),
      getSince: () => undefined,
      WebSocketImpl: FakeWS as unknown as typeof WebSocket,
    });
    const ws = FakeWS.instances[0]!;
    ws._open();
    ws._message({ seq: 1, kind: "event", payload: { type: "system" } });
    expect(frames).toEqual([{ seq: 1, kind: "event", payload: { type: "system" } }]);
    expect(statuses).toContain("open");
    sock.close();
    expect(statuses).toContain("closed");
  });

  it("reconnects on unexpected close, carrying ?since from getSince()", () => {
    vi.useFakeTimers();
    FakeWS.instances = [];
    let lastSeq = 0;
    const sock = createSessionSocket({
      url: "ws://x/sessions/a/ws",
      onFrame: (f) => (lastSeq = f.seq),
      onStatus: () => {},
      getSince: () => (lastSeq > 0 ? lastSeq : undefined),
      WebSocketImpl: FakeWS as unknown as typeof WebSocket,
    });
    const ws = FakeWS.instances[0]!;
    ws._open();
    ws._message({ seq: 5, kind: "event", payload: {} });
    ws.close(); // unexpected close -> schedule a reconnect
    vi.runOnlyPendingTimers();
    expect(FakeWS.instances).toHaveLength(2);
    expect(FakeWS.instances[1]!.url).toContain("since=5");
    sock.close();
    vi.useRealTimers();
  });

  it("send() serializes an outbound frame when open", () => {
    FakeWS.instances = [];
    const sock = createSessionSocket({
      url: "ws://x/sessions/a/ws",
      onFrame: () => {},
      onStatus: () => {},
      getSince: () => undefined,
      WebSocketImpl: FakeWS as unknown as typeof WebSocket,
    });
    const ws = FakeWS.instances[0]!;
    ws._open();
    sock.send({ type: "user", content: "hi" });
    expect(JSON.parse(ws.sent[0]!)).toEqual({ type: "user", content: "hi" });
    sock.close();
  });
});
