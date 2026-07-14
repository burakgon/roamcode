import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import { createTerminalSocket, type TerminalSocket } from "../ws/terminal-socket";
type CreateSocket = typeof createTerminalSocket;
import { terminalWsTicketUrl, terminalFileContentUrl, type RespawnMode } from "../api/client";
import { loadToken } from "../auth/token-store";
import { API_BASE_URL } from "../config";
import { searchBuffer, type BufferMatch } from "./terminal-search";
import { openTerminalWebLink } from "./terminal-links";
import { TerminalKeyBar } from "./TerminalKeyBar";
import { TerminalFiles, type TermFile } from "./TerminalFiles";
import { ImageEditorModal, isLikelyImage, supportsImageEditing } from "./ImageEditorModal";
import { ChatHeader } from "./ChatHeader";
import { Icon } from "../ui/Icon";
import { keyboardEventSequence, keySequence, modifiedDataSequence, type TerminalModifiers } from "./terminal-keys";
import { healPaintBurst } from "../pwa/viewport";
import { loadTheme, TERMINAL_BG } from "../pwa/theme";
import { useFocusTrap } from "../ui/useFocusTrap";
import type { SessionMeta } from "../types/server";

type TerminalCellPoint = { col: number; row: number };
type TerminalBoundary = TerminalCellPoint;
type TerminalContextMenuState = { x: number; y: number; selection: string };
type MobileSelectionState = {
  start: TerminalBoundary;
  end: TerminalBoundary;
  text: string;
  menu: { x: number; y: number } | null;
  clipboardError: "copy" | "paste" | null;
};
type MobileHandleDrag = {
  pointerId: number;
  fixed: TerminalBoundary;
  prefer: "start" | "end";
  lastX: number;
  lastY: number;
  scrollDirection: -1 | 0 | 1;
};

/** xterm's default word separators. Keeping paths/URLs punctuation out means a right-click selects useful
 *  terminal tokens such as `/tmp/error.log`, `foo:123`, and https:// links as a whole. */
const DEFAULT_WORD_SEPARATORS = " ()[]{}',\"`";

function terminalCellAtPoint(
  term: Terminal,
  host: HTMLElement,
  clientX: number,
  clientY: number,
): TerminalCellPoint | undefined {
  const screen = host.querySelector<HTMLElement>(".xterm-screen");
  if (!screen || term.cols <= 0 || term.rows <= 0) return undefined;
  const rect = screen.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return undefined;
  if (clientX < rect.left || clientX >= rect.right || clientY < rect.top || clientY >= rect.bottom) return undefined;
  let col = Math.min(term.cols - 1, Math.max(0, Math.floor(((clientX - rect.left) / rect.width) * term.cols)));
  const viewportRow = Math.min(
    term.rows - 1,
    Math.max(0, Math.floor(((clientY - rect.top) / rect.height) * term.rows)),
  );
  const row = term.buffer.active.viewportY + viewportRow;
  const line = term.buffer.active.getLine(row);
  // A width-0 cell is the trailing half of a wide glyph. Anchor selection on the glyph's leading cell.
  while (col > 0 && line?.getCell(col)?.getWidth() === 0) col--;
  return { col, row };
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

function terminalCellEnd(term: Terminal, point: TerminalCellPoint): TerminalBoundary {
  const width = Math.max(1, term.buffer.active.getLine(point.row)?.getCell(point.col)?.getWidth() ?? 1);
  return boundaryFromIndex(boundaryIndex(point, term.cols) + width, term.cols);
}

function mobileMenuPosition(clientX: number, clientY: number): { x: number; y: number } {
  const margin = 8;
  const menuWidth = 244;
  const menuHeight = 52;
  const gap = 12;
  const viewport = window.visualViewport;
  const left = viewport?.offsetLeft ?? 0;
  const top = viewport?.offsetTop ?? 0;
  const width = viewport?.width ?? window.innerWidth;
  const height = viewport?.height ?? window.innerHeight;
  const x = Math.max(left + margin, Math.min(clientX - menuWidth / 2, left + width - menuWidth - margin));
  const above = clientY - menuHeight - gap;
  const y = above >= top + margin ? above : Math.min(clientY + gap, top + height - menuHeight - margin);
  return { x, y };
}

function boundaryPosition(
  term: Terminal,
  host: HTMLElement,
  stage: HTMLElement,
  point: TerminalBoundary,
  end: boolean,
): { left: number; top: number } | undefined {
  const screen = host.querySelector<HTMLElement>(".xterm-screen");
  if (!screen || term.cols <= 0 || term.rows <= 0) return undefined;
  const screenRect = screen.getBoundingClientRect();
  const stageRect = stage.getBoundingClientRect();
  let col = point.col;
  let row = point.row;
  // xterm exposes selection ends as end-exclusive boundaries. Column 0 on the next row is the right edge of
  // the previous row, which is where the visual end handle belongs.
  if (end && col === 0 && row > 0) {
    col = term.cols;
    row--;
  }
  const viewportRow = row - term.buffer.active.viewportY;
  if (viewportRow < 0 || viewportRow >= term.rows) return undefined;
  return {
    left: screenRect.left - stageRect.left + (col / term.cols) * screenRect.width,
    top: screenRect.top - stageRect.top + ((viewportRow + 1) / term.rows) * screenRect.height,
  };
}

function selectionContainsCell(selection: MobileSelectionState, point: TerminalCellPoint, cols: number): boolean {
  const index = boundaryIndex(point, cols);
  return index >= boundaryIndex(selection.start, cols) && index < boundaryIndex(selection.end, cols);
}

/** Select the word under a pointer using only xterm's public buffer API. Doing this ourselves lets Roamcode
 *  reserve secondary-click for its context menu without leaking MouseDown3 into tmux/provider TUIs. */
function selectionForContextMenu(term: Terminal, host: HTMLElement, clientX: number, clientY: number): string {
  // Once the user deliberately selected a range, a slightly imprecise secondary-click must never replace it.
  // The menu snapshots this value, so Copy stays deterministic even if output arrives while the menu is open.
  const existing = term.getSelection();
  if (existing) return existing;

  const point = terminalCellAtPoint(term, host, clientX, clientY);
  if (!point) return "";

  const buffer = term.buffer.active;
  let firstRow = point.row;
  while (firstRow > 0 && buffer.getLine(firstRow)?.isWrapped) firstRow--;
  let lastRow = point.row;
  while (lastRow + 1 < buffer.length && buffer.getLine(lastRow + 1)?.isWrapped) lastRow++;

  const firstIndex = (point.row - firstRow) * term.cols + point.col;
  const cellAt = (index: number) => {
    if (index < 0) return undefined;
    const row = firstRow + Math.floor(index / term.cols);
    if (row > lastRow) return undefined;
    return buffer.getLine(row)?.getCell(index % term.cols);
  };
  const separators = term.options.wordSeparator ?? DEFAULT_WORD_SEPARATORS;
  const isWordCell = (index: number): boolean => {
    const cell = cellAt(index);
    if (!cell) return false;
    if (cell.getWidth() === 0) {
      // Continuation cells inherit the leading wide glyph's classification.
      let lead = index - 1;
      while (lead >= 0 && cellAt(lead)?.getWidth() === 0) lead--;
      return lead >= 0 && isWordCell(lead);
    }
    const chars = cell.getChars();
    return chars !== "" && !/\s/u.test(chars) && ![...chars].some((char) => separators.includes(char));
  };

  if (!isWordCell(firstIndex)) {
    term.clearSelection();
    return "";
  }
  let start = firstIndex;
  let end = firstIndex + Math.max(1, cellAt(firstIndex)?.getWidth() ?? 1);
  while (start > 0 && isWordCell(start - 1)) start--;
  while (isWordCell(end)) end++;
  const startRow = firstRow + Math.floor(start / term.cols);
  const startCol = start % term.cols;
  term.select(startCol, startRow, end - start);
  return term.getSelection();
}

function desktopMenuPosition(clientX: number, clientY: number): { x: number; y: number } {
  const margin = 8;
  const menuWidth = 204;
  const menuHeight = 126;
  const viewport = window.visualViewport;
  const left = viewport?.offsetLeft ?? 0;
  const top = viewport?.offsetTop ?? 0;
  const width = viewport?.width ?? window.innerWidth;
  const height = viewport?.height ?? window.innerHeight;
  return {
    x: Math.max(left + margin, Math.min(clientX, left + width - menuWidth - margin)),
    y: Math.max(top + margin, Math.min(clientY, top + height - menuHeight - margin)),
  };
}

/** XHR upload with real byte progress (fetch can't report upload progress). Posts to the same
 *  `/sessions/:id/upload` endpoint + Bearer token as the api client, resolving with the saved absolute path. */
function uploadWithProgress(
  sessionId: string,
  file: File,
  onProgress: (fraction: number) => void,
  derivedFromId?: string,
): { xhr: XMLHttpRequest; promise: Promise<{ path: string; file: Record<string, unknown> }> } {
  const xhr = new XMLHttpRequest();
  const promise = new Promise<{ path: string; file: Record<string, unknown> }>((resolve, reject) => {
    const endpoint = derivedFromId
      ? `${API_BASE_URL}/sessions/${encodeURIComponent(sessionId)}/files/${encodeURIComponent(derivedFromId)}/derive`
      : `${API_BASE_URL}/sessions/${encodeURIComponent(sessionId)}/upload`;
    xhr.open("POST", endpoint);
    const token = loadToken();
    if (token) xhr.setRequestHeader("authorization", `Bearer ${token}`);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText) as { path: string; file: Record<string, unknown> });
        } catch {
          reject(new Error("bad upload response"));
        }
      } else {
        reject(new Error(`upload failed (${xhr.status})`));
      }
    };
    xhr.onerror = () => reject(new Error("network error"));
    xhr.onabort = () => reject(new DOMException("Upload cancelled", "AbortError"));
    const form = new FormData();
    form.append("file", file, file.name);
    xhr.send(form);
  });
  return { xhr, promise };
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

