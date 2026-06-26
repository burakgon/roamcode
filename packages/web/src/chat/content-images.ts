import type { ContentBlock } from "../types/server";

export function imageBlockSrc(block: Extract<ContentBlock, { type: "image" }>): string {
  return `data:${block.source.media_type};base64,${block.source.data}`;
}

/** Find absolute-looking file paths in text (for download chips). Conservative + deduped. */
export function extractFilePaths(text: string): string[] {
  // Strip URLs FIRST: a link like `https://code.claude.com` otherwise matched the path regex as
  // `//code.claude.com` and rendered a bogus "code.claude.com" download chip. Remote URLs aren't
  // downloadable through the local /fs endpoint anyway, so they're never real attachments.
  const withoutUrls = text.replace(/\b[a-z][\w+.-]*:\/\/\S+/gi, " ");
  const matches = withoutUrls.match(/\/[\w.\-/]+\.\w+/g) ?? [];
  // Drop any residual protocol-relative leftovers (a bare `//host/...`) — real file paths start with a
  // single `/`, never `//`.
  return [...new Set(matches.filter((m) => !m.startsWith("//")))];
}

/** True for a path that a browser can render inline as an image (so we preview it, not just link it). */
export function isImagePath(path: string): boolean {
  return /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i.test(path);
}
