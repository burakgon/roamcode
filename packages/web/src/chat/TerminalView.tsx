import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { createTerminalSocket, type TerminalSocket } from "../ws/terminal-socket";
type CreateSocket = typeof createTerminalSocket;
import { terminalWsTicketUrl, terminalDownloadUrl, type RespawnMode } from "../api/client";
import { loadToken } from "../auth/token-store";
import { API_BASE_URL } from "../config";
import { searchBuffer, type BufferMatch } from "./terminal-search";
import { TerminalKeyBar } from "./TerminalKeyBar";
import { TerminalFiles, type TermFile } from "./TerminalFiles";
import { ChatHeader } from "./ChatHeader";
import { Icon } from "../ui/Icon";
import { keySequence, ctrlSeq } from "./terminal-keys";
import { healPaintBurst } from "../pwa/viewport";
import { loadTheme, TERMINAL_BG } from "../pwa/theme";
import { useFocusTrap } from "../ui/useFocusTrap";
import type { SessionMeta } from "../types/server";

/** XHR upload with real byte progress (fetch can't report upload progress). Posts to the same
 *  `/sessions/:id/upload` endpoint + Bearer token as the api client, resolving with the saved absolute path. */
function uploadWithProgress(
  sessionId: string,
  file: File,
  onProgress: (fraction: number) => void,
): Promise<{ path: string }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${API_BASE_URL}/sessions/${encodeURIComponent(sessionId)}/upload`);
    const token = loadToken();
    if (token) xhr.setRequestHeader("authorization", `Bearer ${token}`);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText) as { path: string });
        } catch {
          reject(new Error("bad upload response"));
        }
      } else {
        reject(new Error(`upload failed (${xhr.status})`));
      }
    };
    xhr.onerror = () => reject(new Error("network error"));
    const form = new FormData();
    form.append("file", file, file.name);
    xhr.send(form);
  });
}

/** An "ended" this soon after the (re)spawn means the provider died straight away — on this host that often
 *  means the provider CLI is signed out — so the ended overlay adds an authentication hint. Purely
 *  client-side timing; no server signal exists for the exit reason. */
const QUICK_EXIT_MS = 10_000;
const MAX_PROVIDER_SESSION_ID = 2_048;

/** A full dark theme so xterm never falls back to default ANSI colors / a black viewport seam. */
const THEME = {
  background: "#0a0a0b",
  foreground: "#cdd6e4",
  cursor: "#cdd6e4",
  cursorAccent: "#0b0e14",
  selectionBackground: "#2b2b31",
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
  const termRef = useRef<Terminal | undefined>(undefined);
  const sockRef = useRef<TerminalSocket | undefined>(undefined);
  // A ref to the effect's `refit` closure so out-of-effect handlers (font zoom) can re-fit after changing the
  // font size, without re-running the whole terminal-setup effect.
  const refitRef = useRef<() => void>(() => {});
  // Sticky Ctrl: a ref drives the keydown handler (set once), state drives the button highlight.
  const ctrlArmedRef = useRef(false);
  const [ctrlArmed, setCtrlArmedState] = useState(false);
  const setCtrlArmed = (v: boolean) => {
    ctrlArmedRef.current = v;
    setCtrlArmedState(v);
  };
  // Sticky Alt: same pattern as Ctrl — a ref drives the keydown handler, state drives the button highlight.
  const altArmedRef = useRef(false);
  const [altArmed, setAltArmedState] = useState(false);
  const setAltArmed = (v: boolean) => {
    altArmedRef.current = v;
    setAltArmedState(v);
  };
  // "Select text" overlay: in-place native selection over the LIVE xterm doesn't work on mobile (xterm owns
  // touch + the provider TUI's mouse mode eats it). Instead the Select button opens a scrim of the buffer as PLAIN,
  // natively-selectable text — long-press selection + the OS copy menu just work there. `null` = closed.
  const [selectText, setSelectText] = useState<string | null>(null);
  // Opened by the terminal's LONG-PRESS gesture too (see the mount effect) — a ref so the once-per-session
  // effect always reaches the current closure.
  const openSelectRef = useRef<() => void>(() => {});
  // The live NATIVE selection inside the open overlay — drives the one-tap "Copy selection" button (the
  // OS copy menu / Ctrl+C dance was the flow's second friction point).
  const [overlaySel, setOverlaySel] = useState("");
  useEffect(() => {
    if (selectText === null) {
      setOverlaySel("");
      return undefined;
    }
    const onSel = () => setOverlaySel(window.getSelection?.()?.toString() ?? "");
    document.addEventListener("selectionchange", onSel);
    return () => document.removeEventListener("selectionchange", onSel);
  }, [selectText]);
  // Brief "Copied ✓" confirmation (desktop copy-on-select, or the Select overlay's Copy). setCopied + the ref
  // are stable, so the mount effect can safely capture flashCopied.
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const flashCopied = () => {
    setCopied(true);
    clearTimeout(copiedTimer.current);
    copiedTimer.current = setTimeout(() => setCopied(false), 1400);
  };
  // Paste/compose box: a small modal the user types OR pastes into (the OS long-press "Paste" always works in
  // a real textarea, unlike navigator.clipboard.readText on iOS), then Send injects it into the terminal.
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
  const [uploadError, setUploadError] = useState<string | undefined>();
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
    const term = new Terminal({
      cursorBlink: true,
      fontSize: fontSizeRef.current, // persisted zoom (A−/A+), clamped 10–20
      fontFamily: '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
      // xterm paints its own background, so it can't inherit var(--bg) — follow the saved theme (OLED = #000).
      theme: { ...THEME, background: TERMINAL_BG[loadTheme()] },
      allowProposedApi: true,
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

    // Renderer: xterm's DEFAULT (DOM). The WebGL addon rounds cells to integer device pixels → HiDPI fit
    // drift (the "kayık"/shift); the beta Canvas addon mis-sizes its backing store at HiDPI (everything
    // renders 2-3× and clips). The DOM renderer uses CSS-sized cells and renders correctly on every device.
    // (The logo's block glyphs come through intact now that the server runs tmux with `-u` + a UTF-8 locale.)

    // Sticky Ctrl applied to the REAL/soft keyboard: when armed, the next single printable keypress becomes
    // its control byte (Ctrl-R, Ctrl-L, …) and xterm's own handling of it is suppressed. This is what makes
    // the bar's "Ctrl" actually work for typed keys, not just the bar's buttons.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown") return true;
      if (e.isComposing || e.keyCode === 229) return true; // IME composition — never intercept
      const mod = ctrlArmedRef.current ? "ctrl" : altArmedRef.current ? "alt" : null;
      if (!mod) return true;
      const disarm = () => {
        setCtrlArmed(false);
        setAltArmed(false);
      };
      // A sticky Ctrl or Alt is armed from the bar; the next single key picks it up.
      if (e.key === "Escape") {
        disarm(); // cancel the arm and swallow the Esc
        return false;
      }
      if (e.metaKey) return true; // don't hijack Meta combos
      if (e.key.length === 1) {
        // Ctrl → the control byte; Alt → an ESC (meta) prefix, which is how terminals encode Alt+key.
        sockRef.current?.sendInput(mod === "ctrl" ? ctrlSeq(e.key) : `\x1b${e.key}`);
        disarm();
        return false;
      }
      // Armed but a non-printable key (Enter/Backspace/Arrow/Tab/…): DISARM and let it pass normally, so a
      // stray arm never silently turns a later letter into a control/meta byte (e.g. Ctrl-L clear).
      disarm();
      return true;
    });

    const refit = () => {
      if (disposed || host.clientHeight === 0) return;
      try {
        fit.fit();
      } catch {
        return;
      }
      sockRef.current?.sendResize(term.cols, term.rows);
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
    const offScroll = term.onScroll?.(() => updateJumpChip());
    const offBufferChange = term.buffer?.onBufferChange?.(() => updateJumpChip());
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
              id?: string;
              name?: string;
              path?: string;
              isImage?: boolean;
              caption?: string;
            };
            if (msg.t === "attach" && typeof msg.path === "string") {
              const item: TermFile = {
                id: msg.id ?? msg.path,
                name: msg.name ?? "file",
                path: msg.path,
                isImage: !!msg.isImage,
                source: "received",
                caption: msg.caption,
              };
              setFiles((prev) => (prev.some((f) => f.id === item.id) ? prev : [item, ...prev]));
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
      // Sticky Ctrl/Alt from the bar, applied at the DATA level so it ALSO works with the iOS soft keyboard —
      // whose keydown is keyCode 229 / composition, which the attachCustomKeyEventHandler above can't
      // intercept (that path only fires for real hardware keydowns). A single typed char while a modifier is
      // armed becomes its control byte (Ctrl) or an ESC-prefixed meta byte (Alt), then disarms. Multi-char
      // data (a paste) passes through untouched. On desktop the keydown path already suppressed xterm's own
      // handling, so onData never sees that char → no double application.
      if (d.length === 1 && (ctrlArmedRef.current || altArmedRef.current)) {
        const asCtrl = ctrlArmedRef.current;
        setCtrlArmed(false);
        setAltArmed(false);
        sockRef.current?.sendInput(asCtrl ? ctrlSeq(d) : `\x1b${d}`);
        return;
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
    // user taps the terminal to type, and a direct tap opens the keyboard on a STABLE layout, which never
    // freezes. Desktop has no soft keyboard, so it keeps auto-focus for immediate typing. healPaintBurst
    // still runs (arm + kicks) as a safety net for the layout swap itself.
    const coarsePointer = typeof window !== "undefined" && !!window.matchMedia?.("(pointer: coarse)")?.matches;
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
    // LONG-PRESS (one finger, held still ~500ms) opens the Select/copy overlay DIRECTLY — hunting the
    // key bar's Select button was the copy flow's biggest friction on mobile (user report). Cancelled by
    // finger movement (>12px), a second finger (that's the scroll gesture), or lifting off.
    let lpTimer: ReturnType<typeof setTimeout> | undefined;
    let lpStart: { x: number; y: number } | undefined;
    const cancelLongPress = () => {
      if (lpTimer !== undefined) clearTimeout(lpTimer);
      lpTimer = undefined;
      lpStart = undefined;
    };
    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length === 2) {
        cancelLongPress(); // two fingers = scroll, never a long-press
        twoFingerY = avgY(e.touches);
        scrollAccum = 0;
      } else if (e.touches.length === 1) {
        const t = e.touches[0]!;
        lpStart = { x: t.clientX, y: t.clientY };
        lpTimer = setTimeout(() => {
          cancelLongPress();
          try {
            navigator.vibrate?.(10); // a tiny "got it" tick where supported (Android)
          } catch {
            /* no haptics — fine */
          }
          openSelectRef.current();
        }, 500);
      }
    };
    const onTouchMove = (e: TouchEvent) => {
      // A moving finger is scrolling/using the TUI, not long-pressing.
      if (lpStart && e.touches.length === 1) {
        const t = e.touches[0]!;
        if (Math.hypot(t.clientX - lpStart.x, t.clientY - lpStart.y) > 12) cancelLongPress();
      }
      if (e.touches.length !== 2 || twoFingerY === null) return;
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
      cancelLongPress(); // lifting (or losing) a finger always ends a pending long-press
      if (e.touches.length < 2) twoFingerY = null;
    };
    host.addEventListener("touchstart", onTouchStart, { passive: true });
    host.addEventListener("touchmove", onTouchMove, { passive: false });
    host.addEventListener("touchend", onTouchEnd, { passive: true });
    host.addEventListener("touchcancel", onTouchEnd, { passive: true });
    // Desktop copy-on-select: releasing the mouse after selecting terminal text copies it to the OS clipboard
    // so you can paste it on your own computer. The live xterm selection is NOT a native browser selection, so
    // Cmd/Ctrl+C wouldn't otherwise reach the clipboard (and Ctrl+C sends ^C to the provider). Touch uses the Select
    // overlay instead; gated to a fine pointer so it never interferes with mobile.
    const onHostMouseUp = () => {
      if (window.matchMedia?.("(pointer: coarse)")?.matches) return;
      const sel = term.getSelection?.();
      if (sel && sel.trim()) void copyText(sel).then((ok) => ok && flashCopied());
    };
    host.addEventListener("mouseup", onHostMouseUp);

    return () => {
      disposed = true;
      cancelLongPress();
      cancelAnimationFrame(raf);
      clearInterval(poll);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("rc-theme-change", onThemeChange);
      host.removeEventListener("touchstart", onTouchStart);
      host.removeEventListener("touchmove", onTouchMove);
      host.removeEventListener("touchend", onTouchEnd);
      host.removeEventListener("touchcancel", onTouchEnd);
      host.removeEventListener("mouseup", onHostMouseUp);
      ro?.disconnect();
      offData.dispose();
      offScroll?.dispose();
      offBufferChange?.dispose();
      sockRef.current?.close();
      term.dispose();
      sockRef.current = undefined;
      termRef.current = undefined;
    };
  }, [sessionId, createSocket, restartKey]);

  // Bar keys: emit the cursor-mode-correct bytes for the CURRENT terminal mode (arrows/Home/End), then keep
  // focus on the terminal so the on-screen keyboard stays up.
  const onBarKey = (label: string) => {
    const term = termRef.current;
    if (isCodex && (label === "PageUp" || label === "PageDown")) {
      const wheel = label === "PageUp" ? "\x1b[<64;1;1M" : "\x1b[<65;1;1M";
      sockRef.current?.sendInput(wheel.repeat(4)); // ~20 tmux history lines, without leaving the conversation
      term?.focus();
      return;
    }
    const appMode = !!term?.modes?.applicationCursorKeysMode;
    sockRef.current?.sendInput(keySequence(label, appMode));
    term?.focus();
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
    term.focus();
  };
  // Keyboard-dismiss: iOS has no keyboard-hide key, so blur the terminal to reclaim reading space.
  const dismissKeyboard = () => {
    termRef.current?.blur();
    (document.activeElement as HTMLElement | null)?.blur?.();
  };
  // The ACTIVE buffer (scrollback + visible) as plain lines — the shared corpus for the Select overlay
  // AND the find bar. translateToString(true) trims only TRAILING blanks, so match columns still line up
  // with the grid (a leading-trim would shift every col the find bar hands to term.select).
  const bufferLines = (): string[] => {
    const term = termRef.current;
    if (!term) return [];
    const buf = term.buffer.active;
    const lines: string[] = [];
    for (let i = 0; i < buf.length; i++) lines.push(buf.getLine(i)?.translateToString(true) ?? "");
    return lines;
  };
  // Dump the terminal buffer to one plain-text block — the source for the Select overlay.
  const dumpBuffer = (): string =>
    bufferLines()
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/\s+$/, "");

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
  // Select: TOGGLE a scrim of the buffer as plain, natively-selectable text (long-press to select → OS copy
  // menu). Reliable because it's ordinary HTML text, not the live xterm (which swallows touch on mobile).
  const onToggleSelect = () => setSelectText((cur) => (cur === null ? dumpBuffer() || " " : null));
  // The mount effect's LONG-PRESS gesture opens the overlay through this ref (the effect runs once per
  // session; the ref always points at the current dump closure). Open-only — never toggles closed.
  openSelectRef.current = () => setSelectText((cur) => cur ?? (dumpBuffer() || " "));
  // Inject the paste-box contents into the terminal (raw bytes → the provider input), then close + refocus.
  const sendPaste = () => {
    const text = pasteRef.current?.value ?? "";
    // Bracketed paste (\x1b[200~ … \x1b[201~) so the provider treats a multi-line prompt as ONE paste instead of
    // submitting on the first embedded newline — a raw send makes every \n an Enter, breaking long prompts.
    if (text) sockRef.current?.sendInput(`\x1b[200~${text}\x1b[201~`);
    setPasteOpen(false);
    termRef.current?.focus();
  };
  // Upload → server saves it in the app data dir, outside any repo (7-day TTL), list it, and hand the provider the
  // absolute PATH. A placeholder row appears immediately with a live progress bar, then resolves in place.
  const onUploadFiles = (list: FileList) => {
    for (const file of Array.from(list)) {
      const tempId = `upload:${Date.now()}:${Math.random().toString(36).slice(2)}:${file.name}`;
      setFiles((prev) => [
        {
          id: tempId,
          name: file.name,
          path: "",
          isImage: file.type.startsWith("image/"),
          source: "sent",
          uploading: true,
          progress: 0,
        },
        ...prev,
      ]);
      uploadWithProgress(sessionId, file, (fraction) => {
        setFiles((prev) => prev.map((f) => (f.id === tempId ? { ...f, progress: fraction } : f)));
      })
        .then(({ path }) => {
          setFiles((prev) =>
            prev.map((f) => (f.id === tempId ? { ...f, id: path, path, uploading: false, progress: 1 } : f)),
          );
          sockRef.current?.sendInput(path + " ");
          termRef.current?.focus();
        })
        .catch(() => {
          setFiles((prev) => prev.map((f) => (f.id === tempId ? { ...f, uploading: false, error: true } : f)));
          setUploadError(`Couldn't upload ${file.name}`);
        });
    }
  };

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
        filesCount={files.length}
      />
      <div className="rc-terminal__stage">
        <div className="rc-terminal__host" ref={hostRef} role="group" aria-label="Terminal" />
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
          {/* Select / copy — opens the plain-text overlay. Essential on DESKTOP, where the key bar (which
              carries the mobile Select key) is hidden and the live xterm selection can't be copied (the provider's
              mouse mode eats it). From the overlay: select the text, then Cmd/Ctrl+C. */}
          <button
            type="button"
            className="rc-term-tool"
            aria-label="Select / copy text"
            title="Select / copy text — tip: Shift+drag on the terminal selects & copies directly"
            onMouseDown={(e) => e.preventDefault()}
            onClick={onToggleSelect}
          >
            <Icon name="copy" size={15} />
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
              termRef.current?.focus();
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
        {selectText !== null && (
          <div
            className="rc-term-select"
            role="dialog"
            aria-label="Select text"
            onKeyDown={(e) => {
              if (e.key === "Escape") setSelectText(null); // Escape closes (keyboard a11y)
            }}
          >
            <div className="rc-term-select__bar">
              <span className="rc-term-select__hint">
                {copied ? "Copied ✓" : "Select text, then tap Copy — it appears when something is selected"}
              </span>
              {overlaySel.trim() !== "" && (
                <button
                  type="button"
                  className="rc-term-select__btn rc-term-select__btn--copy"
                  // The selection is captured in state, so it doesn't matter that tapping a button clears
                  // the native selection — one tap copies, no OS menu / Ctrl+C dance needed.
                  onClick={() => void copyText(overlaySel).then((ok) => ok && flashCopied())}
                >
                  Copy selection
                </button>
              )}
              <button type="button" className="rc-term-select__btn" onClick={() => setSelectText(null)}>
                Close
              </button>
            </div>
            <pre className="rc-term-select__text">{selectText}</pre>
          </div>
        )}
        {copied && (
          <div className="rc-term-copied" role="status" aria-live="polite">
            Copied ✓
          </div>
        )}
      </div>
      <TerminalKeyBar
        ctrlArmed={ctrlArmed}
        onToggleCtrl={() => {
          const v = !ctrlArmedRef.current;
          setCtrlArmed(v);
          if (v) setAltArmed(false); // only one modifier armed at a time
          termRef.current?.focus(); // keep the on-screen keyboard up (arming a modifier must not dismiss it)
        }}
        altArmed={altArmed}
        onToggleAlt={() => {
          const v = !altArmedRef.current;
          setAltArmed(v);
          if (v) setCtrlArmed(false);
          termRef.current?.focus();
        }}
        onKey={onBarKey}
        onSelect={onToggleSelect}
        selectOn={selectText !== null}
        onPaste={() => setPasteOpen(true)}
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
              <button type="button" className="rc-paste__btn rc-paste__btn--send" onClick={sendPaste}>
                Send
              </button>
            </div>
          </div>
        </div>
      )}
      <TerminalFiles
        files={files}
        open={filesOpen}
        onClose={() => setFilesOpen(false)}
        onUpload={onUploadFiles}
        downloadUrl={terminalDownloadUrl}
      />
      {uploadError && (
        <button type="button" className="rc-term-uploaderr" onClick={() => setUploadError(undefined)}>
          {uploadError} — tap to dismiss
        </button>
      )}
      <style>{terminalCss}</style>
    </div>
  );
}

