import type { ContentBlock } from "../types/server";

export function imageBlockSrc(block: Extract<ContentBlock, { type: "image" }>): string {
  return `data:${block.source.media_type};base64,${block.source.data}`;
}

/** Find absolute-looking file paths in text (for download chips). Conservative + deduped. */
export function extractFilePaths(text: string): string[] {
  const matches = text.match(/\/[\w.\-/]+\.\w+/g) ?? [];
  return [...new Set(matches)];
}

/** True for a path that a browser can render inline as an image (so we preview it, not just link it). */
export function isImagePath(path: string): boolean {
  return /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i.test(path);
}
