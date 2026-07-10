import type { DropEdge } from "./layout";

/**
 * Drag & drop contract for the split workspace (HTML5 DnD — desktop-only, like the workspace itself).
 * Two payload kinds, distinguished by MIME type so the drop targets can tell them apart from `types`
 * alone during dragover (dataTransfer DATA is unreadable until drop, by spec):
 *   - SESSION_MIME: a session dragged from the RAIL (payload = session id);
 *   - PANE_MIME: a pane dragged by its header (payload = leaf id) to rearrange.
 */
export const SESSION_MIME = "application/x-roamcode-session";
export const PANE_MIME = "application/x-roamcode-pane";

/** Where inside a pane a drop lands: one of the four edges (→ split/move there) or the center (→ swap /
 *  show-here). */
export type DropZone = DropEdge | "center";

/** True when a dragover carries one of OUR payloads (ignore stray text/file drags entirely). */
export function isWorkspaceDrag(types: readonly string[]): boolean {
  return types.includes(SESSION_MIME) || types.includes(PANE_MIME);
}

/**
 * Map a pointer position inside a pane to its drop zone: the middle box (40% each axis) is "center",
 * anything else resolves to the NEAREST edge — same feel as iTerm2's drop bands. Pure + unit-tested.
 */
export function zoneForPoint(
  rect: { left: number; top: number; width: number; height: number },
  clientX: number,
  clientY: number,
): DropZone {
  const x = rect.width > 0 ? (clientX - rect.left) / rect.width : 0.5;
  const y = rect.height > 0 ? (clientY - rect.top) / rect.height : 0.5;
  if (x >= 0.3 && x <= 0.7 && y >= 0.3 && y <= 0.7) return "center";
  const edges: Array<{ zone: DropEdge; d: number }> = [
    { zone: "left", d: x },
    { zone: "right", d: 1 - x },
    { zone: "top", d: y },
    { zone: "bottom", d: 1 - y },
  ];
  edges.sort((a, b) => a.d - b.d);
  return edges[0]!.zone;
}
