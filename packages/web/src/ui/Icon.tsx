import type { CSSProperties, ReactElement } from "react";

/**
 * Dependency-free SVG icon system. Hand-authored Feather/Lucide-style paths (no npm icon dep) so the
 * bundle stays lean and every glyph is a real vector — NO EMOJI anywhere in the rendered UI.
 *
 * Conventions: 24×24 viewBox, `currentColor` stroke (inherits the surrounding text color), a
 * consistent ~1.75px stroke weight, rounded joins. Default rendered size is ~17px. Decorative by
 * default (`aria-hidden`); pass a `label` to expose it to assistive tech as an `img` with a name.
 */
export type IconName =
  | "download"
  | "paperclip"
  | "file"
  | "image"
  | "audio"
  | "bolt"
  | "chevron-right"
  | "chevron-down"
  | "settings"
  | "send"
  | "terminal"
  | "search"
  | "check"
  | "x"
  | "alert"
  | "menu"
  | "star"
  | "arrow-up";

export interface IconProps {
  name: IconName;
  /** Rendered square size in px. Default 17. */
  size?: number;
  /** Accessible name. When omitted the icon is decorative (`aria-hidden`). */
  label?: string;
  className?: string;
  style?: CSSProperties;
}

// Each entry is the inner SVG markup for a 24×24 viewBox, stroked in currentColor.
const PATHS: Record<IconName, ReactElement> = {
  download: (
    <>
      <path d="M12 3v12" />
      <path d="m7 11 5 5 5-5" />
      <path d="M5 21h14" />
    </>
  ),
  paperclip: (
    <path d="M21 9.5 12.5 18a4 4 0 0 1-5.66-5.66l8.49-8.48a2.5 2.5 0 0 1 3.54 3.54l-8.49 8.48a1 1 0 0 1-1.41-1.41l7.78-7.78" />
  ),
  file: (
    <>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5" />
    </>
  ),
  image: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <circle cx="8.5" cy="9.5" r="1.5" />
      <path d="m21 16-5-5L5 21" />
    </>
  ),
  audio: (
    <>
      <path d="M3 12v1" />
      <path d="M7 9v6" />
      <path d="M11 5v14" />
      <path d="M15 8v8" />
      <path d="M19 11v2" />
    </>
  ),
  bolt: <path d="M13 2 4 14h7l-1 8 9-12h-7z" />,
  "chevron-right": <path d="m9 5 7 7-7 7" />,
  "chevron-down": <path d="m5 9 7 7 7-7" />,
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </>
  ),
  send: (
    <>
      <path d="M12 19V5" />
      <path d="m5 12 7-7 7 7" />
    </>
  ),
  terminal: (
    <>
      <path d="m4 17 6-6-6-6" />
      <path d="M12 19h8" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="m21 21-4.3-4.3" />
    </>
  ),
  check: <path d="M20 6 9 17l-5-5" />,
  x: (
    <>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </>
  ),
  alert: (
    <>
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
    </>
  ),
  menu: (
    <>
      <path d="M4 6h16" />
      <path d="M4 12h16" />
      <path d="M4 18h16" />
    </>
  ),
  star: (
    <path d="M12 3.5 14.6 9l5.9.6-4.4 4 1.3 5.8L12 16.6 6.6 19.4 7.9 13.6 3.5 9.6 9.4 9z" />
  ),
  "arrow-up": (
    <>
      <path d="M12 19V5" />
      <path d="m5 12 7-7 7 7" />
    </>
  ),
};

export function Icon({ name, size = 17, label, className, style }: IconProps) {
  const a11y = label ? { role: "img", "aria-label": label } : { "aria-hidden": true };
  return (
    <svg
      {...a11y}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      style={{ flex: "none", display: "inline-block", verticalAlign: "text-bottom", ...style }}
    >
      {PATHS[name]}
    </svg>
  );
}

/** Pick the best file-type icon for a path/name by extension (image / audio / generic file). */
export function iconForFile(nameOrPath: string): IconName {
  const ext = nameOrPath.toLowerCase().split(".").pop() ?? "";
  if (/^(png|jpe?g|gif|webp|svg|bmp|avif|heic)$/.test(ext)) return "image";
  if (/^(wav|mp3|m4a|aac|ogg|flac|aiff?|opus)$/.test(ext)) return "audio";
  return "file";
}