/** A full dark theme so xterm never falls back to default ANSI colors / a black viewport seam. */
const THEME = {
  background: "#0a0a0b",
  foreground: "#cdd6e4",
  cursor: "#cdd6e4",
  cursorAccent: "#0b0e14",
  selectionBackground: "#2b2b31",
  // The clipboard menu takes focus while it is open. Keep the range visibly selected instead of making it
  // appear to vanish at precisely the moment the user is trying to copy it.
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

/** Copy text to the OS clipboard, ROBUSTLY: the async Clipboard API first, then a hidden-textarea
 *  execCommand('copy') fallback for when the async API is blocked/unavailable (older WebKit, a non-gesture
 *  call, a permissions quirk). Returns whether it landed. */
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

/** Renders a provider terminal TUI: xterm.js bridged to the binary terminal WebSocket.
 *  `createSocket` is injectable purely so the screenshot harness / tests can feed controlled bytes;
 *  production always uses the default real socket. */
export function canResumeConversation(session: SessionMeta): boolean {
  if (session.provider !== "codex") return true;
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

export function TerminalView({
  session,
  onShowSessions,
  needsYou,
  onClose,
  onOpenSettings,
  onSplitRight,
  onSplitDown,
  closeIsPane,
  dragPaneId,
  createSocket = createTerminalSocket,
}: {
  session: SessionMeta;
  onShowSessions?: () => void;
  needsYou?: number;
  /** Close/stop the session (header X + the "session ended" overlay's Close button). In split-screen the App
   *  wires this to close the PANE instead (with closeIsPane retitling the button) — the session keeps running. */
  onClose?: () => void;
  /** Open the session-scoped settings panel — forwarded straight to the header's gear. The App wires this;
   *  when absent the gear is simply not rendered. */
  onOpenSettings?: () => void;
  /** Desktop split-screen controls — forwarded to ChatHeader (buttons render only when provided). */
  onSplitRight?: () => void;
  onSplitDown?: () => void;
  closeIsPane?: boolean;
  /** Split-screen rearrange: the pane's leaf id — makes the header this pane's drag handle. */
  dragPaneId?: string;
  createSocket?: CreateSocket;
}) {
  const sessionId = session.id;
  const isCodex = session.provider === "codex";
  const providerLabel = isCodex ? "Codex" : "Claude Code";
  const providerCommand = isCodex ? "codex" : "claude";
  const canResume = canResumeConversation(session);
  const resumeHint = canResume
    ? isCodex
      ? "Resume reopens this exact Codex conversation; start fresh begins a new one."
      : "Resume reopens the last Claude Code conversation in this folder; if there is none, start fresh."
    : "The exact Codex conversation identity is unavailable, so Resume cannot safely continue it. Start fresh to begin a new conversation.";
  const hostRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | undefined>(undefined);
  const sockRef = useRef<TerminalSocket | undefined>(undefined);
  // A ref to the effect's `refit` closure so out-of-effect handlers (font zoom) can re-fit after changing the
  // font size, without re-running the whole terminal-setup effect.
  const refitRef = useRef<() => void>(() => {});
  // Ctrl/Alt are independent locks: refs drive xterm's long-lived handlers while state drives the persistent
  // toolbar highlight. They stay locked until explicitly toggled off (or this session view unmounts).
  const ctrlLockedRef = useRef(false);
  const [ctrlLocked, setCtrlLockedState] = useState(false);
  const setCtrlLocked = (v: boolean) => {
    ctrlLockedRef.current = v;
    setCtrlLockedState(v);
  };
  const altLockedRef = useRef(false);
  const [altLocked, setAltLockedState] = useState(false);
  const setAltLocked = (v: boolean) => {
    altLockedRef.current = v;
    setAltLockedState(v);
  };
  // Mobile selection stays on the LIVE xterm. Long-press creates the range; two touch handles adjust it; a
  // transparent guard keeps the provider from receiving taps while the retained selection is active.
  const [mobileSelection, setMobileSelection] = useState<MobileSelectionState | null>(null);
  const mobileSelectionRef = useRef<MobileSelectionState | null>(null);
  const commitMobileSelection = (next: MobileSelectionState | null) => {
    mobileSelectionRef.current = next;
    setMobileSelection(next);
  };
  const syncMobileSelectionRef = useRef<(menu?: { x: number; y: number } | null) => void>(() => {});
  const beginMobileSelectionRef = useRef<(clientX: number, clientY: number) => void>(() => {});
  const applyMobileHandleDragRef = useRef<(clientX: number, clientY: number) => void>(() => {});
  const handleDragRef = useRef<MobileHandleDrag | null>(null);
  const handleScrollTimerRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const guardPointerRef = useRef<{ pointerId: number; x: number; y: number } | null>(null);
  // Brief "Copied ✓" confirmation (explicit desktop Copy, or the mobile live-selection menu). setCopied + the ref
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
      handleDragRef.current = null;
    };
  }, [sessionId]);
  // Desktop secondary-click menu. The selection is snapshotted when it opens so output arriving in the live
  // terminal cannot silently change what the visible Copy action will write.
  const [contextMenu, setContextMenu] = useState<TerminalContextMenuState | null>(null);
  const [contextClipboardError, setContextClipboardError] = useState<"copy" | "paste" | null>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => setContextMenu(null), [sessionId]);
  useEffect(() => {
    if (!contextMenu) {
      setContextClipboardError(null);
      return undefined;
    }
    const focus = requestAnimationFrame(() => {
      contextMenuRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    });
    const dismiss = (event: Event) => {
      if (event.target instanceof Node && contextMenuRef.current?.contains(event.target)) return;
      setContextMenu(null);
    };
    document.addEventListener("pointerdown", dismiss, true);
    document.addEventListener("scroll", dismiss, true);
    window.addEventListener("wheel", dismiss, true);
    window.addEventListener("resize", dismiss);
    window.addEventListener("blur", dismiss);
    return () => {
      cancelAnimationFrame(focus);
      document.removeEventListener("pointerdown", dismiss, true);
      document.removeEventListener("scroll", dismiss, true);
      window.removeEventListener("wheel", dismiss, true);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("blur", dismiss);
    };
  }, [contextMenu]);
  // Manual text-entry box: separate from clipboard-menu Paste, which reads and sends the clipboard directly.
  // This remains the reliable fallback for typing, dictation, or a browser that denies clipboard-read access.
  const [pasteOpen, setPasteOpen] = useState(false);
  const pasteRef = useRef<HTMLTextAreaElement>(null);
  const pasteBoxRef = useRef<HTMLDivElement>(null);
  useFocusTrap(pasteBoxRef, pasteOpen); // keep Tab inside the paste modal while it's open (a11y)
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
  const [fileHistoryStatus, setFileHistoryStatus] = useState<"loading" | "ready" | "error">("loading");
  const [uploadError, setUploadError] = useState<string | undefined>();
  const [maxUploadBytes, setMaxUploadBytes] = useState(25 * 1024 * 1024);
  const [unreadReceived, setUnreadReceived] = useState(0);
  const [fileDragging, setFileDragging] = useState(false);
  const [editBatch, setEditBatch] = useState<{ files: File[]; index: number }>();
  const [existingEdit, setExistingEdit] = useState<{ record: TermFile; file: File }>();
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
      const token = loadToken();
      void fetch(`${API_BASE_URL}/sessions/${encodeURIComponent(sessionId)}/files`, {
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
    [sessionId],
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
  // Discoverability hint for the (non-obvious) two-finger scroll gesture. Touch devices only — desktop
  // scrolls with the wheel/trackpad natively. Shows on EVERY terminal open UNTIL the user's first two-finger
  // scroll marks it "learned" (then never again), capped at 6 opens so someone who never scrolls isn't
  // nagged forever. Auto-dismisses each time.
  const [showScrollHint, setShowScrollHint] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const coarse = window.matchMedia?.("(pointer: coarse)")?.matches;
    let learned = false;
    let shows = 0;
    try {
      learned = window.localStorage?.getItem("rc-scroll-hint-learned") === "1";
      shows = Number(window.localStorage?.getItem("rc-scroll-hint-shows") ?? 0) || 0;
    } catch {
      /* storage blocked (private mode) — just show it */
    }
    if (!coarse || learned || shows >= 6) return;
    const show = window.setTimeout(() => setShowScrollHint(true), 700);
    const hide = window.setTimeout(() => setShowScrollHint(false), 6000);
    try {
      window.localStorage?.setItem("rc-scroll-hint-shows", String(shows + 1));
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
    // Stamp the (re)spawn moment — an "ended" within QUICK_EXIT_MS of THIS reads as a boot-time death
    // (sign-out hint). Re-stamped on every restartKey remount, so each Restart gets a fresh window.
    spawnedAtRef.current = Date.now();
    // Both xterm's OSC 8 provider and the plain-text web-link addon below use this one activation path. The
    // serial lets mouse-mode arbitration ask xterm's link layer first and replay a click to the provider only
    // when no link actually handled it.
    let linkActivationSerial = 0;
    let primaryLinkGesture: { x: number; y: number; moved: boolean; selecting: boolean } | undefined;
    const activateTerminalLink = (_event: MouseEvent, uri: string): void => {
      // xterm 6 can call a link handler after a drag that started and ended inside the same link. RoamCode's
      // native contract is unambiguous: movement selects; only a stationary click/tap opens.
      if (primaryLinkGesture?.moved || primaryLinkGesture?.selecting) return;
      linkActivationSerial++;
      setLinkOpenError(!openTerminalWebLink(uri));
    };
    const term = new Terminal({
      cursorBlink: true,
      fontSize: fontSizeRef.current, // persisted zoom (A−/A+), clamped 10–20
      fontFamily: '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
      // Retain xterm's modifier override as a legacy fallback. Roamcode's desktop gesture arbitration below
      // makes ordinary drag select by default, so users never need to discover Option/Shift themselves.
      macOptionClickForcesSelection: true,
      // xterm paints its own background, so it can't inherit var(--bg) — follow the saved theme (OLED = #000).
      theme: { ...THEME, background: TERMINAL_BG[loadTheme()] },
      allowProposedApi: true,
      // OSC 8 can carry an arbitrary URI behind terminal text. Keep xterm's non-http(s) protection on and
      // route safe web links through the same opener as visible URLs.
      linkHandler: {
        activate: activateTerminalLink,
        allowNonHttpProtocols: false,
      },
      // A finite scrollback so the provider's NORMAL-buffer output (long errors, git diffs, results taller than the
      // viewport) stays scrollable. Its full-screen TUI uses the alt-screen (tmux owns that), unaffected.
      scrollback: 1000,
    });
    termRef.current = term;
    // Live theme switch (Settings → OLED toggle) restyles the OPEN terminal without a remount.
    const onThemeChange = (): void => {
      term.options.theme = { ...THEME, background: TERMINAL_BG[loadTheme()] };
    };
    window.addEventListener("rc-theme-change", onThemeChange);
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon(activateTerminalLink));
    term.open(host);
    // Stop mobile soft keyboards from mangling terminal input: no auto-capitalize/correct/complete/spellcheck
    // on xterm's hidden input textarea (otherwise "ls" → "Ls", flags/paths get autocorrected).
    const helper = host.querySelector<HTMLTextAreaElement>("textarea.xterm-helper-textarea");
    if (helper) {
      helper.setAttribute("autocapitalize", "off");
      helper.setAttribute("autocorrect", "off");
      helper.setAttribute("autocomplete", "off");
      helper.setAttribute("spellcheck", "false");
    }

    let disposed = false;
    let connected = false;
    const coarsePointer = typeof window !== "undefined" && !!window.matchMedia?.("(pointer: coarse)")?.matches;

    const activeLocks = (): TerminalModifiers => ({
      ctrl: ctrlLockedRef.current,
      alt: altLockedRef.current,
    });

    // Some mobile keyboards send a concrete Backspace keydown but no native repeats; others (notably
    // Gboard) send only keyCode=229 + beforeinput changes. Own the concrete path so one held key has a
    // deterministic cadence, and leave a one-event fallback token for the composition path.
    let backspaceDelay: ReturnType<typeof setTimeout> | undefined;
    let backspaceInterval: ReturnType<typeof setInterval> | undefined;
    let suppressDeleteBeforeInput = false;
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
    const startBackspaceRepeat = (sequence: string) => {
      stopBackspaceRepeat();
      sockRef.current?.sendInput(sequence);
      backspaceDelay = setTimeout(() => {
        backspaceInterval = setInterval(() => sockRef.current?.sendInput(sequence), 70);
      }, 380);
    };
    const onBeforeInput = (event: InputEvent) => {
      if (event.inputType !== "deleteContentBackward") return;
      if (suppressDeleteBeforeInput) {
        // The concrete keydown was already emitted by our repeat controller. Keep xterm's helper value from
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
          sockRef.current?.sendInput(keySequence("Backspace", false, pending.modifiers));
        }, 0),
      };
      pendingDeletes.push(pending);
    };
    helper?.addEventListener("beforeinput", onBeforeInput);
    helper?.addEventListener("blur", stopBackspaceRepeat);
    window.addEventListener("blur", stopBackspaceRepeat);
    const stopRepeatWhenHidden = () => document.hidden && stopBackspaceRepeat();
    document.addEventListener("visibilitychange", stopRepeatWhenHidden);

    // Renderer: xterm's DEFAULT (DOM). The WebGL addon rounds cells to integer device pixels → HiDPI fit
    // drift (the "kayık"/shift); the beta Canvas addon mis-sizes its backing store at HiDPI (everything
    // renders 2-3× and clips). The DOM renderer uses CSS-sized cells and renders correctly on every device.
    // (The logo's block glyphs come through intact now that the server runs tmux with `-u` + a UTF-8 locale.)

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
      // xterm's composition helper emits one DEL but RoamCode never starts its hold-repeat controller.
      if (coarsePointer && e.key === "Backspace") {
        e.preventDefault();
        e.stopPropagation();
        suppressDeleteBeforeInput = true;
        queueMicrotask(() => {
          suppressDeleteBeforeInput = false;
        });
        // Usually the first keydown has repeat=false. If an IME hides that first event and only exposes a
        // later repeated Backspace, adopt that event too as long as no RoamCode repeat is already active.
        if (!e.repeat || (backspaceDelay === undefined && backspaceInterval === undefined)) {
          const sequence = keyboardEventSequence(e, !!term.modes?.applicationCursorKeysMode, activeLocks());
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
      // Standard terminal copy contract: Cmd/Ctrl+C copies only when xterm has a selection. With no selection,
      // let xterm/provider receive Ctrl+C as interrupt exactly as before.
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "c" && term.hasSelection()) {
        e.preventDefault();
        e.stopPropagation();
        const selection = term.getSelection();
        void copyText(selection).then((ok) => ok && flashCopied());
        return false;
      }
      if (!ctrlLockedRef.current && !altLockedRef.current) return true;
      const sequence = keyboardEventSequence(e, !!term.modes?.applicationCursorKeysMode, activeLocks());
      if (sequence === undefined) return true;
      e.preventDefault();
      e.stopPropagation();
      sockRef.current?.sendInput(sequence);
      return false;
    });

    const refit = () => {
      if (disposed || host.clientHeight === 0) return;
      try {
        fit.fit();
      } catch {
        return;
      }
      sockRef.current?.sendResize(term.cols, term.rows);
      if (mobileSelectionRef.current) syncMobileSelectionRef.current();
    };
    refitRef.current = refit; // let the font-zoom handlers re-fit without re-running this effect

    // "Jump to latest" chip visibility: only when the NORMAL buffer (git diff / logs / raw shell — not the provider's
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
        fit.fit();
      } catch {
        return;
      }
      connected = true;
      const sock = createSocket({
        // An ASYNC THUNK, not a fixed string, so every reconnect fetches a fresh single-use WS TICKET (the
        // long-lived token stays out of WS URLs; terminalWsTicketUrl falls back to ?token= on any failure)
        // and re-reads the current fitted size. The respawn mode rides the same thunk: set only when the
        // ended overlay chose "Resume conversation" (respawn=continue).
        url: () => terminalWsTicketUrl(sessionId, term.cols, term.rows, respawnRef.current),
        onData: (bytes) => {
          if (!disposed) term.write(bytes);
        },
        onStatus: (s) => {
          if (disposed) return;
          if (s === "open") {
            setConnState("open");
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
      // If Gboard/xterm produced the delete associated with a pending beforeinput token, consume its fallback
      // timer and use this authoritative event. Otherwise the timer emits one DEL after the event turn.
      if ((d === "\x7f" || d === "\x08") && pendingDeletes.length > 0) {
        const pending = pendingDeletes.shift()!;
        clearTimeout(pending.timer);
      }
      const locks = activeLocks();
      sockRef.current?.sendInput(locks.ctrl || locks.alt ? modifiedDataSequence(d, locks) : d);
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
    // user taps the terminal to type, and a direct tap opens the keyboard on a STABLE layout, which never
    // freezes. Desktop has no soft keyboard, so it keeps auto-focus for immediate typing. healPaintBurst
    // still runs (arm + kicks) as a safety net for the layout swap itself.
    const focusAndHealPaint = () => {
      if (!coarsePointer) term.focus();
      healPaintBurst();
    };
    // Re-fit + refocus (and connect if we hadn't yet) when the tab/app returns to the foreground.
    const onVisible = () => {
      if (!document.hidden && !disposed) {
        tick();
        focusAndHealPaint();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    // Back online (e.g. phone woke / Wi-Fi↔cellular) → reconnect immediately instead of waiting out the
    // (up to 15s) backoff. reconnect() resets the backoff and rebuilds the URL with a fresh token.
    const onOnline = () => {
      if (!disposed) sockRef.current?.reconnect();
    };
    window.addEventListener("online", onOnline);
    focusAndHealPaint();

    // TWO-FINGER vertical drag → scroll. Two fingers so it NEVER conflicts with one-finger tap/interact.
    // Claude's alt-screen accepts PgUp/PgDn directly. Codex runs inline and tmux owns its scrollback, so send
    // the same SGR wheel events a trackpad emits; tmux scrolls the conversation in place. On a normal buffer
    // outside tmux's mouse handling, scroll xterm's own history. Fingers DOWN reveal older text.
    const SCROLL_STEP = 44;
    const SCROLLBACK_LINES = 3; // lines of xterm scrollback per step, on the normal buffer
    const avgY = (t: TouchList) => ((t[0]?.clientY ?? 0) + (t[1]?.clientY ?? 0)) / 2;
    let twoFingerY: number | null = null;
    let scrollAccum = 0;
    // The first real two-finger scroll = the user LEARNED the gesture → dismiss the hint + never show again.
    let scrollLearned = false;
    const markScrollLearned = () => {
      if (scrollLearned) return;
      scrollLearned = true;
      setShowScrollHint(false);
      try {
        window.localStorage?.setItem("rc-scroll-hint-learned", "1");
      } catch {
        /* ignore */
      }
    };
    // LONG-PRESS (one finger, held still ~500ms) selects the word directly on the LIVE terminal. Cancelled by
    // finger movement (>12px), a second finger (that's the scroll gesture), or lifting off. Once recognized,
    // prevent the compatibility click/context menu so the provider cannot immediately clear the new range.
    let lastTouchAt = 0;
    let lpTimer: ReturnType<typeof setTimeout> | undefined;
    let lpStart: { x: number; y: number } | undefined;
    let lpActivated = false;
    let tapStart: { x: number; y: number } | undefined;
    let tapEligible = false;
    // Assigned after the mouse replay helpers are created. Touch handlers run only after this effect has
    // finished, so a clean tap can ask xterm's real link provider without duplicating its URL parser.
    let activateLinkAtPoint: (clientX: number, clientY: number, source?: MouseEvent) => boolean = () => false;
    let primeLinkAtPoint: (clientX: number, clientY: number, source: MouseEvent) => void = () => undefined;
    const cancelLongPress = () => {
      if (lpTimer !== undefined) clearTimeout(lpTimer);
      lpTimer = undefined;
      lpStart = undefined;
    };
    const onTouchStart = (e: TouchEvent) => {
      lastTouchAt = Date.now();
      if (e.touches.length === 2) {
        cancelLongPress(); // two fingers = scroll, never a long-press
        tapEligible = false;
        tapStart = undefined;
        twoFingerY = avgY(e.touches);
        scrollAccum = 0;
      } else if (e.touches.length === 1) {
        const t = e.touches[0]!;
        lpActivated = false;
        tapEligible = true;
        tapStart = { x: t.clientX, y: t.clientY };
        lpStart = { x: t.clientX, y: t.clientY };
        lpTimer = setTimeout(() => {
          const start = lpStart;
          lpTimer = undefined;
          lpStart = undefined;
          if (!start) return;
          lpActivated = true;
          try {
            navigator.vibrate?.(10); // a tiny "got it" tick where supported (Android)
          } catch {
            /* no haptics — fine */
          }
          beginMobileSelectionRef.current(start.x, start.y);
        }, 500);
      }
    };
    const onTouchMove = (e: TouchEvent) => {
      if (lpActivated) {
        e.preventDefault();
        return;
      }
      // A moving finger is scrolling/using the TUI, not long-pressing.
      if (lpStart && e.touches.length === 1) {
        const t = e.touches[0]!;
        if (Math.hypot(t.clientX - lpStart.x, t.clientY - lpStart.y) > 12) {
          tapEligible = false;
          cancelLongPress();
        }
      }
      if (e.touches.length !== 2 || twoFingerY === null) return;
      tapEligible = false;
      e.preventDefault(); // claim the gesture from the browser's own two-finger scroll/zoom
      const y = avgY(e.touches);
      scrollAccum += y - twoFingerY;
      twoFingerY = y;
      const onAltScreen = term.buffer.active.type === "alternate";
      while (Math.abs(scrollAccum) >= SCROLL_STEP) {
        const up = scrollAccum > 0; // fingers moved DOWN → reveal older text
        if (isCodex) {
          // SGR mouse wheel up/down at cell 1,1. tmux mouse mode turns this into in-place copy-mode history;
          // its custom first-wheel binding enters AND moves, so the initial gesture is never swallowed.
          sockRef.current?.sendInput(up ? "\x1b[<64;1;1M" : "\x1b[<65;1;1M");
        } else if (onAltScreen) {
          sockRef.current?.sendInput(up ? "\x1b[5~" : "\x1b[6~"); // page the provider's own alt-screen pager
        } else {
          term.scrollLines(up ? -SCROLLBACK_LINES : SCROLLBACK_LINES); // scroll xterm's own scrollback
        }
        markScrollLearned();
        scrollAccum += up ? -SCROLL_STEP : SCROLL_STEP;
      }
    };
    const onTouchEnd = (e: TouchEvent) => {
      if (lpActivated) {
        e.preventDefault();
        e.stopPropagation();
        lpActivated = false;
      } else if (e.type !== "touchcancel" && e.touches.length === 0 && tapEligible && tapStart) {
        const touch = e.changedTouches[0];
        const clientX = touch?.clientX ?? tapStart.x;
        const clientY = touch?.clientY ?? tapStart.y;
        if (activateLinkAtPoint(clientX, clientY)) {
          // Suppress the compatibility mouse sequence: the link opened already, so focusing/sending the same
          // tap to the provider would be a surprising second action.
          e.preventDefault();
          e.stopPropagation();
        }
      }
      tapEligible = false;
      tapStart = undefined;
      cancelLongPress(); // lifting (or losing) a finger always ends a pending long-press
      if (e.touches.length < 2) twoFingerY = null;
    };
    host.addEventListener("touchstart", onTouchStart, { passive: true });
    host.addEventListener("touchmove", onTouchMove, { passive: false });
    host.addEventListener("touchend", onTouchEnd, { passive: false });
    host.addEventListener("touchcancel", onTouchEnd, { passive: false });
    const macPlatform = /Mac|iPhone|iPad|iPod/i.test(`${navigator.platform} ${navigator.userAgent}`);
    const isTouchCompatibilityEvent = () => Date.now() - lastTouchAt < 1_500;
    const isSecondaryMouse = (event: MouseEvent) =>
      event.button === 2 || (macPlatform && event.button === 0 && event.ctrlKey);

    // When a provider enables terminal mouse tracking, xterm normally sends every primary-button drag to the
    // provider and requires Option (macOS) / Shift (Windows/Linux) to select text. That emulator convention is
    // too hidden for a browser UI. Defer a primary down until we know whether it is a click or a drag: clicks are
    // replayed to the provider unchanged; a deliberate drag is replayed with xterm's force-selection modifier.
    // xterm then owns the real selection, including wrapped lines and drag-scrolling outside the viewport.
    const PRIMARY_DRAG_THRESHOLD = 4;
    const replayedMouseEvents = new WeakSet<Event>();
    type PendingPrimaryMouse = {
      down: MouseEvent;
      target: EventTarget;
      selecting: boolean;
      lastX: number;
      lastY: number;
    };
    let pendingPrimary: PendingPrimaryMouse | undefined;
    const dispatchMouse = (
      target: EventTarget,
      type: "mousedown" | "mousemove" | "mouseup",
      source: MouseEvent,
      overrides: MouseEventInit = {},
    ) => {
      const replay = new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        composed: true,
        screenX: source.screenX,
        screenY: source.screenY,
        clientX: source.clientX,
        clientY: source.clientY,
        ctrlKey: source.ctrlKey,
        shiftKey: source.shiftKey,
        altKey: source.altKey,
        metaKey: source.metaKey,
        button: source.button,
        buttons: source.buttons,
        relatedTarget: source.relatedTarget,
        detail: source.detail,
        ...overrides,
      });
      replayedMouseEvents.add(replay);
      target.dispatchEvent(replay);
    };
    primeLinkAtPoint = (clientX: number, clientY: number, source: MouseEvent): void => {
      const screen = host.querySelector<HTMLElement>(".xterm-screen");
      if (!screen) return;
      // Linkifier normally resolves on hover. Prime it at MouseDown as well so a URL that appeared underneath
      // an already-stationary pointer still opens on the first click.
      dispatchMouse(screen, "mousemove", source, { bubbles: false, clientX, clientY, button: 0, buttons: 0 });
    };
    activateLinkAtPoint = (clientX: number, clientY: number, source?: MouseEvent): boolean => {
      const screen = host.querySelector<HTMLElement>(".xterm-screen");
      if (!screen) return false;
      const seed =
        source ??
        new MouseEvent("mouseup", {
          bubbles: false,
          cancelable: true,
          composed: true,
          clientX,
          clientY,
          button: 0,
          buttons: 0,
        });
      const before = linkActivationSerial;
      // These events target xterm's screen without bubbling to its parent mouse-protocol listener. This lets
      // the official linkifier resolve wrapped URLs and activate them while guaranteeing tmux/provider never
      // receives MouseDown1 for a link.
      dispatchMouse(screen, "mousemove", seed, { bubbles: false, clientX, clientY, button: 0, buttons: 0 });
      dispatchMouse(screen, "mousedown", seed, { bubbles: false, clientX, clientY, button: 0, buttons: 1 });
      dispatchMouse(screen, "mouseup", seed, { bubbles: false, clientX, clientY, button: 0, buttons: 0 });
      return linkActivationSerial !== before;
    };
    const beginXtermSelection = (pending: PendingPrimaryMouse, move?: MouseEvent) => {
      dispatchMouse(pending.target, "mousedown", pending.down, {
        altKey: macPlatform || pending.down.altKey,
        shiftKey: !macPlatform || pending.down.shiftKey,
        button: 0,
        buttons: 1,
      });
      if (move) {
        dispatchMouse(pending.target, "mousemove", move, { button: 0, buttons: 1, detail: 0 });
      }
    };
    const removePrimaryDocumentListeners = () => {
      document.removeEventListener("mousemove", onPrimaryMouseMoveCapture, true);
      document.removeEventListener("mouseup", onPrimaryMouseUpCapture, true);
      window.removeEventListener("blur", onPrimaryMouseBlur);
    };
    const clearPendingPrimary = () => {
      removePrimaryDocumentListeners();
      pendingPrimary = undefined;
    };
    const onPrimaryMouseMoveCapture = (event: MouseEvent) => {
      const pending = pendingPrimary;
      if (!pending || replayedMouseEvents.has(event)) return;
      if (
        primaryLinkGesture &&
        Math.hypot(event.clientX - primaryLinkGesture.x, event.clientY - primaryLinkGesture.y) >= PRIMARY_DRAG_THRESHOLD
      ) {
        primaryLinkGesture.moved = true;
      }
      pending.lastX = event.clientX;
      pending.lastY = event.clientY;
      if (pending.selecting) return; // xterm's document listener now owns the rest of the drag.
      event.preventDefault();
      event.stopImmediatePropagation();
      if (
        Math.hypot(event.clientX - pending.down.clientX, event.clientY - pending.down.clientY) < PRIMARY_DRAG_THRESHOLD
      ) {
        return;
      }
      pending.selecting = true;
      beginXtermSelection(pending, event);
    };
    const onPrimaryMouseUpCapture = (event: MouseEvent) => {
      const pending = pendingPrimary;
      if (!pending || replayedMouseEvents.has(event)) return;
      if (pending.selecting) {
        // Keep this real mouseup alive so xterm finishes (and retains) its selection.
        clearPendingPrimary();
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      clearPendingPrimary();
      // No drag: links get first refusal through isolated xterm-screen events. Only a non-link click is
      // replayed to the provider, exactly once.
      const linkActivated = activateLinkAtPoint(event.clientX, event.clientY, event);
      if (!linkActivated) {
        dispatchMouse(pending.target, "mousedown", pending.down, { button: 0, buttons: 1 });
        dispatchMouse(pending.target, "mouseup", event, { button: 0, buttons: 0 });
      }
      primaryLinkGesture = undefined;
    };
    const onPrimaryMouseBlur = () => {
      const pending = pendingPrimary;
      if (!pending) return;
      clearPendingPrimary();
      if (pending.selecting) {
        // A release outside the browser may never produce mouseup; synthesize one so xterm drops its document
        // listeners without clearing the range it already painted.
        dispatchMouse(pending.target, "mouseup", pending.down, {
          clientX: pending.lastX,
          clientY: pending.lastY,
          button: 0,
          buttons: 0,
        });
      }
    };
    const onPrimaryMouseDownCapture = (event: MouseEvent) => {
      if (
        !replayedMouseEvents.has(event) &&
        event.button === 0 &&
        !isSecondaryMouse(event) &&
        !isTouchCompatibilityEvent()
      ) {
        primaryLinkGesture = {
          x: event.clientX,
          y: event.clientY,
          moved: false,
          // Double/triple-click and the legacy modifier route belong to xterm selection, even if the pointer
          // never moves. They must not also activate a link under the selected word.
          selecting: event.detail > 1 || (macPlatform ? event.altKey : event.shiftKey),
        };
        primeLinkAtPoint(event.clientX, event.clientY, event);
      }
      if (
        replayedMouseEvents.has(event) ||
        event.button !== 0 ||
        isSecondaryMouse(event) ||
        isTouchCompatibilityEvent() ||
        coarsePointer ||
        term.modes.mouseTrackingMode === "none"
      ) {
        return;
      }
      // Preserve xterm's legacy modifier route as a harmless fallback for users who already know it.
      if ((macPlatform && event.altKey) || (!macPlatform && event.shiftKey)) return;

      event.preventDefault();
      event.stopImmediatePropagation();
      term.focus();
      const pending: PendingPrimaryMouse = {
        down: event,
        target: event.target ?? host,
        selecting: false,
        lastX: event.clientX,
        lastY: event.clientY,
      };
      // Standard desktop semantics: double-click selects a word, triple-click selects a line immediately.
      if (event.detail === 2 || event.detail === 3) {
        beginXtermSelection(pending);
        return;
      }
      pendingPrimary = pending;
      document.addEventListener("mousemove", onPrimaryMouseMoveCapture, true);
      document.addEventListener("mouseup", onPrimaryMouseUpCapture, true);
      window.addEventListener("blur", onPrimaryMouseBlur);
    };
    const onLinkMouseMoveCapture = (event: MouseEvent) => {
      if (!primaryLinkGesture || event.buttons !== 1 || replayedMouseEvents.has(event)) return;
      if (
        Math.hypot(event.clientX - primaryLinkGesture.x, event.clientY - primaryLinkGesture.y) >= PRIMARY_DRAG_THRESHOLD
      ) {
        primaryLinkGesture.moved = true;
      }
    };
    const onLinkMouseUpCapture = (event: MouseEvent) => {
      if (event.button !== 0 || replayedMouseEvents.has(event) || !primaryLinkGesture) return;
      // The linkifier activates later in this same event dispatch (on .xterm-screen). Keep the gesture state
      // until then, then release it before the next task.
      queueMicrotask(() => {
        primaryLinkGesture = undefined;
      });
    };
    const onSelectedMouseMoveCapture = (event: MouseEvent) => {
      if (
        replayedMouseEvents.has(event) ||
        event.buttons !== 0 ||
        isTouchCompatibilityEvent() ||
        !term.hasSelection()
      ) {
        return;
      }
      // Claude can request ANY mouse tracking, where even a buttonless hover is emitted as terminal input.
      // xterm intentionally clears its selection on user input, so the first tiny pointer movement otherwise
      // erases the range before the user can reach the context menu. A visible selection owns hover until the
      // next click; dragging (buttons !== 0), wheel, keyboard input, and the context menu remain unchanged.
      event.preventDefault();
      event.stopImmediatePropagation();
    };

    // Desktop secondary-click is Roamcode chrome, not provider input. Claim MouseDown3 in CAPTURE phase so tmux
    // never receives it; then open our consistent Copy/Paste menu. contextmenu order differs by browser (before
    // mouseup on macOS, after it on Windows), so mouseup provides a Firefox/ordering fallback without double-open.
    let rightDown = false;
    let rightMenuOpened = false;
    const openContextMenuAt = (event: MouseEvent) => {
      const selection = selectionForContextMenu(term, host, event.clientX, event.clientY);
      const pos = desktopMenuPosition(event.clientX, event.clientY);
      setContextClipboardError(null);
      setContextMenu({ ...pos, selection });
      rightMenuOpened = true;
    };
    const onHostMouseDownCapture = (event: MouseEvent) => {
      if (!isSecondaryMouse(event) || isTouchCompatibilityEvent()) return;
      rightDown = true;
      rightMenuOpened = false;
      event.preventDefault();
      event.stopPropagation();
    };
    const onHostMouseUpCapture = (event: MouseEvent) => {
      if (!isSecondaryMouse(event) || !rightDown || isTouchCompatibilityEvent()) return;
      event.preventDefault();
      event.stopPropagation();
      if (!rightMenuOpened) openContextMenuAt(event);
      rightDown = false;
    };
    const onHostContextMenuCapture = (event: MouseEvent) => {
      // Touch long-press already owns live terminal selection; suppress the browser's competing callout.
      if (isTouchCompatibilityEvent()) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      if (!rightMenuOpened) openContextMenuAt(event);
    };
    host.addEventListener("mousedown", onPrimaryMouseDownCapture, true);
    host.addEventListener("mousemove", onLinkMouseMoveCapture, true);
    host.addEventListener("mouseup", onLinkMouseUpCapture, true);
    host.addEventListener("mousemove", onSelectedMouseMoveCapture, true);
    host.addEventListener("mousedown", onHostMouseDownCapture, true);
    host.addEventListener("mouseup", onHostMouseUpCapture, true);
    host.addEventListener("contextmenu", onHostContextMenuCapture, true);

    return () => {
      disposed = true;
      cancelLongPress();
      cancelAnimationFrame(raf);
      clearInterval(poll);
      stopBackspaceRepeat();
      clearPendingDeletes();
      helper?.removeEventListener("beforeinput", onBeforeInput);
      helper?.removeEventListener("blur", stopBackspaceRepeat);
      window.removeEventListener("blur", stopBackspaceRepeat);
      document.removeEventListener("visibilitychange", stopRepeatWhenHidden);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("rc-theme-change", onThemeChange);
      host.removeEventListener("touchstart", onTouchStart);
      host.removeEventListener("touchmove", onTouchMove);
      host.removeEventListener("touchend", onTouchEnd);
      host.removeEventListener("touchcancel", onTouchEnd);
      clearPendingPrimary();
      host.removeEventListener("mousedown", onPrimaryMouseDownCapture, true);
      host.removeEventListener("mousemove", onLinkMouseMoveCapture, true);
      host.removeEventListener("mouseup", onLinkMouseUpCapture, true);
      host.removeEventListener("mousemove", onSelectedMouseMoveCapture, true);
      host.removeEventListener("mousedown", onHostMouseDownCapture, true);
      host.removeEventListener("mouseup", onHostMouseUpCapture, true);
      host.removeEventListener("contextmenu", onHostContextMenuCapture, true);
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
  }, [sessionId, createSocket, restartKey]);

  // Bar keys preserve the CURRENT soft-keyboard state: mousedown prevention keeps an already-focused helper
  // focused, while the absence of a programmatic focus means a hidden keyboard stays hidden.
  const onBarKey = (label: string) => {
    const term = termRef.current;
    if (isCodex && (label === "PageUp" || label === "PageDown")) {
      const wheel = label === "PageUp" ? "\x1b[<64;1;1M" : "\x1b[<65;1;1M";
      sockRef.current?.sendInput(wheel.repeat(4)); // ~20 tmux history lines, without leaving the conversation
      return;
    }
    const appMode = !!term?.modes?.applicationCursorKeysMode;
    sockRef.current?.sendInput(keySequence(label, appMode, { ctrl: ctrlLockedRef.current, alt: altLockedRef.current }));
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
  // ---- Find bar (buffer search — chat/terminal-search.ts; NO xterm search addon, the lockfile stays put).
  // Matches live in state; navigation selects the hit via xterm's own selection (visible highlight for
  // free) and scrolls its row into view. The buffer is finite (scrollback 1000), so a full re-scan per
  // keystroke is cheap.
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchMatches, setSearchMatches] = useState<BufferMatch[]>([]);
  const [searchIdx, setSearchIdx] = useState(0);
  // Select + reveal one match. xterm's select() paints the standard selection rectangle — no custom
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
    handleDragRef.current = null;
    commitMobileSelection(null);
    if (clearTerminal) termRef.current?.clearSelection();
  };

  // Read xterm's authoritative selection after every programmatic select, viewport scroll, or external clear.
  // The range stays in buffer coordinates; handle pixels are derived at render time from the live screen rect.
  syncMobileSelectionRef.current = (menu) => {
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
      menu: menu === undefined ? current.menu : menu,
      clipboardError: null,
    });
  };

  beginMobileSelectionRef.current = (clientX, clientY) => {
    const term = termRef.current;
    const host = hostRef.current;
    if (!term || !host) return;
    // A search/desktop selection is not the user's new touch range. Start deterministically at the press.
    mobileSelectionRef.current = null;
    setMobileSelection(null);
    term.clearSelection();
    const word = selectionForContextMenu(term, host, clientX, clientY);
    if (!word) {
      const point = terminalCellAtPoint(term, host, clientX, clientY);
      if (!point) return;
      // Whitespace still needs an adjustable anchor. Copy remains disabled until the range contains text.
      term.select(
        point.col,
        point.row,
        Math.max(1, boundaryIndex(terminalCellEnd(term, point), term.cols) - boundaryIndex(point, term.cols)),
      );
    }
    const range = term.getSelectionPosition();
    if (!range) return;
    const next: MobileSelectionState = {
      start: { col: range.start.x, row: range.start.y },
      end: { col: range.end.x, row: range.end.y },
      text: term.getSelection(),
      menu: mobileMenuPosition(clientX, clientY),
      clipboardError: null,
    };
    commitMobileSelection(next);
    setContextMenu(null);
    setSearchOpen(false);
    setSearchMatches([]);
    term.blur();
    (document.activeElement as HTMLElement | null)?.blur?.();
  };

  const stopHandleScroll = () => {
    if (handleScrollTimerRef.current !== undefined) clearInterval(handleScrollTimerRef.current);
    handleScrollTimerRef.current = undefined;
    if (handleDragRef.current) handleDragRef.current.scrollDirection = 0;
  };

  applyMobileHandleDragRef.current = (clientX, clientY) => {
    const term = termRef.current;
    const host = hostRef.current;
    const drag = handleDragRef.current;
    if (!term || !host || !drag) return;
    drag.lastX = clientX;
    drag.lastY = clientY;
    const screen = host.querySelector<HTMLElement>(".xterm-screen");
    if (!screen) return;
    const rect = screen.getBoundingClientRect();
    const x = Math.max(rect.left, Math.min(clientX, rect.right - 0.5));
    const y = Math.max(rect.top, Math.min(clientY, rect.bottom - 0.5));
    const cell = terminalCellAtPoint(term, host, x, y);
    if (!cell) return;
    const fixedIndex = boundaryIndex(drag.fixed, term.cols);
    const cellStart = boundaryIndex(cell, term.cols);
    const cellEnd = boundaryIndex(terminalCellEnd(term, cell), term.cols);
    let movingIndex =
      cellEnd <= fixedIndex
        ? cellStart
        : cellStart >= fixedIndex
          ? cellEnd
          : drag.prefer === "start"
            ? cellStart
            : cellEnd;
    const maxBoundary = Math.max(1, term.buffer.active.length * term.cols);
    movingIndex = Math.max(0, Math.min(movingIndex, maxBoundary));
    if (movingIndex === fixedIndex)
      movingIndex = Math.max(0, Math.min(maxBoundary, fixedIndex + (drag.prefer === "start" ? -1 : 1)));
    if (movingIndex === fixedIndex) return;
    const ordered = orderedBoundaries(drag.fixed, boundaryFromIndex(movingIndex, term.cols), term.cols);
    term.select(ordered.start.col, ordered.start.row, ordered.length);
    syncMobileSelectionRef.current(null);

    const edge = 28;
    const direction: -1 | 0 | 1 =
      term.buffer.active.type !== "normal" ? 0 : clientY < rect.top + edge ? -1 : clientY > rect.bottom - edge ? 1 : 0;
    if (direction === drag.scrollDirection) return;
    stopHandleScroll();
    drag.scrollDirection = direction;
    if (direction !== 0) {
      handleScrollTimerRef.current = setInterval(() => {
        const active = handleDragRef.current;
        if (!active) return stopHandleScroll();
        term.scrollLines(direction);
        applyMobileHandleDragRef.current(active.lastX, active.lastY);
      }, 70);
    }
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
    handleDragRef.current = {
      pointerId: event.pointerId,
      fixed: edge === "start" ? selection.end : selection.start,
      prefer: edge,
      lastX: event.clientX,
      lastY: event.clientY,
      scrollDirection: 0,
    };
    commitMobileSelection({ ...selection, menu: null, clipboardError: null });
  };

  const moveHandle = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (handleDragRef.current?.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    applyMobileHandleDragRef.current(event.clientX, event.clientY);
  };

  const endHandleDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = handleDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    stopHandleScroll();
    handleDragRef.current = null;
    try {
      if (event.currentTarget.hasPointerCapture?.(event.pointerId))
        event.currentTarget.releasePointerCapture?.(event.pointerId);
    } catch {
      /* pointer capture is best effort on iOS */
    }
    syncMobileSelectionRef.current(mobileMenuPosition(event.clientX, event.clientY));
  };

  const copyMobileSelection = async () => {
    const selection = mobileSelectionRef.current;
    if (!selection || selection.text.trim() === "") return;
    const ok = await copyText(selection.text);
    if (!ok) {
      commitMobileSelection({ ...selection, clipboardError: "copy" });
      return;
    }
    commitMobileSelection({ ...selection, menu: null, clipboardError: null });
    flashCopied();
  };

  const sendBracketedText = (text: string) => {
    // Bracketed paste (\x1b[200~ … \x1b[201~) so the provider treats a multi-line prompt as ONE paste instead of
    // submitting on the first embedded newline — a raw send makes every \n an Enter, breaking long prompts.
    if (text) sockRef.current?.sendInput(`\x1b[200~${text}\x1b[201~`);
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
  // Inject the manual text-entry box contents into the terminal, then close + refocus.
  const sendComposedText = () => {
    sendBracketedText(pasteRef.current?.value ?? "");
    setPasteOpen(false);
    termRef.current?.focus();
  };
  const isMacDesktop =
    typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/i.test(`${navigator.platform} ${navigator.userAgent}`);
  const copyShortcut = isMacDesktop ? "⌘C" : "Ctrl+C";
  const selectModifierHint = isMacDesktop ? "⌥ + drag to select more" : "Shift + drag to select more";
  const copyContextSelection = async () => {
    const selection = contextMenu?.selection ?? "";
    if (!selection) return;
    const ok = await copyText(selection);
    if (!ok) {
      setContextClipboardError("copy");
      return;
    }
    setContextMenu(null);
    flashCopied();
    termRef.current?.focus();
  };
  const pasteFromContextMenu = async () => {
    const result = await readClipboardText();
    if (!result.ok) {
      setContextClipboardError("paste");
      return;
    }
    sendBracketedText(result.text);
    setContextMenu(null);
    termRef.current?.focus();
  };
  const onContextMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      setContextMenu(null);
      termRef.current?.focus();
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const items = Array.from(
      contextMenuRef.current?.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]:not(:disabled)') ?? [],
    );
    if (items.length === 0) return;
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? items.length - 1
          : event.key === "ArrowDown"
            ? (current + 1 + items.length) % items.length
            : (current - 1 + items.length) % items.length;
    items[next]?.focus();
  };
  const authHeaders = (): HeadersInit | undefined => {
    const token = loadToken();
    return token ? { authorization: `Bearer ${token}` } : undefined;
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
    setFilesOpen(true);
    setFiles((prev) => [placeholder, ...prev.filter((item) => item.id !== tempId)]);
    let cancelled = false;
    let running: XMLHttpRequest | undefined;
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
      );
      running = task.xhr;
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
    const editable = chosen.filter((file) => supportsImageEditing(file));
    const immediate = chosen.filter((file) => !editable.includes(file));
    for (const file of immediate) {
      if (isLikelyImage(file) && !supportsImageEditing(file)) {
        setUploadError(`${file.name} can't be edited safely in the browser; uploading the original`);
      }
      startUpload(file);
    }
    if (editable.length > 0) {
      setEditBatch((current) =>
        current ? { files: [...current.files, ...editable], index: current.index } : { files: editable, index: 0 },
      );
    }
  };

  const finishBatchImage = (file?: File) => {
    if (file) startUpload(file);
    setEditBatch((current) => {
      if (!current || current.index + 1 >= current.files.length) return undefined;
      return { ...current, index: current.index + 1 };
    });
  };

  const editStoredImage = async (record: TermFile) => {
    try {
      const response = await fetch(terminalFileContentUrl(sessionId, record.id));
      if (!response.ok) throw new Error("Image download failed");
      const blob = await response.blob();
      const file = new File([blob], record.name, { type: blob.type || record.mimeType || "image/jpeg" });
      if (!supportsImageEditing(file)) throw new Error("This image format can't be edited without losing data");
      setExistingEdit({ record, file });
    } catch (reason) {
      setUploadError(reason instanceof Error ? reason.message : "Couldn't open the image editor");
    }
  };

  const saveStoredImage = async (edited: File) => {
    const editing = existingEdit;
    setExistingEdit(undefined);
    if (!editing) return;
    if (editing.record.source !== "sent" || editing.record.storage !== "managed") {
      const dot = edited.name.lastIndexOf(".");
      const derivedName =
        dot > 0 ? `${edited.name.slice(0, dot)}-edited${edited.name.slice(dot)}` : `${edited.name}-edited`;
      startUpload(
        new File([edited], derivedName, { type: edited.type, lastModified: Date.now() }),
        undefined,
        editing.record.id,
      );
      return;
    }
    const form = new FormData();
    form.append("file", edited, editing.record.name);
    try {
      const response = await fetch(
        `${API_BASE_URL}/sessions/${encodeURIComponent(sessionId)}/files/${encodeURIComponent(editing.record.id)}/content`,
        { method: "PUT", headers: authHeaders(), body: form },
      );
      if (!response.ok) throw new Error(`Image save failed (${response.status})`);
      const body = (await response.json()) as { file: Record<string, unknown> };
      const item = normalizeTermFile(body.file);
      setFiles((prev) => [item, ...prev.filter((file) => file.id !== item.id)]);
      setUploadError(`${item.name} updated — use Prompt to reference it again`);
    } catch (reason) {
      setUploadError(reason instanceof Error ? reason.message : "Couldn't save the edited image");
    }
  };

  const patchFileVisibility = async (file: TermFile, hidden: boolean) => {
    if (hidden) setFiles((prev) => prev.filter((item) => item.id !== file.id));
    else setFiles((prev) => [file, ...prev.filter((item) => item.id !== file.id)]);
    try {
      const response = await fetch(
        `${API_BASE_URL}/sessions/${encodeURIComponent(sessionId)}/files/${encodeURIComponent(file.id)}`,
        {
          method: "PATCH",
          headers: { ...(authHeaders() ?? {}), "content-type": "application/json" },
          body: JSON.stringify({ hidden }),
        },
      );
      if (!response.ok) throw new Error("File update failed");
    } catch {
      setFiles((prev) => (hidden ? [file, ...prev] : prev.filter((item) => item.id !== file.id)));
      setUploadError("Couldn't update the file list");
    }
  };

  const deleteManagedFile = async (file: TermFile) => {
    setFiles((prev) => prev.filter((item) => item.id !== file.id));
    try {
      const response = await fetch(
        `${API_BASE_URL}/sessions/${encodeURIComponent(sessionId)}/files/${encodeURIComponent(file.id)}?content=true`,
        {
          method: "DELETE",
          headers: authHeaders(),
        },
      );
      if (!response.ok) throw new Error("Delete failed");
    } catch {
      setFiles((prev) => [file, ...prev]);
      setUploadError(`Couldn't delete ${file.name}`);
    }
  };

  const selectionStartHandle =
    mobileSelection && termRef.current && hostRef.current && stageRef.current
      ? boundaryPosition(termRef.current, hostRef.current, stageRef.current, mobileSelection.start, false)
      : undefined;
  const selectionEndHandle =
    mobileSelection && termRef.current && hostRef.current && stageRef.current
      ? boundaryPosition(termRef.current, hostRef.current, stageRef.current, mobileSelection.end, true)
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
        onOpenFiles={() => setFilesOpen(true)}
        filesCount={unreadReceived}
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
                    menu: mobileMenuPosition(event.clientX, event.clientY),
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
            {selectionStartHandle && (
              <button
                type="button"
                className="rc-term-touch-selection__handle rc-term-touch-selection__handle--start"
                aria-label="Adjust selection start"
                style={{ left: selectionStartHandle.left, top: selectionStartHandle.top }}
                onPointerDown={(event) => beginHandleDrag("start", event)}
                onPointerMove={moveHandle}
                onPointerUp={endHandleDrag}
                onPointerCancel={endHandleDrag}
              />
            )}
            {selectionEndHandle && (
              <button
                type="button"
                className="rc-term-touch-selection__handle rc-term-touch-selection__handle--end"
                aria-label="Adjust selection end"
                style={{ left: selectionEndHandle.left, top: selectionEndHandle.top }}
                onPointerDown={(event) => beginHandleDrag("end", event)}
                onPointerMove={moveHandle}
                onPointerUp={endHandleDrag}
                onPointerCancel={endHandleDrag}
              />
            )}
            {mobileSelection.menu && (
              <div
                className="rc-term-touch-selection__menu"
                role="menu"
                aria-label="Mobile terminal clipboard menu"
                style={{ left: mobileSelection.menu.x, top: mobileSelection.menu.y }}
              >
                <button
                  type="button"
                  role="menuitem"
                  disabled={mobileSelection.text.trim() === ""}
                  onClick={() => void copyMobileSelection()}
                >
                  Copy
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
        {contextMenu && (
          <div
            ref={contextMenuRef}
            className="rc-term-context"
            role="menu"
            aria-label="Terminal clipboard menu"
            style={{ left: contextMenu.x, top: contextMenu.y }}
            onKeyDown={onContextMenuKeyDown}
          >
            <button
              type="button"
              role="menuitem"
              className="rc-term-context__item"
              disabled={!contextMenu.selection}
              onClick={() => void copyContextSelection()}
            >
              <span>Copy</span>
              <kbd>{copyShortcut}</kbd>
            </button>
            <button
              type="button"
              role="menuitem"
              className="rc-term-context__item"
              onClick={() => void pasteFromContextMenu()}
            >
              <span>Paste</span>
              <kbd>{isMacDesktop ? "⌘V" : "Ctrl+V"}</kbd>
            </button>
            <div
              className={`rc-term-context__hint${contextClipboardError ? " is-error" : ""}`}
              role={contextClipboardError ? "status" : undefined}
            >
              {contextClipboardError === "copy"
                ? `Copy failed — press ${copyShortcut}`
                : contextClipboardError === "paste"
                  ? "Paste failed — allow clipboard access"
                  : selectModifierHint}
            </div>
          </div>
        )}
        {/* Floating view controls (top-right): font zoom + a keyboard-dismiss (mobile only). preventDefault on
            mousedown keeps the on-screen keyboard up for zoom; the dismiss button intentionally lets the blur
            through (and blurs the terminal) so the user can reclaim reading space. */}
        <div className="rc-term-tools" role="group" aria-label="Terminal view controls">
          {/* Find in the terminal buffer — toggles the compact find bar (top-left). Highlighted while open. */}
          <button
            type="button"
            className={`rc-term-tool${searchOpen ? " is-on" : ""}`}
            aria-label="Search the terminal"
            aria-pressed={searchOpen}
            title="Search the terminal"
            onMouseDown={(e) => e.preventDefault()}
            onClick={toggleSearch}
          >
            <Icon name="search" size={15} />
          </button>
          <button
            type="button"
            className="rc-term-tool"
            aria-label="Smaller text"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => changeFont(-1)}
            disabled={fontSize <= 10}
          >
            A−
          </button>
          <button
            type="button"
            className="rc-term-tool"
            aria-label="Larger text"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => changeFont(1)}
            disabled={fontSize >= 20}
          >
            A+
          </button>
          <button
            type="button"
            className="rc-term-tool rc-term-tool--kbd"
            aria-label="Hide keyboard"
            onClick={dismissKeyboard}
          >
            <Icon name="chevron-down" size={16} />
          </button>
        </div>
        {/* The find bar — compact, top-left of the stage (the tools cluster owns top-right). The input keeps
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
        {showScrollHint && (
          <button
            type="button"
            className="rc-term-hint"
            aria-label="Scroll the terminal with two fingers. Tap to dismiss."
            onClick={() => setShowScrollHint(false)}
          >
            <svg
              className="rc-term-hint__gesture"
              width="22"
              height="26"
              viewBox="0 0 22 26"
              fill="none"
              aria-hidden="true"
            >
              <path
                d="M7 6l4-3.5 4 3.5M7 20l4 3.5 4-3.5"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinecap="round"
                strokeLinejoin="round"
                opacity="0.5"
              />
              <g className="rc-term-hint__fingers">
                <circle cx="8" cy="13" r="2.6" fill="currentColor" />
                <circle cx="14" cy="13" r="2.6" fill="currentColor" />
              </g>
            </svg>
            <span>Scroll with two fingers</span>
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
              <div className="rc-term-ended__title">{providerLabel} exited</div>
              <div className="rc-term-ended__sub">The terminal session ended.</div>
              {/* Boot-time death (< QUICK_EXIT_MS after (re)spawn) often means the provider CLI is signed out.
                  Say so — otherwise Resume/Start fresh can just loop here. */}
              {quickExit && (
                <div className="rc-term-ended__warn" role="status">
                  {providerLabel} may be signed out on the host — run <code>{providerCommand}</code> there or check
                  Settings → {providerLabel} account.
                </div>
              )}
              <div className="rc-term-ended__actions">
                {/* Resume is offered only when this session's provider identity can be continued safely.
                    Start fresh always creates a clean provider conversation. */}
                <button
                  type="button"
                  className="rc-term-ended__primary"
                  disabled={!canResume}
                  onClick={() => canResume && restart("continue")}
                >
                  Resume conversation
                </button>
                <button type="button" className="rc-term-ended__ghost" onClick={() => restart()}>
                  Start fresh
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
      <TerminalKeyBar
        ctrlLocked={ctrlLocked}
        onToggleCtrl={() => {
          setCtrlLocked(!ctrlLockedRef.current);
        }}
        altLocked={altLocked}
        onToggleAlt={() => {
          setAltLocked(!altLockedRef.current);
        }}
        onKey={onBarKey}
        onCompose={() => setPasteOpen(true)}
      />
      {pasteOpen && (
        <div
          ref={pasteBoxRef}
          className="rc-paste"
          role="dialog"
          aria-modal="true"
          aria-label="Type or paste text to send to the terminal"
          onKeyDown={(e) => {
            if (e.key === "Escape") setPasteOpen(false); // Escape closes (keyboard a11y)
          }}
          onPointerDown={(e) => {
            if (e.target === e.currentTarget) setPasteOpen(false); // tap the backdrop to cancel
          }}
        >
          <div className="rc-paste__card">
            {/* A natural-language COMPOSE box (a provider prompt), NOT the terminal — so keep the FULL iOS
                keyboard: dictation / voice typing, the QuickType predictive bar, and autocorrect. Suppressing
                autocorrect/spellcheck the way we must on xterm's own helper textarea ALSO hides the mic +
                QuickType, which the user needs here — so use browser defaults (all of those on). */}
            <textarea
              ref={pasteRef}
              className="rc-paste__input"
              placeholder="Type or paste text, then Send…"
              autoFocus
              rows={2}
              onInput={(e) => {
                // Auto-grow with the content (up to ~42% of the viewport, then scroll): a short note stays a
                // small box, a long prompt expands — instead of a fixed 4-row block. Fires on typing AND paste.
                const el = e.currentTarget;
                el.style.height = "auto";
                el.style.height = `${Math.min(el.scrollHeight, Math.round(window.innerHeight * 0.42))}px`;
              }}
            />
            <div className="rc-paste__row">
              <button type="button" className="rc-paste__btn" onClick={() => setPasteOpen(false)}>
                Cancel
              </button>
              <button type="button" className="rc-paste__btn rc-paste__btn--send" onClick={sendComposedText}>
                Send
              </button>
            </div>
          </div>
        </div>
      )}
      <TerminalFiles
        files={files}
        open={filesOpen}
        historyStatus={fileHistoryStatus}
        onClose={() => setFilesOpen(false)}
        onRetryHistory={loadFileHistory}
        onUpload={onUploadFiles}
        unreadReceived={unreadReceived}
        contentUrl={(file, disposition) => terminalFileContentUrl(sessionId, file.id, disposition)}
        onMarkReceivedSeen={() => {
          setUnreadReceived(0);
          seenReceivedAtRef.current = Date.now();
          try {
            window.localStorage.setItem(`rc-files-seen:${sessionId}`, String(seenReceivedAtRef.current));
          } catch {
            /* ignore */
          }
        }}
        onAddToPrompt={(file) => sendBracketedText(`Attached file: ${JSON.stringify(file.path)} `)}
        onEdit={(file) => void editStoredImage(file)}
        onCancel={(file) => uploadsRef.current.get(file.id)?.abort()}
        onRetry={(file) => {
          if (file.localFile) startUpload(file.localFile, file.id);
        }}
        onHide={(file) => void patchFileVisibility(file, true)}
        onRestore={(file) => void patchFileVisibility(file, false)}
        onDelete={(file) => void deleteManagedFile(file)}
      />
      {editBatch && (
        <ImageEditorModal
          key={`${editBatch.index}:${editBatch.files[editBatch.index]?.name}`}
          file={editBatch.files[editBatch.index]!}
          index={editBatch.index}
          total={editBatch.files.length}
          maxBytes={maxUploadBytes}
          onRemove={() => finishBatchImage()}
          onUseOriginal={() => finishBatchImage(editBatch.files[editBatch.index])}
          onSave={finishBatchImage}
        />
      )}
      {existingEdit && (
        <ImageEditorModal
          key={existingEdit.record.id}
          file={existingEdit.file}
          index={0}
          total={1}
          maxBytes={maxUploadBytes}
          onRemove={() => setExistingEdit(undefined)}
          onUseOriginal={() => setExistingEdit(undefined)}
          onSave={(file) => void saveStoredImage(file)}
        />
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

const terminalCss = `
/* Manual text-entry box — type, dictate, or paste here, then Send injects it into the terminal. Clipboard-menu
   Paste bypasses this modal. Anchored near the TOP so the on-screen keyboard never covers it. */
.rc-paste {
  position: fixed; inset: 0; z-index: 60;
  display: flex; align-items: flex-start; justify-content: center;
  padding: calc(9vh + env(safe-area-inset-top, 0px)) 16px 0;
  background: var(--scrim);
}
.rc-paste__card {
  width: 100%; max-width: 560px;
  display: flex; flex-direction: column; gap: 12px;
  background: var(--surface); border: 1px solid var(--border-strong);
  border-radius: var(--radius-lg); box-shadow: var(--shadow); padding: 14px;
}
.rc-paste__input {
  width: 100%; min-height: 56px; max-height: 42vh; resize: none; overflow-y: auto;
  background: var(--surface-2); color: var(--text);
  border: 1px solid var(--border); border-radius: var(--radius); padding: 12px 14px;
  font: 400 16px/1.5 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  transition: border-color 120ms ease, box-shadow 120ms ease;
}
.rc-paste__input::placeholder { color: var(--text-faint); }
.rc-paste__input:focus { outline: none; border-color: var(--coral); box-shadow: var(--focus-glow); }
.rc-paste__row { display: flex; justify-content: flex-end; gap: 8px; }
.rc-paste__btn {
  min-height: 42px; padding: 0 20px; border-radius: var(--radius);
  border: 1px solid var(--border-strong); background: var(--surface-2); color: var(--text);
  font-weight: 600; font-size: 15px; cursor: pointer;
  transition: filter 120ms ease, background 120ms ease;
}
.rc-paste__btn:active { filter: brightness(1.12); }
.rc-paste__btn--send { background: var(--coral); color: var(--on-accent); border-color: var(--coral); padding: 0 24px; }
.rc-terminal {
  display: flex; flex-direction: column; height: 100%; min-height: 0;
  background: var(--bg);
}
/* The stage is the flex-fill region + the positioning context for the reconnect/ended overlays. */
.rc-terminal__stage { position: relative; flex: 1 1 auto; min-height: 0; }
.rc-terminal__stage.is-file-dragging { outline: 2px dashed var(--coral); outline-offset: -8px; }
.rc-terminal__filedrop { position: absolute; inset: 12px; z-index: 18; display: flex; align-items: center; justify-content: center; gap: 10px; border: 1px solid color-mix(in srgb,var(--coral) 58%,transparent); border-radius: 14px; background: color-mix(in srgb,var(--bg) 84%,transparent); color: var(--coral); -webkit-backdrop-filter: blur(8px); backdrop-filter: blur(8px); pointer-events: none; font: 700 13px/1 "JetBrains Mono",monospace; }
.rc-terminal__host {
  position: absolute; inset: 0;
  overflow: hidden;
  /* Isolate xterm's (heavy, many-node) rendering into its own layout/paint scope so a recomposite of the
     terminal doesn't cascade across the whole app — helps iOS Safari repaint the session-select transition. */
  contain: layout paint;
}
/* Desktop secondary-click menu — compact native-terminal semantics in Roamcode's flat surface language. */
.rc-term-context {
  position: fixed; z-index: 100; width: 196px;
  display: flex; flex-direction: column; gap: 2px; padding: 4px;
  background: var(--surface-2); border: 1px solid var(--border-strong);
  border-radius: 10px; box-shadow: var(--shadow-1); color: var(--text);
  user-select: none; -webkit-user-select: none;
}
.rc-term-context__item {
  width: 100%; min-height: 34px; padding: 0 9px; border: none; border-radius: 7px;
  display: flex; align-items: center; justify-content: space-between; gap: 14px;
  background: transparent; color: var(--text); cursor: pointer; text-align: left;
  font: 500 13px/1 var(--font-body);
}
.rc-term-context__item:hover, .rc-term-context__item:focus-visible {
  outline: none; background: var(--surface-3);
}
.rc-term-context__item:disabled { color: var(--text-faint); cursor: default; background: transparent; }
.rc-term-context__item kbd {
  color: var(--text-faint); font: 500 11px/1 var(--font-mono); white-space: nowrap;
}
.rc-term-context__hint {
  margin-top: 2px; padding: 7px 9px 6px; border-top: 1px solid var(--border);
  color: var(--text-faint); font: 500 10.5px/1.25 var(--font-mono);
}
.rc-term-context__hint.is-error { color: var(--warn); }
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
  margin-left: 2px; padding: 3px 9px; border-radius: 999px; cursor: pointer;
  border: 1px solid var(--border-strong); background: var(--surface-3); color: var(--text);
  font: 600 12px/1 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
}
.rc-term-toast__btn:active { background: var(--coral); color: var(--on-accent); border-color: var(--coral); }
@keyframes rc-term-pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.3; } }
/* One-time two-finger-scroll hint — a small coral-accented pill, bottom-center, whose two "fingers" bob to
   demonstrate the motion. Fades in, holds, fades out over ~5s; tap dismisses early. Shown once ever. */
.rc-term-hint {
  position: absolute; left: 50%; bottom: 14px; z-index: 6;
  display: flex; align-items: center; gap: 9px;
  padding: 8px 14px 8px 11px; border-radius: 999px; cursor: pointer;
  background: var(--surface-2); border: 1px solid var(--coral); color: var(--text);
  font: 600 12.5px/1 var(--font-body); text-align: left;
  box-shadow: 0 6px 22px rgba(0,0,0,0.45);
  animation: rc-hint-life 5300ms ease both;
}
.rc-term-hint__gesture { color: var(--coral); flex: none; }
.rc-term-hint__fingers { animation: rc-hint-bob 1.5s ease-in-out infinite; transform-box: fill-box; transform-origin: center; }
@keyframes rc-hint-bob { 0%, 100% { transform: translateY(-2.5px); } 50% { transform: translateY(2.5px); } }
@keyframes rc-hint-life {
  0% { opacity: 0; transform: translate(-50%, 10px); }
  9%, 88% { opacity: 1; transform: translate(-50%, 0); }
  100% { opacity: 0; transform: translate(-50%, 6px); }
}
@media (prefers-reduced-motion: reduce) { .rc-term-hint__fingers { animation: none; } }
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
  min-height: 38px; padding: 0 16px; border-radius: 9px; cursor: pointer;
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
  max-width: 88%; padding: 8px 14px; border-radius: 10px; cursor: pointer;
  background: rgba(217,164,65,0.12); border: 1px solid var(--warn); color: var(--warn);
  font: 500 12px/1.3 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
}
.rc-term-linkerr { bottom: 98px; }
/* The padding lives on .xterm (NOT the host): FitAddon reads padding from the terminal element, so padding
   on the host was never subtracted from the grid math → the right column / bottom row got clipped ("shifted"). */
.rc-terminal__host .xterm { height: 100%; box-sizing: border-box; padding: 6px; }
/* Neutralize global text styling the terminal must not inherit: body sets letter-spacing: 0.1px, which a
   character grid must never have (it drifts the columns) — matters for the DOM fallback renderer. */
.rc-terminal__host .xterm, .rc-terminal__host .xterm * { letter-spacing: normal; }
/* xterm.css hardcodes the viewport background to #000; match the theme so there's no black seam on resize. */
.rc-terminal__host .xterm-viewport { background-color: var(--bg) !important; }
/* Mobile live selection: an invisible guard retains the xterm range without letting a dismissing tap leak into
   the provider. The visible handles sit on xterm's real start/end boundaries and keep 44px touch targets. */
.rc-term-touch-selection__guard {
  position: absolute; inset: 0; z-index: 7;
  background: transparent; touch-action: none;
  user-select: none; -webkit-user-select: none; -webkit-touch-callout: none;
}
.rc-term-touch-selection__handle {
  position: absolute; z-index: 8; width: 44px; height: 44px; padding: 0;
  transform: translate(-50%, -22px); border: none; background: transparent;
  touch-action: none; user-select: none; -webkit-user-select: none; -webkit-touch-callout: none;
}
.rc-term-touch-selection__handle::before {
  content: ""; position: absolute; left: 50%; top: 50%; width: 13px; height: 13px;
  transform: translate(-50%, -50%); border-radius: 999px;
  background: var(--coral); border: 2px solid var(--bg); box-shadow: 0 2px 8px rgba(0,0,0,0.55);
}
.rc-term-touch-selection__handle::after {
  content: ""; position: absolute; left: calc(50% - 1px); top: 4px; width: 2px; height: 13px;
  border-radius: 2px; background: var(--coral); box-shadow: 0 0 0 1px var(--bg);
}
.rc-term-touch-selection__handle--end::after { top: 27px; }
.rc-term-touch-selection__menu {
  position: fixed; z-index: 100; width: 244px; padding: 4px;
  display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 2px;
  background: var(--surface-2); border: 1px solid var(--border-strong);
  border-radius: 11px; box-shadow: var(--shadow-1); color: var(--text);
  user-select: none; -webkit-user-select: none;
}
.rc-term-touch-selection__menu button {
  min-width: 0; min-height: 42px; padding: 0 8px; border: none; border-radius: 8px;
  background: transparent; color: var(--text); touch-action: manipulation;
  font: 600 13px/1 var(--font-body); cursor: pointer;
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

/* Termux-style extra-keys bar: TWO rows of flat, evenly-spread keys (no boxes) pinned below the terminal,
   with a safe-area inset so it clears the iOS home indicator / sits above the on-screen keyboard. Compact —
   thin rows, all keys visible at once, no horizontal scrolling. */
.rc-termkeys {
  flex: 0 0 auto;
  padding: 3px 4px calc(3px + var(--kb-safe-bottom, env(safe-area-inset-bottom, 0px)));
  background: var(--surface); border-top: 1px solid var(--border);
}
.rc-termkeys__grid {
  display: grid; grid-template-columns: minmax(0, 6fr) minmax(0, 1fr);
  grid-template-rows: repeat(2, 28px); gap: 2px;
}
.rc-termkeys__row { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 2px; }
.rc-tk__key {
  height: 28px; padding: 0; margin: 0; border: none; border-radius: 6px;
  background: transparent; color: var(--text-muted);
  font: 600 12.5px/1 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  letter-spacing: 0.2px; white-space: nowrap;
  cursor: pointer; -webkit-tap-highlight-color: transparent;
  /* touch-action:none + no callout/selection so a PRESS-AND-HOLD (arrow auto-repeat) isn't hijacked by iOS
     into a scroll/long-press → a pointercancel that would kill the repeat. */
  user-select: none; -webkit-user-select: none; -webkit-touch-callout: none; touch-action: none;
}
.rc-tk__key--compose { grid-column: 2; grid-row: 1 / span 2; height: auto; }
.rc-tk__key:active { background: var(--surface-2); color: var(--text); }
.rc-tk__key.is-on { background: var(--coral); color: var(--on-accent); }
/* The on-screen key bar exists for devices WITHOUT a physical keyboard. Hide it only where the PRIMARY
   pointer is a mouse/trackpad (a real desktop) — keyed off INPUT TYPE, not width, so a FOLDABLE phone
   (wide when unfolded but still touch, even with an S-Pen as a secondary pointer) keeps the keys. */
@media (hover: hover) and (pointer: fine) { .rc-termkeys { display: none; } }
/* Floating view controls (top-right of the stage): font zoom + keyboard-dismiss. Dim at rest so they never
   fight the terminal content; brighten on interaction. */
.rc-term-tools {
  position: absolute; top: 8px; right: 8px; z-index: 5;
  display: flex; gap: 3px; padding: 3px; border-radius: 10px;
  background: var(--surface-2); border: 1px solid var(--border); box-shadow: 0 4px 16px rgba(0,0,0,0.4);
  opacity: 0.55; transition: opacity 120ms ease;
}
.rc-term-tools:hover, .rc-term-tools:focus-within, .rc-term-tools:active { opacity: 1; }
.rc-term-tool {
  min-width: 30px; height: 28px; padding: 0 6px; border: none; border-radius: 7px;
  background: transparent; color: var(--text-muted);
  font: 700 13px/1 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  display: grid; place-items: center; cursor: pointer;
  touch-action: manipulation; -webkit-tap-highlight-color: transparent;
}
.rc-term-tool:active { background: var(--surface-3); color: var(--text); }
.rc-term-tool:disabled { opacity: 0.4; cursor: default; }
/* The search tool reads "on" while its find bar is open (same accent convention as the key bar's Ctrl). */
.rc-term-tool.is-on { background: var(--coral); color: var(--on-accent); }
/* Find bar — a compact pill top-LEFT of the stage (the tools cluster owns top-right). Input + count +
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
  flex: 1 1 auto; min-width: 84px; width: 150px; min-height: 28px;
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
  flex: none; min-width: 28px; height: 28px; padding: 0 4px; border: none; border-radius: 7px;
  background: transparent; color: var(--text-muted);
  font: 700 13px/1 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  display: grid; place-items: center; cursor: pointer;
  touch-action: manipulation; -webkit-tap-highlight-color: transparent;
}
.rc-term-find__btn:active { background: var(--surface-3); color: var(--text); }
.rc-term-find__btn:disabled { opacity: 0.4; cursor: default; }
/* No soft-keyboard dismiss control is needed on a real desktop. */
@media (hover: hover) and (pointer: fine) { .rc-term-tool--kbd { display: none; } }
/* "Jump to latest" chip — shown only when the normal-buffer scrollback is scrolled up; snaps to bottom. */
.rc-term-jump {
  position: absolute; right: 12px; bottom: 14px; z-index: 6;
  display: inline-flex; align-items: center; gap: 5px;
  padding: 7px 12px 7px 9px; border-radius: 999px; cursor: pointer;
  background: var(--coral); color: var(--on-accent); border: none;
  font: 700 12px/1 var(--font-body); box-shadow: 0 6px 22px rgba(0,0,0,0.45);
  animation: rc-jump-in 160ms ease both;
}
@keyframes rc-jump-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
`;
