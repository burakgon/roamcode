import type { ReactNode } from "react";

export interface SurfaceProps {
  level?: 1 | 2;
  as?: "div" | "section" | "article";
  className?: string;
  children: ReactNode;
}

export function Surface({ level = 1, as = "div", className, children }: SurfaceProps) {
  const Tag = as;
  return (
    <Tag
      className={className}
      style={{
        background: level === 1 ? "var(--surface)" : "var(--surface-2)",
        border: "1px solid var(--border)",
        borderRadius: 0,
      }}
    >
      {children}
    </Tag>
  );
}
