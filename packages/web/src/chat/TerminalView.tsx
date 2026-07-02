import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { createTerminalSocket, type TerminalSocket } from "../ws/terminal-socket";
type CreateSocket = typeof createTerminalSocket;
import { terminalWsUrl, terminalDownloadUrl } from "../api/client";
import { loadToken } from "../auth/token-store";
import { API_BASE_URL } from "../config";
import { TerminalKeyBar } from "./TerminalKeyBar";
import { TerminalFiles, type TermFile } from "./TerminalFiles";
import { ChatHeader } from "./ChatHeader";
import { HelpSheet } from "./HelpSheet";
import { Icon } from "../ui/Icon";
import { keySequence, ctrlSeq } from "./terminal-keys";
import { healPaintBurst } from "../pwa/viewport";
import { useFocusTrap } from "../ui/useFocusTrap";
import type { SessionMeta } from "../types/server";

/** A single choice in an `ask_user` question. */
interface AskOption {
  label: string;
  description?: string;
}
/** One question in an `ask_user` control frame from the terminal socket. */
interface AskQuestion {
  question: string;
  header?: string;
  options: AskOption[];
  multiSelect?: boolean;
}
/** The `{ t: "ask", askId, questions }` control frame (server ↔ web contract). */
interface AskFrame {
  askId: string;
  questions: AskQuestion[];
}

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

/** Renders a terminal session's claude TUI: xterm.js bridged to the binary terminal WebSocket.
 *  `createSocket` is injectable purely so the screenshot harness / tests can feed controlled bytes;
 *  production always uses the default real socket. */
