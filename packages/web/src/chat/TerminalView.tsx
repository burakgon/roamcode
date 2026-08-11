import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  GhosttyCanvasTerminal,
  loadGhosttyRuntime,
  type GhosttyRuntime,
  type GhosttyTerminalTheme,
} from "@roamcode.ai/ghostty-web";
import { createTerminalSocket, type TerminalSocket } from "../ws/terminal-socket";
const DEFAULT_TERMINAL_CONNECTION: ApiClientOptions & { hostId: string } = {
  hostId: "current",
  baseUrl: API_BASE_URL,
  getToken: loadToken,
};
const ImageEditorModal = lazy(() => import("./ImageEditorModal"));
import {
  terminalWsTicketUrl,
  terminalFileContentRequest,
  terminalFileContentUrl,
  type ApiClientOptions,
  type RespawnMode,
} from "../api/client";
import { loadToken } from "../auth/token-store";
import { API_BASE_URL } from "../config";
import { loadTerminalDraft, saveTerminalDraft } from "../hosts/host-ui-state";
import { searchBuffer, type BufferMatch } from "./terminal-search";
import { openTerminalWebLink } from "./terminal-links";
import { TerminalKeyBar } from "./TerminalKeyBar";
import { TerminalFiles, type TermFile } from "./TerminalFiles";
import { isLikelyImage } from "./image-editor-model";
import { ImageEditorBoundary } from "./ImageEditorBoundary";
import { ChatHeader } from "./ChatHeader";
import { Icon } from "../ui/Icon";
import { loadTheme, TERMINAL_BG } from "../pwa/theme";
import { installTerminalTouchpad, type TerminalTouchpadButton, type TerminalTouchpadPoint } from "./terminal-touchpad";
import type { SessionMeta } from "../types/server";
import { providerDisplayName } from "../session/provider-display";
import type { TerminalViewProps } from "./terminal-view-types";

type TerminalCellPoint = { col: number; row: number };
type TerminalBoundary = TerminalCellPoint;
type TerminalModifiers = { ctrl: boolean; alt: boolean };
type MobileSelectionState = {
  start: TerminalBoundary;
  end: TerminalBoundary;
  text: string;
  menuAnchor: { x: number; y: number } | null;
  clipboardError: "copy" | "paste" | null;
};
type MobileSelectionDragBase = {
  pointerId: number;
  lastX: number;
  lastY: number;
  scrollDirection: -1 | 0 | 1;
};
type MobileSelectionDrag = MobileSelectionDragBase & {
  kind: "handle";
  fixed: TerminalBoundary;
  origin: "start" | "end";
  prefer: "start" | "end";
};
function terminalCellAtPoint(
  term: GhosttyCanvasTerminal,
  _host: HTMLElement,
  clientX: number,
  clientY: number,
): TerminalCellPoint | undefined {
  return term.cellAtPoint(clientX, clientY);
}

function boundaryIndex(point: TerminalBoundary, cols: number): number {
  return point.row * cols + point.col;
}

function boundaryFromIndex(index: number, cols: number): TerminalBoundary {
  return { col: index % cols, row: Math.floor(index / cols) };
}

function orderedBoundaries(
  a: TerminalBoundary,
  b: TerminalBoundary,
  cols: number,
): { start: TerminalBoundary; end: TerminalBoundary; length: number } {
  const ai = boundaryIndex(a, cols);
  const bi = boundaryIndex(b, cols);
  const start = Math.min(ai, bi);
  const end = Math.max(ai, bi);
  return { start: boundaryFromIndex(start, cols), end: boundaryFromIndex(end, cols), length: end - start };
}

function terminalCellEnd(term: GhosttyCanvasTerminal, point: TerminalCellPoint): TerminalBoundary {
  const width = Math.max(1, term.buffer.active.getLine(point.row)?.getCell(point.col)?.getWidth() ?? 1);
  return boundaryFromIndex(boundaryIndex(point, term.cols) + width, term.cols);
}

function mobileSelectionDragRange(
  term: GhosttyCanvasTerminal,
  drag: MobileSelectionDrag,
  cell: TerminalCellPoint,
): { start: TerminalBoundary; end: TerminalBoundary; length: number } | undefined {
  const maxBoundary = Math.max(1, Math.max(term.rows, term.buffer.active.length) * term.cols);
  const cellStart = Math.max(0, Math.min(boundaryIndex(cell, term.cols), maxBoundary));
  const cellEnd = Math.max(cellStart + 1, Math.min(boundaryIndex(terminalCellEnd(term, cell), term.cols), maxBoundary));

  const fixedIndex = Math.max(0, Math.min(boundaryIndex(drag.fixed, term.cols), maxBoundary));
  let movingIndex =
    cellEnd <= fixedIndex
      ? cellStart
      : cellStart >= fixedIndex
        ? cellEnd
        : drag.prefer === "start"
          ? cellStart
          : cellEnd;
  movingIndex = Math.max(0, Math.min(movingIndex, maxBoundary));
  if (movingIndex === fixedIndex) {
    movingIndex = Math.max(0, Math.min(maxBoundary, fixedIndex + (drag.prefer === "start" ? -1 : 1)));
  }
  if (movingIndex === fixedIndex) return undefined;
  return orderedBoundaries(drag.fixed, boundaryFromIndex(movingIndex, term.cols), term.cols);
}

const MOBILE_MENU_MAX_WIDTH = 304;

function mobileMenuPosition(clientX: number, clientY: number, menuHeight = 52): { x: number; y: number } {
  const margin = 8;
  const gap = 12;
  const viewport = window.visualViewport;
  const left = viewport?.offsetLeft ?? 0;
  const top = viewport?.offsetTop ?? 0;
  const width = viewport?.width ?? window.innerWidth;
  const height = viewport?.height ?? window.innerHeight;
  const menuWidth = Math.min(MOBILE_MENU_MAX_WIDTH, Math.max(1, width - margin * 2));
  const x = Math.max(left + margin, Math.min(clientX - menuWidth / 2, left + width - menuWidth - margin));
  const minY = top + margin;
  const maxY = Math.max(minY, top + height - menuHeight - margin);
  const above = clientY - menuHeight - gap;
  const preferredY = above >= minY ? above : clientY + gap;
  const y = Math.max(minY, Math.min(preferredY, maxY));
  return { x, y };
}

function boundaryPosition(
  term: GhosttyCanvasTerminal,
  stage: HTMLElement,
  point: TerminalBoundary,
  edge: "start" | "end",
): { left: number; top: number } | undefined {
  const boundary = term.selectionBoundaryAt(point, edge);
  if (!boundary) return undefined;
  const stageRect = stage.getBoundingClientRect();
  return {
    left: boundary.x - stageRect.left,
    top: boundary.y - stageRect.top,
  };
}

function selectionContainsCell(selection: MobileSelectionState, point: TerminalCellPoint, cols: number): boolean {
  const index = boundaryIndex(point, cols);
  return index >= boundaryIndex(selection.start, cols) && index < boundaryIndex(selection.end, cols);
}

type TerminalUploadResult = { path: string; file: Record<string, unknown> };
type TerminalUploadTask = { abort(): void; promise: Promise<TerminalUploadResult> };

function terminalUploadResult(value: unknown): TerminalUploadResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("bad upload response");
  const candidate = value as { path?: unknown; file?: unknown };
  if (
    typeof candidate.path !== "string" ||
    !candidate.file ||
    typeof candidate.file !== "object" ||
    Array.isArray(candidate.file)
  ) {
    throw new Error("bad upload response");
  }
  return { path: candidate.path, file: candidate.file as Record<string, unknown> };
}

/** Progress-aware terminal upload. The browser client uses native XHR byte progress; custom transports can inject
 *  a streaming implementation without changing terminal behavior. */
function uploadWithProgress(
  sessionId: string,
  file: File,
  onProgress: (fraction: number) => void,
  derivedFromId?: string,
  connection: ApiClientOptions = { baseUrl: API_BASE_URL, getToken: loadToken },
): TerminalUploadTask {
  const endpoint = derivedFromId
    ? `${connection.baseUrl}/sessions/${encodeURIComponent(sessionId)}/files/${encodeURIComponent(derivedFromId)}/derive`
    : `${connection.baseUrl}/sessions/${encodeURIComponent(sessionId)}/upload`;
  const form = new FormData();
  form.append("file", file, file.name);
  const token = connection.getToken();

  if (connection.uploadRequest) {
    let transfer: ReturnType<NonNullable<ApiClientOptions["uploadRequest"]>>;
    try {
      transfer = connection.uploadRequest(
        endpoint,
        {
          method: "POST",
          headers: token ? { authorization: `Bearer ${token}` } : undefined,
          body: form,
        },
        onProgress,
        file.size,
      );
    } catch (error: unknown) {
      return { abort() {}, promise: Promise.reject(error) };
    }
    return {
      abort: () => transfer.abort(),
      promise: transfer.promise.then(async (response) => {
        if (!response.ok) throw new Error(`upload failed (${response.status})`);
        let value: unknown;
        try {
          value = await response.json();
        } catch {
          throw new Error("bad upload response");
        }
        return terminalUploadResult(value);
      }),
    };
  }

  const xhr = new XMLHttpRequest();
  const promise = new Promise<TerminalUploadResult>((resolve, reject) => {
    xhr.open("POST", endpoint);
    if (token) xhr.setRequestHeader("authorization", `Bearer ${token}`);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(terminalUploadResult(JSON.parse(xhr.responseText) as unknown));
        } catch {
          reject(new Error("bad upload response"));
        }
      } else {
        reject(new Error(`upload failed (${xhr.status})`));
      }
    };
    xhr.onerror = () => reject(new Error("network error"));
    xhr.onabort = () => reject(new DOMException("Upload cancelled", "AbortError"));
    xhr.send(form);
  });
  return { abort: () => xhr.abort(), promise };
}

function normalizeTermFile(value: Record<string, unknown>): TermFile {
  const source = value.direction === "received" || value.source === "received" ? "received" : "sent";
  const kind = typeof value.kind === "string" ? (value.kind as TermFile["kind"]) : value.isImage ? "image" : "binary";
  return {
    id: String(value.id ?? value.path ?? "file"),
    name: String(value.name ?? "file"),
    path: String(value.path ?? ""),
    source,
    storage: value.storage === "workspace" ? "workspace" : "managed",
    mimeType: typeof value.mimeType === "string" ? value.mimeType : undefined,
    size: typeof value.size === "number" ? value.size : undefined,
    kind,
    isImage: value.isImage === true || kind === "image",
    caption: typeof value.caption === "string" ? value.caption : undefined,
    createdAt: typeof value.createdAt === "number" ? value.createdAt : undefined,
    updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : undefined,
    expiresAt: typeof value.expiresAt === "number" ? value.expiresAt : undefined,
    derivedFromId: typeof value.derivedFromId === "string" ? value.derivedFromId : undefined,
    available: value.available !== false,
  };
}

/** An "ended" this soon after the (re)spawn means the provider died straight away — on this host that often
 *  means the provider CLI is signed out — so the ended overlay adds an authentication hint. Purely
 *  client-side timing; no server signal exists for the exit reason. */
const QUICK_EXIT_MS = 10_000;
const MAX_PROVIDER_SESSION_ID = 2_048;
const FILE_HISTORY_TIMEOUT_MS = 2_000;
const FILE_HISTORY_RETRY_DELAYS_MS = [350, 1_000] as const;

/** A full dark theme so the terminal never falls back to default ANSI colors or a black viewport seam. */
const THEME = {
  background: "#0a0a0b",
  foreground: "#cdd6e4",
  cursor: "#cdd6e4",
  cursorAccent: "#0b0e14",
  // A clearly bounded slate field plus explicit white glyphs stays legible across every ANSI color.
  selectionBackground: "#50617a",
  selectionForeground: "#ffffff",
  // Keep a retained range visible if a browser moves focus to one of the clipboard actions.
  selectionInactiveBackground: "#25252b",
  black: "#11151c",
  red: "#e06c75",
  green: "#98c379",
  yellow: "#e5c07b",
  blue: "#61afef",
  magenta: "#c678dd",
  cyan: "#56b6c2",
  white: "#cdd6e4",
  brightBlack: "#5c6370",
  brightRed: "#e06c75",
  brightGreen: "#98c379",
  brightYellow: "#e5c07b",
  brightBlue: "#61afef",
  brightMagenta: "#c678dd",
  brightCyan: "#56b6c2",
  brightWhite: "#ffffff",
} as const;

function ghosttyTheme(): GhosttyTerminalTheme {
  return {
    background: TERMINAL_BG[loadTheme()],
    foreground: THEME.foreground,
    cursor: THEME.cursor,
    selectionBackground: THEME.selectionBackground,
    selectionForeground: THEME.selectionForeground,
    palette: [
      THEME.black,
      THEME.red,
      THEME.green,
      THEME.yellow,
      THEME.blue,
      THEME.magenta,
      THEME.cyan,
      THEME.white,
      THEME.brightBlack,
      THEME.brightRed,
      THEME.brightGreen,
      THEME.brightYellow,
      THEME.brightBlue,
      THEME.brightMagenta,
      THEME.brightCyan,
      THEME.brightWhite,
    ],
  };
}

/** Copy from the visible mobile selection action, where there is no keyboard-triggered copy event. Desktop
 *  selection deliberately stays on the browser's native synchronous ClipboardEvent path below. */
