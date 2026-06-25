import type { ReactNode } from "react";

export interface ButtonProps {
  variant?: "primary" | "ghost" | "danger";
  type?: "button" | "submit";
  disabled?: boolean;
  onClick?: () => void;
  "aria-label"?: string;
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
  // The single coral primary — a clay-coral gradient with the liquid-glass "pop" glow. The label is
  // DARK ink (--on-accent) reading on the warm coral, never white (spec).
  primary: {
    background: "var(--accent-grad)",
    color: "var(--on-accent)",
    borderColor: "transparent",
    boxShadow: "var(--shadow-pop)",
  },
  ghost: { background: "transparent", color: "var(--text)" },
  danger: { background: "transparent", color: "var(--err)", borderColor: "var(--err)" },
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
      style={{ ...base, ...variants[variant], opacity: disabled ? 0.5 : 1 }}
    >
      {children}
    </button>
  );
}
