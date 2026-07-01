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
  | "arrow-up"
  | "lock"
  | "folder"
  | "plus"
  | "bell"
  | "power"
  | "sliders"
  | "branch"
  | "history"
  | "stop"
  | "agent"
  | "archive"
  | "copy"
  | "arrow-right"
  | "keyboard";

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
  archive: (
    <>
      <rect x="3" y="4" width="18" height="4" rx="1" />
      <path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8" />
      <path d="M10 12h4" />
    </>
  ),
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
  star: <path d="M12 3.5 14.6 9l5.9.6-4.4 4 1.3 5.8L12 16.6 6.6 19.4 7.9 13.6 3.5 9.6 9.4 9z" />,
  "arrow-up": (
    <>
      <path d="M12 19V5" />
      <path d="m5 12 7-7 7 7" />
    </>
  ),
  lock: (
    <>
      <rect x="4.5" y="11" width="15" height="9" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </>
  ),
  folder: <path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />,
  plus: (
    <>
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </>
  ),
  bell: (
    <>
      <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.73 21a2 2 0 0 1-3.46 0" />
    </>
  ),
  power: (
    <>
      <path d="M12 3v9" />
      <path d="M6.4 6.4a8 8 0 1 0 11.2 0" />
    </>
  ),
  sliders: (
    <>
      <path d="M4 6h10" />
      <path d="M18 6h2" />
      <path d="M4 12h2" />
      <path d="M10 12h10" />
      <path d="M4 18h12" />
      <path d="M20 18h0" />
      <circle cx="16" cy="6" r="2" />
      <circle cx="6" cy="12" r="2" />
      <circle cx="18" cy="18" r="2" />
    </>
  ),
  // Git branch — two rails with a fork (lower node branching up to an upper node).
  branch: (
    <>
      <circle cx="6" cy="6" r="2.5" />
      <circle cx="6" cy="18" r="2.5" />
      <circle cx="18" cy="8" r="2.5" />
      <path d="M6 8.5v7" />
      <path d="M18 10.5a6 6 0 0 1-6 6H8.5" />
    </>
  ),
  // Clock with a counter-clockwise sweep — "past / resume" affordance.
  history: (
    <>
      <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
      <path d="M3 4v4h4" />
      <path d="M12 8v4l3 2" />
    </>
  ),
  // A rounded square — the universal STOP / interrupt glyph (filled via currentColor for a solid block).
  stop: <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none" />,
  // A small "agent" tile — a rounded frame with two eyes + a mouth (a delegated worker / mission).
  agent: (
    <>
      <rect x="4" y="5" width="16" height="15" rx="4" />
      <path d="M12 2v3" />
      <circle cx="9.5" cy="11" r="1" />
      <circle cx="14.5" cy="11" r="1" />
      <path d="M9.5 15.5h5" />
    </>
  ),
  "arrow-right": (
    <>
      <path d="M5 12h14" />
      <path d="m13 5 7 7-7 7" />
    </>
  ),
  // Two overlapping rounded rectangles — the universal "copy to clipboard" glyph.
  copy: (
    <>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </>
  ),
  // A keyboard: outer key-well + rows of key dots (round linecaps render the h.001 segments as dots).
  keyboard: (
    <>
      <rect x="2" y="4" width="20" height="16" rx="2" />
      <path d="M6 8h.001" />
      <path d="M10 8h.001" />
      <path d="M14 8h.001" />
      <path d="M18 8h.001" />
      <path d="M8 12h.001" />
      <path d="M12 12h.001" />
      <path d="M16 12h.001" />
      <path d="M7 16h10" />
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