export function TerminalView({
  session,
  onShowSessions,
  needsYou,
  onClose,
  onOpenSettings,
  createSocket = createTerminalSocket,
}: {
  session: SessionMeta;
  onShowSessions?: () => void;
  needsYou?: number;
  /** Close/stop the session (header X + the "session ended" overlay's Close button). */
  onClose?: () => void;
  /** Open the session-scoped settings panel — forwarded straight to the header's gear. The App wires this;
   *  when absent the gear is simply not rendered. */
  onOpenSettings?: () => void;
  createSocket?: CreateSocket;
}) {
  const sessionId = session.id;
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
  // touch + claude's mouse mode eats it). Instead the Select button opens a scrim of the buffer as PLAIN,
  // natively-selectable text — long-press selection + the OS copy menu just work there. `null` = closed.
  const [selectText, setSelectText] = useState<string | null>(null);
  // Paste/compose box: a small modal the user types OR pastes into (the OS long-press "Paste" always works in
  // a real textarea, unlike navigator.clipboard.readText on iOS), then Send injects it into the terminal.
  const [pasteOpen, setPasteOpen] = useState(false);
  const pasteRef = useRef<HTMLTextAreaElement>(null);
  const pasteBoxRef = useRef<HTMLDivElement>(null);
  useFocusTrap(pasteBoxRef, pasteOpen); // keep Tab inside the paste modal while it's open (a11y)
  // Connection lifecycle → drives the reconnect/ended overlay. `restartKey` bump remounts the effect (fresh
  // terminal + socket → reattach, which respawns a fresh claude for an ended session).
  const [connState, setConnState] = useState<"connecting" | "open" | "reconnecting" | "ended">("connecting");
  const [restartKey, setRestartKey] = useState(0);
  // Files exchanged with claude: received (send_image/send_file → control frames) + uploaded by the user.
  const [files, setFiles] = useState<TermFile[]>([]);
  const [filesOpen, setFilesOpen] = useState(false);
  const [uploadError, setUploadError] = useState<string | undefined>();
  // Help sheet (the header "?" legend of gestures + keys).
  const [helpOpen, setHelpOpen] = useState(false);
  // ask_user overlay: driven by a `{ t: "ask", … }` control frame. `null` = no pending question.
  const [ask, setAsk] = useState<AskFrame | null>(null);
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
  const restart = () => {
    setConnState("connecting");
    setRestartKey((k) => k + 1);
  };

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const term = new Terminal({
      cursorBlink: true,
      fontSize: fontSizeRef.current, // persisted zoom (A−/A+), clamped 10–20
      fontFamily: '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
      theme: { ...THEME },
      allowProposedApi: true,
      // A finite scrollback so claude's NORMAL-buffer output (long errors, git diffs, results taller than the
      // viewport) stays scrollable. Its full-screen TUI uses the alt-screen (tmux owns that), unaffected.
      scrollback: 1000,
    });
    termRef.current = term;
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

    // "Jump to latest" chip visibility: only when the NORMAL buffer (git diff / logs / raw shell — not claude's
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
        // A THUNK, not a fixed string, so every reconnect re-reads a rotated token + the current fitted size
        // (a fixed URL would reconnect forever with the stale token captured here).
        url: () => terminalWsUrl(sessionId, term.cols, term.rows),
        onData: (bytes) => {
          if (!disposed) term.write(bytes);
        },
        onStatus: (s) => {
          if (disposed) return;
          if (s === "open") {
            setConnState("open");
            // Clear any stale frame from a prior connection; tmux sends a full redraw on (re)attach, so the
            // screen repaints cleanly instead of overlaying the old one.
            term.reset();
            refit();
          } else if (s === "reconnecting") {
            setConnState("reconnecting");
          } else if (s === "ended") {
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
              askId?: string;
              questions?: AskQuestion[];
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
            } else if (msg.t === "ask" && typeof msg.askId === "string" && Array.isArray(msg.questions)) {
              setAsk({ askId: msg.askId, questions: msg.questions });
            } else if (msg.t === "ask-cancel" && typeof msg.askId === "string") {
              // The server-side ask_user timed out → dismiss the overlay if it's still that same question.
              setAsk((cur) => (cur && cur.askId === msg.askId ? null : cur));
            }
          } catch {
            /* ignore a malformed control frame */
          }
        },
      });
      sockRef.current = sock;
    };
    const tick = () => (connected ? refit() : fitThenConnect());

    const offData = term.onData((d) => sockRef.current?.sendInput(d));

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

    // TWO-FINGER vertical drag → scroll. Two fingers so it NEVER conflicts with one-finger tap/interact. On
    // claude's full-screen alt-screen we drive ITS pager with PgUp/PgDn (one key per ~SCROLL_STEP px); on the
    // NORMAL buffer (a git diff / stack trace / npm logs / raw shell) we instead scroll xterm's OWN scrollback
    // so read-back doesn't accidentally page claude's UI. Fingers DOWN reveal older text; UP go toward latest.
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
    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length === 2) {
        twoFingerY = avgY(e.touches);
        scrollAccum = 0;
      }
    };
    const onTouchMove = (e: TouchEvent) => {
      if (e.touches.length !== 2 || twoFingerY === null) return;
      e.preventDefault(); // claim the gesture from the browser's own two-finger scroll/zoom
      const y = avgY(e.touches);
      scrollAccum += y - twoFingerY;
      twoFingerY = y;
      const onAltScreen = term.buffer.active.type === "alternate";
      while (Math.abs(scrollAccum) >= SCROLL_STEP) {
        markScrollLearned();
        const up = scrollAccum > 0; // fingers moved DOWN → reveal older text
        if (onAltScreen) {
          sockRef.current?.sendInput(up ? "\x1b[5~" : "\x1b[6~"); // page claude's own alt-screen pager
        } else {
          term.scrollLines(up ? -SCROLLBACK_LINES : SCROLLBACK_LINES); // scroll xterm's own scrollback
        }
        scrollAccum += up ? -SCROLL_STEP : SCROLL_STEP;
      }
    };
    const onTouchEnd = (e: TouchEvent) => {
      if (e.touches.length < 2) twoFingerY = null;
    };
    host.addEventListener("touchstart", onTouchStart, { passive: true });
    host.addEventListener("touchmove", onTouchMove, { passive: false });
    host.addEventListener("touchend", onTouchEnd, { passive: true });
    host.addEventListener("touchcancel", onTouchEnd, { passive: true });

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      clearInterval(poll);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onOnline);
      host.removeEventListener("touchstart", onTouchStart);
      host.removeEventListener("touchmove", onTouchMove);
      host.removeEventListener("touchend", onTouchEnd);
      host.removeEventListener("touchcancel", onTouchEnd);
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
  // ask_user submit: POST the keyed answers to the server (auth token as Bearer), then close + refocus.
  const submitAsk = (answers: Record<string, string | string[]>) => {
    const cur = ask;
    setAsk(null);
    termRef.current?.focus();
    if (!cur) return;
    const token = loadToken();
    void fetch(`${API_BASE_URL}/sessions/${encodeURIComponent(sessionId)}/ask/answer`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ askId: cur.askId, answers }),
    }).catch(() => undefined);
  };
  // Dump the terminal buffer (scrollback + visible) to plain text — the source for the Select overlay.
  const dumpBuffer = (): string => {
    const term = termRef.current;
    if (!term) return "";
    const buf = term.buffer.active;
    const lines: string[] = [];
    for (let i = 0; i < buf.length; i++) lines.push(buf.getLine(i)?.translateToString(true) ?? "");
    return lines
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/\s+$/, "");
  };
  // Select: TOGGLE a scrim of the buffer as plain, natively-selectable text (long-press to select → OS copy
  // menu). Reliable because it's ordinary HTML text, not the live xterm (which swallows touch on mobile).
  const onToggleSelect = () => setSelectText((cur) => (cur === null ? dumpBuffer() || " " : null));
  // Inject the paste-box contents into the terminal (raw bytes → claude's input line), then close + refocus.
  const sendPaste = () => {
    const text = pasteRef.current?.value ?? "";
    // Bracketed paste (\x1b[200~ … \x1b[201~) so claude treats a multi-line prompt as ONE paste instead of
    // submitting on the first embedded newline — a raw send makes every \n an Enter, breaking long prompts.
    if (text) sockRef.current?.sendInput(`\x1b[200~${text}\x1b[201~`);
    setPasteOpen(false);
    termRef.current?.focus();
  };
  // Upload → server saves it in the app data dir, outside any repo (7-day TTL), list it, and hand claude the
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
        onOpenSettings={onOpenSettings}
        onOpenHelp={() => setHelpOpen(true)}
        onOpenFiles={() => setFilesOpen(true)}
        filesCount={files.length}
      />
      <div className="rc-terminal__stage">
        <div className="rc-terminal__host" ref={hostRef} role="group" aria-label="Terminal" />
        {/* Floating view controls (top-right): font zoom + a keyboard-dismiss (mobile only). preventDefault on
            mousedown keeps the on-screen keyboard up for zoom; the dismiss button intentionally lets the blur
            through (and blurs the terminal) so the user can reclaim reading space. */}
        <div className="rc-term-tools" role="group" aria-label="Terminal view controls">
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
              <div className="rc-term-ended__title">claude exited</div>
              <div className="rc-term-ended__sub">The terminal session ended.</div>
              <div className="rc-term-ended__actions">
                <button type="button" className="rc-term-ended__primary" onClick={restart}>
                  Restart
                </button>
                {onClose && (
                  <button type="button" className="rc-term-ended__ghost" onClick={onClose}>
                    Close
                  </button>
                )}
              </div>
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
              <span className="rc-term-select__hint">Long-press to select · then Copy</span>
              <button
                type="button"
                className="rc-term-select__btn"
                onClick={() => {
                  const s = typeof window !== "undefined" ? (window.getSelection?.()?.toString() ?? "") : "";
                  const text = s.trim() ? s : selectText;
                  if (text) void navigator.clipboard?.writeText?.(text).catch(() => undefined);
                }}
              >
                Copy all
              </button>
              <button type="button" className="rc-term-select__btn" onClick={() => setSelectText(null)}>
                Close
              </button>
            </div>
            <pre className="rc-term-select__text">{selectText}</pre>
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
            <textarea
              ref={pasteRef}
              className="rc-paste__input"
              placeholder="Type or paste text, then Send…"
              autoFocus
              rows={4}
              autoCapitalize="off"
              autoCorrect="off"
              autoComplete="off"
              spellCheck={false}
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
      <HelpSheet open={helpOpen} onClose={() => setHelpOpen(false)} />
      {ask && <AskOverlay ask={ask} onSubmit={submitAsk} onClose={() => setAsk(null)} />}
      <style>{terminalCss}</style>
    </div>
  );
}

