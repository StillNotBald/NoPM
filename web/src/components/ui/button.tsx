import type { ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/cn";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md" | "lg";
type Variant = ButtonVariant;
type Size = ButtonSize;

const variants: Record<Variant, string> = {
  // accent fill pairs with --accent-ink for contrast
  primary: "bg-accent text-accent-ink font-semibold hover:bg-accent-hover",
  secondary: "bg-surface text-ink border border-border-subtle hover:bg-well",
  ghost: "text-ink-secondary hover:bg-well",
  danger: "bg-danger-solid text-white hover:bg-danger-hover",
};

// Desktop heights are the compact 32/40/48. Below `sm` sm/md floor at 44px via
// min-height (not `h-11 sm:h-*`), so a caller's own `h-9` override can still
// not shrink the touch target; lg is already 48px.
const sizes: Record<Size, string> = {
  sm: "h-8 px-3 text-sm rounded-md max-sm:min-h-11",
  md: "h-10 px-4 text-sm rounded-md max-sm:min-h-11",
  lg: "h-12 px-6 text-base rounded-lg",
};

/**
 * The Button recipe as a class string, for elements that are not a <button>
 * (a next/link, an <a download>). See ButtonLink; one definition of the
 * primary button means one focus ring, one 44px floor, one accent-ink pairing.
 */
export function buttonClass({
  variant = "primary",
  size = "md",
  className,
}: { variant?: Variant; size?: Size; className?: string } = {}): string {
  return cn(
    "inline-flex items-center justify-center font-medium transition-colors duration-150",
    "focus-ring",
    "disabled:opacity-50 disabled:pointer-events-none",
    variants[variant],
    sizes[size],
    className,
  );
}

export function Button({
  variant = "primary",
  size = "md",
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size }) {
  return <button className={buttonClass({ variant, size, className })} {...props} />;
}
