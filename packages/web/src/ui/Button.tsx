import type { ReactNode } from "react";

export interface ButtonProps {
  variant?: "primary" | "ghost" | "danger";
  type?: "button" | "submit";
  disabled?: boolean;
  onClick?: () => void;
  "aria-label"?: string;
  "aria-expanded"?: boolean;
  "aria-controls"?: string;
  className?: string;
  children: ReactNode;
}

const base: React.CSSProperties = {
  minHeight: "var(--tap-min)",
  padding: "0 var(--sp-4)",
  borderRadius: "var(--radius-sm)",
  border: "1px solid var(--border)",
  font: "inherit",
  fontWeight: 500,
  cursor: "pointer",
};

const variants: Record<NonNullable<ButtonProps["variant"]>, React.CSSProperties> = {
  // The single coral primary — a FLAT coral fill with DARK ink (--on-accent), never white (spec).
  // Depth comes from contrast, not a glow.
  primary: {
    background: "var(--accent-grad)",
    color: "var(--on-accent)",
    borderColor: "transparent",
    fontWeight: 600,
  },
  // Secondary / ghost — neutral outline (hairline) + neutral text.
  ghost: { background: "transparent", color: "var(--text)", borderColor: "var(--border-strong)" },
  danger: { background: "transparent", color: "var(--err)", borderColor: "var(--err-line)" },
};

export function Button({
  variant = "ghost",
  type = "button",
  disabled,
  onClick,
  className,
  children,
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      disabled={disabled}
      onClick={onClick}
      className={className}
      aria-label={rest["aria-label"]}
      aria-expanded={rest["aria-expanded"]}
      aria-controls={rest["aria-controls"]}
      style={{ ...base, ...variants[variant], opacity: disabled ? 0.5 : 1 }}
    >
      {children}
    </button>
  );
}
