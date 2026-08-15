export const MAX_TERMINAL_CLIPBOARD_BYTES = 512 * 1024;

type ClipboardCommand = { handled: boolean; text?: string };

export interface OscParserLike {
  registerOscHandler(ident: number, callback: (data: string) => boolean | Promise<boolean>): { dispose(): void };
}

function decodeBase64Text(payload: string, allowEmpty: boolean): string | undefined {
  if (payload.length === 0) return allowEmpty ? "" : undefined;
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}(?:==)?|[A-Za-z0-9+/]{3}=?)?$/u.test(payload)) {
    return undefined;
  }
  const unpaddedLength = payload.replace(/=+$/u, "").length;
  if (Math.floor((unpaddedLength * 3) / 4) > MAX_TERMINAL_CLIPBOARD_BYTES) return undefined;

  try {
    const binary = globalThis.atob(payload);
    if (binary.length > MAX_TERMINAL_CLIPBOARD_BYTES) return undefined;
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

/** Parse OSC 52 writes without ever answering a remote clipboard-read query. */
export function parseOsc52Clipboard(data: string): ClipboardCommand {
  const separator = data.indexOf(";");
  if (separator < 0) return { handled: true };
  const selection = data.slice(0, separator);
  const payload = data.slice(separator + 1);
  // Browsers expose one clipboard. Accept the standard clipboard/selection slots and map them to it.
  if (!/^[cpsq0-7]*$/u.test(selection) || payload === "?") return { handled: true };
  const text = decodeBase64Text(payload, true);
  return text === undefined ? { handled: true } : { handled: true, text };
}

/** Parse iTerm2 OSC 1337 Copy=:base64. Other OSC 1337 commands remain available to xterm. */
export function parseItermClipboard(data: string): ClipboardCommand {
  if (!data.startsWith("Copy")) return { handled: false };
  if (!data.startsWith("Copy=:") || data.length === "Copy=:".length) return { handled: true };
  const payload = data.slice("Copy=:".length);
  if (payload === "?") return { handled: true };
  const text = decodeBase64Text(payload, false);
  return text === undefined ? { handled: true } : { handled: true, text };
}

export function registerTerminalClipboardHandlers(
  parser: OscParserLike,
  onWrite: (text: string) => void,
): { dispose(): void } {
  const dispatch = (command: ClipboardCommand): boolean => {
    if (command.text !== undefined) onWrite(command.text);
    return command.handled;
  };
  const osc52 = parser.registerOscHandler(52, (data) => dispatch(parseOsc52Clipboard(data)));
  const iterm = parser.registerOscHandler(1337, (data) => dispatch(parseItermClipboard(data)));
  return {
    dispose() {
      osc52.dispose();
      iterm.dispose();
    },
  };
}
