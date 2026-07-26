import type { ReactNode } from "react";
import "../styles/button.css";

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
      className={["rc-button", `rc-button--${variant}`, className].filter(Boolean).join(" ")}
      aria-label={rest["aria-label"]}
      aria-expanded={rest["aria-expanded"]}
      aria-controls={rest["aria-controls"]}
    >
      {children}
    </button>
  );
}
