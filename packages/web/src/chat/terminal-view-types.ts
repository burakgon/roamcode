import type { ApiClientOptions } from "../api/client";
import type { SessionMeta } from "../types/server";
import type { createTerminalSocket } from "../ws/terminal-socket";

export interface TerminalViewProps {
  session: SessionMeta;
  onShowSessions?: () => void;
  needsYou?: number;
  /** Close/stop the session. In split-screen the App can wire this to close only the pane. */
  onClose?: () => void;
  onOpenSettings?: () => void;
  onSplitRight?: () => void;
  onSplitDown?: () => void;
  closeIsPane?: boolean;
  dragPaneId?: string;
  /** Current-origin connection. Host id is a stable scope for local UI state. */
  connection?: ApiClientOptions & { hostId: string };
  /** Injectable for tests and screenshot scenes; production uses the normal terminal socket. */
  createSocket?: typeof createTerminalSocket;
}
