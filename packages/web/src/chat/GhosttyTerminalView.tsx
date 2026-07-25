import { useEffect, useRef, useState } from "react";
import { GhosttyCanvasTerminal, GHOSTTY_UPSTREAM, loadGhosttyRuntime } from "@roamcode.ai/ghostty-web";
import { terminalWsTicketUrl, type ApiClientOptions } from "../api/client";
import { loadToken } from "../auth/token-store";
import { API_BASE_URL } from "../config";
import { useXtermAndReload } from "../settings/terminal-renderer";
import { InlineConfirm } from "../ui/InlineConfirm";
import type { TerminalSocket, TerminalStatus } from "../ws/terminal-socket";
import { createTerminalSocket } from "../ws/terminal-socket";
import { ChatHeader } from "./ChatHeader";
import type { TerminalViewProps } from "./terminal-view-types";

type ConnectionState = "loading" | "connecting" | TerminalStatus;

interface InputLease {
  supported: boolean;
  writable: boolean;
  owner: string | null;
  canTakeover: boolean;
  revision: number;
  reason?: string;
}

const LEGACY_INPUT_LEASE: InputLease = {
  supported: false,
  writable: true,
  owner: null,
  canTakeover: false,
  revision: 0,
};

const DEFAULT_CONNECTION: ApiClientOptions & { hostId: string } = {
  hostId: "current",
  baseUrl: API_BASE_URL,
  getToken: loadToken,
};

function waitForLayout(host: HTMLElement): { promise: Promise<void>; cancel(): void } {
  if (host.clientWidth > 0 && host.clientHeight > 0) {
    return { promise: Promise.resolve(), cancel() {} };
  }
  let finish: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    const observer = new ResizeObserver(() => {
      if (host.clientWidth <= 0 || host.clientHeight <= 0) return;
      finish();
    });
    finish = () => {
      observer.disconnect();
      resolve();
    };
    observer.observe(host);
  });
  return { promise, cancel: () => finish() };
}

function parseInputLease(json: string): InputLease | undefined {
  try {
    const message = JSON.parse(json) as {
      t?: unknown;
      writable?: unknown;
      owner?: { label?: unknown } | null;
      canTakeover?: unknown;
      revision?: unknown;
      reason?: unknown;
    };
    if (
      message.t !== "input-lease" ||
      typeof message.writable !== "boolean" ||
      !Number.isSafeInteger(message.revision)
    ) {
      return undefined;
    }
    if (message.owner !== null && message.owner !== undefined && typeof message.owner.label !== "string") {
      return undefined;
    }
    return {
      supported: true,
      writable: message.writable,
      owner: message.owner && typeof message.owner.label === "string" ? message.owner.label : null,
      canTakeover: message.canTakeover === true,
      revision: message.revision as number,
      ...(typeof message.reason === "string" ? { reason: message.reason } : {}),
    };
  } catch {
    return undefined;
  }
}

