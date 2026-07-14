/** Return a canonical web URL only for protocols that are safe to hand to the browser. */
export function terminalWebUrl(raw: string): string | undefined {
  if (/[\u0000-\u001f\u007f]/u.test(raw)) return undefined;
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

export type TerminalWindowOpener = () => Window | null;

/**
 * Open a terminal URL without giving the destination access to the RoamCode window.
 *
 * Opening an empty window first mirrors xterm's own default link handler: it keeps the call directly inside
 * the trusted click/tap gesture (important for mobile popup blockers), then severs `opener` before navigating.
 */
export function openTerminalWebLink(raw: string, openWindow: TerminalWindowOpener = () => window.open()): boolean {
  const href = terminalWebUrl(raw);
  if (!href) return false;

  const popup = openWindow();
  if (!popup) return false;
  try {
    popup.opener = null;
    popup.location.href = href;
    return true;
  } catch {
    try {
      popup.close();
    } catch {
      /* the browser owns the failed popup; there is nothing else to clean up */
    }
    return false;
  }
}