async function copyText(text: string): Promise<boolean> {
  if (!text) return false;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the legacy path */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.cssText = "position:fixed;top:0;left:0;opacity:0;pointer-events:none";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

/** Read the OS clipboard only in direct response to a visible Paste action. Browsers intentionally expose no
 *  safe legacy fallback for reads: if permission/support is unavailable, keep the menu open and report it. */
async function readClipboardText(): Promise<{ ok: true; text: string } | { ok: false }> {
  try {
    if (!navigator.clipboard?.readText) return { ok: false };
    return { ok: true, text: await navigator.clipboard.readText() };
  } catch {
    return { ok: false };
  }
}

/** Renders a provider terminal TUI: Ghostty's official WebAssembly terminal core bridged to the binary
 *  terminal WebSocket.
 *  `createSocket` is injectable purely so the screenshot harness / tests can feed controlled bytes;
 *  production always uses the default real socket. */
export function canResumeConversation(session: SessionMeta): boolean {
  if (session.launch?.kind === "shell" || (!session.provider && !session.agent)) return false;
  if (session.resumeIdentity === "unsupported") return false;
  const provider = session.agent?.provider ?? session.provider;
  const requiresExactIdentity = session.resumeIdentity === "required" || provider === "codex";
  if (!requiresExactIdentity) return true;
  const id = session.providerSessionId;
  return (
    session.identityState === "exact" &&
    typeof id === "string" &&
    id.trim().length > 0 &&
    id.length <= MAX_PROVIDER_SESSION_ID &&
    !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(id) &&
    !id.trimStart().startsWith("-")
  );
}

export function TerminalView(props: TerminalViewProps) {
  const [runtime, setRuntime] = useState<GhosttyRuntime>();
  const [runtimeError, setRuntimeError] = useState<Error>();
  const [runtimeAttempt, setRuntimeAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    setRuntimeError(undefined);
    void loadGhosttyRuntime()
      .then((loaded) => {
        if (active) setRuntime(loaded);
      })
      .catch((cause) => {
        if (active) setRuntimeError(cause instanceof Error ? cause : new Error(String(cause)));
      });
    return () => {
      active = false;
    };
  }, [runtimeAttempt]);

  if (runtime) return <GhosttyProductTerminalView {...props} runtime={runtime} />;
  return (
    <div className="rc-terminal rc-terminal--loading">
      <ChatHeader
        session={props.session}
        onShowSessions={props.onShowSessions}
        needsYou={props.needsYou}
        onClose={props.onClose}
        onOpenSettings={props.onOpenSettings}
        onSplitRight={props.onSplitRight}
        onSplitDown={props.onSplitDown}
        closeIsPane={props.closeIsPane}
        dragPaneId={props.dragPaneId}
      />
      <div className="rc-terminal-runtime" role={runtimeError ? "alert" : "status"}>
        {runtimeError ? (
          <>
            <strong>Ghostty could not start</strong>
            <span>{runtimeError.message}</span>
            <button type="button" onClick={() => setRuntimeAttempt((value) => value + 1)}>
              Retry Ghostty
            </button>
          </>
        ) : (
          "Loading Ghostty terminal…"
        )}
      </div>
      <style>{terminalRuntimeCss}</style>
    </div>
  );
}