export function GhosttyTerminalView({
  session,
  onShowSessions,
  needsYou,
  onClose,
  onOpenSettings,
  onSplitRight,
  onSplitDown,
  closeIsPane,
  dragPaneId,
  connection: suppliedConnection,
  createSocket = createTerminalSocket,
}: TerminalViewProps) {
  const connection = suppliedConnection ?? DEFAULT_CONNECTION;
  const hostRef = useRef<HTMLDivElement>(null);
  const socketRef = useRef<TerminalSocket | undefined>(undefined);
  const terminalRef = useRef<GhosttyCanvasTerminal | undefined>(undefined);
  const inputLeaseRevisionRef = useRef(0);
  const [connectionState, setConnectionState] = useState<ConnectionState>("loading");
  const [error, setError] = useState<Error>();
  const [inputLease, setInputLease] = useState<InputLease>(LEGACY_INPUT_LEASE);
  const [confirmingTakeover, setConfirmingTakeover] = useState(false);
  const [restartKey, setRestartKey] = useState(0);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let disposed = false;
    let terminal: GhosttyCanvasTerminal | undefined;
    let socket: TerminalSocket | undefined;
    const layout = waitForLayout(host);
    setError(undefined);
    setConnectionState("loading");
    setInputLease(LEGACY_INPUT_LEASE);
    setConfirmingTakeover(false);
    inputLeaseRevisionRef.current = 0;

    void (async () => {
      try {
        await layout.promise;
        if (disposed) return;
        const runtime = await loadGhosttyRuntime();
        if (disposed) return;
        terminal = new GhosttyCanvasTerminal(runtime, host, {
          onInput(data) {
            socket?.sendInput(data);
          },
          onResize(cols, rows) {
            socket?.sendResize(cols, rows);
          },
          onError(runtimeError) {
            if (!disposed) {
              socket?.close();
              setError(runtimeError);
            }
          },
        });
        terminalRef.current = terminal;
        setConnectionState("connecting");
        const createdSocket = (connection.terminalSocketFactory ?? createSocket)({
          sessionId: session.id,
          cols: terminal.cols,
          rows: terminal.rows,
          url: () => terminalWsTicketUrl(session.id, terminal?.cols, terminal?.rows, undefined, connection),
          onData(bytes) {
            if (!disposed) terminal?.write(bytes);
          },
          onStatus(status) {
            if (disposed) return;
            setConnectionState(status);
            if (status === "open") {
              setInputLease(LEGACY_INPUT_LEASE);
              inputLeaseRevisionRef.current = 0;
              terminal?.setReadOnly(false);
              terminal?.reset();
              terminal?.fit();
              terminal?.focus();
            } else if (status === "reconnecting") {
              terminal?.setReadOnly(true);
              setInputLease((current) =>
                current.supported ? { ...current, writable: false, reason: "connection interrupted" } : current,
              );
            }
          },
          onControl(json) {
            if (disposed) return;
            const lease = parseInputLease(json);
            if (!lease || lease.revision < inputLeaseRevisionRef.current) return;
            inputLeaseRevisionRef.current = lease.revision;
            setInputLease(lease);
            if (lease.writable || !lease.owner) setConfirmingTakeover(false);
            terminal?.setReadOnly(!lease.writable);
          },
        });
        socket = createdSocket;
        socketRef.current = createdSocket;
      } catch (cause) {
        if (!disposed) {
          setError(cause instanceof Error ? cause : new Error(String(cause)));
        }
      }
    })();

    return () => {
      disposed = true;
      layout.cancel();
      socket?.close();
      terminal?.dispose();
      if (socketRef.current === socket) socketRef.current = undefined;
      if (terminalRef.current === terminal) terminalRef.current = undefined;
      host.replaceChildren();
    };
  }, [connection, createSocket, restartKey, session.id]);

  const shortCommit = GHOSTTY_UPSTREAM.commit.slice(0, 10);
  return (
    <div className="rc-terminal rc-ghostty-terminal">
      <ChatHeader
        session={session}
        onShowSessions={onShowSessions}
        needsYou={needsYou}
        onClose={onClose}
        onOpenSettings={onOpenSettings}
        onSplitRight={onSplitRight}
        onSplitDown={onSplitDown}
        closeIsPane={closeIsPane}
        dragPaneId={dragPaneId}
      />
      <div className="rc-ghostty-banner" role="status">
        <span>Ghostty experimental</span>
        <code title={GHOSTTY_UPSTREAM.commit}>{shortCommit}</code>
        <span>official VT core · minimal browser canvas</span>
      </div>
      {inputLease.supported && (
        <div className={`rc-input-lease${inputLease.writable ? " is-writable" : " is-observer"}`} role="status">
          <span className="rc-input-lease__dot" aria-hidden="true" />
          <span className="rc-input-lease__copy">
            {inputLease.writable
              ? "You control input"
              : inputLease.owner
                ? `Viewing only · ${inputLease.owner} is typing`
                : "Viewing only · input is available"}
            {!inputLease.writable && inputLease.reason && <small>{inputLease.reason}</small>}
          </span>
          {inputLease.writable ? (
            <button type="button" onClick={() => socketRef.current?.requestInputLease?.("release")}>
              Release
            </button>
          ) : (
            <button
              type="button"
              disabled={!inputLease.canTakeover}
              aria-expanded={inputLease.owner ? confirmingTakeover : undefined}
              onClick={() => {
                if (inputLease.owner) setConfirmingTakeover(true);
                else socketRef.current?.requestInputLease?.("acquire");
              }}
            >
              {inputLease.owner ? "Take control" : "Control input"}
            </button>
          )}
        </div>
      )}
      {inputLease.supported && confirmingTakeover && inputLease.owner && (
        <InlineConfirm
          className="rc-input-lease__confirm"
          tone="caution"
          message={`${inputLease.owner} currently controls this terminal. Taking control interrupts their input.`}
          confirmLabel="Take control now"
          onCancel={() => setConfirmingTakeover(false)}
          onConfirm={() => {
            setConfirmingTakeover(false);
            socketRef.current?.requestInputLease?.("takeover", true);
          }}
        />
      )}
      <div className="rc-ghostty-stage" onPointerDown={() => terminalRef.current?.focus()}>
        <div ref={hostRef} className="rc-ghostty-host" />
        {(connectionState === "loading" || connectionState === "connecting") && !error && (
          <div className="rc-ghostty-overlay" role="status">
            {connectionState === "loading" ? "Loading Ghostty WASM…" : "Connecting terminal…"}
          </div>
        )}
        {connectionState === "reconnecting" && !error && (
          <div className="rc-ghostty-toast" role="status">
            Reconnecting…
            <button type="button" onClick={() => socketRef.current?.reconnect()}>
              Reconnect now
            </button>
          </div>
        )}
        {connectionState === "ended" && !error && (
          <div className="rc-ghostty-overlay" role="alertdialog" aria-label="Session ended">
            <strong>Terminal session ended</strong>
            <div className="rc-ghostty-actions">
              <button
                type="button"
                onClick={() => {
                  setConnectionState("loading");
                  setRestartKey((key) => key + 1);
                }}
              >
                Start fresh
              </button>
              {onClose && (
                <button type="button" onClick={onClose}>
                  Close
                </button>
              )}
            </div>
          </div>
        )}
        {error && (
          <div className="rc-ghostty-overlay rc-ghostty-error" role="alert">
            <strong>Ghostty could not start</strong>
            <span>{error.message}</span>
            <div className="rc-ghostty-actions">
              <button
                type="button"
                onClick={() => {
                  setError(undefined);
                  setRestartKey((key) => key + 1);
                }}
              >
                Retry Ghostty
              </button>
              <button type="button" onClick={useXtermAndReload}>
                Use xterm.js
              </button>
            </div>
          </div>
        )}
      </div>
      <style>{ghosttyCss}</style>
    </div>
  );
}

