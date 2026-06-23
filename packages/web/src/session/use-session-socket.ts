import { useCallback, useEffect, useRef, useState } from "react";
import { createSessionSocket } from "../ws/session-socket";
import type { SessionSocket, SocketStatus } from "../ws/session-socket";
import { wsUrl } from "../api/client";
import { API_BASE_URL } from "../config";
import { useStore } from "../store/store";
import type { OutboundFrame, SessionMeta } from "../types/server";

export function useSessionSocket(
  session: SessionMeta,
  token: string | undefined,
): { send: (f: OutboundFrame) => void; status: SocketStatus } {
  const applyFrame = useStore((s) => s.applyFrame);
  const [status, setStatus] = useState<SocketStatus>("connecting");
  const socketRef = useRef<SessionSocket | undefined>(undefined);

  useEffect(() => {
    const url = wsUrl(API_BASE_URL, session.id, { token: token || undefined });
    const socket = createSessionSocket({
      url,
      onFrame: (frame) => applyFrame(session.id, frame),
      onStatus: setStatus,
      // Reconnect delta: resume after the last applied seq for THIS session.
      getSince: () => {
        const last = useStore.getState().views[session.id]?.lastSeq ?? 0;
        return last > 0 ? last : undefined;
      },
    });
    socketRef.current = socket;
    return () => {
      socket.close();
      socketRef.current = undefined;
    };
  }, [session.id, token, applyFrame]);

  // Stable `send` identity (reads the latest socket via the ref) so consumers' callbacks that close
  // over `send` — e.g. ChatView's `answer` and its auto-allow effect — don't churn every render.
  const send = useCallback((f: OutboundFrame) => socketRef.current?.send(f), []);

  return { send, status };
}
