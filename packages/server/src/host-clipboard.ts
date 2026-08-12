import { spawn } from "node:child_process";

export const HOST_CLIPBOARD_MAX_BYTES = 512 * 1024;
const HOST_CLIPBOARD_TIMEOUT_MS = 3_000;

export type HostClipboardErrorCode = "EMPTY" | "TOO_LARGE" | "UNAVAILABLE";

export class HostClipboardError extends Error {
  constructor(readonly code: HostClipboardErrorCode) {
    super(
      code === "EMPTY"
        ? "clipboard text is empty"
        : code === "TOO_LARGE"
          ? "clipboard text is too large"
          : "host clipboard is unavailable",
    );
    this.name = "HostClipboardError";
  }
}

export interface HostClipboardWriter {
  writeText(text: string): Promise<void>;
}

export interface HostClipboardCommand {
  command: string;
  args: readonly string[];
}

export type RunHostClipboardCommand = (
  candidate: HostClipboardCommand,
  text: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
) => Promise<void>;

export interface HostClipboardWriterOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  run?: RunHostClipboardCommand;
}

/** Native clipboard commands in preference order. Every command receives the selected text over stdin; text
 * never enters argv, a shell, logs, or process listings. macOS ships pbcopy. Linux tries the standard Wayland
 * and X11 tools because desktop distributions differ; a missing helper falls through to the next candidate. */
export function hostClipboardCommands(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): readonly HostClipboardCommand[] {
  if (platform === "darwin") return [{ command: "/usr/bin/pbcopy", args: [] }];
  if (platform === "win32") return [{ command: "clip.exe", args: [] }];
  if (platform !== "linux") return [];

  const wayland: HostClipboardCommand = {
    command: "wl-copy",
    args: ["--type", "text/plain;charset=utf-8"],
  };
  const x11: HostClipboardCommand[] = [
    { command: "xclip", args: ["-selection", "clipboard", "-in"] },
    { command: "xsel", args: ["--clipboard", "--input"] },
  ];
  if (env.WAYLAND_DISPLAY) return [wayland, ...x11];
  if (env.DISPLAY) return [...x11, wayland];
  return [wayland, ...x11];
}

export function runHostClipboardCommand(
  candidate: HostClipboardCommand,
  text: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };

    try {
      const child = spawn(candidate.command, [...candidate.args], {
        env,
        stdio: ["pipe", "ignore", "ignore"],
        windowsHide: true,
      });
      child.once("error", (error) => finish(error));
      child.once("close", (code) =>
        finish(code === 0 ? undefined : new Error(`clipboard helper exited with status ${String(code)}`)),
      );
      child.stdin?.once("error", (error) => finish(error));
      timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* already exited */
        }
        finish(new Error("clipboard helper timed out"));
      }, timeoutMs);
      timer.unref?.();
      child.stdin?.end(text, "utf8");
    } catch (error) {
      finish(error instanceof Error ? error : new Error("clipboard helper failed"));
    }
  });
}

/** Writes to the operating-system clipboard of the computer running RoamCode. Success means a native helper
 * exited successfully; callers must not show a copied confirmation for a browser-only write. */
export function createHostClipboardWriter(options: HostClipboardWriterOptions = {}): HostClipboardWriter {
  const platform = options.platform ?? process.platform;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...(options.env ?? {}),
    // Services often start without a locale. Native clipboard helpers need UTF-8 to preserve terminal text.
    LC_CTYPE: options.env?.LC_CTYPE || process.env.LC_CTYPE || "UTF-8",
  };
  const candidates = hostClipboardCommands(platform, env);
  const run = options.run ?? runHostClipboardCommand;
  const timeoutMs = options.timeoutMs ?? HOST_CLIPBOARD_TIMEOUT_MS;

  return {
    async writeText(text: string): Promise<void> {
      if (text.length === 0) throw new HostClipboardError("EMPTY");
      if (Buffer.byteLength(text, "utf8") > HOST_CLIPBOARD_MAX_BYTES) throw new HostClipboardError("TOO_LARGE");
      for (const candidate of candidates) {
        try {
          await run(candidate, text, env, timeoutMs);
          return;
        } catch {
          /* try the next native helper without exposing selected text or command stderr */
        }
      }
      throw new HostClipboardError("UNAVAILABLE");
    },
  };
}