export function GhosttyProductTerminalView({
  session,
  onShowSessions,
  sessionSwitcherOpen,
  onHideSessions,
  needsYou,
  onClose,
  onOpenSettings,
  onSplitRight,
  onSplitDown,
  closeIsPane,
  dragPaneId,
  connection: suppliedConnection,
  createSocket = createTerminalSocket,
  runtime,
}: TerminalViewProps & { runtime: GhosttyRuntime }) {
  const sessionId = session.id;
  const connection = suppliedConnection ?? DEFAULT_TERMINAL_CONNECTION;
  const requestTerminalFile = useCallback(
    (file: TermFile, disposition: "inline" | "attachment" = "inline", init?: RequestInit) =>
      terminalFileContentRequest(sessionId, file.id, disposition, init, connection),
    [connection, sessionId],
  );
  const providerId = session.agent?.provider ?? session.provider;
  const isShell = session.launch?.kind === "shell" || !providerId;
  const isCodex = providerId === "codex";
  const isClaude = providerId === "claude";
  const providerLabel = !providerId ? "Terminal" : isClaude ? "Claude Code" : providerDisplayName(providerId);
  const canResume = canResumeConversation(session);
  const resumeHint = isShell
    ? "Restart opens a new shell in the same directory."
    : canResume
      ? isCodex
        ? "Resume reopens this exact Codex conversation; start fresh begins a new one."
        : isClaude
          ? "Resume reopens the last Claude Code conversation in this folder; if there is none, start fresh."
          : `Resume asks ${providerLabel} to continue this adapter session; start fresh begins a new one.`
      : session.resumeIdentity === "unsupported"
        ? `${providerLabel} does not support resume. Start fresh to begin a new conversation.`
        : `The exact ${providerLabel} conversation identity is unavailable, so Resume cannot safely continue it. Start fresh to begin a new conversation.`;
  const hostRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const touchCursorRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<GhosttyCanvasTerminal | undefined>(undefined);
  const sockRef = useRef<TerminalSocket | undefined>(undefined);
  // A ref to the effect's `refit` closure so out-of-effect handlers (font zoom) can re-fit after changing the
  // font size, without re-running the whole terminal-setup effect.
  const refitRef = useRef<() => void>(() => {});
  // Ctrl is a persistent mobile-toolbar lock: the ref drives Ghostty's long-lived handlers while state drives
  // the highlight. Physical keyboards continue to provide their own native modifiers.
  const ctrlLockedRef = useRef(false);
  const [ctrlLocked, setCtrlLockedState] = useState(false);
  const setCtrlLocked = (v: boolean) => {
    ctrlLockedRef.current = v;
    termRef.current?.setModifierLocks({ ctrl: v, alt: false });
    setCtrlLockedState(v);
  };
  // Mobile selection stays in Ghostty's live selection model. Touchpad secondary-click or tap-drag creates the
  // range through the desktop mouse path; two persistent touch handles refine it afterwards.
  const [mobileSelection, setMobileSelection] = useState<MobileSelectionState | null>(null);
  const mobileSelectionRef = useRef<MobileSelectionState | null>(null);
  const commitMobileSelection = (next: MobileSelectionState | null) => {
    mobileSelectionRef.current = next;
    setMobileSelection(next);
  };
  const syncMobileSelectionRef = useRef<(menuAnchor?: { x: number; y: number } | null) => void>(() => {});
  const adoptMobileSelectionRef = useRef<(menuAnchor: { x: number; y: number }) => void>(() => {});
  const applyMobileHandleDragRef = useRef<(clientX: number, clientY: number) => void>(() => {});
  const finishMobileSelectionDragRef = useRef<(clientX: number, clientY: number, showMenu?: boolean) => void>(() => {});
  const mobileSelectionDragRef = useRef<MobileSelectionDrag | null>(null);
  const handleScrollTimerRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const guardPointerRef = useRef<{ pointerId: number; x: number; y: number } | null>(null);
  // Brief "Copied ✓" confirmation (native desktop Copy, or the mobile live-selection menu). setCopied + the ref
  // are stable, so the mount effect can safely capture flashCopied.
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const flashCopied = () => {
    setCopied(true);
    clearTimeout(copiedTimer.current);
    copiedTimer.current = setTimeout(() => setCopied(false), 1400);
  };
  useEffect(() => () => clearTimeout(copiedTimer.current), []);
  useEffect(() => {
    commitMobileSelection(null);
    return () => {
      if (handleScrollTimerRef.current !== undefined) clearInterval(handleScrollTimerRef.current);
      handleScrollTimerRef.current = undefined;
      mobileSelectionDragRef.current = null;
    };
  }, [sessionId]);
  // Compact chat/prompt composer: separate from clipboard-menu Paste, which reads and sends the clipboard directly.
  // It stays attached immediately above the mobile key bar and never auto-opens the software keyboard.
  const [chatInputOpen, setChatInputOpen] = useState(false);
  const chatInputRef = useRef<HTMLTextAreaElement>(null);
  const [composedText, setComposedText] = useState(() => loadTerminalDraft(connection.hostId, sessionId));
  useEffect(() => {
    setComposedText(loadTerminalDraft(connection.hostId, sessionId));
  }, [connection.hostId, sessionId]);
  // Connection lifecycle → drives the reconnect/ended overlay. `restartKey` bump remounts the effect (fresh
  // terminal + socket → reattach, which respawns the provider for an ended session).
  const [connState, setConnState] = useState<"connecting" | "open" | "reconnecting" | "ended">("connecting");
  const [restartKey, setRestartKey] = useState(0);
  // The ended overlay's chosen respawn mode for the NEXT (re)connect: "continue" resumes the provider's
  // exact conversation; undefined = fresh. A ref (not state) so the
  // socket's url THUNK reads the live value on every attempt without recreating the effect; cleared the
  // moment a connection OPENS so later transient reconnects plain re-attach instead of respawning again.
  const respawnRef = useRef<RespawnMode | undefined>(undefined);
  // When the (re)spawned session ENDED within QUICK_EXIT_MS of the terminal effect starting, the provider
  // died on boot (often: signed out on the host) — the ended overlay adds an authentication hint.
  const spawnedAtRef = useRef<number>(Date.now());
  const [quickExit, setQuickExit] = useState(false);
  // Files exchanged with the provider: received (send_image/send_file → control frames) + uploaded by the user.
  const [files, setFiles] = useState<TermFile[]>([]);
  const [filesOpen, setFilesOpen] = useState(false);
  const [filesPreserveExternalFocus, setFilesPreserveExternalFocus] = useState(false);
  const [fileHistoryStatus, setFileHistoryStatus] = useState<"loading" | "ready" | "error">("loading");
  const [uploadError, setUploadError] = useState<string | undefined>();
  const [maxUploadBytes, setMaxUploadBytes] = useState(25 * 1024 * 1024);
  const [unreadReceived, setUnreadReceived] = useState(0);
  const [fileDragging, setFileDragging] = useState(false);
  const [editBatch, setEditBatch] = useState<{ files: File[]; index: number }>();
  const uploadsRef = useRef(new Map<string, { abort: () => void }>());
  const uploadQueueRef = useRef<Array<() => void>>([]);
  const activeUploadsRef = useRef(0);
  const fileIdsRef = useRef(new Set<string>());
  const seenReceivedAtRef = useRef(0);
  const filesOpenRef = useRef(false);
  const fileHistoryRequestRef = useRef<AbortController | undefined>(undefined);
  const fileHistoryRetryTimerRef = useRef<number | undefined>(undefined);
  const fileHistoryRetryCountRef = useRef(0);
  const loadFileHistoryRef = useRef<(resetRetries?: boolean) => void>(() => {});
  filesOpenRef.current = filesOpen;
  const openFiles = (preserveTerminalKeyboard = false) => {
    setFilesPreserveExternalFocus(preserveTerminalKeyboard);
    setFilesOpen(true);
  };
  const closeFiles = () => {
    setFilesOpen(false);
    setFilesPreserveExternalFocus(false);
  };
  const [linkOpenError, setLinkOpenError] = useState(false);
  const loadFileHistory = useCallback(
    (resetRetries = true) => {
      if (resetRetries) {
        fileHistoryRetryCountRef.current = 0;
        clearTimeout(fileHistoryRetryTimerRef.current);
        fileHistoryRetryTimerRef.current = undefined;
      }
      const previous = fileHistoryRequestRef.current;
      fileHistoryRequestRef.current = undefined;
      previous?.abort();
      const controller = new AbortController();
      fileHistoryRequestRef.current = controller;
      let timedOut = false;
      setFileHistoryStatus("loading");
      const timeout = window.setTimeout(() => {
        if (fileHistoryRequestRef.current !== controller) return;
        timedOut = true;
        controller.abort();
      }, FILE_HISTORY_TIMEOUT_MS);
      const token = connection.getToken();
      void fetch(`${connection.baseUrl}/sessions/${encodeURIComponent(sessionId)}/files`, {
        headers: token ? { authorization: `Bearer ${token}` } : undefined,
        signal: controller.signal,
      })
        .then(async (response) => {
          if (!response.ok) {
            throw Object.assign(new Error(`files request failed (${response.status})`), { status: response.status });
          }
          return response.json() as Promise<{
            files?: Record<string, unknown>[];
            policy?: { maxUploadBytes?: number };
          }>;
        })
        .then((body) => {
          if (fileHistoryRequestRef.current !== controller) return;
          const restored = (body.files ?? []).map(normalizeTermFile);
          const unseen = restored.filter(
            (file) =>
              file.source === "received" &&
              !fileIdsRef.current.has(file.id) &&
              (file.createdAt ?? 0) > seenReceivedAtRef.current,
          ).length;
          for (const file of restored) fileIdsRef.current.add(file.id);
          setFiles((current) => {
            const local = current.filter((file) => file.uploading || file.error);
            const durable = restored.filter((file) => !local.some((item) => item.id === file.id));
            const controlsThatBeatTheRequest = current.filter(
              (file) => !local.includes(file) && !durable.some((item) => item.id === file.id),
            );
            return [...local, ...controlsThatBeatTheRequest, ...durable];
          });
          if (typeof body.policy?.maxUploadBytes === "number") setMaxUploadBytes(body.policy.maxUploadBytes);
          if (unseen > 0) setUnreadReceived((count) => count + unseen);
          fileHistoryRetryCountRef.current = 0;
          setFileHistoryStatus("ready");
        })
        .catch((error: unknown) => {
          if (fileHistoryRequestRef.current !== controller) return;
          if ((error as { name?: string }).name === "AbortError" && !timedOut) return;
          const status = (error as { status?: number }).status;
          const retryable =
            timedOut || status === undefined || status === 404 || status === 408 || status === 429 || status >= 500;
          const retryIndex = fileHistoryRetryCountRef.current;
          if (retryable && retryIndex < FILE_HISTORY_RETRY_DELAYS_MS.length) {
            fileHistoryRetryCountRef.current += 1;
            setFileHistoryStatus("loading");
            fileHistoryRetryTimerRef.current = window.setTimeout(() => {
              fileHistoryRetryTimerRef.current = undefined;
              loadFileHistoryRef.current(false);
            }, FILE_HISTORY_RETRY_DELAYS_MS[retryIndex]);
            return;
          }
          // File history is an auxiliary panel. Keep this failure local to that panel so the terminal/chat
          // remains visible, connected, and fully interactive.
          setFileHistoryStatus("error");
        })
        .finally(() => {
          window.clearTimeout(timeout);
          if (fileHistoryRequestRef.current === controller) fileHistoryRequestRef.current = undefined;
        });
    },
    [connection, sessionId],
  );
  loadFileHistoryRef.current = loadFileHistory;

  useEffect(() => {
    fileIdsRef.current.clear();
    setFiles([]);
    setUnreadReceived(0);
    try {
      seenReceivedAtRef.current = Number(window.localStorage.getItem(`rc-files-seen:${sessionId}`)) || 0;
    } catch {
      seenReceivedAtRef.current = 0;
    }
    loadFileHistory();
    return () => {
      const historyRequest = fileHistoryRequestRef.current;
      fileHistoryRequestRef.current = undefined;
      historyRequest?.abort();
      clearTimeout(fileHistoryRetryTimerRef.current);
      fileHistoryRetryTimerRef.current = undefined;
      fileHistoryRetryCountRef.current = 0;
      for (const upload of uploadsRef.current.values()) upload.abort();
      uploadsRef.current.clear();
      uploadQueueRef.current = [];
      activeUploadsRef.current = 0;
    };
  }, [sessionId, loadFileHistory]);
  const previousFileHistoryConnStateRef = useRef(connState);
  useEffect(() => {
    const previous = previousFileHistoryConnStateRef.current;
    previousFileHistoryConnStateRef.current = connState;
    // OTA/server restart can reject the one background HTTP request while the terminal socket is reconnecting.
    // A successful socket re-open is authoritative evidence that the server is back, so recover history too.
    if (connState === "open" && previous !== "open" && fileHistoryStatus === "error") loadFileHistory();
  }, [connState, fileHistoryStatus, loadFileHistory]);
  // "Jump to latest" chip: shown only when the terminal is scrolled UP in its normal-buffer scrollback.
  const [showJumpLatest, setShowJumpLatest] = useState(false);
  // Font zoom (persisted): clamped 10–20. A ref mirrors it so the setup effect reads the current size at mount
  // without depending on the state (which would needlessly recreate the terminal on every A−/A+).
  const [fontSize, setFontSizeState] = useState<number>(() => {
    try {
      const v = Number(window.localStorage?.getItem("rc-term-fontsize"));
      if (v >= 10 && v <= 20) return v;
    } catch {
      /* storage blocked */
    }
    return 13;
  });
  const fontSizeRef = useRef(fontSize);
  const setFontSize = (v: number) => {
    fontSizeRef.current = v;
    setFontSizeState(v);
  };
  // The terminal is a relative touchpad on touch devices. Teach that contract until the first real gesture,
  // capped at six opens so a person who dismisses it is never trapped in onboarding chrome.
  const [showTouchpadHint, setShowTouchpadHint] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const coarse = window.matchMedia?.("(pointer: coarse)")?.matches;
    let learned = false;
    let shows = 0;
    try {
      learned = window.localStorage?.getItem("rc-touchpad-hint-learned") === "1";
      shows = Number(window.localStorage?.getItem("rc-touchpad-hint-shows") ?? 0) || 0;
    } catch {
      /* storage blocked (private mode) — just show it */
    }
    if (!coarse || learned || shows >= 6) return;
    const show = window.setTimeout(() => setShowTouchpadHint(true), 700);
    const hide = window.setTimeout(() => setShowTouchpadHint(false), 7000);
    try {
      window.localStorage?.setItem("rc-touchpad-hint-shows", String(shows + 1));
    } catch {
      /* ignore */
    }
    return () => {
      window.clearTimeout(show);
      window.clearTimeout(hide);
    };
  }, []);
  // Restart from the ended overlay: `mode` "continue" asks the server to resume the exact conversation;
  // undefined respawns fresh (Start fresh). The key bump remounts the effect.
  const restart = (mode?: RespawnMode) => {
    respawnRef.current = mode;
    setConnState("connecting");
    setRestartKey((k) => k + 1);
  };

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    // A touch often produces a compatibility mousedown afterwards. Track the actual input stream instead of
    // classifying the whole device: Android tablets, styluses, and hybrid laptops can report a fine primary
    // pointer even while the current interaction came from a finger.
    let lastTouchAt = 0;
    const coarsePointer = typeof window !== "undefined" && !!window.matchMedia?.("(pointer: coarse)")?.matches;
    // Stamp the (re)spawn moment — an "ended" within QUICK_EXIT_MS of THIS reads as a boot-time death
    // (sign-out hint). Re-stamped on every restartKey remount, so each Restart gets a fresh window.
    spawnedAtRef.current = Date.now();
    const activateTerminalLink = (uri: string): void => {
      setLinkOpenError(!openTerminalWebLink(uri));
    };
    const term = new GhosttyCanvasTerminal(runtime, host, {
      fontSize: fontSizeRef.current, // persisted zoom (A−/A+), clamped 10–20
      fontFamily: '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
      theme: ghosttyTheme(),
      // Keep normal-buffer scrollback backed by a real overflow surface for desktop wheels, scrollbar state,
      // and Ghostty's programmatic viewport sync. Touch devices drive it through the virtual touchpad below.
      nativeScroll: true,
      // A genuine mouse press may still focus the terminal on hybrid devices. Finger/pen compatibility mouse
      // events may not: the dedicated keyboard button below is the sole software-keyboard affordance.
      focusOnPointer: (event) => {
        const source = (event as MouseEvent & { sourceCapabilities?: { firesTouchEvents?: boolean } | null })
          .sourceCapabilities;
        return source?.firesTouchEvents !== true && Date.now() - lastTouchAt >= 1_500;
      },
      onLink(uri) {
        activateTerminalLink(uri);
      },
      onCopy() {
        flashCopied();
      },
      onError() {
        setConnState("ended");
      },
    });
    termRef.current = term;
    // Live theme switch (Settings → OLED toggle) restyles the OPEN terminal without a remount.
    const onThemeChange = (): void => {
      term.options.theme = ghosttyTheme();
    };
    window.addEventListener("rc-theme-change", onThemeChange);
    // Stop mobile soft keyboards from mangling terminal input: no auto-capitalize/correct/complete/spellcheck
    // on Ghostty's hidden input textarea (otherwise "ls" → "Ls", flags/paths get autocorrected).
    const helper = host.querySelector<HTMLTextAreaElement>("textarea.rc-ghostty-input");
    if (helper) {
      helper.setAttribute("autocapitalize", "off");
      helper.setAttribute("autocorrect", "off");
      helper.setAttribute("autocomplete", "off");
      helper.setAttribute("spellcheck", "false");
    }
    const onTouchLikePointerDown = (event: PointerEvent) => {
      if (event.pointerType !== "touch" && event.pointerType !== "pen") return;
      lastTouchAt = Date.now();
      // A hidden textarea can remain focused after Android dismisses its keyboard. Blurring it on the next
      // terminal gesture prevents the browser from resurrecting the keyboard for an ordinary screen tap.
      if (helper && document.activeElement === helper) helper.blur();
    };
    host.addEventListener("pointerdown", onTouchLikePointerDown, true);

    let disposed = false;
    let connected = false;
    const activeLocks = (): TerminalModifiers => ({
      ctrl: ctrlLockedRef.current,
      alt: false,
    });
    term.setModifierLocks(activeLocks());

    // Some mobile keyboards send a concrete Backspace keydown but no native repeats; others (notably
    // Gboard) send only keyCode=229 + beforeinput changes. Own the concrete path so one held key has a
    // deterministic cadence, and leave a one-event fallback token for the composition path.
    let backspaceDelay: ReturnType<typeof setTimeout> | undefined;
    let backspaceInterval: ReturnType<typeof setInterval> | undefined;
    let suppressDeleteBeforeInput = false;
    let suppressDeleteTimer: ReturnType<typeof setTimeout> | undefined;
    let deleteSentinelTimer: ReturnType<typeof setTimeout> | undefined;
    const deleteSentinel = "\u200b";
    type PendingDelete = { timer: ReturnType<typeof setTimeout>; modifiers: TerminalModifiers };
    const pendingDeletes: PendingDelete[] = [];
    const clearPendingDeletes = () => {
      for (const pending of pendingDeletes.splice(0)) clearTimeout(pending.timer);
    };
    const stopBackspaceRepeat = () => {
      if (backspaceDelay !== undefined) clearTimeout(backspaceDelay);
      if (backspaceInterval !== undefined) clearInterval(backspaceInterval);
      backspaceDelay = undefined;
      backspaceInterval = undefined;
    };
    const clearDeleteSentinel = () => {
      if (deleteSentinelTimer !== undefined) clearTimeout(deleteSentinelTimer);
      deleteSentinelTimer = undefined;
      if (helper?.value === deleteSentinel) helper.value = "";
    };
    const armDeleteSentinel = () => {
      if (!helper || (helper.value !== "" && helper.value !== deleteSentinel)) return false;
      helper.value = deleteSentinel;
      try {
        helper.setSelectionRange(deleteSentinel.length, deleteSentinel.length);
      } catch {
        /* an unfocused mobile helper may reject selection changes; the sentinel still works */
      }
      if (deleteSentinelTimer !== undefined) clearTimeout(deleteSentinelTimer);
      // Keep the helper non-empty through the phone keyboard's initial hold delay. Every native repeated
      // beforeinput refreshes this window; a normal tap leaves no residue before the user's next action.
      deleteSentinelTimer = setTimeout(clearDeleteSentinel, 700);
      return true;
    };
    const markConcreteDelete = () => {
      suppressDeleteBeforeInput = true;
      if (suppressDeleteTimer !== undefined) clearTimeout(suppressDeleteTimer);
      // beforeinput is a default action after keydown and may arrive after the microtask checkpoint on Android.
      // Keep the dedupe token briefly instead of clearing it in a microtask.
      suppressDeleteTimer = setTimeout(() => {
        suppressDeleteBeforeInput = false;
        suppressDeleteTimer = undefined;
      }, 120);
    };
    const consumeConcreteDelete = () => {
      if (!suppressDeleteBeforeInput) return false;
      suppressDeleteBeforeInput = false;
      if (suppressDeleteTimer !== undefined) clearTimeout(suppressDeleteTimer);
      suppressDeleteTimer = undefined;
      return true;
    };
    const startBackspaceRepeat = (sequence: string) => {
      stopBackspaceRepeat();
      sockRef.current?.sendInput(sequence);
      backspaceDelay = setTimeout(() => {
        backspaceInterval = setInterval(() => sockRef.current?.sendInput(sequence), 70);
      }, 380);
    };
    const onBeforeInput = (event: InputEvent) => {
      if (event.inputType !== "deleteContentBackward") return;
      // Composition candidate edits are mirrored by Ghostty's composition delta. Owning the same deletion
      // here would erase twice, especially in Safari's compositionupdate-before-beforeinput ordering.
      if (event.isComposing) return;
      if (armDeleteSentinel()) {
        // An empty helper makes iOS/Android stop delivering native hold repeats after one deletion. Keep a
        // disposable sentinel in it and cancel the DOM edit, then let every OS-generated beforeinput own one
        // terminal delete. If keydown already sent the first delete, this event only switches authority from
        // RoamCode's fallback timer to the phone keyboard's real press duration/cadence.
        event.preventDefault();
        stopBackspaceRepeat();
        if (!consumeConcreteDelete()) {
          term.sendKey("Backspace", activeLocks());
        }
        return;
      }
      if (consumeConcreteDelete()) {
        // The concrete keydown was already emitted by our repeat controller. Keep Ghostty's helper value from
        // drifting, but never manufacture a second delete for the same physical event.
        event.preventDefault();
        return;
      }
      const pending: PendingDelete = {
        modifiers: activeLocks(),
        timer: setTimeout(() => {
          const index = pendingDeletes.indexOf(pending);
          if (index < 0) return;
          pendingDeletes.splice(index, 1);
          term.sendKey("Backspace", pending.modifiers);
        }, 0),
      };
      pendingDeletes.push(pending);
    };
    // Capture runs before Ghostty's own textarea listener. Prevented deletes stay wrapper-owned and Ghostty
    // observes defaultPrevented, eliminating a second DEL from the same native event.
    helper?.addEventListener("beforeinput", onBeforeInput, true);
    const stopMobileDelete = () => {
      stopBackspaceRepeat();
      clearDeleteSentinel();
    };
    helper?.addEventListener("blur", stopMobileDelete);
    window.addEventListener("blur", stopMobileDelete);
    const stopRepeatWhenHidden = () => document.hidden && stopMobileDelete();
    document.addEventListener("visibilitychange", stopRepeatWhenHidden);

    // Locked Ctrl/Alt use the same encoder for printable and special keys. Concrete mobile Backspace is also
    // normalized here so holding it works independently of the phone keyboard's native repeat behavior.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type === "keyup" && e.key === "Backspace" && coarsePointer) {
        e.preventDefault();
        stopBackspaceRepeat();
        return false;
      }
      if (e.type !== "keydown") return true;
      // Android IMEs commonly report a real Backspace as keyCode 229 / isComposing even though `key` still
      // identifies it precisely. Own that known control key before the generic IME escape hatch; otherwise
      // the composition helper emits one DEL but RoamCode never starts its hold-repeat controller.
      if (coarsePointer && e.key === "Backspace") {
        e.preventDefault();
        e.stopPropagation();
        markConcreteDelete();
        // Usually the first keydown has repeat=false. If an IME hides that first event and only exposes a
        // later repeated Backspace, adopt that event too as long as no RoamCode repeat is already active.
        if (!e.repeat || (backspaceDelay === undefined && backspaceInterval === undefined)) {
          const sequence = term.keySequence("Backspace", activeLocks());
          if (sequence) startBackspaceRepeat(sequence);
        }
        return false;
      }
      if (e.isComposing || e.keyCode === 229) return true; // Other IME composition — never intercept
      if (e.key === "Escape" && mobileSelectionRef.current) {
        mobileSelectionRef.current = null;
        setMobileSelection(null);
        term.clearSelection();
        return false;
      }
      // Standard terminal copy contract: Cmd/Ctrl+C copies only when Ghostty has a selection. With no
      // selection, let Ghostty/provider receive Ctrl+C as interrupt. Returning false skips terminal encoding
      // without canceling the browser default, so its trusted native `copy` event writes the selection.
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "c" && term.hasSelection()) {
        return false;
      }
      term.setModifierLocks(activeLocks());
      return true;
    });

    const refit = () => {
      if (disposed || host.clientHeight === 0) return;
      try {
        term.fit();
      } catch {
        return;
      }
      sockRef.current?.sendResize(term.cols, term.rows);
      if (mobileSelectionRef.current) syncMobileSelectionRef.current();
    };
    refitRef.current = refit; // let the font-zoom handlers re-fit without re-running this effect

    // "Jump to latest" chip visibility: only when the NORMAL buffer (long output / logs / raw shell — not the provider's
    // alt-screen TUI) is scrolled up off the bottom. onScroll covers user scroll + autoscroll-on-output;
    // onBufferChange covers entering/leaving the alt-screen (where scrollback doesn't apply).
    const updateJumpChip = () => {
      if (disposed) return;
      const b = term.buffer.active;
      setShowJumpLatest(b.type === "normal" && b.viewportY < b.baseY);
    };
    const offScroll = term.onScroll?.(() => {
      updateJumpChip();
      if (mobileSelectionRef.current) syncMobileSelectionRef.current();
    });
    const offBufferChange = term.buffer?.onBufferChange?.(() => {
      updateJumpChip();
      if (mobileSelectionRef.current) {
        mobileSelectionRef.current = null;
        setMobileSelection(null);
        term.clearSelection();
      }
    });
    const offSelectionChange = term.onSelectionChange(() => {
      if (mobileSelectionRef.current) syncMobileSelectionRef.current();
    });
    // FIT FIRST, THEN connect with the fitted size in the URL, so the pty/tmux is BORN at the real viewport
    // (no spawn-at-80×24-then-reflow jump). Only connect once the host has a real size.
    const fitThenConnect = () => {
      if (connected || disposed || host.clientHeight === 0) return;
      try {
        term.fit();
      } catch {
        return;
      }
      connected = true;
      const sock = (connection.terminalSocketFactory ?? createSocket)({
        sessionId,
        cols: term.cols,
        rows: term.rows,
        respawn: respawnRef.current,
        // An ASYNC THUNK, not a fixed string, so every reconnect fetches a fresh single-use WS TICKET (the
        // long-lived token stays out of WS URLs; terminalWsTicketUrl falls back to ?token= on any failure)
        // and re-reads the current fitted size. The respawn mode rides the same thunk: set only when the
        // ended overlay chose "Resume conversation" (respawn=continue).
        url: () => terminalWsTicketUrl(sessionId, term.cols, term.rows, respawnRef.current, connection),
        onData: (bytes) => {
          if (!disposed) term.write(bytes);
        },
        onStatus: (s) => {
          if (disposed) return;
          if (s === "open") {
            setConnState("open");
            term.options.disableStdin = false;
            // The respawn choice applied to THE spawn this open confirms — clear it so a later transient
            // reconnect re-attaches plainly instead of asking the server to respawn with --continue again.
            respawnRef.current = undefined;
            // Clear any stale frame from a prior connection; tmux sends a full redraw on (re)attach, so the
            // screen repaints cleanly instead of overlaying the old one.
            mobileSelectionRef.current = null;
            setMobileSelection(null);
            term.reset();
            refit();
          } else if (s === "reconnecting") {
            setConnState("reconnecting");
            term.options.disableStdin = true;
          } else if (s === "ended") {
            // Died within the boot window → surface the sign-out hint on the overlay (see QUICK_EXIT_MS).
            setQuickExit(Date.now() - spawnedAtRef.current < QUICK_EXIT_MS);
            setConnState("ended");
          }
        },
        onControl: (json) => {
          if (disposed) return;
          try {
            const msg = JSON.parse(json) as {
              t?: string;
              op?: string;
              id?: string;
              name?: string;
              path?: string;
              isImage?: boolean;
              caption?: string;
              file?: Record<string, unknown>;
              direction?: string;
              storage?: string;
              mimeType?: string;
              size?: number;
              kind?: string;
              createdAt?: number;
              updatedAt?: number;
              expiresAt?: number;
              available?: boolean;
            };
            if (msg.t === "attach" && typeof msg.path === "string") {
              const item = normalizeTermFile({ ...msg, direction: "received" });
              const isNew = !fileIdsRef.current.has(item.id);
              fileIdsRef.current.add(item.id);
              setFiles((prev) => (prev.some((f) => f.id === item.id) ? prev : [item, ...prev]));
              if (isNew && (item.createdAt === undefined || item.createdAt > seenReceivedAtRef.current)) {
                setUnreadReceived((count) => count + 1);
                if (!filesOpenRef.current) setUploadError(`Received ${item.name}`);
              }
            } else if (msg.t === "file" && msg.file) {
              const item = normalizeTermFile(msg.file);
              fileIdsRef.current.add(item.id);
              if (msg.op === "added" || msg.op === "updated") {
                setFiles((prev) => [item, ...prev.filter((file) => file.id !== item.id)]);
              }
            } else if (msg.t === "file" && typeof msg.id === "string" && ["hidden", "removed"].includes(msg.op ?? "")) {
              setFiles((prev) => prev.filter((file) => file.id !== msg.id));
            }
          } catch {
            /* ignore a malformed control frame */
          }
        },
      });
      sockRef.current = sock;
    };
    const tick = () => (connected ? refit() : fitThenConnect());

    const offData = term.onData((d) => {
      const isBackspace = d === "\x7f" || d === "\x08" || d === term.keySequence("Backspace", activeLocks());
      // A concrete composing Backspace may arrive first as keyCode 229, then again as a composition delta.
      // The direct key path already reached the socket; consume its mirrored duplicate.
      if (isBackspace && consumeConcreteDelete()) return;
      // If Gboard/Ghostty produced the delete associated with a pending beforeinput token, consume its fallback
      // timer and use this authoritative event. Otherwise the timer emits one DEL after the event turn.
      if (isBackspace && pendingDeletes.length > 0) {
        const pending = pendingDeletes.shift()!;
        clearTimeout(pending.timer);
      }
      sockRef.current?.sendInput(d);
    });

    // two rAFs (layout settled) → fit+connect; fonts.ready re-fits once the webfont swaps in; RO handles
    // rotation / on-screen keyboard / split-view resizes (and connects if the host wasn't sized yet).
    const raf = requestAnimationFrame(() => requestAnimationFrame(tick));
    document.fonts?.ready?.then(tick).catch(() => undefined);
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => tick()) : undefined;
    ro?.observe(host);
    // Fallback: a host that mounts hidden (display:none tab / collapsed) has clientHeight 0 and the rAF
    // bails; ResizeObserver doesn't fire for display:none→visible in some browsers. Poll until connected.
    const poll = setInterval(() => {
      if (disposed || connected) {
        clearInterval(poll);
        return;
      }
      tick();
    }, 500);
    // On TOUCH devices, do NOT auto-focus the terminal on mount/foreground. Focusing raises the on-screen
    // keyboard right as the session-select layout swap happens, and THAT coincidence is what freezes iOS's
    // compositor on the stale (list) frame — "klavye çıkıyor ama ekran değişmiyor". It recurs worst post-OTA
    // (hardRefresh clears caches → the font re-downloads → the first terminal paint is slow → the freeze
    // settles LATE and the repaint-heal burst misses it). Removing the auto-focus removes the trigger: the
    // the user opens it deliberately from the toolbar after the terminal has settled. Desktop has no soft
    // keyboard, so it keeps auto-focus for immediate typing.
    const focusTerminal = () => {
      if (!coarsePointer) term.focus();
    };
    // Re-fit + refocus (and connect if we hadn't yet) when the tab/app returns to the foreground.
    const onVisible = () => {
      if (!document.hidden && !disposed) {
        tick();
        focusTerminal();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    // Back online (e.g. phone woke / Wi-Fi↔cellular) → reconnect immediately instead of waiting out the
    // (up to 15s) backoff. reconnect() resets the backoff and rebuilds the URL with a fresh token.
    const onOnline = () => {
      if (!disposed) sockRef.current?.reconnect();
    };
    window.addEventListener("online", onOnline);
    focusTerminal();

    const updateTouchCursor = (point: TerminalTouchpadPoint, buttons: number): void => {
      const cursor = touchCursorRef.current;
      const stage = stageRef.current;
      if (!cursor || !stage) return;
      const rect = stage.getBoundingClientRect();
      cursor.style.transform = `translate3d(${point.x - rect.left}px, ${point.y - rect.top}px, 0)`;
      cursor.dataset.pressed = buttons === 0 ? "false" : "true";
    };
    const dispatchTouchpadMouse = (
      type: "mousedown" | "mousemove" | "mouseup",
      point: TerminalTouchpadPoint,
      buttons: number,
      button: TerminalTouchpadButton = "left",
      detail = 0,
    ): void => {
      const canvas = host.querySelector<HTMLElement>(".rc-ghostty-canvas");
      if (!canvas) return;
      const buttonNumber = button === "left" ? 0 : button === "middle" ? 1 : 2;
      canvas.dispatchEvent(
        new MouseEvent(type, {
          bubbles: true,
          cancelable: true,
          clientX: point.x,
          clientY: point.y,
          button: buttonNumber,
          buttons,
          detail,
        }),
      );
    };
    const dispatchTouchpadWheel = (up: boolean, count: number, point: TerminalTouchpadPoint): void => {
      if (term.buffer.active.type === "normal") {
        term.scrollLines((up ? -1 : 1) * count * 3);
        return;
      }
      if (term.modes.mouseTrackingMode !== "none") {
        term.sendMouseWheel(up, count, point.x, point.y);
        return;
      }
      const canvas = host.querySelector<HTMLElement>(".rc-ghostty-canvas");
      if (!canvas) return;
      for (let index = 0; index < count; index++) {
        canvas.dispatchEvent(
          new WheelEvent("wheel", {
            bubbles: true,
            cancelable: true,
            clientX: point.x,
            clientY: point.y,
            deltaY: up ? -1 : 1,
          }),
        );
      }
    };
    let touchpadLearned = false;
    const markTouchpadLearned = () => {
      if (touchpadLearned) return;
      touchpadLearned = true;
      setShowTouchpadHint(false);
      try {
        window.localStorage?.setItem("rc-touchpad-hint-learned", "1");
      } catch {
        /* storage blocked */
      }
    };
    const disposeTouchpad = installTerminalTouchpad(host, {
      // The scrollback canvas is repositioned within its overflow surface as output arrives. The host viewport
      // is the stable, full touchpad boundary; the canvas rect is only a zero-layout fallback for tests/mount.
      bounds: () => {
        const rect = host.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 ? rect : term.screenRect();
      },
      onTouchStart: () => {
        lastTouchAt = Date.now();
        if (helper && document.activeElement === helper) helper.blur();
      },
      onMove: (point, buttons, dispatch) => {
        updateTouchCursor(point, buttons);
        if (dispatch) dispatchTouchpadMouse("mousemove", point, buttons);
      },
      onButton: (button, pressed, point, buttons, detail) => {
        updateTouchCursor(point, buttons);
        dispatchTouchpadMouse(pressed ? "mousedown" : "mouseup", point, buttons, button, detail);
        if (!disposed && ((button === "right" && pressed) || (button === "left" && !pressed))) {
          adoptMobileSelectionRef.current({ x: point.x, y: point.y });
        }
      },
      onScroll: dispatchTouchpadWheel,
      onGesture: markTouchpadLearned,
    });
    const onTouchContextMenu = (event: MouseEvent) => {
      if (Date.now() - lastTouchAt >= 1_500) return;
      event.preventDefault();
      event.stopPropagation();
    };
    host.addEventListener("contextmenu", onTouchContextMenu);

    return () => {
      disposed = true;
      disposeTouchpad();
      cancelAnimationFrame(raf);
      clearInterval(poll);
      stopBackspaceRepeat();
      clearDeleteSentinel();
      if (suppressDeleteTimer !== undefined) clearTimeout(suppressDeleteTimer);
      clearPendingDeletes();
      helper?.removeEventListener("beforeinput", onBeforeInput, true);
      helper?.removeEventListener("blur", stopMobileDelete);
      window.removeEventListener("blur", stopMobileDelete);
      document.removeEventListener("visibilitychange", stopRepeatWhenHidden);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("rc-theme-change", onThemeChange);
      host.removeEventListener("pointerdown", onTouchLikePointerDown, true);
      host.removeEventListener("contextmenu", onTouchContextMenu);
      ro?.disconnect();
      offData.dispose();
      offScroll?.dispose();
      offBufferChange?.dispose();
      offSelectionChange.dispose();
      sockRef.current?.close();
      term.dispose();
      sockRef.current = undefined;
      termRef.current = undefined;
    };
  }, [sessionId, createSocket, restartKey, connection, runtime]);

  // Ordinary bar keys never request focus, so a closed software keyboard stays closed.
  const onBarKey = (label: string) => {
    const term = termRef.current;
    if (!term) return;
    term.sendKey(label, { ctrl: ctrlLockedRef.current, alt: false });
  };
  // Font zoom: bump term.options.fontSize (clamped 10–20), persist it, then re-fit so the pty/tmux grid follows.
  const changeFont = (delta: number) => {
    const term = termRef.current;
    if (!term) return;
    const cur = term.options.fontSize ?? fontSizeRef.current;
    const next = Math.min(20, Math.max(10, cur + delta));
    if (next === cur) return;
    term.options.fontSize = next;
    setFontSize(next);
    try {
      window.localStorage?.setItem("rc-term-fontsize", String(next));
    } catch {
      /* storage blocked */
    }
    refitRef.current();
  };
  // Keyboard-dismiss: iOS has no keyboard-hide key, so blur the terminal to reclaim reading space.
  const dismissKeyboard = () => {
    termRef.current?.blur();
    (document.activeElement as HTMLElement | null)?.blur?.();
  };
  const closeChatInput = () => {
    chatInputRef.current?.blur();
    setChatInputOpen(false);
  };
  const toggleChatInput = () => {
    if (chatInputOpen) {
      closeChatInput();
      return;
    }
    dismissKeyboard();
    setChatInputOpen(true);
  };
  const showKeyboard = () => {
    if (chatInputOpen) chatInputRef.current?.focus({ preventScroll: true });
    else termRef.current?.focus();
  };
  // The ACTIVE buffer (scrollback + visible) as plain lines for the find bar. translateToString(true) trims
  // only TRAILING blanks, so match columns still line up with the grid (a leading-trim would shift every col
  // the find bar hands to term.select).
  const bufferLines = (): string[] => {
    const term = termRef.current;
    if (!term) return [];
    const buf = term.buffer.active;
    const lines: string[] = [];
    for (let i = 0; i < buf.length; i++) lines.push(buf.getLine(i)?.translateToString(true) ?? "");
    return lines;
  };
  // ---- Find bar (buffer search — chat/terminal-search.ts).
  // Matches live in state; navigation selects the hit via Ghostty's own selection (visible highlight for
  // free) and scrolls its row into view. The buffer is finite (scrollback 1000), so a full re-scan per
  // keystroke is cheap.
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchMatches, setSearchMatches] = useState<BufferMatch[]>([]);
  const [searchIdx, setSearchIdx] = useState(0);
  // Select + reveal one match. Ghostty paints the standard selection rectangle — no custom
  // decoration layer needed — and scrollToLine brings the row into the viewport first.
  const showMatch = (list: BufferMatch[], idx: number) => {
    const term = termRef.current;
    const m = list[idx];
    if (!term || !m) return;
    term.scrollToLine(m.row);
    term.select(m.col, m.row, m.length);
  };
  const runSearch = (q: string) => {
    setSearchQuery(q);
    const found = searchBuffer(bufferLines(), q);
    setSearchMatches(found);
    setSearchIdx(0);
    if (found.length > 0) showMatch(found, 0);
    else termRef.current?.clearSelection();
  };
  // Prev/next with wrap-around. Enter = next, Shift+Enter = prev (the input's onKeyDown drives this).
  const stepMatch = (dir: 1 | -1) => {
    if (searchMatches.length === 0) return;
    const next = (searchIdx + dir + searchMatches.length) % searchMatches.length;
    setSearchIdx(next);
    showMatch(searchMatches, next);
  };
  const closeSearch = () => {
    setSearchOpen(false);
    setSearchMatches([]);
    setSearchIdx(0);
    termRef.current?.clearSelection();
    // Refocus the terminal ONLY where hover exists (a real desktop): on touch a programmatic focus would
    // pop the iOS keyboard right as the bar collapses (the exact annoyance the key bar dodges).
    if (window.matchMedia?.("(hover: hover)")?.matches) termRef.current?.focus();
  };
  const toggleSearch = () => {
    if (searchOpen) closeSearch();
    // Re-run the kept query against the CURRENT buffer on reopen (output kept flowing while closed).
    else {
      setSearchOpen(true);
      if (searchQuery) runSearch(searchQuery);
    }
  };

  const exitMobileSelection = (clearTerminal = true) => {
    if (handleScrollTimerRef.current !== undefined) clearInterval(handleScrollTimerRef.current);
    handleScrollTimerRef.current = undefined;
    mobileSelectionDragRef.current = null;
    commitMobileSelection(null);
    if (clearTerminal) termRef.current?.clearSelection();
  };

  // Read Ghostty's authoritative selection after every programmatic select, viewport scroll, or external clear.
  // The range stays in buffer coordinates; handle pixels are derived at render time from the live screen rect.
  syncMobileSelectionRef.current = (menuAnchor) => {
    const term = termRef.current;
    const current = mobileSelectionRef.current;
    if (!term || !current) return;
    const range = term.getSelectionPosition();
    if (!range) {
      commitMobileSelection(null);
      return;
    }
    const start = { col: range.start.x, row: range.start.y };
    const end = { col: range.end.x, row: range.end.y };
    if (boundaryIndex(start, term.cols) >= boundaryIndex(end, term.cols)) {
      commitMobileSelection(null);
      return;
    }
    commitMobileSelection({
      start,
      end,
      text: term.getSelection(),
      menuAnchor: menuAnchor === undefined ? current.menuAnchor : menuAnchor,
      clipboardError: null,
    });
  };

  // A virtual desktop drag/double-click/right-click uses Ghostty's ordinary mouse-selection path. If that path
  // produced a range, adopt it into the compact clipboard controls without changing the mouse semantics.
  adoptMobileSelectionRef.current = (menuAnchor) => {
    const term = termRef.current;
    if (!term) return;
    const range = term.getSelectionPosition();
    if (!range) return;
    const next: MobileSelectionState = {
      start: { col: range.start.x, row: range.start.y },
      end: { col: range.end.x, row: range.end.y },
      text: term.getSelection(),
      menuAnchor,
      clipboardError: null,
    };
    if (boundaryIndex(next.start, term.cols) >= boundaryIndex(next.end, term.cols)) return;
    commitMobileSelection(next);
    setSearchOpen(false);
    setSearchMatches([]);
  };

  const stopHandleScroll = () => {
    if (handleScrollTimerRef.current !== undefined) clearInterval(handleScrollTimerRef.current);
    handleScrollTimerRef.current = undefined;
    if (mobileSelectionDragRef.current) mobileSelectionDragRef.current.scrollDirection = 0;
  };

  applyMobileHandleDragRef.current = (clientX, clientY) => {
    const term = termRef.current;
    const host = hostRef.current;
    const drag = mobileSelectionDragRef.current;
    if (!term || !host || !drag) return;
    drag.lastX = clientX;
    drag.lastY = clientY;
    const rect = term.screenRect();
    const x = Math.max(rect.left, Math.min(clientX, rect.right - 0.5));
    const y = Math.max(rect.top, Math.min(clientY, rect.bottom - 0.5));
    const cell = terminalCellAtPoint(term, host, x, y);
    if (!cell) return;
    const range = mobileSelectionDragRange(term, drag, cell);
    if (!range) return;
    if (drag.kind === "handle") {
      drag.prefer = boundaryIndex(range.start, term.cols) === boundaryIndex(drag.fixed, term.cols) ? "end" : "start";
    }
    term.select(range.start.col, range.start.row, range.length);
    syncMobileSelectionRef.current(null);

    const edge = 28;
    const direction: -1 | 0 | 1 =
      term.buffer.active.type !== "normal" ? 0 : clientY < rect.top + edge ? -1 : clientY > rect.bottom - edge ? 1 : 0;
    if (direction === drag.scrollDirection) return;
    stopHandleScroll();
    drag.scrollDirection = direction;
    if (direction !== 0) {
      handleScrollTimerRef.current = setInterval(() => {
        const active = mobileSelectionDragRef.current;
        if (!active) return stopHandleScroll();
        term.scrollLines(direction);
        applyMobileHandleDragRef.current(active.lastX, active.lastY);
      }, 70);
    }
  };

  finishMobileSelectionDragRef.current = (clientX, clientY, showMenu = true) => {
    stopHandleScroll();
    mobileSelectionDragRef.current = null;
    syncMobileSelectionRef.current(showMenu ? { x: clientX, y: clientY } : null);
  };

  const beginHandleDrag = (edge: "start" | "end", event: ReactPointerEvent<HTMLButtonElement>) => {
    const selection = mobileSelectionRef.current;
    if (!selection) return;
    event.preventDefault();
    event.stopPropagation();
    try {
      event.currentTarget.setPointerCapture?.(event.pointerId);
    } catch {
      /* pointer capture is best effort on iOS */
    }
    mobileSelectionDragRef.current = {
      kind: "handle",
      pointerId: event.pointerId,
      fixed: edge === "start" ? selection.end : selection.start,
      origin: edge,
      prefer: edge,
      lastX: event.clientX,
      lastY: event.clientY,
      scrollDirection: 0,
    };
    commitMobileSelection({ ...selection, menuAnchor: null, clipboardError: null });
  };

  const moveHandle = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = mobileSelectionDragRef.current;
    if (drag?.kind !== "handle" || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    applyMobileHandleDragRef.current(event.clientX, event.clientY);
  };

  const endHandleDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = mobileSelectionDragRef.current;
    if (drag?.kind !== "handle" || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    finishMobileSelectionDragRef.current(event.clientX, event.clientY);
    try {
      if (event.currentTarget.hasPointerCapture?.(event.pointerId))
        event.currentTarget.releasePointerCapture?.(event.pointerId);
    } catch {
      /* pointer capture is best effort on iOS */
    }
  };

  const cancelHandleDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = mobileSelectionDragRef.current;
    if (drag?.kind !== "handle" || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    finishMobileSelectionDragRef.current(drag.lastX, drag.lastY, false);
    try {
      if (event.currentTarget.hasPointerCapture?.(event.pointerId))
        event.currentTarget.releasePointerCapture?.(event.pointerId);
    } catch {
      /* pointer capture is best effort on iOS */
    }
  };

  const copyMobileSelection = async () => {
    const selection = mobileSelectionRef.current;
    if (!selection || selection.text.trim() === "") return;
    const ok = await copyText(selection.text);
    if (!ok) {
      commitMobileSelection({ ...selection, clipboardError: "copy" });
      return;
    }
    commitMobileSelection({ ...selection, menuAnchor: null, clipboardError: null });
    flashCopied();
  };

  const selectAllMobile = () => {
    const term = termRef.current;
    if (!term || !mobileSelectionRef.current) return;
    term.selectAll();
    syncMobileSelectionRef.current();
  };

  const sendBracketedText = (text: string) => {
    // Ghostty reads the live terminal mode and applies bracketed-paste framing only when the provider enabled it.
    if (text) termRef.current?.paste(text);
  };
  const pasteFromMobileSelection = async () => {
    if (!mobileSelectionRef.current) return;
    const result = await readClipboardText();
    if (!result.ok) {
      const selection = mobileSelectionRef.current;
      if (selection) commitMobileSelection({ ...selection, clipboardError: "paste" });
      return;
    }
    sendBracketedText(result.text);
    exitMobileSelection();
  };
  // Inject the compact composer contents into the terminal, then close without reopening terminal focus.
  const sendComposedText = () => {
    if (!composedText) return;
    sendBracketedText(composedText);
    setComposedText("");
    saveTerminalDraft(connection.hostId, sessionId, "");
    closeChatInput();
  };
  const startUpload = (file: File, existingTempId?: string, derivedFromId?: string) => {
    if (file.size > maxUploadBytes) {
      setUploadError(`${file.name} exceeds the ${Math.floor(maxUploadBytes / 1_048_576)} MB limit`);
      return;
    }
    const tempId = existingTempId ?? `upload:${Date.now()}:${Math.random().toString(36).slice(2)}:${file.name}`;
    const placeholder: TermFile = {
      id: tempId,
      name: file.name,
      path: "",
      isImage: isLikelyImage(file),
      kind: isLikelyImage(file) ? "image" : undefined,
      mimeType: file.type,
      size: file.size,
      source: "sent",
      storage: "managed",
      uploading: true,
      progress: 0,
      localFile: file,
      createdAt: Date.now(),
    };
    openFiles();
    setFiles((prev) => [placeholder, ...prev.filter((item) => item.id !== tempId)]);
    let cancelled = false;
    let running: TerminalUploadTask | undefined;
    const releaseSlot = () => {
      activeUploadsRef.current = Math.max(0, activeUploadsRef.current - 1);
      uploadQueueRef.current.shift()?.();
    };
    const run = () => {
      if (cancelled) return;
      activeUploadsRef.current += 1;
      const task = uploadWithProgress(
        sessionId,
        file,
        (fraction) => {
          setFiles((prev) => prev.map((item) => (item.id === tempId ? { ...item, progress: fraction } : item)));
        },
        derivedFromId,
        connection,
      );
      running = task;
      task.promise
        .then(({ path, file: stored }) => {
          const item = normalizeTermFile({ ...stored, path });
          setFiles((prev) => [item, ...prev.filter((entry) => entry.id !== tempId && entry.id !== item.id)]);
          sendBracketedText(`Attached file: ${JSON.stringify(path)} `);
          if (window.matchMedia?.("(hover: hover) and (pointer: fine)")?.matches) termRef.current?.focus();
        })
        .catch((reason: unknown) => {
          if ((reason as { name?: string }).name === "AbortError") {
            setFiles((prev) => prev.filter((item) => item.id !== tempId));
            return;
          }
          setFiles((prev) =>
            prev.map((item) =>
              item.id === tempId
                ? {
                    ...item,
                    uploading: false,
                    error: true,
                    errorMessage: reason instanceof Error ? reason.message : "Upload failed",
                  }
                : item,
            ),
          );
          setUploadError(`Couldn't upload ${file.name}`);
        })
        .finally(() => {
          uploadsRef.current.delete(tempId);
          releaseSlot();
        });
    };
    uploadsRef.current.set(tempId, {
      abort: () => {
        cancelled = true;
        if (running) running.abort();
        else {
          uploadQueueRef.current = uploadQueueRef.current.filter((job) => job !== run);
          uploadsRef.current.delete(tempId);
          setFiles((prev) => prev.filter((item) => item.id !== tempId));
        }
      },
    });
    if (activeUploadsRef.current < 3) run();
    else uploadQueueRef.current.push(run);
  };

  const onUploadFiles = (list: FileList) => {
    const chosen = Array.from(list);
    const images = chosen.filter((file) => isLikelyImage(file));
    for (const file of chosen.filter((file) => !images.includes(file))) startUpload(file);
    if (images.length > 0) {
      setEditBatch((current) =>
        current ? { files: [...current.files, ...images], index: current.index } : { files: images, index: 0 },
      );
    }
  };

  const finishBatchImage = (file: File) => {
    startUpload(file);
    setEditBatch((current) => {
      if (!current || current.index + 1 >= current.files.length) return undefined;
      return { ...current, index: current.index + 1 };
    });
  };

  const activeHandleDrag =
    mobileSelectionDragRef.current?.kind === "handle" ? mobileSelectionDragRef.current : undefined;
  const selectionTerm = termRef.current;
  const selectionStage = stageRef.current;
  const selectionHandleSlots =
    mobileSelection && selectionTerm && selectionStage
      ? (["start", "end"] as const).map((slot) => {
          // Keep the DOM node that captured the pointer under that pointer. When the moving boundary crosses
          // the fixed one its semantic edge flips, while the two physical handle slots remain stable.
          const edge = activeHandleDrag
            ? slot === activeHandleDrag.origin
              ? activeHandleDrag.prefer
              : activeHandleDrag.prefer === "start"
                ? "end"
                : "start"
            : slot;
          return {
            slot,
            edge,
            position: boundaryPosition(selectionTerm, selectionStage, mobileSelection[edge], edge),
          };
        })
      : [];
  const mobileSelectionMenuPosition = mobileSelection?.menuAnchor
    ? mobileMenuPosition(
        mobileSelection.menuAnchor.x,
        mobileSelection.menuAnchor.y,
        mobileSelection.clipboardError ? 84 : 52,
      )
    : undefined;

  return (
    <div className="rc-terminal">
      <ChatHeader
        session={session}
        onShowSessions={onShowSessions}
        needsYou={needsYou}
        onClose={onClose}
        onSplitRight={onSplitRight}
        onSplitDown={onSplitDown}
        closeIsPane={closeIsPane}
        dragPaneId={dragPaneId}
        onOpenSettings={onOpenSettings}
        onOpenFiles={() => openFiles()}
        filesCount={unreadReceived}
        terminalTools={{
          searchOpen,
          fontSize,
          onToggleSearch: toggleSearch,
          onSmallerText: () => changeFont(-1),
          onLargerText: () => changeFont(1),
        }}
      />
      <div
        className={`rc-terminal__stage${fileDragging ? " is-file-dragging" : ""}`}
        ref={stageRef}
        onDragOver={(event) => {
          event.preventDefault();
          setFileDragging(true);
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFileDragging(false);
        }}
        onDrop={(event) => {
          event.preventDefault();
          setFileDragging(false);
          if (event.dataTransfer.files.length) onUploadFiles(event.dataTransfer.files);
        }}
        onPaste={(event) => {
          if (event.clipboardData.files.length) {
            event.preventDefault();
            onUploadFiles(event.clipboardData.files);
          }
        }}
      >
        <div className="rc-terminal__host" ref={hostRef} role="group" aria-label="Terminal" />
        <div className="rc-terminal__touch-cursor" ref={touchCursorRef} data-pressed="false" aria-hidden="true">
          <svg viewBox="0 0 24 30" focusable="false">
            <path d="M3 2.5v21.2l5.2-5 3.9 8.5 4.2-2-3.9-8.2h7.3L3 2.5Z" />
          </svg>
        </div>
        {fileDragging && (
          <div className="rc-terminal__filedrop">
            <Icon name="paperclip" size={24} /> Drop files to add
          </div>
        )}
        {mobileSelection && (
          <>
            <div
              className="rc-term-touch-selection__guard"
              aria-label="Terminal text selection active"
              onContextMenu={(event) => event.preventDefault()}
              onPointerDown={(event) => {
                event.preventDefault();
                event.stopPropagation();
                guardPointerRef.current = {
                  pointerId: event.pointerId,
                  x: event.clientX,
                  y: event.clientY,
                };
              }}
              onPointerUp={(event) => {
                const down = guardPointerRef.current;
                guardPointerRef.current = null;
                event.preventDefault();
                event.stopPropagation();
                if (
                  !down ||
                  down.pointerId !== event.pointerId ||
                  Math.hypot(event.clientX - down.x, event.clientY - down.y) > 10
                )
                  return;
                const term = termRef.current;
                const host = hostRef.current;
                const selection = mobileSelectionRef.current;
                const point = term && host ? terminalCellAtPoint(term, host, event.clientX, event.clientY) : undefined;
                if (term && selection && point && selectionContainsCell(selection, point, term.cols)) {
                  commitMobileSelection({
                    ...selection,
                    menuAnchor: { x: event.clientX, y: event.clientY },
                    clipboardError: null,
                  });
                } else {
                  exitMobileSelection();
                }
              }}
              onPointerCancel={() => {
                guardPointerRef.current = null;
              }}
            />
            {selectionHandleSlots.map(
              ({ slot, edge, position }) =>
                position && (
                  <button
                    key={slot}
                    type="button"
                    className={`rc-term-touch-selection__handle rc-term-touch-selection__handle--${edge}`}
                    data-handle-slot={slot}
                    aria-label={`Adjust selection ${edge}`}
                    style={{ left: position.left, top: position.top }}
                    onPointerDown={(event) => beginHandleDrag(edge, event)}
                    onPointerMove={moveHandle}
                    onPointerUp={endHandleDrag}
                    onPointerCancel={cancelHandleDrag}
                  />
                ),
            )}
            {mobileSelectionMenuPosition && (
              <div
                className="rc-term-touch-selection__menu"
                role="menu"
                aria-label="Mobile terminal clipboard menu"
                style={{ left: mobileSelectionMenuPosition.x, top: mobileSelectionMenuPosition.y }}
              >
                <button
                  type="button"
                  role="menuitem"
                  disabled={mobileSelection.text.trim() === ""}
                  onClick={() => void copyMobileSelection()}
                >
                  Copy
                </button>
                <button type="button" role="menuitem" onClick={selectAllMobile}>
                  Select all
                </button>
                <button type="button" role="menuitem" onClick={() => void pasteFromMobileSelection()}>
                  Paste
                </button>
                <button type="button" role="menuitem" onClick={() => exitMobileSelection()}>
                  Done
                </button>
                {mobileSelection.clipboardError && (
                  <span className="rc-term-touch-selection__error" role="status">
                    {mobileSelection.clipboardError === "copy"
                      ? "Copy failed — try again"
                      : "Paste failed — allow clipboard access"}
                  </span>
                )}
              </div>
            )}
          </>
        )}
        {/* The find bar — compact and top-left of the stage. Its launcher and text-size controls now live in
            the header's Terminal tools menu, so terminal output has no floating control cluster over it. The input keeps
            focus while open (prev/next preventDefault their mousedown so taps never blur it); Enter/Shift+
            Enter step, Escape closes. Closing refocuses the terminal on desktop only (see closeSearch). */}
        {searchOpen && (
          <div className="rc-term-find" role="search" aria-label="Terminal search bar">
            <input
              className="rc-term-find__input"
              type="text"
              value={searchQuery}
              onChange={(e) => runSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  stepMatch(e.shiftKey ? -1 : 1);
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  closeSearch();
                }
              }}
              placeholder="Find…"
              aria-label="Find in terminal"
              autoFocus
              autoCapitalize="off"
              autoCorrect="off"
              autoComplete="off"
              spellCheck={false}
            />
            {/* Live position: "2/5" while there are hits, "0/0" for a miss, blank for an empty query. */}
            <span className="rc-term-find__count" aria-live="polite">
              {searchMatches.length > 0 ? `${searchIdx + 1}/${searchMatches.length}` : searchQuery ? "0/0" : ""}
            </span>
            <button
              type="button"
              className="rc-term-find__btn"
              aria-label="Previous match"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => stepMatch(-1)}
              disabled={searchMatches.length === 0}
            >
              ↑
            </button>
            <button
              type="button"
              className="rc-term-find__btn"
              aria-label="Next match"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => stepMatch(1)}
              disabled={searchMatches.length === 0}
            >
              ↓
            </button>
            <button type="button" className="rc-term-find__btn" aria-label="Close search" onClick={closeSearch}>
              ✕
            </button>
          </div>
        )}
        {showJumpLatest && (
          <button
            type="button"
            className="rc-term-jump"
            aria-label="Jump to latest output"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              termRef.current?.scrollToBottom();
              setShowJumpLatest(false);
            }}
          >
            <Icon name="chevron-down" size={16} /> Latest
          </button>
        )}
        {showTouchpadHint && (
          <button
            type="button"
            className="rc-term-hint"
            aria-label="Terminal touchpad: move with one finger, tap to click, and scroll with two fingers. Tap to dismiss."
            onClick={() => setShowTouchpadHint(false)}
          >
            <svg
              className="rc-term-hint__gesture"
              width="24"
              height="24"
              viewBox="0 0 24 24"
              fill="none"
              aria-hidden="true"
            >
              <path
                d="M4 3.5v13.8l3.3-3 2.4 5.4 2.7-1.3-2.5-5h4.7L4 3.5Z"
                stroke="currentColor"
                strokeWidth="1.35"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <path d="M18 5v11M15.5 8 18 5l2.5 3M15.5 13l2.5 3 2.5-3" stroke="currentColor" strokeWidth="1.4" />
            </svg>
            <span>
              <strong>Trackpad</strong> · move · tap · two-finger scroll
            </span>
          </button>
        )}
        {connState === "reconnecting" && (
          <div className="rc-term-toast" role="status">
            <span className="rc-term-toast__dot" aria-hidden="true" /> Reconnecting…
            <button
              type="button"
              className="rc-term-toast__btn"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => sockRef.current?.reconnect()}
            >
              Reconnect now
            </button>
          </div>
        )}
        {connState === "ended" && (
          <div className="rc-term-ended" role="alertdialog" aria-label="Session ended">
            <div className="rc-term-ended__card">
              <div className="rc-term-ended__title">{isShell ? "Shell exited" : `${providerLabel} exited`}</div>
              <div className="rc-term-ended__sub">The terminal session ended.</div>
              {/* Boot-time death (< QUICK_EXIT_MS after (re)spawn) often means the provider CLI is signed out.
                  Say so — otherwise Resume/Start fresh can just loop here. */}
              {quickExit && (
                <div className="rc-term-ended__warn" role="status">
                  {isShell ? (
                    <>The shell closed before the terminal was ready.</>
                  ) : isClaude || isCodex ? (
                    <>
                      {providerLabel} may be signed out on the host — run <code>{providerId}</code> there or check
                      Settings → {providerLabel} account.
                    </>
                  ) : (
                    <>This runtime is no longer supported. Start a new Claude or Codex Session.</>
                  )}
                </div>
              )}
              <div className="rc-term-ended__actions">
                {/* Resume is offered only when this session's provider identity can be continued safely.
                    Start fresh always creates a clean provider conversation. */}
                {!isShell && (
                  <button
                    type="button"
                    className="rc-term-ended__primary"
                    disabled={!canResume}
                    onClick={() => canResume && restart("continue")}
                  >
                    Resume conversation
                  </button>
                )}
                <button
                  type="button"
                  className={isShell ? "rc-term-ended__primary" : "rc-term-ended__ghost"}
                  onClick={() => restart()}
                >
                  {isShell ? "Restart terminal" : "Start fresh"}
                </button>
                {onClose && (
                  <button type="button" className="rc-term-ended__ghost" onClick={onClose}>
                    Close
                  </button>
                )}
              </div>
              <div className="rc-term-ended__hint">{resumeHint}</div>
            </div>
          </div>
        )}
        {copied && (
          <div className="rc-term-copied" role="status" aria-live="polite">
            Copied ✓
          </div>
        )}
      </div>
      {chatInputOpen && (
        <div
          className="rc-chat-input"
          role="region"
          aria-label="Chat input composer"
          onKeyDown={(e) => {
            if (e.key === "Escape") closeChatInput();
          }}
        >
          {/* This is a natural-language provider prompt, not the raw terminal input, so browser dictation,
              suggestions, and autocorrect remain available. Opening the panel itself does not steal focus,
              while tapping this real text field uses the browser's normal focus and keyboard behavior. */}
          <textarea
            ref={chatInputRef}
            className="rc-chat-input__field"
            aria-label="Chat message"
            placeholder="Message the terminal…"
            rows={1}
            value={composedText}
            onChange={(event) => {
              const value = event.target.value;
              setComposedText(value);
              saveTerminalDraft(connection.hostId, sessionId, value);
            }}
            onInput={(event) => {
              const field = event.currentTarget;
              field.style.height = "auto";
              field.style.height = `${Math.min(field.scrollHeight, Math.round(window.innerHeight * 0.28))}px`;
            }}
          />
          <button
            type="button"
            className="rc-chat-input__button"
            aria-label="Close chat input"
            onClick={closeChatInput}
          >
            <Icon name="x" size={18} />
          </button>
          <button
            type="button"
            className="rc-chat-input__button rc-chat-input__button--send"
            aria-label="Send message"
            disabled={!composedText}
            onClick={sendComposedText}
          >
            <Icon name="send" size={18} />
          </button>
        </div>
      )}
      <TerminalKeyBar
        ctrlLocked={ctrlLocked}
        onToggleCtrl={() => {
          setCtrlLocked(!ctrlLockedRef.current);
        }}
        onKey={onBarKey}
        onOpenFiles={() => {
          const active = document.activeElement;
          const terminalKeyboardOpen =
            window.matchMedia?.("(pointer: coarse)")?.matches === true &&
            active instanceof HTMLTextAreaElement &&
            active.classList.contains("rc-ghostty-input");
          openFiles(terminalKeyboardOpen);
        }}
        filesCount={unreadReceived}
        chatOpen={chatInputOpen}
        onToggleChat={toggleChatInput}
        onOpenKeyboard={showKeyboard}
        sessionSwitcherOpen={sessionSwitcherOpen}
        onDismissSessionSwitcher={onHideSessions}
      />
      <TerminalFiles
        files={files}
        open={filesOpen}
        preserveExternalFocus={filesPreserveExternalFocus}
        historyStatus={fileHistoryStatus}
        onClose={closeFiles}
        onRetryHistory={loadFileHistory}
        onUpload={onUploadFiles}
        unreadReceived={unreadReceived}
        contentUrl={(file, disposition) => terminalFileContentUrl(sessionId, file.id, disposition, connection)}
        contentRequest={connection.request ? requestTerminalFile : undefined}
        onMarkReceivedSeen={() => {
          setUnreadReceived(0);
          seenReceivedAtRef.current = Date.now();
          try {
            window.localStorage.setItem(`rc-files-seen:${sessionId}`, String(seenReceivedAtRef.current));
          } catch {
            /* ignore */
          }
        }}
        onShare={(file) => {
          sendBracketedText(`Attached file: ${JSON.stringify(file.path)} `);
          if (window.matchMedia?.("(hover: hover) and (pointer: fine)")?.matches) {
            window.setTimeout(() => termRef.current?.focus(), 0);
          }
        }}
        onCancel={(file) => uploadsRef.current.get(file.id)?.abort()}
        onRetry={(file) => {
          if (file.localFile) startUpload(file.localFile, file.id);
        }}
      />
      {editBatch && (
        <ImageEditorBoundary
          key={`${editBatch.index}:${editBatch.files[editBatch.index]?.name}`}
          onCancel={() => setEditBatch(undefined)}
          onSendOriginal={() => finishBatchImage(editBatch.files[editBatch.index]!)}
        >
          <Suspense
            fallback={
              <div className="rc-ie-boot" role="status">
                <Icon name="image" size={24} /> Preparing editor…
              </div>
            }
          >
            <ImageEditorModal
              file={editBatch.files[editBatch.index]!}
              index={editBatch.index}
              total={editBatch.files.length}
              maxBytes={maxUploadBytes}
              onCancel={() => setEditBatch(undefined)}
              onSend={finishBatchImage}
            />
          </Suspense>
        </ImageEditorBoundary>
      )}
      {uploadError && (
        <button type="button" className="rc-term-uploaderr" onClick={() => setUploadError(undefined)}>
          {uploadError} — tap to dismiss
        </button>
      )}
      {linkOpenError && (
        <button type="button" className="rc-term-uploaderr rc-term-linkerr" onClick={() => setLinkOpenError(false)}>
          Link couldn't be opened — tap to dismiss
        </button>
      )}
      <style>{terminalCss}</style>
    </div>
  );
}

