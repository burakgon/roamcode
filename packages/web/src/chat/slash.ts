export interface SlashCommand {
  name: string;
  hint: string;
  /** When true, selecting this command runs a CLIENT-SIDE action (e.g. opens a UI) instead of
   * inserting text to send to claude. Defaults falsy — the command is text typed to claude. */
  clientAction?: boolean;
}

/** A small static fallback shown BEFORE the session's `system/init` advertises its real command list. */
export const SLASH_COMMANDS: SlashCommand[] = [
  { name: "/clear", hint: "Clear the conversation context" },
  { name: "/compact", hint: "Summarize and compact the context" },
  { name: "/help", hint: "Show available commands" },
  { name: "/model", hint: "Switch the model" },
  { name: "/cost", hint: "Show token/cost usage" },
  { name: "/resume", hint: "Resume a past session", clientAction: true },
];

/** /resume is purely a CLIENT action (it opens the past-sessions picker); the CLI never advertises it, so
 *  it's always merged into the per-session menu. */
const RESUME_COMMAND: SlashCommand = { name: "/resume", hint: "Resume a past session", clientAction: true };

/**
 * The full slash menu for a session: its REAL available commands as advertised by `system/init`
 * (`slash_commands` — custom skills, plugin + project commands, built-ins), each prefixed with `/` and
 * enriched with a known hint/clientAction when we have one; plus `/resume`. Falls back to the small static
 * list before init has arrived. This is what lets the phone run the SAME commands as the terminal.
 */
export function sessionCommands(commands: string[] | undefined): SlashCommand[] {
  if (!commands || commands.length === 0) return SLASH_COMMANDS;
  const fromInit = commands.map((name): SlashCommand => {
    const full = name.startsWith("/") ? name : `/${name}`;
    const known = SLASH_COMMANDS.find((c) => c.name === full);
    return { name: full, hint: known?.hint ?? "", ...(known?.clientAction ? { clientAction: true } : {}) };
  });
  return fromInit.some((c) => c.name === "/resume") ? fromInit : [RESUME_COMMAND, ...fromInit];
}

/**
 * True when the user's text is a slash command (e.g. "/compact", "/model opus"). Used to decide such a
 * send must NOT be marked `queued`: the CLI never echoes a slash command back as a user event, so a queued
 * optimistic bubble would never reconcile and would stay dimmed at the bottom of the chat forever.
 */
export function isSlashCommand(text: string | undefined): boolean {
  return (text ?? "").trimStart().startsWith("/");
}

/** When `text` starts with `/`, return the session's commands whose name starts with the typed prefix.
 *  `commands` is the session's real list (from init); omit it to match the static fallback. Once the
 *  command token is COMPLETE (any whitespace follows, e.g. "/model opus"), the user is typing arguments,
 *  not choosing a command — return nothing so the menu closes instead of lingering over "/model". */
export function matchSlash(text: string, commands?: string[]): SlashCommand[] {
  if (!text.startsWith("/")) return [];
  if (/\s/.test(text)) return [];
  const prefix = text.toLowerCase();
  return sessionCommands(commands).filter((c) => c.name.toLowerCase().startsWith(prefix));
}
