import { describe, expect, it, vi } from "vitest";
import {
  TERMINAL_WRITE_CHUNK_BYTES,
  TerminalReplayGuard,
  writeTerminalBytes,
  type TerminalByteWriter,
} from "./terminal-output";

describe("writeTerminalBytes", () => {
  it("splits the maximum reconnect frame into 64 KiB writes and completes after the final parse", () => {
    const callbacks: Array<(() => void) | undefined> = [];
    const writes: Uint8Array[] = [];
    const terminal: TerminalByteWriter = {
      write(data, callback) {
        writes.push(data);
        callbacks.push(callback);
      },
    };
    const complete = vi.fn();
    const bytes = new Uint8Array(12 * 1024 * 1024);

    expect(writeTerminalBytes(terminal, bytes, complete)).toBe(192);
    expect(writes).toHaveLength(192);
    expect(writes.every((chunk) => chunk.byteLength === TERMINAL_WRITE_CHUNK_BYTES)).toBe(true);
    expect(callbacks.slice(0, -1).every((callback) => callback === undefined)).toBe(true);
    expect(complete).not.toHaveBeenCalled();

    callbacks.at(-1)?.();
    expect(complete).toHaveBeenCalledOnce();
  });

  it("keeps subarray ordering and supports an empty frame", () => {
    const source = Uint8Array.from({ length: TERMINAL_WRITE_CHUNK_BYTES + 3 }, (_, index) => index % 251);
    const writes: Uint8Array[] = [];
    const terminal: TerminalByteWriter = { write: (data) => writes.push(data) };

    expect(writeTerminalBytes(terminal, source)).toBe(2);
    expect(Uint8Array.from(writes.flatMap((chunk) => [...chunk]))).toEqual(source);
    expect(writeTerminalBytes(terminal, new Uint8Array())).toBe(1);
    expect(writes.at(-1)).toHaveLength(0);
  });
});

describe("TerminalReplayGuard", () => {
  it("suppresses side effects through asynchronous parsing and recovers without an end marker", () => {
    const guard = new TerminalReplayGuard();
    guard.begin();
    expect(guard.suppressSideEffects).toBe(true);

    const parsed = guard.acceptFrame();
    guard.end();
    expect(guard.suppressSideEffects).toBe(true);

    parsed?.();
    expect(guard.suppressSideEffects).toBe(false);
  });

  it("recovers when replay data is empty or dropped", () => {
    const guard = new TerminalReplayGuard();
    guard.begin();
    guard.end();
    expect(guard.suppressSideEffects).toBe(false);
    expect(guard.acceptFrame()).toBeUndefined();
  });
});
