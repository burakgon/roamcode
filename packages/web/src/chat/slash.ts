export interface SlashCommand {
  name: string;
  hint: string;
  /** When true, selecting this command runs a CLIENT-SIDE action (e.g. opens a UI) instead of
   * inserting text to send to claude. Defaults falsy — the command is text typed to claude. */
  clientAction?: boolean;
}

export const SLASH_COMMANDS: SlashCommand[] = [
  { name: "/clear", hint: "Clear the conversation context" },
  { name: "/compact", hint: "Summarize and compact the context" },
  { name: "/help", hint: "Show available commands" },
  { name: "/model", hint: "Switch the model" },
  { name: "/cost", hint: "Show token/cost usage" },
  { name: "/resume", hint: "Resume a past session", clientAction: true },
];

/** When `text` starts with `/`, return commands whose name starts with the typed prefix. */
export function matchSlash(text: string): SlashCommand[] {
  if (!text.startsWith("/")) return [];
  const prefix = text.split(/\s/)[0]!.toLowerCase();
  return SLASH_COMMANDS.filter((c) => c.name.startsWith(prefix));
}