const terminalRuntimeCss = `
.rc-terminal--loading {
  display: flex; flex-direction: column; height: 100%; min-height: 0; background: var(--bg);
}
.rc-terminal-runtime {
  flex: 1 1 auto; min-height: 0; display: grid; place-content: center; justify-items: center; gap: 10px;
  padding: 24px; color: var(--text-muted); text-align: center; font: 600 13px/1.45 var(--font-body);
}
.rc-terminal-runtime strong { color: var(--text); }
.rc-terminal-runtime span { max-width: 560px; color: var(--err); overflow-wrap: anywhere; }
.rc-terminal-runtime button {
  min-height: 38px; padding: 0 14px; border: 1px solid var(--border-strong); border-radius: 8px;
  background: var(--surface-2); color: var(--text); cursor: pointer; font: 600 12px/1 var(--font-body);
}
`;

const terminalCss = `
/* Moshi-style compact composer: it is part of the terminal stack immediately above the key bar, not a
   full-screen modal. A short prompt stays one row; longer text grows only as far as the usable viewport. */
.rc-chat-input {
  flex: 0 0 auto; min-width: 0;
  display: grid; grid-template-columns: minmax(0, 1fr) var(--tap-min) var(--tap-min); align-items: end; gap: 4px;
  margin: 6px 6px 4px; padding: 5px;
  background: var(--surface); border: 1px solid var(--border-strong); border-radius: 14px;
  box-shadow: 0 -8px 28px rgba(0,0,0,0.28); animation: rc-chat-input-in 140ms ease both;
}
@keyframes rc-chat-input-in {
  from { opacity: 0; transform: translateY(6px); }
  to { opacity: 1; transform: none; }
}
.rc-chat-input__field {
  width: 100%; min-width: 0; min-height: var(--tap-min); max-height: 28vh; resize: none; overflow-y: auto;
  background: var(--surface-2); color: var(--text);
  border: 1px solid var(--border); border-radius: 10px; padding: 10px 12px;
  font: 400 16px/1.4 var(--font-body); transition: border-color 120ms ease, box-shadow 120ms ease;
}
.rc-chat-input__field::placeholder { color: var(--text-faint); }
.rc-chat-input__field:focus { outline: none; border-color: var(--coral); box-shadow: var(--focus-glow); }
.rc-chat-input__button {
  width: var(--tap-min); height: var(--tap-min); padding: 0; border-radius: 10px;
  display: grid; place-items: center; border: 1px solid var(--border); background: var(--surface-2); color: var(--text-muted);
  cursor: pointer; touch-action: manipulation; -webkit-tap-highlight-color: transparent;
}
.rc-chat-input__button:active { filter: brightness(1.12); }
.rc-chat-input__button:disabled { opacity: 0.38; cursor: default; }
.rc-chat-input__button--send { background: var(--coral); color: var(--on-accent); border-color: var(--coral); }
.rc-terminal {
  display: flex; flex-direction: column; height: 100%; min-height: 0;
  background: var(--bg);
}
.rc-ie-boot {
  position: fixed; inset: 0; z-index: 90; display: flex; align-items: center; justify-content: center; gap: 10px;
  padding: env(safe-area-inset-top,0px) 16px env(safe-area-inset-bottom,0px);
  background: var(--bg); color: var(--text-faint); font: 600 12px/1 var(--font-mono);
}
/* The stage is the flex-fill region + the positioning context for the reconnect/ended overlays. */
.rc-terminal__stage { position: relative; flex: 1 1 auto; min-height: 0; }
.rc-terminal__stage.is-file-dragging { outline: 2px dashed var(--coral); outline-offset: -8px; }
.rc-terminal__filedrop { position: absolute; inset: 12px; z-index: 18; display: flex; align-items: center; justify-content: center; gap: 10px; border: 1px solid color-mix(in srgb,var(--coral) 58%,transparent); border-radius: 14px; background: color-mix(in srgb,var(--bg) 84%,transparent); color: var(--coral); -webkit-backdrop-filter: blur(8px); backdrop-filter: blur(8px); pointer-events: none; font: 700 13px/1 "JetBrains Mono",monospace; }
.rc-terminal__host {
  position: absolute; inset: 0;
  overflow: hidden;
  overscroll-behavior: none;
  touch-action: none;
  user-select: none; -webkit-user-select: none; -webkit-touch-callout: none;
  /* Isolate Ghostty's canvas rendering so a recomposite of the
     terminal doesn't cascade across the whole app — helps iOS Safari repaint the session-select transition. */
  contain: layout paint;
}
.rc-terminal__touch-cursor {
  position: absolute; left: 0; top: 0; z-index: 4; width: 24px; height: 30px;
  display: none; pointer-events: none; transform-origin: 3px 3px;
  color: #fff; filter: drop-shadow(0 1px 1px rgba(0,0,0,.9)) drop-shadow(0 0 3px rgba(0,0,0,.55));
  will-change: transform;
}
.rc-terminal__touch-cursor svg { display: block; width: 24px; height: 30px; overflow: visible; }
.rc-terminal__touch-cursor path { fill: currentColor; stroke: #111; stroke-width: 1.35; stroke-linejoin: round; }
.rc-terminal__touch-cursor[data-pressed="true"] { transform-origin: 3px 3px; opacity: .82; }
@media (any-pointer: coarse) { .rc-terminal__touch-cursor { display: block; } }
/* Reconnecting toast — a small pill, top-center, non-blocking. */
.rc-term-toast {
  position: absolute; top: 8px; left: 50%; transform: translateX(-50%); z-index: 5;
  display: flex; align-items: center; gap: 7px;
  padding: 5px 11px; border-radius: 999px;
  background: var(--surface-2); border: 1px solid var(--border-strong); color: var(--text);
  font: 600 12px/1 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  box-shadow: 0 4px 16px rgba(0,0,0,0.4);
}
.rc-term-toast__dot { width: 7px; height: 7px; border-radius: 999px; background: var(--warn); animation: rc-term-pulse 1s ease-in-out infinite; }
.rc-term-toast__btn {
  min-height: var(--tap-min); margin-left: 2px; padding: 3px 12px; border-radius: 999px; cursor: pointer;
  border: 1px solid var(--border-strong); background: var(--surface-3); color: var(--text);
  font: 600 12px/1 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
}
.rc-term-toast__btn:active { background: var(--coral); color: var(--on-accent); border-color: var(--coral); }
@keyframes rc-term-pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.3; } }
/* One-time compact touchpad legend. It disappears permanently after the first translated gesture. */
.rc-term-hint {
  position: absolute; left: 50%; bottom: 14px; z-index: 6;
  min-height: var(--tap-min);
  display: flex; align-items: center; gap: 9px;
  padding: 8px 14px 8px 11px; border-radius: 999px; cursor: pointer;
  background: var(--surface-2); border: 1px solid var(--coral); color: var(--text);
  font: 600 12.5px/1 var(--font-body); text-align: left;
  box-shadow: 0 6px 22px rgba(0,0,0,0.45);
  animation: rc-hint-life 5300ms ease both;
}
.rc-term-hint__gesture { color: var(--coral); flex: none; }
.rc-term-hint strong { color: var(--coral); font-weight: 700; }
@keyframes rc-hint-life {
  0% { opacity: 0; transform: translate(-50%, 10px); }
  9%, 88% { opacity: 1; transform: translate(-50%, 0); }
  100% { opacity: 0; transform: translate(-50%, 6px); }
}
/* Session-ended overlay — a centered card scrimming the dead terminal, with Restart / Close. */
.rc-term-ended {
  position: absolute; inset: 0; z-index: 6;
  display: grid; place-items: center;
  background: rgba(0,0,0,0.6); backdrop-filter: blur(2px);
}
.rc-term-ended__card {
  min-width: 220px; max-width: 90%; padding: 20px;
  background: var(--surface); border: 1px solid var(--border-strong); border-radius: 12px;
  text-align: center; box-shadow: 0 12px 40px rgba(0,0,0,0.5);
}
.rc-term-ended__title { font: 600 15px/1.3 "JetBrains Mono", ui-monospace, monospace; color: var(--text); }
.rc-term-ended__sub { margin-top: 4px; font-size: 12px; color: var(--text-faint); }
.rc-term-ended__actions { display: flex; gap: 8px; justify-content: center; margin-top: 16px; }
.rc-term-ended__primary, .rc-term-ended__ghost {
  min-height: var(--tap-min); padding: 0 16px; border-radius: 9px; cursor: pointer;
  font: 600 13px/1 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  touch-action: manipulation;
}
.rc-term-ended__primary { background: var(--coral); color: var(--on-accent); border: 1px solid var(--coral); }
.rc-term-ended__primary:disabled { opacity: 0.45; cursor: not-allowed; }
.rc-term-ended__ghost { background: transparent; color: var(--text); border: 1px solid var(--border-strong); }
/* Three actions (Resume / Start fresh / Close) can outgrow a narrow card — let them wrap, centered. */
.rc-term-ended__actions { flex-wrap: wrap; }
/* The resume-vs-fresh explainer under the buttons — one quiet line so the choice is self-describing. */
.rc-term-ended__hint { margin-top: 10px; max-width: 36ch; font-size: 11.5px; line-height: 1.45; color: var(--text-faint); }
/* Sign-out hint on a boot-time death — warn-toned so it reads as the LIKELY CAUSE, not decoration. */
.rc-term-ended__warn {
  margin-top: 10px; max-width: 36ch; padding: 8px 10px; border-radius: 8px;
  background: rgba(217,164,65,0.1); border: 1px solid var(--warn); color: var(--warn);
  font-size: 12px; line-height: 1.45; text-align: left;
}
.rc-term-ended__warn code { font-family: var(--font-mono); font-size: 0.95em; }
/* Upload error toast — tap to dismiss. */
.rc-term-uploaderr {
  position: absolute; left: 50%; bottom: 60px; transform: translateX(-50%); z-index: 8;
  min-height: var(--tap-min); max-width: 88%; padding: 8px 14px; border-radius: 10px; cursor: pointer;
  background: rgba(217,164,65,0.12); border: 1px solid var(--warn); color: var(--warn);
  font: 500 12px/1.3 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
}
.rc-term-linkerr { bottom: 98px; }
.rc-terminal__host .rc-ghostty-canvas {
  position: absolute; inset: 0; display: block;
  user-select: none; -webkit-user-select: none; -webkit-touch-callout: none;
}
.rc-terminal__host.rc-ghostty-native-scroll {
  overflow-y: auto; overflow-x: hidden;
  touch-action: none;
  overflow-anchor: none;
  scrollbar-width: none;
}
.rc-terminal__host.rc-ghostty-native-scroll::-webkit-scrollbar { display: none; }
.rc-terminal__host.rc-ghostty-native-scroll.rc-ghostty-alt-screen {
  overflow-y: hidden;
  touch-action: none;
}
.rc-terminal__host.rc-ghostty-native-scroll .rc-ghostty-canvas {
  inset: auto; left: 0; z-index: 0;
}
.rc-terminal__host .rc-ghostty-scroll-spacer {
  width: 1px; min-height: 0; pointer-events: none;
}
.rc-terminal__host .rc-ghostty-input {
  position: absolute; left: 0; bottom: 0; width: 1px; height: 1px; z-index: 1;
  padding: 0; border: 0; opacity: .01; resize: none; overflow: hidden;
  color: transparent; background: transparent; letter-spacing: normal;
}
.rc-terminal__host .rc-ghostty-input:focus { outline: none; }
.rc-terminal__host .rc-ghostty-accessibility {
  position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden;
  clip: rect(0 0 0 0); clip-path: inset(50%); white-space: pre; border: 0;
}
/* Mobile live selection: an invisible guard retains the Ghostty range without letting a dismissing tap leak
   into the provider. The visible handles sit on Ghostty's real start/end boundaries and keep 44px targets. */
.rc-term-touch-selection__guard {
  position: absolute; inset: 0; z-index: 7;
  background: transparent; touch-action: none;
  user-select: none; -webkit-user-select: none; -webkit-touch-callout: none;
}
.rc-term-touch-selection__handle {
  position: absolute; z-index: 8; width: 48px; height: 48px; padding: 0;
  transform: translate(-50%, -50%); border: none; background: transparent;
  touch-action: none; user-select: none; -webkit-user-select: none; -webkit-touch-callout: none;
}
.rc-term-touch-selection__handle::before {
  content: ""; position: absolute; left: 50%; top: 50%; width: 15px; height: 15px;
  transform: translate(-50%, -50%); border-radius: 999px;
  background: var(--coral); border: 2px solid var(--bg); box-shadow: 0 2px 8px rgba(0,0,0,0.55);
}
.rc-term-touch-selection__handle::after {
  content: ""; position: absolute; left: calc(50% - 1px); top: 4px; width: 2px; height: 13px;
  border-radius: 2px; background: var(--coral); box-shadow: 0 0 0 1px var(--bg);
}
.rc-term-touch-selection__handle--end::after { top: 31px; }
.rc-term-touch-selection__menu {
  position: fixed; z-index: 100; width: min(304px, calc(100vw - 16px)); padding: 4px;
  display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 2px;
  background: var(--surface-2); border: 1px solid var(--border-strong);
  border-radius: 11px; box-shadow: var(--shadow-1); color: var(--text);
  user-select: none; -webkit-user-select: none;
}
.rc-term-touch-selection__menu button {
  min-width: 0; min-height: var(--tap-min); padding: 0 8px; border: none; border-radius: 8px;
  background: transparent; color: var(--text); touch-action: manipulation;
  font: 600 12.5px/1 var(--font-body); white-space: nowrap; cursor: pointer;
}
.rc-term-touch-selection__menu button:active { background: var(--surface-3); }
.rc-term-touch-selection__menu button:first-child:not(:disabled) { background: var(--coral); color: var(--on-accent); }
.rc-term-touch-selection__menu button:disabled { color: var(--text-faint); }
.rc-term-touch-selection__error {
  grid-column: 1 / -1; padding: 7px 8px 5px; border-top: 1px solid var(--border);
  color: var(--warn); font: 600 11px/1.25 var(--font-mono); text-align: center;
}
/* "Copied ✓" confirmation pill (desktop or mobile explicit Copy) — top-center, brief, non-blocking. */
.rc-term-copied {
  position: absolute; top: 8px; left: 50%; transform: translateX(-50%); z-index: 9;
  padding: 4px 12px; border-radius: 999px;
  background: var(--coral); color: var(--on-accent, #fff);
  font-size: 12px; font-weight: 600; pointer-events: none;
  box-shadow: var(--shadow); animation: rc-term-copied-in 120ms ease;
}
@keyframes rc-term-copied-in { from { opacity: 0; transform: translate(-50%, -4px); } to { opacity: 1; transform: translate(-50%, 0); } }

/* Moshi-inspired input hierarchy: one quiet capsule keeps the essential keys and launchers in a single row;
   the full-size physical D-pad appears above it only when requested. The bar owns the single iOS inset. */
.rc-termkeys {
  flex: 0 0 auto; padding: 4px 6px calc(3px + var(--kb-safe-bottom, env(safe-area-inset-bottom, 0px)));
  background: var(--bg);
  overscroll-behavior: none; touch-action: none;
}
.rc-termkeys__grid {
  position: relative; box-sizing: border-box; height: calc(var(--tap-min) + 6px); padding: 3px;
  display: grid;
  grid-template-columns:
    repeat(3, minmax(34px, 0.86fr)) repeat(4, minmax(38px, 1fr));
  grid-template-rows: var(--tap-min); gap: 3px; align-items: stretch;
  border: 1px solid var(--border-strong); border-radius: 14px;
  background: var(--surface); box-shadow: 0 5px 18px rgba(0,0,0,0.28);
}
.rc-termkeys__dpad {
  position: absolute; z-index: 8; left: 50%; bottom: calc(100% + 7px); transform: translateX(-50%);
  box-sizing: border-box; width: 152px; padding: 6px;
  display: grid; grid-template-columns: repeat(3, 44px); grid-template-rows: repeat(2, 44px); gap: 4px;
  border: 1px solid var(--border-strong); border-radius: 15px;
  /* Keep the terminal readable behind the D-pad. The individual key caps remain legible, but the popup no
     longer paints an opaque card over the exact lines the arrows are navigating. */
  background: color-mix(in srgb, var(--bg) 18%, transparent);
  box-shadow: 0 10px 28px rgba(0,0,0,0.25);
  animation: rc-termkeys-pop 120ms cubic-bezier(0.16,1,0.3,1);
}
@keyframes rc-termkeys-pop {
  from { opacity: 0; transform: translate(-50%, 5px) scale(0.97); }
  to { opacity: 1; transform: translate(-50%, 0) scale(1); }
}
.rc-termkeys__utility-wrap { position: relative; display: block; min-width: 0; height: 100%; }
.rc-tk__key {
  width: 100%; min-width: 0; height: 100%; padding: 0; margin: 0;
  display: grid; place-items: center;
  border: 0; border-radius: 9px;
  background: transparent; color: var(--text-muted);
  font: 650 clamp(9px, 2.8vw, 11px)/1 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  letter-spacing: 0; white-space: nowrap;
  cursor: pointer; -webkit-tap-highlight-color: transparent;
  /* touch-action:none + no callout/selection so a PRESS-AND-HOLD (arrow auto-repeat) isn't hijacked by iOS
     into a scroll/long-press → a pointercancel that would kill the repeat. */
  user-select: none; -webkit-user-select: none; -webkit-touch-callout: none; touch-action: none;
}
.rc-tk__key--standard {
  background: var(--surface-2); color: var(--text-muted);
  box-shadow: inset 0 0 0 1px var(--border);
}
.rc-tk__key--utility { width: 100%; height: 100%; }
.rc-tk__key--dpad.is-on { background: var(--surface-3); color: var(--text); }
.rc-tk__key--arrow {
  width: 44px; height: 44px; border-radius: 10px; font-size: 17px;
  background: color-mix(in srgb, var(--surface-2) 72%, transparent); color: var(--text);
  box-shadow: inset 0 0 0 1px var(--border);
}
.rc-tk__key--arrow-left { grid-column: 1; grid-row: 2; }
.rc-tk__key--arrow-up { grid-column: 2; grid-row: 1; }
.rc-tk__key--arrow-down { grid-column: 2; grid-row: 2; }
.rc-tk__key--arrow-right { grid-column: 3; grid-row: 2; }
.rc-tk__key--arrow-enter { grid-column: 3; grid-row: 1; font-size: 20px; }
.rc-tk__key--keyboard { background: var(--surface-2); color: var(--text); }
.rc-tk__badge {
  position: absolute; top: -4px; right: -2px; z-index: 1; min-width: 14px; height: 14px; padding: 0 3px;
  display: grid; place-items: center; border: 1px solid var(--surface); border-radius: 999px;
  background: var(--coral); color: var(--on-accent); font: 700 8px/1 var(--font-mono); font-style: normal;
  pointer-events: none;
}
.rc-tk__key:active { background: var(--surface-3); color: var(--text); transform: scale(0.96); }
.rc-tk__key.is-on { background: var(--coral); color: var(--on-accent); }
.rc-tk__key.is-inert { opacity: .38; color: var(--text-faint); transform: none; }
/* The on-screen key bar exists for devices WITHOUT a physical keyboard. Hide it only where the PRIMARY
   pointer is a mouse/trackpad (a real desktop) — keyed off INPUT TYPE, not width, so a FOLDABLE phone
   (wide when unfolded but still touch, even with an S-Pen as a secondary pointer) keeps the keys. */
@media (hover: hover) and (pointer: fine) { .rc-termkeys { display: none; } }
/* Find bar — a compact pill at the top-left of the stage. Input + count +
   prev/next + close; opaque enough to read over any terminal content. */
.rc-term-find {
  position: absolute; top: 8px; left: 8px; z-index: 6;
  display: flex; align-items: center; gap: 2px;
  max-width: min(94%, 400px);
  padding: 3px 4px; border-radius: 10px;
  background: var(--surface-2); border: 1px solid var(--border-strong);
  box-shadow: 0 4px 16px rgba(0,0,0,0.4);
}
.rc-term-find__input {
  flex: 1 1 auto; min-width: 84px; width: 150px; min-height: var(--tap-min);
  padding: 0 6px; background: transparent; border: none; outline: none;
  color: var(--text);
  font: 500 13px/1 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
}
.rc-term-find__input::placeholder { color: var(--text-faint); }
.rc-term-find__count {
  flex: none; min-width: 34px; text-align: right; padding-right: 2px;
  color: var(--text-faint); font: 600 11px/1 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-variant-numeric: tabular-nums;
}
.rc-term-find__btn {
  flex: none; min-width: var(--tap-min); height: var(--tap-min); padding: 0 4px; border: none; border-radius: 7px;
  background: transparent; color: var(--text-muted);
  font: 700 13px/1 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  display: grid; place-items: center; cursor: pointer;
  touch-action: manipulation; -webkit-tap-highlight-color: transparent;
}
.rc-term-find__btn:active { background: var(--surface-3); color: var(--text); }
.rc-term-find__btn:disabled { opacity: 0.4; cursor: default; }
/* "Jump to latest" chip — shown only when the normal-buffer scrollback is scrolled up; snaps to bottom. */
.rc-term-jump {
  position: absolute; right: 12px; bottom: 14px; z-index: 6;
  min-height: var(--tap-min);
  display: inline-flex; align-items: center; gap: 5px;
  padding: 7px 12px 7px 9px; border-radius: 999px; cursor: pointer;
  background: var(--coral); color: var(--on-accent); border: none;
  font: 700 12px/1 var(--font-body); box-shadow: 0 6px 22px rgba(0,0,0,0.45);
  animation: rc-jump-in 160ms ease both;
}
@keyframes rc-jump-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
`;