/** The ask_user overlay: renders each question's choices (single- or multi-select) and, on Send, hands the
 *  answers (keyed by question text) back to TerminalView, which POSTs them. Styling lives in `terminalCss`. */
function AskOverlay({
  ask,
  onSubmit,
  onClose,
}: {
  ask: AskFrame;
  onSubmit: (answers: Record<string, string | string[]>) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref, true);
  // Selections stored as arrays throughout (single-select keeps ≤1); collapsed to a scalar on submit.
  const [sel, setSel] = useState<Record<string, string[]>>({});
  const toggle = (q: AskQuestion, label: string) => {
    setSel((prev) => {
      const cur = prev[q.question] ?? [];
      if (q.multiSelect) {
        return { ...prev, [q.question]: cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label] };
      }
      return { ...prev, [q.question]: [label] };
    });
  };
  // Every single-select question needs a pick; multi-select may be empty (a valid "none").
  const ready = ask.questions.every((q) => q.multiSelect || (sel[q.question]?.length ?? 0) > 0);
  const submit = () => {
    const answers: Record<string, string | string[]> = {};
    for (const q of ask.questions) {
      const chosen = sel[q.question] ?? [];
      answers[q.question] = q.multiSelect ? chosen : (chosen[0] ?? "");
    }
    onSubmit(answers);
  };
  return (
    <div
      className="rc-ask"
      role="dialog"
      aria-modal="true"
      aria-label="claude is asking"
      ref={ref}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
    >
      <div className="rc-ask__card">
        {ask.questions.map((q, qi) => (
          <div className="rc-ask__q" key={qi}>
            {q.header && <div className="rc-ask__header">{q.header}</div>}
            <div className="rc-ask__prompt">{q.question}</div>
            <div className="rc-ask__opts">
              {q.options.map((o, oi) => {
                const on = (sel[q.question] ?? []).includes(o.label);
                return (
                  <button
                    type="button"
                    key={oi}
                    className={on ? "rc-ask__opt is-on" : "rc-ask__opt"}
                    aria-pressed={on}
                    onClick={() => toggle(q, o.label)}
                  >
                    <span className="rc-ask__optlabel">{o.label}</span>
                    {o.description && <span className="rc-ask__optdesc">{o.description}</span>}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
        <div className="rc-ask__row">
          <button type="button" className="rc-ask__btn" onClick={onClose}>
            Dismiss
          </button>
          <button type="button" className="rc-ask__btn rc-ask__btn--send" onClick={submit} disabled={!ready}>
            Send
          </button>
        </div>
      </div>
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
  display: flex; flex-direction: column; gap: 10px;
  background: var(--surface); border: 1px solid var(--border-strong);
  border-radius: var(--radius-lg); box-shadow: var(--shadow); padding: 12px;
}
.rc-paste__input {
  width: 100%; min-height: 96px; resize: vertical;
  background: var(--surface-2); color: var(--text);
  border: 1px solid var(--border); border-radius: var(--radius); padding: 10px;
  font: 400 16px/1.45 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
}
.rc-paste__input:focus { outline: none; border-color: var(--coral); }
.rc-paste__row { display: flex; justify-content: flex-end; gap: 8px; }
.rc-paste__btn {
  min-height: 40px; padding: 0 18px; border-radius: var(--radius);
  border: 1px solid var(--border-strong); background: var(--surface-2); color: var(--text);
  font-weight: 600; font-size: 14px; cursor: pointer;
}
.rc-paste__btn--send { background: var(--coral); color: var(--on-accent); border-color: var(--coral); }
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
.rc-term-ended__ghost { background: transparent; color: var(--text); border: 1px solid var(--border-strong); }
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
  cursor: pointer; user-select: none; touch-action: manipulation; -webkit-tap-highlight-color: transparent;
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
/* ask_user overlay — claude's questions as tappable choices, pinned to the bottom on mobile (centered on
   desktop) so the answer chips sit within easy thumb reach. */
.rc-ask {
  position: fixed; inset: 0; z-index: 70;
  display: flex; align-items: flex-end; justify-content: center;
  padding: 16px; padding-bottom: calc(16px + env(safe-area-inset-bottom, 0px));
  background: var(--scrim);
}
.rc-ask__card {
  width: 100%; max-width: 560px; max-height: 80vh; overflow-y: auto; -webkit-overflow-scrolling: touch;
  display: flex; flex-direction: column; gap: 14px;
  background: var(--surface); border: 1px solid var(--border-strong);
  border-radius: var(--radius-lg); box-shadow: var(--shadow); padding: 16px;
}
.rc-ask__header { font: 700 11px/1 var(--font-mono); text-transform: uppercase; letter-spacing: 0.6px; color: var(--text-faint); margin-bottom: 4px; }
.rc-ask__prompt { font: 600 14px/1.35 var(--font-body); color: var(--text); }
.rc-ask__opts { display: flex; flex-direction: column; gap: 6px; margin-top: 8px; }
.rc-ask__opt {
  text-align: left; display: flex; flex-direction: column; gap: 2px;
  padding: 10px 12px; border-radius: var(--radius); cursor: pointer;
  border: 1px solid var(--border-strong); background: var(--surface-2); color: var(--text);
  touch-action: manipulation;
}
.rc-ask__opt.is-on { box-shadow: inset 0 0 0 1.5px var(--coral); border-color: var(--coral); }
.rc-ask__optlabel { font: 600 13.5px/1.3 var(--font-body); }
.rc-ask__optdesc { font: 400 12px/1.35 var(--font-body); color: var(--text-faint); }
.rc-ask__row { display: flex; justify-content: flex-end; gap: 8px; }
.rc-ask__btn {
  min-height: 40px; padding: 0 18px; border-radius: var(--radius);
  border: 1px solid var(--border-strong); background: var(--surface-2); color: var(--text);
  font-weight: 600; font-size: 14px; cursor: pointer;
}
.rc-ask__btn--send { background: var(--coral); color: var(--on-accent); border-color: var(--coral); }
.rc-ask__btn:disabled { opacity: 0.5; cursor: default; }
@media (min-width: 768px) { .rc-ask { align-items: center; } }
`;
