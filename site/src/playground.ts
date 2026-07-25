/**
 * The playground — the same official Ghostty Web terminal the app ships, replaying the
 * deliberately Claude-labelled cast, then handing the prompt to the visitor. Codex support is demonstrated
 * elsewhere with its own TUI visual. Lazily loaded on first approach; if Ghostty
 * fails to load, a DOM fallback replays a simplified cast in #cast.
 */
import { CAST, PROMPT, reply, type Frame } from "./cast";
import type { GhosttyCanvasTerminal } from "@roamcode.ai/ghostty-web";

const SPIN = ["✳", "✻", "✽", "·"];
const CORAL = "\x1b[38;2;247;122;68m";
const DIM = "\x1b[38;2;147;147;156m";
const FAINT = "\x1b[38;2;85;85;94m";
const R = "\x1b[0m";
const CLEAR_LINE = "\r\x1b[2K";

const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, reduced ? 0 : ms));

export function initPlayground(): void {
  const section = document.getElementById("demo");
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
    const { GhosttyCanvasTerminal, loadGhosttyRuntime } = await import("@roamcode.ai/ghostty-web");
    const runtime = await loadGhosttyRuntime();
    mount.classList.add("is-ghostty");
    const term = new GhosttyCanvasTerminal(runtime, mount, {
      scrollback: 0,
      allowPageScroll: true,
      fontSize: 13,
      fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
      theme: {
        background: "#0a0a0b",
        foreground: "#e9e9ec",
        cursor: "#f77a44",
        selectionBackground: "#6d3828",
      },
    });
    document.getElementById("cast")?.remove();
    document.getElementById("fallback-prompt")?.remove();
    mount.style.background = "#0a0a0b";
    const write = (text: string) => term.write(new TextEncoder().encode(text));
    await runCast(write);
    interactive(term);
    wireKeybar(term);
  } catch {
    await domFallback();
  }
}

/** Replay the cast through a Ghostty writer. */
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
function interactive(term: GhosttyCanvasTerminal): void {
  let buf = "";
  let replies = 0;
  let busy = false;
  const write = (text: string) => term.write(new TextEncoder().encode(text));
  write(PROMPT);
  term.onData((data) => {
    if (busy) return;
    if (data === "\r") {
      if (!buf.trim()) {
        write(`\r\n${PROMPT}`);
        buf = "";
        return;
      }
      busy = true;
      write("\r\n");
      const lines = reply(replies++);
      void (async () => {
        await sleep(380);
        for (const l of lines) {
          write(l + "\r\n");
          await sleep(160);
        }
        write(PROMPT);
        buf = "";
        busy = false;
      })();
    } else if (data === "\x7f") {
      // backspace
      if (buf.length) {
        buf = buf.slice(0, -1);
        write("\b \b");
      }
    } else if (data === "\x03") {
      // ctrl-c
      write(`${FAINT}^C${R}\r\n${PROMPT}`);
      buf = "";
    } else if (data === "\x1b") {
      // esc — a wink
      write(`${CLEAR_LINE}${FAINT}(nothing to interrupt — this is the demo)${R}\r\n${PROMPT}${buf}`);
    } else if (data >= " " || data === "\t") {
      buf += data;
      write(data);
    }
  });
}

/** The key bar drives the same input path — sticky ctrl turns the next key into a chord. */
function wireKeybar(term: GhosttyCanvasTerminal): void {
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
      term.sendKey(k === "^C" ? "c" : k, { ctrl: true });
      stuck = false;
      ctrl.classList.remove("stuck");
      return;
    }
    const label: Record<string, string> = {
      esc: "Esc",
      tab: "Tab",
      up: "ArrowUp",
      down: "ArrowDown",
      "^C": "c",
    };
    term.sendKey(label[k] ?? k, { ctrl: k === "^C" });
  });
}

/** No-WASM fallback: simplified DOM replay + the same canned prompt, mockup-style. */
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
