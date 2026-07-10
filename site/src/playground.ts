/**
 * The playground — a real xterm.js terminal (the same renderer the app ships) replaying the
 * cast, then handing the prompt to the visitor. Lazily loaded on first approach; if xterm
 * fails to load, a DOM fallback replays a simplified cast in #cast.
 */
import { CAST, PROMPT, reply, type Frame } from "./cast";

const SPIN = ["✳", "✻", "✽", "·"];
const CORAL = "\x1b[38;2;247;122;68m";
const DIM = "\x1b[38;2;147;147;156m";
const FAINT = "\x1b[38;2;85;85;94m";
const R = "\x1b[0m";
const CLEAR_LINE = "\r\x1b[2K";

const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, reduced ? 0 : ms));

export function initPlayground(): void {
  const section = document.getElementById("play-sec");
  if (!section) return;
  const io = new IntersectionObserver(
    (es) => {
      if (!es[0]?.isIntersecting) return;
      io.disconnect();
      void boot();
    },
    { rootMargin: "300px" },
  ); // start loading before it's on screen
  io.observe(section);
}

async function boot(): Promise<void> {
  const mount = document.getElementById("term-mount")!;
  try {
    const [{ Terminal }] = await Promise.all([import("@xterm/xterm"), import("@xterm/xterm/css/xterm.css")]);
    const cols = Math.max(48, Math.min(96, Math.floor(mount.clientWidth / 8.2)));
    const term = new Terminal({
      cols,
      rows: 19,
      // No scrollback: otherwise xterm grows an internal scroll viewport that shows its own
      // right-hand scrollbar and SWALLOWS two-finger/wheel scrolling over the demo (the page
      // stops scrolling, a tiny inner area scrolls instead). Old replay lines simply flow off
      // the top — terminal-authentic, and page scrolling always stays with the page.
      scrollback: 0,
      fontSize: 13,
      lineHeight: 1.35,
      fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
      cursorBlink: true,
      convertEol: true,
      theme: {
        background: "#0a0a0b",
        foreground: "#e9e9ec",
        cursor: "#f77a44",
        selectionBackground: "#f77a4455",
      },
    });
    document.getElementById("cast")?.remove();
    document.getElementById("fallback-prompt")?.remove();
    mount.style.background = "#0a0a0b";
    term.open(mount);
    await runCast((s) => term.write(s));
    interactive(term);
    wireKeybar((data) => term.input(data));
  } catch {
    await domFallback();
  }
}

/** Replay the cast through a writer (xterm.write). */
async function runCast(write: (s: string) => void): Promise<void> {
  const visible = () => document.visibilityState === "visible";
  for (const f of CAST) {
    while (!visible()) await sleep(300);
    if (f.t === "type") {
      write(PROMPT);
      for (const ch of f.s) {
        write(ch);
        await sleep(24 + Math.random() * 40);
      }
      write("\r\n");
      await sleep(f.d);
    } else if (f.t === "spin") {
      await runSpinner(write, f);
    } else {
      write(f.s + "\r\n");
      await sleep(f.d);
    }
  }
}

async function runSpinner(write: (s: string) => void, f: Extract<Frame, { t: "spin" }>): Promise<void> {
  const steps = reduced ? 1 : Math.max(1, Math.round(f.ms / 130));
  for (let i = 0; i < steps; i++) {
    const k = (f.fromK + (f.toK - f.fromK) * (i / steps)).toFixed(1);
    write(
      `${CLEAR_LINE}${CORAL}${SPIN[i % SPIN.length]}${R} ${DIM}${f.label}…${R} ${FAINT}(esc to interrupt · ↓ ${k}k tokens)${R}`,
    );
    await sleep(130);
  }
  write(CLEAR_LINE);
}

/** Hand the prompt to the visitor: echo, backspace, Ctrl-C, Enter → in-character reply. */
function interactive(term: import("@xterm/xterm").Terminal): void {
  let buf = "";
  let replies = 0;
  let busy = false;
  term.write(PROMPT);
  term.onData((data) => {
    if (busy) return;
    if (data === "\r") {
      if (!buf.trim()) {
        term.write(`\r\n${PROMPT}`);
        buf = "";
        return;
      }
      busy = true;
      term.write("\r\n");
      const lines = reply(replies++);
      void (async () => {
        await sleep(380);
        for (const l of lines) {
          term.write(l + "\r\n");
          await sleep(160);
        }
        term.write(PROMPT);
        buf = "";
        busy = false;
      })();
    } else if (data === "\x7f") {
      // backspace
      if (buf.length) {
        buf = buf.slice(0, -1);
        term.write("\b \b");
      }
    } else if (data === "\x03") {
      // ctrl-c
      term.write(`${FAINT}^C${R}\r\n${PROMPT}`);
      buf = "";
    } else if (data === "\x1b") {
      // esc — a wink
      term.write(`${CLEAR_LINE}${FAINT}(nothing to interrupt — this is the demo)${R}\r\n${PROMPT}${buf}`);
    } else if (data >= " " || data === "\t") {
      buf += data;
      term.write(data);
    }
  });
}

/** The key bar drives the same input path — sticky ctrl turns the next key into a chord. */
function wireKeybar(input: (data: string) => void): void {
  const bar = document.getElementById("keybar");
  const ctrl = document.getElementById("ctrlkey");
  if (!bar || !ctrl) return;
  let stuck = false;
  bar.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>(".key");
    if (!btn) return;
    const k = btn.dataset.k!;
    if (k === "ctrl") {
      stuck = !stuck;
      ctrl.classList.toggle("stuck", stuck);
      return;
    }
    if (stuck && k.length === 1) {
      const code = k.toUpperCase().charCodeAt(0) - 64;
      if (code > 0 && code < 27) input(String.fromCharCode(code));
      stuck = false;
      ctrl.classList.remove("stuck");
      return;
    }
    const seq: Record<string, string> = {
      esc: "\x1b",
      tab: "\t",
      up: "\x1b[A",
      down: "\x1b[B",
      "^C": "\x03",
      "/": "/",
      "|": "|",
    };
    input(seq[k] ?? k);
  });
}

/** No-xterm fallback: simplified DOM replay + the same canned prompt, mockup-style. */
async function domFallback(): Promise<void> {
  const cast = document.getElementById("cast");
  const pin = document.getElementById("pinput") as HTMLInputElement | null;
  if (!cast || !pin) return;
  const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
  const add = (text: string, cls?: string) => {
    const d = document.createElement("div");
    if (cls) d.className = cls;
    d.textContent = text;
    cast.appendChild(d);
  };
  for (const f of CAST) {
    if (f.t === "spin") continue;
    add(f.t === "type" ? `❯ ${f.s}` : strip(f.s), f.t === "type" ? undefined : "g-dim");
    await sleep(f.t === "type" ? 500 : f.d);
  }
  let replies = 0;
  pin.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || !pin.value.trim()) return;
    add(`❯ ${pin.value}`);
    for (const l of reply(replies++)) add(strip(l), "g-dim");
    pin.value = "";
  });
}
