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
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
  _open() {
    this.readyState = 1;
    this.onopen?.();
  }
  _message(frame: ServerFrame) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
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
    expect(sock.send({ type: "user", content: "hi" })).toBe(true); // delivered over the open socket
    expect(JSON.parse(ws.sent[0]!)).toEqual({ type: "user", content: "hi" });
    sock.close();
  });

  it("send() returns false when buffered (socket not open) and true once flushed on reconnect", () => {
    vi.useFakeTimers();
    FakeWS.instances = [];
    const sock = createSessionSocket({
      url: "ws://x/sessions/a/ws",
      onFrame: () => {},
      onStatus: () => {},
      getSince: () => undefined,
      WebSocketImpl: FakeWS as unknown as typeof WebSocket,
    });
    const ws1 = FakeWS.instances[0]!;
    ws1._open();
    ws1.close(); // unexpected close → not open
    expect(sock.send({ type: "user", content: "x" })).toBe(false); // buffered, NOT delivered
    vi.runOnlyPendingTimers();
    const ws2 = FakeWS.instances[1]!;
    ws2._open();
    expect(JSON.parse(ws2.sent[0]!)).toEqual({ type: "user", content: "x" }); // flushed on reconnect
    expect(sock.send({ type: "user", content: "y" })).toBe(true); // now open → delivered
    sock.close();
    vi.useRealTimers();
  });

  it("buffers a send made while disconnected and flushes it on reconnect (no silent drop)", () => {
    vi.useFakeTimers();
    FakeWS.instances = [];
    const sock = createSessionSocket({
      url: "ws://x/sessions/a/ws",
      onFrame: () => {},
      onStatus: () => {},
      getSince: () => undefined,
      WebSocketImpl: FakeWS as unknown as typeof WebSocket,
    });
    const ws1 = FakeWS.instances[0]!;
    ws1._open();
    ws1.close(); // unexpected close → the socket is no longer OPEN
    // The user hits Send while the link is down. The old code dropped this on the floor.
    sock.send({ type: "user", content: "queued while offline" });
    expect(ws1.sent).toHaveLength(0);
    vi.runOnlyPendingTimers(); // backoff fires → a new socket is created
    const ws2 = FakeWS.instances[1]!;
    ws2._open(); // reconnect completes → buffered frame flushes
    expect(JSON.parse(ws2.sent[0]!)).toEqual({ type: "user", content: "queued while offline" });
    sock.close();
    vi.useRealTimers();
  });

  it("routes a resync control frame to onResync, never to onFrame", () => {
    FakeWS.instances = [];
    const frames: ServerFrame[] = [];
    let resyncs = 0;
    const sock = createSessionSocket({
      url: "ws://x/sessions/a/ws",
      onFrame: (f) => frames.push(f),
      onStatus: () => {},
      onResync: () => resyncs++,
      getSince: () => undefined,
      WebSocketImpl: FakeWS as unknown as typeof WebSocket,
    });
    const ws = FakeWS.instances[0]!;
    ws._open();
    ws._message({ seq: 0, kind: "resync", payload: {} });
    ws._message({ seq: 7, kind: "event", payload: { type: "system" } });
    // The resync frame is a control signal (the server tells us the reconnect buffer rotated past our
    // position): it triggers a full history refetch, and is NEVER folded into the conversation view.
    expect(resyncs).toBe(1);
    expect(frames).toEqual([{ seq: 7, kind: "event", payload: { type: "system" } }]);
    sock.close();
  });
});