const ghosttyCss = `
.rc-terminal {
  display: flex; flex-direction: column; height: 100%; min-height: 0; background: var(--bg);
}
.rc-ghostty-banner {
  min-height: 28px; flex: none; padding: 4px 10px; display: flex; align-items: center; gap: 8px;
  border-bottom: 1px solid var(--border); color: var(--text-muted);
  background: color-mix(in srgb, var(--surface-2) 88%, var(--coral));
  font: 600 10px/1.2 var(--font-mono);
}
.rc-ghostty-banner code { color: var(--coral); }
.rc-ghostty-stage { position: relative; flex: 1 1 auto; min-height: 0; overflow: hidden; background: #000; }
.rc-ghostty-host { position: absolute; inset: 0; overflow: hidden; }
.rc-ghostty-canvas { position: absolute; inset: 0; display: block; }
.rc-ghostty-input {
  position: absolute; left: 0; bottom: 0; width: 1px; height: 1px; padding: 0; border: 0;
  opacity: .01; resize: none; overflow: hidden; color: transparent; background: transparent;
}
.rc-ghostty-input:focus { outline: none; }
.rc-ghostty-overlay {
  position: absolute; inset: 0; z-index: 3; display: grid; place-content: center; justify-items: center;
  gap: 12px; padding: 24px; text-align: center; color: var(--text-muted);
  background: color-mix(in srgb, var(--bg) 88%, transparent); font: 600 13px/1.45 var(--font-body);
}
.rc-ghostty-error span { max-width: 560px; color: var(--err); overflow-wrap: anywhere; }
.rc-ghostty-actions { display: flex; justify-content: center; gap: 8px; flex-wrap: wrap; }
.rc-ghostty-actions button, .rc-ghostty-toast button {
  min-height: 38px; padding: 0 13px; border-radius: 8px; border: 1px solid var(--border-strong);
  background: var(--surface-2); color: var(--text); font: 600 12px/1 var(--font-body); cursor: pointer;
}
.rc-ghostty-toast {
  position: absolute; z-index: 4; top: 10px; left: 50%; transform: translateX(-50%);
  display: flex; align-items: center; gap: 9px; padding: 7px 9px 7px 12px; border-radius: 10px;
  border: 1px solid var(--border); background: var(--surface-2); color: var(--text);
  font: 600 11px/1 var(--font-mono);
}
.rc-input-lease {
  flex: none; min-height: 30px; padding: 4px 9px 4px 12px; display: flex; align-items: center; gap: 8px;
  border-bottom: 1px solid var(--border); background: var(--surface-2); color: var(--text-muted);
  font: 600 11px/1.25 var(--font-mono);
}
.rc-input-lease__dot { width: 7px; height: 7px; flex: none; border-radius: 999px; background: var(--text-faint); }
.rc-input-lease.is-writable .rc-input-lease__dot { background: var(--success); }
.rc-input-lease__copy { min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rc-input-lease__copy small { margin-left: 8px; color: var(--warn); font: inherit; }
.rc-input-lease button {
  min-height: 24px; padding: 0 8px; border-radius: 6px; border: 1px solid var(--border);
  background: transparent; color: var(--text); font: inherit; cursor: pointer;
}
.rc-input-lease button:disabled { opacity: .45; cursor: default; }
.rc-input-lease__confirm { flex: none; border-width: 0 0 1px; border-radius: 0; }
@media (max-width: 540px) {
  .rc-ghostty-banner > :last-child { display: none; }
  .rc-input-lease__copy small { display: none; }
}
`;