const terminalCss = `
/* Paste/compose box — a small modal the user types or pastes into, then Send injects it into the terminal.
   Anchored near the TOP so the on-screen keyboard the textarea raises never covers it. */
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
.rc-terminal__host {
  position: absolute; inset: 0;
  overflow: hidden;
  /* Isolate xterm's (heavy, many-node) rendering into its own layout/paint scope so a recomposite of the
     terminal doesn't cascade across the whole app — helps iOS Safari repaint the session-select transition. */
  contain: layout paint;
}
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
/* The padding lives on .xterm (NOT the host): FitAddon reads padding from the terminal element, so padding
   on the host was never subtracted from the grid math → the right column / bottom row got clipped ("shifted"). */
.rc-terminal__host .xterm { height: 100%; box-sizing: border-box; padding: 6px; }
/* Neutralize global text styling the terminal must not inherit: body sets letter-spacing: 0.1px, which a
   character grid must never have (it drifts the columns) — matters for the DOM fallback renderer. */
.rc-terminal__host .xterm, .rc-terminal__host .xterm * { letter-spacing: normal; }
/* xterm.css hardcodes the viewport background to #000; match the theme so there's no black seam on resize. */
.rc-terminal__host .xterm-viewport { background-color: var(--bg) !important; }
/* "Select text" overlay: a scrim over the terminal showing the buffer as PLAIN, natively-selectable text so
   long-press selection + the OS copy menu work (the live xterm swallows touch on mobile). */
.rc-term-select {
  position: absolute; inset: 0; z-index: 7;
  display: flex; flex-direction: column;
  background: var(--bg); /* opaque so the live terminal underneath never repaints over the selectable text */
}
/* "Copied ✓" confirmation pill (desktop copy-on-select) — top-center, brief, non-blocking. */
.rc-term-copied {
  position: absolute; top: 8px; left: 50%; transform: translateX(-50%); z-index: 8;
  padding: 4px 12px; border-radius: 999px;
  background: var(--coral); color: var(--on-accent, #fff);
  font-size: 12px; font-weight: 600; pointer-events: none;
  box-shadow: var(--shadow); animation: rc-term-copied-in 120ms ease;
}
@keyframes rc-term-copied-in { from { opacity: 0; transform: translate(-50%, -4px); } to { opacity: 1; transform: translate(-50%, 0); } }
.rc-term-select__bar {
  flex: 0 0 auto; display: flex; align-items: center; gap: 8px;
  padding: 8px 10px; border-bottom: 1px solid var(--border); background: var(--surface);
}
.rc-term-select__hint { flex: 1 1 auto; min-width: 0; color: var(--text-faint); font-size: 12px; }
.rc-term-select__btn {
  flex: 0 0 auto; height: 34px; padding: 0 14px; border-radius: 8px; cursor: pointer;
  border: 1px solid var(--border-strong); background: var(--surface-2); color: var(--text);
  font: 600 13px/1 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  touch-action: manipulation;
}
/* The one-tap copy — the PRIMARY action while a selection exists, so it reads coral. */
.rc-term-select__btn--copy { background: var(--coral); border-color: var(--coral); color: var(--on-accent); }
.rc-term-select__text {
  flex: 1 1 auto; margin: 0; padding: 10px 12px calc(10px + var(--kb-safe-bottom, env(safe-area-inset-bottom, 0px)));
  overflow: auto; -webkit-overflow-scrolling: touch;
  color: var(--text); background: var(--bg);
  font: 13px/1.45 "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  white-space: pre-wrap; word-break: break-word;
  -webkit-user-select: text; user-select: text;
}

/* Termux-style extra-keys bar: TWO rows of flat, evenly-spread keys (no boxes) pinned below the terminal,
   with a safe-area inset so it clears the iOS home indicator / sits above the on-screen keyboard. Compact —
   thin rows, all keys visible at once, no horizontal scrolling. */
.rc-termkeys {
  flex: 0 0 auto;
  display: flex; flex-direction: column; gap: 2px;
  padding: 3px 4px calc(3px + var(--kb-safe-bottom, env(safe-area-inset-bottom, 0px)));
  background: var(--surface); border-top: 1px solid var(--border);
}
.rc-termkeys__row { display: grid; grid-template-columns: repeat(7, 1fr); gap: 2px; }
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
/* No soft keyboard on a real desktop → the dismiss control is pointless there. */
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
