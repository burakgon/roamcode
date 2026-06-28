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
  /** Gate the connection until the REST history has loaded, so the socket's `getSince` reads the
   * lastSeq (= the server's sinceSeq) ChatView just set — the first connect carries `?since=sinceSeq`
   * and the buffer isn't re-replayed over the already-rendered transcript. Defaults to true so any
   * other caller (and existing behaviour) connects immediately. */
  enabled = true,
  /** Called when the server signals a `resync` (the reconnect buffer rotated past our position): the
   *  caller should refetch the full REST history. Held in a ref so a changing identity never churns the
   *  socket effect. */
  onResync?: () => void,
): { send: (f: OutboundFrame) => void; status: SocketStatus } {
  const applyFrame = useStore((s) => s.applyFrame);
  const [status, setStatus] = useState<SocketStatus>("connecting");
  const socketRef = useRef<SessionSocket | undefined>(undefined);
  const onResyncRef = useRef(onResync);
  onResyncRef.current = onResync;

  useEffect(() => {
    if (!enabled) return;
    const url = wsUrl(API_BASE_URL, session.id, { token: token || undefined });
    const socket = createSessionSocket({
      url,
      onFrame: (frame) => applyFrame(session.id, frame),
      onStatus: setStatus,
      onResync: () => onResyncRef.current?.(),
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
  }, [session.id, token, applyFrame, enabled]);

  // Stable `send` identity (reads the latest socket via the ref) so consumers' callbacks that close
  // over `send` — e.g. ChatView's `answer` and its auto-allow effect — don't churn every render.
  const send = useCallback((f: OutboundFrame) => socketRef.current?.send(f), []);

  return { send, status };
}
